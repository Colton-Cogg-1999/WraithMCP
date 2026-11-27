import { detectProjectAdapter, loadLocaleCatalog, loadSourceCatalog } from "../adapters/registry.js";
import { findFuzzyMatches, FuzzyMatch } from "./fuzzy.js";
import { GlossaryHit, matchGlossaryTerms } from "./glossary.js";
import { getLocaleConventions, LocaleConventions } from "./locales.js";
import { reconcileMemoryWithLiveLocales } from "./memory-ops.js";
import { projectDecisions, CharLimit, ContextNoteStatus, contextNoteFor, isBindingCharLimit, listQuestions, questionsFor, readContextNotes, resolveCharLimit, visibleCharCount } from "./context.js";
import { extractPlaceholders } from "./placeholders.js";
import { composeTranslationGuidance, ResolvedStyleGuide, resolveStyleGuide } from "./style-guide.js";
import { computeContextFingerprint, WraithStore, sha256Short } from "./store.js";
import { UsageFile, UsageSite } from "./types.js";

export type PrepareReason = "missing" | "stale_source" | "question_answered" | "context_changed" | "layout_budget_exceeded" | "char_limit_exceeded" | "char_limit_inferred" | "requested" | "flagged";

export interface PreparedLayoutInfo {
  element?: string;
  constraint?: string;
  budgetChars?: number;
  maxWidthPx?: number;
  approvedAbbreviations?: Record<string, string>;
}

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
  advisoryPluralCategories?: Intl.LDMLPluralRule[];
  usageSites: UsageSite[];
  layout?: PreparedLayoutInfo;
  /** Plain-language meaning of the source. "missing"/"stale": write one (apply contextNote) after reading the code. */
  contextNote?: string;
  contextNoteStatus: ContextNoteStatus;
  /** Declared limits are binding; inferred ones are a budget to shorten toward. */
  charLimit?: CharLimit;
  /** Open Questions and Answers about this string. Answers are binding context. */
  questions?: Array<{ id: string; status: "open" | "answered" | "resolved"; question: string; answer?: string }>;
  glossaryHits: GlossaryHit[];
  /**
   * Memory matches are provided strictly as context/suggestions, never blind auto-fills.
   * Even 100% lexical matches must be checked against the current component & surrounding UI.
   */
  fuzzyMatches: PreparedMemorySuggestion[];
  comment?: string;
}

export const CONTEXT_GUIDANCE =
  "Check usageSites when a string is short, ambiguous, or UI-constrained. Pass an optional contextNote to apply only for genuinely ambiguous or domain-specific keys worth clarifying for future translators (not needed for self-explanatory strings). Respect charLimit: declared (config) and rendered (measured UI width) limits are binding errors in check; heuristic element budgets are advisory. Treat human Answers in questions as binding; file an Open Question (memory add_question) only when code cannot settle meaning.";

export interface PrepareOptions {
  rootDir: string;
  targetLocale: string;
  keys?: string[];
  includeTranslated?: boolean;
  /** Skip O(N*M) fuzzy memory matching (e.g. internal QE collection that does not use fuzzyMatches). */
  skipFuzzy?: boolean;
  /** Payload detail level: "full" (default for programmatic API) or "compact" (lean payload for agents). */
  detail?: "compact" | "full";
  offset?: number;
  limit?: number;
}

