import { detectProjectAdapter, LoadedLocaleCatalog, loadLocaleCatalog, loadSourceCatalog } from "../adapters/registry.js";
import { PlaceholderSyntax } from "../formats/types.js";
import { findFuzzyMatches, FuzzyMatch } from "./fuzzy.js";
import {
  AffectedKeyInfo,
  findAffectedKeysForTerm,
  GlossaryHit,
  matchGlossaryTerms,
} from "./glossary.js";
import { validateTranslationString } from "./placeholders.js";
import { withWorkspaceLock } from "./security.js";
import { WraithStore, sha256Short } from "./store.js";
import { AssumptionCategory, GlossaryOrigin, MemoryEntry, WraithConfig, RecordsFile } from "./types.js";

/**
 * Reconcile persisted memory against authoritative live target locale files (L2, N4/MT5):
 * - Excludes superseded old agent translations whose recorded target was manually overwritten.
 * - Promotes valid live manual corrections (`origin: "manual"`) so they rank above stale agent text.
 */
export function reconcileMemoryWithLiveLocales(
  store: WraithStore,
  config: WraithConfig,
  memory: readonly MemoryEntry[],
  targetLocale: string,
  preloaded?: {
    records?: RecordsFile;
    srcCatalog?: LoadedLocaleCatalog;
    tgtCatalog?: LoadedLocaleCatalog;
    placeholderSyntaxes?: readonly PlaceholderSyntax[];
  }
): MemoryEntry[] {
  const records = preloaded?.records ?? store.readRecords();
  let srcCatalog = preloaded?.srcCatalog;
  let tgtCatalog = preloaded?.tgtCatalog;
  let syntaxes = preloaded?.placeholderSyntaxes;

  if (!srcCatalog || !tgtCatalog || !syntaxes) {
    const { adapter, detection } = detectProjectAdapter(
      store.rootDir,
      config.framework,
      config.paths.locales
    );
    if (!adapter) return [...memory];
    const tgtFiles = detection.localeFiles[targetLocale] ?? [];
    if (tgtFiles.length === 0) return [...memory];
    srcCatalog = srcCatalog ?? loadSourceCatalog(adapter, detection, config.sourceLocale);
    tgtCatalog = tgtCatalog ?? loadLocaleCatalog(adapter, tgtFiles, targetLocale);
    syntaxes = syntaxes ?? detection.placeholderSyntaxes;
  }

  const activeLivePairs = new Set<string>();
  const supersededTargets = new Set<string>();
  const manualAdditions: MemoryEntry[] = [];
  const now = new Date().toISOString();

  for (const [key, liveTgt] of tgtCatalog.entries) {
    const liveSrc = srcCatalog.entries.get(key);
    if (!liveSrc || !liveTgt.value.trim() || liveTgt.fuzzy) continue;
    activeLivePairs.add(`${liveSrc.value}\0${liveTgt.value}`);

    const rec = records.records[key]?.[targetLocale];
    const liveSerialized = liveTgt.plurals ? JSON.stringify(liveTgt.plurals) : liveTgt.value;
    if (rec && rec.translation !== liveSerialized) {
      supersededTargets.add(`${liveSrc.value}\0${rec.translation}`);
      // Only promote the live manual edit into suggestions if its placeholders/syntax are valid
      const problems = validateTranslationString(
        liveSrc.value,
        liveTgt.value,
        targetLocale,
        syntaxes,
        { sourcePlurals: liveSrc.plurals, targetPlurals: liveTgt.plurals }
      );
      if (problems.length === 0) {
        manualAdditions.push({
          sourceLocale: config.sourceLocale,
          targetLocale,
          source: liveSrc.value,
          target: liveTgt.value,
          origin: "manual",
          updatedAt: now,
        });
      }
    }
  }

  const filtered = memory.filter((m) => {
    const pairKey = `${m.source}\0${m.target}`;
    if (supersededTargets.has(pairKey) && !activeLivePairs.has(pairKey)) {
      return false;
    }
    return true;
  });

  return [...manualAdditions, ...filtered];
}

export interface MemoryLookupResult {
  query: string;
  targetLocale?: string;
  guidance: string;
  glossaryHits: GlossaryHit[];
  fuzzyMatches: Array<FuzzyMatch & { advisory: string }>;
  totalMemoryEntries: number;
  totalGlossaryEntries: number;
}

export function lookupMemory(
  rootDir: string,
  options: {
    query: string;
    targetLocale?: string;
    minScore?: number;
    limit?: number;
  }
): MemoryLookupResult {
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();

  const glossaryHits = matchGlossaryTerms(
    options.query,
    glossary.entries,
    options.targetLocale
  );

  // Also include partial substring glossary matches when querying a single term
  const qLower = options.query.trim().toLowerCase();
  for (const entry of glossary.entries) {
    if (
      qLower &&
      entry.term.toLowerCase().includes(qLower) &&
      !glossaryHits.some((h) => h.term === entry.term)
    ) {
      glossaryHits.push({
        term: entry.term,
        doNotTranslate: entry.doNotTranslate,
        preferredTranslation: options.targetLocale
          ? entry.translations[options.targetLocale]
          : undefined,
        notes: entry.notes,
        origin: entry.origin,
      });
    }
  }

  // Reconcile memory against authoritative locale files (L2, N4/MT5)
  const activeMemory = options.targetLocale
    ? reconcileMemoryWithLiveLocales(store, config, memory, options.targetLocale)
    : memory;

  const fuzzyMatches = options.targetLocale
    ? findFuzzyMatches(options.query, activeMemory, {
        sourceLocale: config.sourceLocale,
        targetLocale: options.targetLocale,
        minScore: options.minScore ?? 50,
        limit: options.limit ?? 10,
      }).map((m) => ({
        ...m,
        advisory:
          m.score >= 95
            ? "Strong suggestion — verify against current component/UI context before reusing."
            : "Reference match — adapt to current context.",
      }))
    : [];

  return {
    query: options.query,
    targetLocale: options.targetLocale,
    guidance:
      "Treat even 100% lexical matches as strong suggestions with prior context, not guaranteed-correct translations.",
    glossaryHits: glossaryHits.slice(0, options.limit ?? 10),
    fuzzyMatches,
    totalMemoryEntries: memory.length,
    totalGlossaryEntries: glossary.entries.length,
  };
}

