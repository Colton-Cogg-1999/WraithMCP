import { detectProjectAdapter, loadLocaleCatalog, loadSourceCatalog } from "../adapters/registry.js";
import { findFuzzyMatches, FuzzyMatch } from "./fuzzy.js";
import { GlossaryHit, matchGlossaryTerms } from "./glossary.js";
import { getLocaleConventions, LocaleConventions } from "./locales.js";
import { reconcileMemoryWithLiveLocales } from "./memory-ops.js";
import { extractPlaceholders } from "./placeholders.js";
import { computeContextFingerprint, PolyglotStore, sha256Short } from "./store.js";
import { UsageFile, UsageSite } from "./types.js";

export type PrepareReason = "missing" | "stale_source" | "context_changed" | "requested" | "flagged";

export interface PreparedMemorySuggestion extends FuzzyMatch {
  advisory: "strong_suggestion_verify_context" | "partial_suggestion_verify_context";
  contextAlignment: "same_context" | "different_context" | "unknown";
  note: string;
}

export interface PreparedItem {
  key: string;
  source: string;
  sourcePlurals?: Record<string, string>;
  currentTarget?: string;
  reason: PrepareReason;
  placeholders: string[];
  hasPlurals: boolean;
  usageSites: UsageSite[];
  glossaryHits: GlossaryHit[];
  /**
   * Memory matches are provided strictly as context/suggestions, never blind auto-fills.
   * Even 100% lexical matches must be checked against the current component & surrounding UI.
   */
  fuzzyMatches: PreparedMemorySuggestion[];
  comment?: string;
}

export interface PrepareOptions {
  rootDir: string;
  targetLocale: string;
  keys?: string[];
  includeTranslated?: boolean;
  offset?: number;
  limit?: number;
}

