import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { findFuzzyMatches, FuzzyMatch } from "./fuzzy.js";
import {
  AffectedKeyInfo,
  findAffectedKeysForTerm,
  GlossaryHit,
  matchGlossaryTerms,
} from "./glossary.js";
import { PolyglotStore } from "./store.js";
import { AssumptionCategory, GlossaryOrigin } from "./types.js";

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
  const store = new PolyglotStore(rootDir);
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

  const fuzzyMatches = options.targetLocale
    ? findFuzzyMatches(options.query, memory, {
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
    notes?: string;
    origin?: GlossaryOrigin;
  }
): UpsertGlossaryResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const { changed } = store.upsertGlossaryEntry({
    term: input.term,
    doNotTranslate: input.doNotTranslate ?? false,
    caseSensitive: input.caseSensitive ?? false,
    translations: input.translations ?? {},
    notes: input.notes,
    origin: input.origin ?? "user",
  });

  let affectedKeys: AffectedKeyInfo[] = [];
  let flaggedRecords = 0;

  if (changed) {
    const { adapter, detection } = detectProjectAdapter(
      store.rootDir,
      config.framework,
      config.paths.locales
    );
    if (adapter) {
      const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
      if (srcFiles.length > 0) {
        const srcCatalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
        const targetLocales =
          input.translations && Object.keys(input.translations).length > 0
            ? Object.keys(input.translations)
            : config.targetLocales;
        affectedKeys = findAffectedKeysForTerm(
          input.term,
          input.caseSensitive ?? false,
          srcCatalog.entries,
          targetLocales
        );

        // Flag existing records so prepare() and check() surface them for re-translation
        const records = store.readRecords();
        let mutated = false;
        for (const item of affectedKeys) {
          for (const loc of item.locales) {
            const rec = records.records[item.key]?.[loc];
            if (rec && rec.reviewStatus !== "flagged") {
              rec.reviewStatus = "flagged";
              flaggedRecords++;
              mutated = true;
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
  const store = new PolyglotStore(rootDir);
  return store.addAssumption(input);
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
  const store = new PolyglotStore(rootDir);
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
}
