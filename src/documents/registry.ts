import fs from "node:fs";
import path from "node:path";
import { findFuzzyMatches } from "../core/fuzzy.js";
import { matchGlossaryTerms } from "../core/glossary.js";
import { getLocaleConventions } from "../core/locales.js";
import { extractInlineTags } from "../core/placeholders.js";
import { DocumentScanSummary } from "../core/scan.js";
import {
  atomicWriteFileSync,
  resolveConfinedPath,
  SecurityBoundaryError,
  validateLocaleTag,
  withWorkspaceLock,
} from "../core/security.js";
import { WraithStore, sha256Short } from "../core/store.js";
import { composeTranslationGuidance, resolveStyleGuide } from "../core/style-guide.js";
import { DocxDocumentAdapter } from "./docx.js";
import { MarkdownDocumentAdapter } from "./markdown.js";
import { PptxDocumentAdapter } from "./pptx.js";
import { SubtitleDocumentAdapter } from "./subtitles.js";
import { XlsxDocumentAdapter } from "./xlsx.js";
import {
  DocumentAdapter,
  DocumentApplyResult,
  DocumentSegment,
  DocumentTranslationUpdate,
  ExtractedDocument,
} from "./types.js";

const docAdapters: DocumentAdapter[] = [
  new DocxDocumentAdapter(),
  new PptxDocumentAdapter(),
  new XlsxDocumentAdapter(),
  new SubtitleDocumentAdapter("vtt"),
  new SubtitleDocumentAdapter("srt"),
  new MarkdownDocumentAdapter("markdown"),
  new MarkdownDocumentAdapter("mdx"),
];

export interface DocumentSegmentRecord {
  contentKey: string;
  part: string;
  sourceHash: string;
  source: string;
  translation: string;
  lastSegmentId: string;
  origin?: "agent" | "manual";
  updatedAt: string;
}

export interface DocumentStaleRecord {
  segmentId: string;
  part: string;
  previousSourceHash: string;
  previousSource: string;
  previousTranslation: string;
  currentSourceHash: string;
  currentSource: string;
}

export interface DocumentStateRecord {
  targetFile: string;
  sourceHash: string;
  totalSegments: number;
  translatedSegments: number;
  /** Content-derived segment translations keyed by `${part}:${sourceHash}:${occurrence}` */
  segmentRecords?: Record<string, DocumentSegmentRecord>;
  /** Segments whose source text changed since last applied translation */
  staleSegments?: Record<string, DocumentStaleRecord>;
  /** Legacy positional map (only used when sourceHash matches identically) */
  segments?: Record<string, string>;
  updatedAt: string;
}

export interface DocumentsStateFile {
  version: 1;
  documents: Record<string, Record<string, DocumentStateRecord>>;
}

interface IdentifiedSegment {
  segment: DocumentSegment;
  sourceHash: string;
  contentKey: string;
}

export interface EvaluatedDocumentSegment {
  segment: DocumentSegment;
  sourceHash: string;
  contentKey: string;
  status: "translated" | "stale" | "untranslated";
  carriedTranslation?: string;
  manuallyEdited?: boolean;
  manualEditTagConflict?: boolean;
  priorOrigin?: "agent" | "manual";
  staleInfo?: DocumentStaleRecord;
}

export interface DocumentEvaluation {
  extracted: ExtractedDocument;
  sourceHash: string;
  segments: EvaluatedDocumentSegment[];
  translatedCount: number;
  staleCount: number;
  untranslatedCount: number;
  pendingCount: number;
}

function identifySegments(segments: DocumentSegment[]): IdentifiedSegment[] {
  const counts = new Map<string, number>();
  return segments.map((segment) => {
    const sourceHash = sha256Short(segment.text);
    const baseKey = `${segment.part}:${sourceHash}`;
    const occ = counts.get(baseKey) ?? 0;
    counts.set(baseKey, occ + 1);
    return {
      segment,
      sourceHash,
      contentKey: `${baseKey}:${occ}`,
    };
  });
}

