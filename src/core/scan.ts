import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { ConcatenationFinding, HardcodedStringFinding, ParseFailure } from "../adapters/types.js";
import { inferGlossaryCandidates, InferredGlossaryCandidate } from "./glossary.js";
import { computeContextFingerprint, PolyglotStore } from "./store.js";
import { UsageFile } from "./types.js";

export interface ScanOptions {
  rootDir: string;
  saveUsage?: boolean;
  offset?: number;
  limit?: number;
  fileFilter?: string;
}

export interface DocumentScanSummary {
  file: string;
  format: string;
  segments: number;
  words: number;
}

export interface ScanResult {
  framework: string;
  i18nLibrary: string | null;
  localesDir: string | null;
  detectedLocales: string[];
  sourceLocale: string;
  sourceKeys: number;
  filesScanned: number;
  counts: {
    hardcodedStrings: number;
    concatenations: number;
    trackedKeys: number;
    parseFailures: number;
    documents: number;
  };
  parseFailures: ParseFailure[];
  hardcodedStrings: {
    items: HardcodedStringFinding[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  concatenations: {
    items: ConcatenationFinding[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  glossaryCandidates: InferredGlossaryCandidate[];
  documents: DocumentScanSummary[];
  notes: string[];
}

export type DocumentScannerHook = (rootDir: string, docPaths: string[]) => DocumentScanSummary[];
let documentScannerHook: DocumentScannerHook | null = null;

export function registerDocumentScannerHook(hook: DocumentScannerHook): void {
  documentScannerHook = hook;
}

export function scanProject(options: ScanOptions): ScanResult {
  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  let filesScanned = 0;
  let hardcodedStrings: HardcodedStringFinding[] = [];
  let concatenations: ConcatenationFinding[] = [];
  let parseFailures: ParseFailure[] = [];
  let usageByKey: Record<string, UsageFile["keys"][string]["sites"]> = {};
  let sourceKeys = 0;
  const sourceValues: string[] = [];

  if (adapter) {
    const scanRes = adapter.scanSource(store.rootDir, {
      sourcePaths: config.paths.source,
      ignore: config.paths.ignore,
      i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
    });
    filesScanned = scanRes.filesScanned;
    hardcodedStrings = scanRes.hardcodedStrings;
    concatenations = scanRes.concatenations;
    parseFailures = scanRes.parseFailures ?? [];
    usageByKey = scanRes.usageByKey;

    const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
    if (srcFiles.length > 0) {
      const catalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
      sourceKeys = catalog.entries.size;
      for (const entry of catalog.entries.values()) {
        sourceValues.push(entry.value);
      }
    }
  }

  if (options.saveUsage !== false && Object.keys(usageByKey).length > 0) {
    const usageFile: UsageFile = { version: 1, keys: {} };
    for (const [key, sites] of Object.entries(usageByKey)) {
      usageFile.keys[key] = {
        fingerprint: computeContextFingerprint(sites),
        sites,
      };
    }
    store.writeUsage(usageFile);
  }

  const fileFilter = options.fileFilter;
  const filteredHardcoded = fileFilter
    ? hardcodedStrings.filter((h) => h.file.includes(fileFilter))
    : hardcodedStrings;
  const filteredConcats = fileFilter
    ? concatenations.filter((c) => c.file.includes(fileFilter))
    : concatenations;

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));

  const candidateInputs = [
    ...sourceValues,
    ...hardcodedStrings.map((h) => h.text),
  ];
  const glossaryCandidates = inferGlossaryCandidates(candidateInputs).slice(0, 12);

  const documents =
    documentScannerHook && config.paths.documents.length > 0
      ? documentScannerHook(store.rootDir, config.paths.documents)
      : [];

  const parseNotes = parseFailures.map(
    (pf) => `Parse failure in ${pf.file}: ${pf.error}`
  );

  return {
    framework: detection.framework,
    i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
    localesDir: detection.localesDir,
    detectedLocales: Object.keys(detection.localeFiles).sort(),
    sourceLocale: config.sourceLocale,
    sourceKeys,
    filesScanned,
    counts: {
      hardcodedStrings: hardcodedStrings.length,
      concatenations: concatenations.length,
      trackedKeys: Object.keys(usageByKey).length,
      parseFailures: parseFailures.length,
      documents: documents.length,
    },
    parseFailures: parseFailures.slice(0, limit),
    hardcodedStrings: {
      items: filteredHardcoded.slice(offset, offset + limit),
      total: filteredHardcoded.length,
      offset,
      limit,
      hasMore: offset + limit < filteredHardcoded.length,
    },
    concatenations: {
      items: filteredConcats.slice(offset, offset + limit),
      total: filteredConcats.length,
      offset,
      limit,
      hasMore: offset + limit < filteredConcats.length,
    },
    glossaryCandidates,
    documents,
    notes: [
      ...detection.notes.map((n) => n.replace(store.rootDir + path.sep, "")),
      ...parseNotes,
    ],
  };
}