export interface PrepareResult {
  sourceLocale: string;
  targetLocale: string;
  reviewMode: "auto" | "confirm";
  memoryGuidance: string;
  conventions: LocaleConventions;
  placeholderSyntaxes: string[];
  items: PreparedItem[];
  totalPending: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export function prepareBatch(options: PrepareOptions): PrepareResult {
  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();
  const records = store.readRecords();
  const usage = store.readUsage();

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const conventions = getLocaleConventions(options.targetLocale);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));

  if (!adapter) {
    return {
      sourceLocale: config.sourceLocale,
      targetLocale: options.targetLocale,
      reviewMode: config.review,
      memoryGuidance:
        "Treat all fuzzyMatches (including 100% lexical matches) as strong contextual suggestions rather than guaranteed-correct auto-fills. Always verify against usageSites, surrounding strings, and component purpose.",
      conventions,
      placeholderSyntaxes: detection.placeholderSyntaxes,
      items: [],
      totalPending: 0,
      offset,
      limit,
      hasMore: false,
    };
  }

  // Compute live usage sites read-only so prepare always reflects current component context
  let liveUsage: UsageFile = usage;
  const scanRes = adapter.scanSource(store.rootDir, {
    sourcePaths: config.paths.source,
    ignore: config.paths.ignore,
    i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
  });
  if (Object.keys(scanRes.usageByKey).length > 0) {
    liveUsage = { version: 1, keys: {} };
    for (const [k, sites] of Object.entries(scanRes.usageByKey)) {
      liveUsage.keys[k] = {
        fingerprint: computeContextFingerprint(sites),
        sites,
      };
    }
  }

  const srcCatalog = loadSourceCatalog(adapter, detection, config.sourceLocale);
  const tgtFiles = detection.localeFiles[options.targetLocale] ?? [];
  const tgtCatalog = loadLocaleCatalog(adapter, tgtFiles, options.targetLocale);
  const activeMemory = reconcileMemoryWithLiveLocales(
    store,
    config,
    memory,
    options.targetLocale,
    {
      records,
      srcCatalog,
      tgtCatalog,
      placeholderSyntaxes: detection.placeholderSyntaxes,
    }
  );

  const requestedKeys = options.keys && options.keys.length > 0 ? new Set(options.keys) : null;
  const allCandidates: PreparedItem[] = [];

  for (const [key, srcEntry] of srcCatalog.entries) {
    if (requestedKeys && !requestedKeys.has(key)) continue;

    const tgtEntry = tgtCatalog.entries.get(key);
    const rec = records.records[key]?.[options.targetLocale];
    const currentHash = sha256Short(
      srcEntry.plurals ? JSON.stringify(srcEntry.plurals) : srcEntry.value
    );
    const currentFp = liveUsage.keys[key]?.fingerprint ?? "";
    const liveSerialized = tgtEntry
      ? tgtEntry.plurals
        ? JSON.stringify(tgtEntry.plurals)
        : tgtEntry.value
      : "";
    const targetChangedManually = Boolean(rec && tgtEntry && rec.translation !== liveSerialized);
    const baselineHash = records.sourceBaselines?.[key];

    let reason: PrepareReason | null = null;
    if (!tgtEntry || tgtEntry.value.trim() === "" || tgtEntry.fuzzy) {
      reason = "missing";
    } else if (rec && rec.sourceHash !== currentHash && !targetChangedManually) {
      reason = "stale_source";
    } else if (!rec && baselineHash && baselineHash !== currentHash) {
      reason = "stale_source";
    } else if (rec && currentFp && rec.contextFingerprint && rec.contextFingerprint !== currentFp) {
      reason = "context_changed";
    } else if (rec?.reviewStatus === "flagged") {
      reason = "flagged";
    } else if (requestedKeys || options.includeTranslated) {
      reason = "requested";
    }

    if (!reason) continue;

    const extracted = extractPlaceholders(srcEntry.value, detection.placeholderSyntaxes);
    const glossaryHits = matchGlossaryTerms(
      srcEntry.value,
      glossary.entries,
      options.targetLocale
    );
    const rawFuzzyMatches = findFuzzyMatches(srcEntry.value, activeMemory, {
      sourceLocale: config.sourceLocale,
      targetLocale: options.targetLocale,
      minScore: 55,
      limit: 3,
    });

    const currentSites = (liveUsage.keys[key]?.sites ?? []).slice(0, 3);
    const currentContextStr = currentSites[0]
      ? `${currentSites[0].component ?? currentSites[0].file}${currentSites[0].element ? ` <${currentSites[0].element}>` : ""}`
      : "";

    const fuzzyMatches: PreparedMemorySuggestion[] = rawFuzzyMatches.map((m) => {
      const contextAlignment: PreparedMemorySuggestion["contextAlignment"] =
        !m.context || !currentContextStr
          ? "unknown"
          : m.context.toLowerCase() === currentContextStr.toLowerCase()
            ? "same_context"
            : "different_context";
      const isStrong = m.score >= 95;
      return {
        ...m,
        advisory: isStrong
          ? "strong_suggestion_verify_context"
          : "partial_suggestion_verify_context",
        contextAlignment,
        note:
          isStrong && contextAlignment === "different_context"
            ? `Exact text match (${m.score}%), but previously used in "${m.context}" vs current "${currentContextStr}". Strong suggestion — verify meaning still fits before reusing.`
            : isStrong
              ? `Strong suggestion (${m.score}% lexical match from ${m.origin}). Treat as high-confidence reference, not blind auto-fill; verify against current UI context.`
              : `Partial match (${m.score}%) for reference; adapt to source and UI context.`,
      };
    });

    allCandidates.push({
      key,
      source: srcEntry.value,
      sourcePlurals: srcEntry.plurals,
      currentTarget: tgtEntry?.value,
      reason,
      placeholders: extracted.names,
      hasPlurals: Object.keys(extracted.plurals).length > 0 || Boolean(srcEntry.plurals),
      usageSites: currentSites,
      glossaryHits,
      fuzzyMatches,
      comment: srcEntry.comment,
    });
  }

  // Prioritize: missing -> stale_source -> context_changed -> flagged -> requested
  const priority: Record<PrepareReason, number> = {
    missing: 0,
    stale_source: 1,
    context_changed: 2,
    flagged: 3,
    requested: 4,
  };
  allCandidates.sort(
    (a, b) => priority[a.reason] - priority[b.reason] || a.key.localeCompare(b.key)
  );

  const slice = allCandidates.slice(offset, offset + limit);
  return {
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    reviewMode: config.review,
    memoryGuidance:
      "Treat all fuzzyMatches (including 100% lexical matches) as strong contextual suggestions rather than guaranteed-correct auto-fills. Always verify against usageSites, surrounding strings, and component purpose.",
    conventions,
    placeholderSyntaxes: detection.placeholderSyntaxes,
    items: slice,
    totalPending: allCandidates.length,
    offset,
    limit,
    hasMore: offset + slice.length < allCandidates.length,
  };
}