function computeDocSourceHash(segments: DocumentSegment[]): string {
  return sha256Short(segments.map((s) => `${s.part}:${s.id}:${s.text}`).join("\n"));
}

function inlineTagsCompatible(sourceText: string, candidateText: string): boolean {
  const srcTags = extractInlineTags(sourceText);
  const tgtTags = extractInlineTags(candidateText);
  return (
    tgtTags.balanced &&
    JSON.stringify(srcTags.selfClosing) === JSON.stringify(tgtTags.selfClosing) &&
    JSON.stringify(srcTags.paired) === JSON.stringify(tgtTags.paired)
  );
}

function inspectDocumentState(
  extracted: ExtractedDocument,
  adapter: DocumentAdapter,
  prior: DocumentStateRecord | undefined,
  absTarget: string | null,
  relTarget: string | null
): DocumentEvaluation {
  const identified = identifySegments(extracted.segments);
  const currentSourceHash = computeDocSourceHash(extracted.segments);
  const currentContentKeys = new Set(identified.map((i) => i.contentKey));

  const priorByContentKey = new Map<string, DocumentSegmentRecord>();
  const priorByLastId = new Map<string, DocumentSegmentRecord>();

  if (prior) {
    if (prior.segmentRecords) {
      for (const rec of Object.values(prior.segmentRecords)) {
        priorByContentKey.set(rec.contentKey, rec);
        priorByLastId.set(rec.lastSegmentId, rec);
      }
    } else if (prior.segments && prior.sourceHash === currentSourceHash) {
      // Legacy positional state: ONLY valid if the entire source document is unchanged.
      for (const item of identified) {
        const legacyText = prior.segments[item.segment.id];
        if (legacyText !== undefined) {
          const rec: DocumentSegmentRecord = {
            contentKey: item.contentKey,
            part: item.segment.part,
            sourceHash: item.sourceHash,
            source: item.segment.text,
            translation: legacyText,
            lastSegmentId: item.segment.id,
            origin: "agent",
            updatedAt: prior.updatedAt,
          };
          priorByContentKey.set(rec.contentKey, rec);
          priorByLastId.set(rec.lastSegmentId, rec);
        }
      }
    }
  }

  // Read existing target document on disk to detect & preserve manual reviewer edits (N5)
  const existingTargetById = new Map<string, DocumentSegment>();
  if (
    prior &&
    absTarget &&
    relTarget &&
    prior.targetFile === relTarget &&
    fs.existsSync(absTarget)
  ) {
    try {
      const targetDoc = adapter.extract(absTarget);
      for (const tSeg of targetDoc.segments) {
        existingTargetById.set(tSeg.id, tSeg);
      }
    } catch {
      // If existing target cannot be parsed, fall back to stored segmentRecords
    }
  }

  const evaluated: EvaluatedDocumentSegment[] = [];
  let translatedCount = 0;
  let staleCount = 0;
  let untranslatedCount = 0;

  for (const item of identified) {
    const matchedPrior = priorByContentKey.get(item.contentKey);
    if (matchedPrior) {
      let carriedTranslation = matchedPrior.translation;
      let manuallyEdited = false;
      let manualEditTagConflict = false;

      const diskSeg = existingTargetById.get(matchedPrior.lastSegmentId);
      if (
        diskSeg &&
        diskSeg.part === item.segment.part &&
        diskSeg.text !== matchedPrior.translation &&
        diskSeg.text !== item.segment.text
      ) {
        if (inlineTagsCompatible(item.segment.text, diskSeg.text)) {
          carriedTranslation = diskSeg.text;
          manuallyEdited = true;
        } else {
          manualEditTagConflict = true;
        }
      }

      translatedCount++;
      evaluated.push({
        segment: item.segment,
        sourceHash: item.sourceHash,
        contentKey: item.contentKey,
        status: "translated",
        carriedTranslation,
        manuallyEdited,
        manualEditTagConflict,
        priorOrigin: manuallyEdited ? "manual" : (matchedPrior.origin ?? "agent"),
      });
      continue;
    }

    // Check if this segment was previously recorded as stale for this exact new source hash
    const priorStale = prior?.staleSegments?.[item.segment.id];
    if (priorStale && priorStale.currentSourceHash === item.sourceHash) {
      staleCount++;
      evaluated.push({
        segment: item.segment,
        sourceHash: item.sourceHash,
        contentKey: item.contentKey,
        status: "stale",
        staleInfo: priorStale,
      });
      continue;
    }

    // Detect in-place source edits: a prior translated segment occupied this same structural ID/part,
    // its old contentKey is no longer present anywhere in the document (so it wasn't merely shifted),
    // and its sourceHash differs from the current segment.
    const priorAtPos = priorByLastId.get(item.segment.id);
    if (
      priorAtPos &&
      priorAtPos.part === item.segment.part &&
      priorAtPos.sourceHash !== item.sourceHash &&
      !currentContentKeys.has(priorAtPos.contentKey)
    ) {
      staleCount++;
      evaluated.push({
        segment: item.segment,
        sourceHash: item.sourceHash,
        contentKey: item.contentKey,
        status: "stale",
        staleInfo: {
          segmentId: item.segment.id,
          part: item.segment.part,
          previousSourceHash: priorAtPos.sourceHash,
          previousSource: priorAtPos.source,
          previousTranslation: priorAtPos.translation,
          currentSourceHash: item.sourceHash,
          currentSource: item.segment.text,
        },
      });
      continue;
    }

    untranslatedCount++;
    evaluated.push({
      segment: item.segment,
      sourceHash: item.sourceHash,
      contentKey: item.contentKey,
      status: "untranslated",
    });
  }

  return {
    extracted,
    sourceHash: currentSourceHash,
    segments: evaluated,
    translatedCount,
    staleCount,
    untranslatedCount,
    pendingCount: staleCount + untranslatedCount,
  };
}

