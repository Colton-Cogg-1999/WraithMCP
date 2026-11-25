import fs from "node:fs";
import path from "node:path";
import { findFuzzyMatches } from "../core/fuzzy.js";
import { matchGlossaryTerms } from "../core/glossary.js";
import { getLocaleConventions } from "../core/locales.js";
import { DocumentScanSummary } from "../core/scan.js";
import {
  atomicWriteFileSync,
  resolveConfinedPath,
  SecurityBoundaryError,
  validateLocaleTag,
} from "../core/security.js";
import { PolyglotStore, sha256Short } from "../core/store.js";
import { DocxDocumentAdapter } from "./docx.js";
import { MarkdownDocumentAdapter } from "./markdown.js";
import {
  DocumentAdapter,
  DocumentApplyResult,
  DocumentTranslationUpdate,
  ExtractedDocument,
} from "./types.js";

const docAdapters: DocumentAdapter[] = [
  new DocxDocumentAdapter(),
  new MarkdownDocumentAdapter("markdown"),
  new MarkdownDocumentAdapter("mdx"),
];

export interface DocumentStateRecord {
  targetFile: string;
  sourceHash: string;
  totalSegments: number;
  translatedSegments: number;
  segments: Record<string, string>;
  updatedAt: string;
}

export interface DocumentsStateFile {
  version: 1;
  documents: Record<string, Record<string, DocumentStateRecord>>;
}

function readDocumentsState(store: PolyglotStore): DocumentsStateFile {
  const p = store.filePath("documents.json");
  if (!fs.existsSync(p)) return { version: 1, documents: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as DocumentsStateFile;
    return { version: 1, documents: parsed.documents ?? {} };
  } catch {
    return { version: 1, documents: {} };
  }
}

function writeDocumentsState(store: PolyglotStore, state: DocumentsStateFile): void {
  store.ensureDir();
  atomicWriteFileSync(store.filePath("documents.json"), JSON.stringify(state, null, 2) + "\n");
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
 * 3. Merges incoming batch updates with previously persisted segment translations
 *    for (sourceFile, targetLocale) in `.polyglot/documents.json` so multi-batch
 *    paginated translations NEVER lose earlier batches!
 * 4. Validates the entire merged operation before atomically writing the target file.
 */
export function applyDocumentTranslations(
  rootDir: string,
  options: {
    sourceFile: string;
    targetFile: string;
    targetLocale: string;
    updates: DocumentTranslationUpdate[];
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

  const store = new PolyglotStore(rootDir);
  const relSource = path.relative(store.rootDir, absSource).replace(/\\/g, "/");
  const relTarget = path.relative(store.rootDir, absTarget).replace(/\\/g, "/");
  const extracted = adapter.extract(absSource);
  const sourceHash = sha256Short(
    extracted.segments.map((s) => `${s.id}:${s.text}`).join("\n")
  );
  const validSegmentIds = new Set(extracted.segments.map((s) => s.id));

  // Merge prior batch translations (if target file still exists and source structure matches)
  const docState = readDocumentsState(store);
  const prior = docState.documents[relSource]?.[options.targetLocale];
  const mergedMap = new Map<string, string>();
  if (
    prior &&
    prior.targetFile === relTarget &&
    fs.existsSync(absTarget)
  ) {
    for (const [id, text] of Object.entries(prior.segments)) {
      if (validSegmentIds.has(id)) {
        mergedMap.set(id, text);
      }
    }
  }

  for (const u of options.updates) {
    mergedMap.set(u.id, u.text);
  }

  const mergedUpdates: DocumentTranslationUpdate[] = [...mergedMap.entries()].map(
    ([id, text]) => ({ id, text })
  );

  const res = adapter.apply(absSource, absTarget, mergedUpdates, {
    targetLocale: options.targetLocale,
  });

  if (res.ok) {
    const now = new Date().toISOString();
    // Persist merged segment state so subsequent batches accumulate cleanly and check() can verify coverage
    if (!docState.documents[relSource]) docState.documents[relSource] = {};
    const persistedSegments: Record<string, string> = {};
    for (const [id, text] of mergedMap) {
      persistedSegments[id] = text;
    }
    docState.documents[relSource][options.targetLocale] = {
      targetFile: relTarget,
      sourceHash,
      totalSegments: extracted.segments.length,
      translatedSegments: Object.keys(persistedSegments).length,
      segments: persistedSegments,
      updatedAt: now,
    };
    if (store.exists()) {
      writeDocumentsState(store, docState);
    }

    // Record incoming segment pairs into .polyglot/memory.jsonl automatically
    if (res.segmentsUpdated > 0 && store.exists()) {
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
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();
  const abs = resolveConfinedPath(rootDir, options.documentPath, { label: "documentPath" });
  const extracted = extractDocument(abs);

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
  const slice = extracted.segments.slice(offset, offset + limit);
  const ctx = buildCompactDocumentContext(extracted, offset, limit);

  return {
    file: options.documentPath,
    format: extracted.format,
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    conventions: getLocaleConventions(options.targetLocale),
    documentGuidance:
      "Translate with full document-level coherence using fullDocumentContext below. Preserve every <x id=\"...\"/> and <g id=\"...\">...</g> inline tag verbatim. Treat fuzzyMatches (even 100%) as strong contextual suggestions to verify.",
    stats: extracted.stats,
    fullDocumentContext: ctx.text,
    contextTruncated: ctx.truncated,
    segments: slice.map((seg) => ({
      id: seg.id,
      part: seg.part,
      source: seg.text,
      tags: seg.tags,
      glossaryHits: matchGlossaryTerms(seg.plainText, glossary.entries, options.targetLocale),
      fuzzyMatches: findFuzzyMatches(seg.text, memory, {
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
  const store = new PolyglotStore(rootDir);
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