export interface PrepareResult {
  sourceLocale: string;
  targetLocale: string;
  reviewMode: "auto" | "confirm";
  memoryGuidance: string;
  contextGuidance: string;
  /** Active project style guide and additive prompt, when configured. */
  styleGuide?: ResolvedStyleGuide;
  /** Recorded assumptions (A1…) and human overrides; a human override is binding. */
  projectDecisions: ReturnType<typeof projectDecisions>;
  conventions: LocaleConventions;
  placeholderSyntaxes: string[];
  items: PreparedItem[];
  totalPending: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export function prepareBatch(options: PrepareOptions): PrepareResult {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();
  const records = store.readRecords();
  const usage = store.readUsage();
  const layoutState = store.readLayout();
  const contextNotes = readContextNotes(store.rootDir);
  const allQuestions = listQuestions(store.rootDir);

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const resolvedStyle = resolveStyleGuide(store.rootDir, config, [options.targetLocale]);
  const composedGuidance = composeTranslationGuidance(CONTEXT_GUIDANCE, resolvedStyle);

  const conventions = getLocaleConventions(options.targetLocale);
  const offset = Math.max(0, options.offset ?? 0);
  const maxLimit = options.skipFuzzy ? 50_000 : 300;
  const limit = Math.max(1, Math.min(options.limit ?? 100, maxLimit));
  const compactFollowup = offset > 0;

  if (!adapter) {
    return {
      sourceLocale: config.sourceLocale,
      targetLocale: options.targetLocale,
      reviewMode: config.review,
      memoryGuidance:
        "Treat all fuzzyMatches (including 100% lexical matches) as strong contextual suggestions rather than guaranteed-correct auto-fills. Always verify against usageSites, surrounding strings, and component purpose.",
      contextGuidance: composedGuidance,
      ...(resolvedStyle.hasAny ? { styleGuide: resolvedStyle } : {}),
      projectDecisions: projectDecisions(store.rootDir, [options.targetLocale]),
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

  // Build key -> static layout risk constraint map from scanRes.layoutRisks
  const staticConstraintByKey = new Map<string, string>();
  for (const lr of scanRes.layoutRisks ?? []) {
    if (lr.key && !staticConstraintByKey.has(lr.key)) {
      staticConstraintByKey.set(lr.key, lr.constraint);
    }
  }

  const requestedKeys = options.keys && options.keys.length > 0 ? new Set(options.keys) : null;
  const allCandidates: PreparedItem[] = [];

  for (const [key, srcEntry] of srcCatalog.entries) {
    if (requestedKeys && !requestedKeys.has(key)) continue;

    const tgtEntry = tgtCatalog.entries.get(key);
    const rec = records.records[key]?.[options.targetLocale];
    const layoutBudget = layoutState.budgets[key]?.[options.targetLocale];
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

    const keyQuestions = questionsFor(allQuestions, key, options.targetLocale);
    const keySites = liveUsage.keys[key]?.sites ?? [];
    const charLimit = resolveCharLimit({
      config,
      layout: layoutState,
      key,
      locale: options.targetLocale,
      source: srcEntry.value,
      elements: keySites.map((s) => s.element),
    });
    const overLimit = Boolean(charLimit && tgtEntry && visibleCharCount(tgtEntry.value) > charLimit.maxChars);
    const overBindingLimit = Boolean(overLimit && charLimit && isBindingCharLimit(charLimit));

    let reason: PrepareReason | null = null;
    if (!tgtEntry || tgtEntry.value.trim() === "" || tgtEntry.fuzzy) {
      reason = "missing";
    } else if (rec && rec.sourceHash !== currentHash && !targetChangedManually) {
      reason = "stale_source";
    } else if (!rec && baselineHash && baselineHash !== currentHash) {
      reason = "stale_source";
    } else if (keyQuestions.some((q) => q.status === "answered")) {
      reason = "question_answered";
    } else if (rec && currentFp && rec.contextFingerprint && rec.contextFingerprint !== currentFp) {
      reason = "context_changed";
    } else if (overBindingLimit) {
      reason = charLimit!.basis === "rendered" ? "layout_budget_exceeded" : "char_limit_exceeded";
    } else if (rec?.reviewStatus === "flagged") {
      reason = "flagged";
    } else if (overLimit && (requestedKeys || options.includeTranslated)) {
      reason = "char_limit_inferred";
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
    const rawFuzzyMatches = options.skipFuzzy
      ? []
      : findFuzzyMatches(srcEntry.value, activeMemory, {
          sourceLocale: config.sourceLocale,
          targetLocale: options.targetLocale,
          minScore: 55,
          limit: 3,
        });

    const currentSites = (liveUsage.keys[key]?.sites ?? []).slice(0, 3);
    const currentContextStr = currentSites[0]
      ? `${currentSites[0].component ?? currentSites[0].file}${currentSites[0].element ? ` <${currentSites[0].element}>` : ""}`
      : "";

    const staticConstraint = staticConstraintByKey.get(key);
    const approvedAbbreviations: Record<string, string> = {};
    for (const hit of glossaryHits) {
      const ge = glossary.entries.find((e) => e.term.toLowerCase() === hit.term.toLowerCase());
      const abbr = ge?.abbreviations?.[options.targetLocale];
      if (abbr) approvedAbbreviations[hit.term] = abbr;
    }
    const layoutInfo: PreparedLayoutInfo | undefined =
      layoutBudget || staticConstraint || Object.keys(approvedAbbreviations).length > 0
        ? {
            element: layoutBudget?.element ?? currentSites[0]?.element,
            constraint: layoutBudget?.constraint ?? staticConstraint,
            ...(layoutBudget
              ? { budgetChars: layoutBudget.budgetChars, maxWidthPx: layoutBudget.maxWidthPx }
              : {}),
            ...(Object.keys(approvedAbbreviations).length > 0 ? { approvedAbbreviations } : {}),
          }
        : undefined;

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

    const hasPlurals = Object.keys(extracted.plurals).length > 0 || Boolean(srcEntry.plurals);
    allCandidates.push({
      key,
      source: srcEntry.value,
      sourcePlurals: srcEntry.plurals,
      currentTarget: tgtEntry?.value,
      reason,
      placeholders: extracted.names,
      hasPlurals,
      ...(hasPlurals && conventions.advisoryPluralCategories.length > 0
        ? { advisoryPluralCategories: conventions.advisoryPluralCategories }
        : {}),
      usageSites: currentSites,
      ...(layoutInfo ? { layout: layoutInfo } : {}),
      ...(() => {
        const cn = contextNoteFor(contextNotes, key, srcEntry.value);
        return { ...(cn.note ? { contextNote: cn.note } : {}), contextNoteStatus: cn.status };
      })(),
      ...(charLimit ? { charLimit } : {}),
      ...(keyQuestions.length > 0
        ? { questions: keyQuestions.map((q) => ({ id: q.id, status: q.status, question: q.question, ...(q.answer ? { answer: q.answer } : {}) })) }
        : {}),
      glossaryHits,
      fuzzyMatches,
      comment: srcEntry.comment,
    });
  }

  // Prioritize: missing -> stale_source -> question_answered -> layout_budget_exceeded/char_limit_exceeded -> context_changed -> flagged -> char_limit_inferred -> requested
  const priority: Record<PrepareReason, number> = {
    missing: 0,
    stale_source: 1,
    question_answered: 2,
    layout_budget_exceeded: 3,
    char_limit_exceeded: 3,
    context_changed: 4,
    flagged: 5,
    char_limit_inferred: 6,
    requested: 7,
  };
  allCandidates.sort(
    (a, b) => priority[a.reason] - priority[b.reason] || a.key.localeCompare(b.key)
  );

  const slice = allCandidates.slice(offset, offset + limit);
  return {
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    reviewMode: config.review,
    memoryGuidance: compactFollowup
      ? "Same memory guidance as offset=0."
      : "Treat all fuzzyMatches (including 100% lexical matches) as strong contextual suggestions rather than guaranteed-correct auto-fills. Always verify against usageSites, surrounding strings, and component purpose.",
    contextGuidance: compactFollowup ? "Same context guidance as offset=0." : composedGuidance,
    ...(!compactFollowup && resolvedStyle.hasAny ? { styleGuide: resolvedStyle } : {}),
    projectDecisions: compactFollowup ? [] : projectDecisions(store.rootDir, [options.targetLocale]),
    conventions,
    placeholderSyntaxes: detection.placeholderSyntaxes,
    items: slice,
    totalPending: allCandidates.length,
    offset,
    limit,
    hasMore: offset + slice.length < allCandidates.length,
  };
}

/**
 * Strip empty arrays, redundant defaults, and repeated header metadata for lean MCP responses.
 * Preserves all actionable signals (source, placeholders, plurals, usage sites, glossary, TM, limits, style).
 */
export function compactPrepareResult(result: PrepareResult): Record<string, unknown> {
  const isFollowup = result.offset > 0;
  const compactItems = result.items.map((item) => {
    const out: Record<string, unknown> = {
      key: item.key,
      source: item.source,
      reason: item.reason,
    };
    if (item.sourcePlurals) out.sourcePlurals = item.sourcePlurals;
    if (item.currentTarget !== undefined) out.currentTarget = item.currentTarget;
    if (item.placeholders.length > 0) out.placeholders = item.placeholders;
    if (item.hasPlurals) out.hasPlurals = true;
    if (item.advisoryPluralCategories && item.advisoryPluralCategories.length > 0) {
      out.advisoryPluralCategories = item.advisoryPluralCategories;
    }
    if (item.usageSites.length > 0) {
      const keepSurrounding = item.source.trim().length <= 24;
      out.usageSites = item.usageSites.map((s) => ({
        file: s.file,
        line: s.line,
        ...(s.component ? { component: s.component } : {}),
        ...(s.element ? { element: s.element } : {}),
        ...(keepSurrounding && s.surrounding.length > 0 ? { surrounding: s.surrounding } : {}),
      }));
    }
    if (item.layout) out.layout = item.layout;
    if (item.contextNote) {
      out.contextNote = item.contextNote;
      if (item.contextNoteStatus !== "current") out.contextNoteStatus = item.contextNoteStatus;
    }
    if (item.charLimit) out.charLimit = item.charLimit;
    if (item.questions && item.questions.length > 0) out.questions = item.questions;
    if (item.glossaryHits.length > 0) out.glossaryHits = item.glossaryHits;
    if (item.fuzzyMatches.length > 0) {
      out.fuzzyMatches = item.fuzzyMatches.map((m) => ({
        source: m.source,
        target: m.target,
        score: m.score,
        origin: m.origin,
        ...(m.context ? { context: m.context } : {}),
        advisory: m.advisory,
        contextAlignment: m.contextAlignment,
      }));
    }
    if (item.comment) out.comment = item.comment;
    return out;
  });

  const payload: Record<string, unknown> = {
    sourceLocale: result.sourceLocale,
    targetLocale: result.targetLocale,
    ...(isFollowup
      ? {}
      : {
          reviewMode: result.reviewMode,
          memoryGuidance: result.memoryGuidance,
          contextGuidance: result.contextGuidance,
          ...(result.styleGuide ? { styleGuide: result.styleGuide } : {}),
          ...(result.projectDecisions.length > 0 ? { projectDecisions: result.projectDecisions } : {}),
          conventions: result.conventions,
          placeholderSyntaxes: result.placeholderSyntaxes,
        }),
    items: compactItems,
    totalPending: result.totalPending,
    offset: result.offset,
    limit: result.limit,
    hasMore: result.hasMore,
  };
  return payload;
}
