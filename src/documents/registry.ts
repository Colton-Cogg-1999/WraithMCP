import fs from "node:fs";
import path from "node:path";
import { findFuzzyMatches } from "../core/fuzzy.js";
import { matchGlossaryTerms } from "../core/glossary.js";
import { getLocaleConventions } from "../core/locales.js";
import { DocumentScanSummary } from "../core/scan.js";
import { resolveConfinedPath, SecurityBoundaryError, validateLocaleTag } from "../core/security.js";
import { PolyglotStore } from "../core/store.js";
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

  const extracted = adapter.extract(absSource);
  const res = adapter.apply(absSource, absTarget, options.updates, {
    targetLocale: options.targetLocale,
  });

  // Record document segment pairs into .polyglot/memory.jsonl automatically
  if (res.ok && res.segmentsUpdated > 0) {
    const store = new PolyglotStore(rootDir);
    const config = store.readConfig();
    const segById = new Map(extracted.segments.map((s) => [s.id, s]));
    const now = new Date().toISOString();
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
    if (additions.length > 0 && store.exists()) {
      store.appendMemory(additions);
    }
  }

  return res;
}

/**
 * Prepare a document for translation with FULL document-level context available,
 * plus per-segment glossary hits and advisory fuzzy memory matches.
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

  return {
    file: options.documentPath,
    format: extracted.format,
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    conventions: getLocaleConventions(options.targetLocale),
    documentGuidance:
      "Translate with full document-level coherence using fullDocumentContext below. Preserve every <x id=\"...\"/> and <g id=\"...\">...</g> inline tag verbatim. Treat fuzzyMatches (even 100%) as strong contextual suggestions to verify.",
    stats: extracted.stats,
    fullDocumentContext: extracted.fullDocumentContext,
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
  const summaries: DocumentScanSummary[] = [];
  for (const rel of docPaths) {
    const abs = path.resolve(rootDir, rel);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    const files: string[] = [];
    if (stat.isFile()) {
      files.push(abs);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        const child = path.join(abs, name);
        if (fs.statSync(child).isFile() && getDocumentAdapter(child)) {
          files.push(child);
        }
      }
    }
    for (const f of files) {
      const adapter = getDocumentAdapter(f);
      if (!adapter) continue;
      const doc = adapter.extract(f);
      summaries.push({
        file: path.relative(rootDir, f).replace(/\\/g, "/"),
        format: doc.format,
        segments: doc.stats.segmentCount,
        words: doc.stats.wordCount,
      });
    }
  }
  return summaries;
}