export function readDocumentsState(store: WraithStore): DocumentsStateFile {
  const p = store.filePath("documents.json");
  if (!fs.existsSync(p)) return { version: 1, documents: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as DocumentsStateFile;
    return { version: 1, documents: parsed.documents ?? {} };
  } catch {
    return { version: 1, documents: {} };
  }
}

function writeDocumentsState(store: WraithStore, state: DocumentsStateFile): void {
  store.ensureDir();
  atomicWriteFileSync(store.filePath("documents.json"), JSON.stringify(state, null, 2) + "\n");
}

export function evaluateDocumentForCheck(
  rootDir: string,
  relDocFile: string,
  targetLocale: string
): {
  targetExists: boolean;
  hasStateRecord: boolean;
  evaluation: DocumentEvaluation | null;
  targetPathError?: string;
} {
  const store = new WraithStore(rootDir);
  const absSource = resolveConfinedPath(store.rootDir, relDocFile, { label: "document" });
  const adapter = getDocumentAdapter(absSource);
  if (!adapter) {
    return { targetExists: false, hasStateRecord: false, evaluation: null };
  }

  const docState = readDocumentsState(store);
  const entry = docState.documents[relDocFile]?.[targetLocale];

  const ext = path.extname(relDocFile);
  const stem = relDocFile.slice(0, -ext.length);
  const defaultRelTarget = `${stem}.${targetLocale}${ext}`;
  const candidateRelTarget = entry?.targetFile ?? defaultRelTarget;

  let absTarget: string;
  try {
    absTarget = resolveConfinedPath(store.rootDir, candidateRelTarget, { label: "targetFile" });
  } catch (err) {
    return {
      targetExists: false,
      hasStateRecord: Boolean(entry),
      evaluation: null,
      targetPathError: err instanceof Error ? err.message : String(err),
    };
  }

  const targetExists = fs.existsSync(absTarget);
  const extracted = adapter.extract(absSource);
  const evaluation = inspectDocumentState(
    extracted,
    adapter,
    entry,
    targetExists ? absTarget : null,
    candidateRelTarget
  );

  return {
    targetExists,
    hasStateRecord: Boolean(entry),
    evaluation,
  };
}