export interface UpsertGlossaryResult {
  term: string;
  changed: boolean;
  affectedKeys: AffectedKeyInfo[];
  flaggedRecords: number;
}

/**
 * Record or update a glossary entry and propagate changes to every affected key
 * across target locales by flagging their records and returning the affected list.
 */
export function recordGlossaryTerm(
  rootDir: string,
  input: {
    term: string;
    doNotTranslate?: boolean;
    caseSensitive?: boolean;
    translations?: Record<string, string>;
    abbreviations?: Record<string, string>;
    notes?: string;
    origin?: GlossaryOrigin;
  }
): UpsertGlossaryResult {
  return withWorkspaceLock(rootDir, () => recordGlossaryTermUnlocked(rootDir, input));
}

function recordGlossaryTermUnlocked(
  rootDir: string,
  input: {
    term: string;
    doNotTranslate?: boolean;
    caseSensitive?: boolean;
    translations?: Record<string, string>;
    abbreviations?: Record<string, string>;
    notes?: string;
    origin?: GlossaryOrigin;
  }
): UpsertGlossaryResult {
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  // O1: Pass undefined when omitted so upsertGlossaryEntry preserves previous doNotTranslate/caseSensitive!
  const { changed, glossary } = store.upsertGlossaryEntry({
    term: input.term,
    doNotTranslate: input.doNotTranslate,
    caseSensitive: input.caseSensitive,
    translations: input.translations,
    abbreviations: input.abbreviations,
    notes: input.notes,
    origin: input.origin,
  });

  const savedEntry = glossary.entries.find(
    (e) => e.term.toLowerCase() === input.term.toLowerCase()
  );

  let affectedKeys: AffectedKeyInfo[] = [];
  let flaggedRecords = 0;

  if (changed) {
    const { adapter, detection } = detectProjectAdapter(
      store.rootDir,
      config.framework,
      config.paths.locales
    );
    if (adapter) {
      const srcCatalog = loadSourceCatalog(adapter, detection, config.sourceLocale);
      if (srcCatalog.entries.size > 0) {
        const targetLocales =
          input.translations && Object.keys(input.translations).length > 0
            ? Object.keys(input.translations)
            : config.targetLocales;
        affectedKeys = findAffectedKeysForTerm(
          input.term,
          savedEntry?.caseSensitive ?? false,
          srcCatalog.entries,
          targetLocales
        );

        // Flag BOTH existing records AND keys translated manually outside apply() (O2)!
        const records = store.readRecords();
        const now = new Date().toISOString();
        let mutated = false;
        const tgtCatalogs = new Map<string, ReturnType<typeof loadLocaleCatalog>>();
        for (const loc of targetLocales) {
          const files = detection.localeFiles[loc] ?? [];
          tgtCatalogs.set(loc, loadLocaleCatalog(adapter, files, loc));
        }

        for (const item of affectedKeys) {
          for (const loc of item.locales) {
            const rec = records.records[item.key]?.[loc];
            if (rec) {
              if (rec.reviewStatus !== "flagged") {
                rec.reviewStatus = "flagged";
                flaggedRecords++;
                mutated = true;
              }
            } else {
              const tgtEntry = tgtCatalogs.get(loc)?.entries.get(item.key);
              if (tgtEntry && tgtEntry.value.trim()) {
                if (!records.records[item.key]) records.records[item.key] = {};
                records.records[item.key][loc] = {
                  sourceHash: sha256Short(item.source),
                  contextFingerprint: "",
                  translation: tgtEntry.value,
                  updatedAt: now,
                  origin: "imported",
                  reviewStatus: "flagged",
                };
                flaggedRecords++;
                mutated = true;
              }
            }
          }
        }
        if (mutated) {
          store.writeRecords(records);
        }
      }
    }
  }

  return {
    term: input.term,
    changed,
    affectedKeys,
    flaggedRecords,
  };
}

export function recordAssumption(
  rootDir: string,
  input: {
    category: AssumptionCategory;
    locale?: string;
    summary: string;
    rationale?: string;
  }
) {
  return withWorkspaceLock(rootDir, () => new WraithStore(rootDir).addAssumption(input));
}

export function recordMemoryPair(
  rootDir: string,
  input: {
    source: string;
    target: string;
    targetLocale: string;
    sourceLocale?: string;
    context?: string;
    origin?: string;
  }
): { added: number; total: number } {
  return withWorkspaceLock(rootDir, () => {
    const store = new WraithStore(rootDir);
    const config = store.readConfig();
    const added = store.appendMemory([
      {
        sourceLocale: input.sourceLocale ?? config.sourceLocale,
        targetLocale: input.targetLocale,
        source: input.source,
        target: input.target,
        context: input.context,
        origin: input.origin ?? "correction",
        updatedAt: new Date().toISOString(),
      },
    ]);
    return { added, total: store.readMemory().length };
  });
}