export function getDocumentAdapter(filePath: string): DocumentAdapter | null {
  const ext = path.extname(filePath).toLowerCase();
  return docAdapters.find((a) => a.extensions.includes(ext)) ?? null;
}

export function extractDocument(filePath: string): ExtractedDocument {
  const adapter = getDocumentAdapter(filePath);
  if (!adapter) {
    throw new Error(`Unsupported document format: ${filePath}`);
  }
  return adapter.extract(filePath);
}

/**
 * Apply document translations safely and incrementally:
 * 1. Validates targetLocale and confines sourceFile & targetFile within rootDir.
 * 2. Refuses targetFile === sourceFile (prevents overwriting the original).
 * 3. Matches prior translations by per-segment content identity (`part:sourceHash:occurrence`),
 *    NEVER by paragraph position, so insertions/deletions/reordering never misalign paragraphs
 *    and edited source paragraphs never silently inherit stale translations.
 * 4. Detects and preserves manual reviewer edits made directly in the translated target file
 *    for untouched segments (unless `force: true` overrides a conflicting inline-tag edit).
 * 5. Validates the entire merged operation before atomically writing the target file.
 */
export function applyDocumentTranslations(
  rootDir: string,
  options: {
    sourceFile: string;
    targetFile: string;
    targetLocale: string;
    updates: DocumentTranslationUpdate[];
    force?: boolean;
  }
): DocumentApplyResult {
  let absSource: string;
  let absTarget: string;
  try {
    validateLocaleTag(options.targetLocale, "targetLocale");
    absSource = resolveConfinedPath(rootDir, options.sourceFile, { label: "sourceFile" });
    absTarget = resolveConfinedPath(rootDir, options.targetFile, { label: "targetFile" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      segmentsTotal: 0,
      segmentsUpdated: 0,
      byteIdentical: false,
      errors: [
        {
          id: "*",
          code: err instanceof SecurityBoundaryError ? err.code : "security_error",
          message,
        },
      ],
    };
  }

  if (absSource === absTarget) {
    return {
      ok: false,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      segmentsTotal: 0,
      segmentsUpdated: 0,
      byteIdentical: false,
      errors: [
        {
          id: "*",
          code: "same_source_and_target",
          message: "Refused to overwrite source document: targetFile must be different from sourceFile.",
        },
      ],
    };
  }

  const adapter = getDocumentAdapter(absSource);
  if (!adapter) {
    return {
      ok: false,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      segmentsTotal: 0,
      segmentsUpdated: 0,
      byteIdentical: false,
      errors: [{ id: "*", code: "unsupported_document", message: `Unsupported document: ${options.sourceFile}` }],
    };
  }

  return withWorkspaceLock(rootDir, () =>
    applyDocumentTranslationsUnlocked(rootDir, absSource, absTarget, adapter, options)
  );
}

function applyDocumentTranslationsUnlocked(
  rootDir: string,
  absSource: string,
  absTarget: string,
  adapter: DocumentAdapter,
  options: {
    sourceFile: string;
    targetFile: string;
    targetLocale: string;
    updates: DocumentTranslationUpdate[];
    force?: boolean;
  }
): DocumentApplyResult {
  const store = new WraithStore(rootDir);
  const relSource = path.relative(store.rootDir, absSource).replace(/\\/g, "/");
  const relTarget = path.relative(store.rootDir, absTarget).replace(/\\/g, "/");
  const extracted = adapter.extract(absSource);

  const docState = readDocumentsState(store);
  const prior = docState.documents[relSource]?.[options.targetLocale];
  const evaluation = inspectDocumentState(
    extracted,
    adapter,
    prior,
    fs.existsSync(absTarget) ? absTarget : null,
    relTarget
  );

  const incomingById = new Map<string, string>();
  for (const u of options.updates) {
    incomingById.set(u.id, u.text);
  }

  // Carry forward prior translations ONLY when their content identity (part + sourceHash + occurrence)
  // still matches AND the target file still exists for the same relTarget.
  const canCarryPrior = Boolean(prior && prior.targetFile === relTarget && fs.existsSync(absTarget));
  const mergedMap = new Map<string, { text: string; origin: "agent" | "manual" }>();
  const manualConflicts: Array<{ id: string; code: string; message: string }> = [];

  for (const ev of evaluation.segments) {
    const incoming = incomingById.get(ev.segment.id);
    if (incoming !== undefined) {
      mergedMap.set(ev.segment.id, { text: incoming, origin: "agent" });
      continue;
    }

    if (canCarryPrior && ev.status === "translated" && ev.carriedTranslation !== undefined) {
      if (ev.manualEditTagConflict && !options.force) {
        manualConflicts.push({
          id: ev.segment.id,
          code: "manual_edit_conflict",
          message: `Segment "${ev.segment.id}" was manually edited in "${relTarget}" with altered inline formatting tags. Re-run with force=true to overwrite, or re-apply this segment explicitly.`,
        });
        continue;
      }
      mergedMap.set(ev.segment.id, {
        text: ev.carriedTranslation,
        origin: ev.priorOrigin ?? "agent",
      });
    }
  }

  // Also forward any unknown incoming IDs so adapter.apply reports unknown_segment cleanly
  const knownIds = new Set(extracted.segments.map((s) => s.id));
  for (const u of options.updates) {
    if (!knownIds.has(u.id)) {
      mergedMap.set(u.id, { text: u.text, origin: "agent" });
    }
  }

  if (manualConflicts.length > 0) {
    return {
      ok: false,
      sourceFile: options.sourceFile,
      targetFile: options.targetFile,
      segmentsTotal: extracted.segments.length,
      segmentsUpdated: 0,
      byteIdentical: false,
      errors: manualConflicts,
    };
  }

  const mergedUpdates: DocumentTranslationUpdate[] = [...mergedMap.entries()].map(
    ([id, entry]) => ({ id, text: entry.text })
  );

  const res = adapter.apply(absSource, absTarget, mergedUpdates, {
    targetLocale: options.targetLocale,
  });

  if (res.ok) {
    const now = new Date().toISOString();
    if (!docState.documents[relSource]) docState.documents[relSource] = {};

    const segmentRecords: Record<string, DocumentSegmentRecord> = {};
    const staleSegments: Record<string, DocumentStaleRecord> = {};
    let translatedCount = 0;

    for (const ev of evaluation.segments) {
      const merged = mergedMap.get(ev.segment.id);
      if (merged) {
        translatedCount++;
        segmentRecords[ev.contentKey] = {
          contentKey: ev.contentKey,
          part: ev.segment.part,
          sourceHash: ev.sourceHash,
          source: ev.segment.text,
          translation: merged.text,
          lastSegmentId: ev.segment.id,
          origin: merged.origin,
          updatedAt: now,
        };
      } else if (ev.status === "stale" && ev.staleInfo) {
        staleSegments[ev.segment.id] = ev.staleInfo;
      }
    }

    docState.documents[relSource][options.targetLocale] = {
      targetFile: relTarget,
      sourceHash: evaluation.sourceHash,
      totalSegments: extracted.segments.length,
      translatedSegments: translatedCount,
      segmentRecords,
      staleSegments,
      updatedAt: now,
    };
    if (store.exists()) {
      writeDocumentsState(store, docState);
    }

    // Record incoming segment pairs (and preserved manual edits) into .wraith/memory.jsonl
    if (store.exists()) {
      const config = store.readConfig();
      const segById = new Map(extracted.segments.map((s) => [s.id, s]));
      const additions = options.updates
        .filter((u) => segById.has(u.id))
        .map((u) => ({
          sourceLocale: config.sourceLocale,
          targetLocale: options.targetLocale,
          source: segById.get(u.id)!.text,
          target: u.text,
          context: `Document ${path.basename(absSource)} (${segById.get(u.id)!.part})`,
          origin: "apply-document",
          updatedAt: now,
        }));
      for (const ev of evaluation.segments) {
        if (ev.manuallyEdited && ev.carriedTranslation && !incomingById.has(ev.segment.id)) {
          additions.push({
            sourceLocale: config.sourceLocale,
            targetLocale: options.targetLocale,
            source: ev.segment.text,
            target: ev.carriedTranslation,
            context: `Document ${path.basename(absSource)} (${ev.segment.part})`,
            origin: "manual-document",
            updatedAt: now,
          });
        }
      }
      if (additions.length > 0) {
        store.appendMemory(additions);
      }
    }
  }

  return res;
}

function buildCompactDocumentContext(
  extracted: ExtractedDocument,
  offset: number,
  limit: number,
  maxChars = 6000
): { text: string; truncated: boolean } {
  const segs = extracted.segments;
  if (extracted.fullDocumentContext.length <= maxChars) {
    return { text: extracted.fullDocumentContext, truncated: false };
  }
  // Include opening title/headings + local window surrounding the requested batch
  const winStart = Math.max(0, offset - 5);
  const winEnd = Math.min(segs.length, offset + limit + 5);
  const lines: string[] = [];
  if (winStart > 0) {
    lines.push(...segs.slice(0, Math.min(3, winStart)).map((s) => `[${s.id}] ${s.text}`));
    lines.push(`... (${winStart} preceding segments omitted for compactness) ...`);
  }
  lines.push(...segs.slice(winStart, winEnd).map((s) => `[${s.id}] ${s.text}`));
  if (winEnd < segs.length) {
    lines.push(`... (${segs.length - winEnd} following segments omitted for compactness) ...`);
  }
  const joined = lines.join("\n");
  return {
    text: joined.length > maxChars ? joined.slice(0, maxChars) + "\n..." : joined,
    truncated: true,
  };
}

/**
 * Prepare a document for translation with compact document-level context,
 * per-segment glossary hits, and advisory fuzzy memory matches.
 */
export function prepareDocument(
  rootDir: string,
  options: {
    documentPath: string;
    targetLocale: string;
    offset?: number;
    limit?: number;
  }
) {
  validateLocaleTag(options.targetLocale, "targetLocale");
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();
  const abs = resolveConfinedPath(rootDir, options.documentPath, { label: "documentPath" });
  const adapter = getDocumentAdapter(abs);
  if (!adapter) {
    throw new Error(`Unsupported document format: ${options.documentPath}`);
  }
  const extracted = adapter.extract(abs);
  const relSource = path.relative(store.rootDir, abs).replace(/\\/g, "/");
  const docState = readDocumentsState(store);
  const prior = docState.documents[relSource]?.[options.targetLocale];

  let absTarget: string | null = null;
  if (prior?.targetFile) {
    try {
      const candidate = resolveConfinedPath(store.rootDir, prior.targetFile, { label: "targetFile" });
      if (fs.existsSync(candidate)) absTarget = candidate;
    } catch {
      absTarget = null;
    }
  }

  const evaluation = inspectDocumentState(
    extracted,
    adapter,
    prior,
    absTarget,
    prior?.targetFile ?? null
  );

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const slice = evaluation.segments.slice(offset, offset + limit);
  const ctx = buildCompactDocumentContext(extracted, offset, limit);

  const resolvedStyle = resolveStyleGuide(store.rootDir, config, [options.targetLocale]);
  const baseDocumentGuidance =
    "Translate with full document-level coherence using fullDocumentContext below. Preserve every <x id=\"...\"/> and <g id=\"...\">...</g> inline tag verbatim. Treat fuzzyMatches (even 100%) as strong contextual suggestions to verify.";

  return {
    file: options.documentPath,
    format: extracted.format,
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    conventions: getLocaleConventions(options.targetLocale),
    documentGuidance: composeTranslationGuidance(baseDocumentGuidance, resolvedStyle),
    ...(resolvedStyle.hasAny ? { styleGuide: resolvedStyle } : {}),
    stats: extracted.stats,
    fullDocumentContext: ctx.text,
    contextTruncated: ctx.truncated,
    translatedSegments: evaluation.translatedCount,
    staleSegments: evaluation.staleCount,
    untranslatedSegments: evaluation.untranslatedCount,
    pendingSegments: evaluation.pendingCount,
    segments: slice.map((ev) => ({
      id: ev.segment.id,
      part: ev.segment.part,
      source: ev.segment.text,
      sourceHash: ev.sourceHash,
      contentKey: ev.contentKey,
      status: ev.status,
      ...(ev.carriedTranslation !== undefined ? { currentTranslation: ev.carriedTranslation } : {}),
      ...(ev.manuallyEdited ? { manuallyEdited: true } : {}),
      ...(ev.staleInfo
        ? {
            previousSource: ev.staleInfo.previousSource,
            previousTranslation: ev.staleInfo.previousTranslation,
          }
        : {}),
      tags: ev.segment.tags,
      ...(ev.segment.constraints ? { constraints: ev.segment.constraints } : {}),
      glossaryHits: matchGlossaryTerms(ev.segment.plainText, glossary.entries, options.targetLocale),
      fuzzyMatches: findFuzzyMatches(ev.segment.text, memory, {
        sourceLocale: config.sourceLocale,
        targetLocale: options.targetLocale,
        minScore: 55,
        limit: 3,
      }).map((m) => ({
        ...m,
        advisory:
          m.score >= 95
            ? "strong_suggestion_verify_context"
            : "partial_suggestion_verify_context",
      })),
    })),
    totalSegments: extracted.segments.length,
    offset,
    limit,
    hasMore: offset + slice.length < extracted.segments.length,
  };
}

export function scanDocumentsInProject(
  rootDir: string,
  docPaths: string[]
): DocumentScanSummary[] {
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const docState = readDocumentsState(store);
  const knownTargets = new Set<string>();
  for (const byLocale of Object.values(docState.documents)) {
    for (const rec of Object.values(byLocale)) {
      if (rec.targetFile) knownTargets.add(rec.targetFile);
    }
  }
  const targetLocaleSuffixes = config.targetLocales.map((l) => `.${l.toLowerCase()}.`);

  const summaries: DocumentScanSummary[] = [];
  for (const rel of docPaths) {
    let abs: string;
    try {
      abs = resolveConfinedPath(rootDir, rel, { label: "document path" });
    } catch {
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    const files: string[] = [];
    if (stat.isFile()) {
      files.push(abs);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        const child = path.join(abs, name);
        if (!fs.statSync(child).isFile() || !getDocumentAdapter(child)) continue;
        const childRel = path.relative(store.rootDir, child).replace(/\\/g, "/");
        if (knownTargets.has(childRel)) continue;
        const lowerName = name.toLowerCase();
        if (targetLocaleSuffixes.some((suf) => lowerName.includes(suf))) continue;
        files.push(child);
      }
    }
    for (const f of files) {
      const adapter = getDocumentAdapter(f);
      if (!adapter) continue;
      const doc = adapter.extract(f);
      summaries.push({
        file: path.relative(store.rootDir, f).replace(/\\/g, "/"),
        format: doc.format,
        segments: doc.stats.segmentCount,
        words: doc.stats.wordCount,
      });
    }
  }
  return summaries;
}
