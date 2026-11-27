import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { runCheck } from "./check.js";
import { contextNoteFor, LabeledAssumption, latestAnswerAt, listAssumptions, listQuestions, Question, readContextNotes } from "./context.js";
import { qeIndex, QeStatus, qeStatusOf } from "./qe.js";
import { currentRunStart, Mitigation, mitigationsSince, normalizeSince, readRunLog } from "./run-log.js";
import { WraithStore } from "./store.js";
import { CheckIssue } from "./types.js";

/* ------------------------------------------------------------------------------------------------
 * End-of-run report: what was translated, what still needs attention, what was caught and fixed,
 * what is still ambiguous, and what the agent assumed. Every Open Question (Q1…) and assumption
 * (A1…) carries an ID the user can reply to. Read-only.
 * ---------------------------------------------------------------------------------------------- */

export interface ReviewRecommendation {
  key: string;
  locale: string;
  source: string;
  translation: string;
  reason: string;
  context?: string;
}

export interface FlaggedString {
  locale: string;
  key: string;
  source: string;
  translation: string;
  by: "check" | "qe";
  why: string;
  severity?: "critical" | "major" | "minor";
  category?: string;
  evidence?: string;
  visualEvidence?: string;
  suggestedFix?: string;
}

export interface IntentionalVariant {
  locale: string;
  source: string;
  items: Array<{ key: string; translation: string; contextNote?: string }>;
}

export interface LocalizationReport {
  generatedAt: string;
  framework: string;
  sourceLocale: string;
  targetLocales: string[];
  checkPassed: boolean;
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
  /** Start of the run the "this run" figures cover (after an hour of inactivity a new run starts). */
  runStartedAt?: string;
  summary: {
    totalSourceKeys: number;
    errorCount: number;
    warningCount: number;
    issuesByCategory: Record<string, number>;
    assumptionsMade: number;
    stringsToReview: number;
    flagged: number;
    mitigated: number;
    openQuestions: number;
    pendingFollowUps: number;
  };
  translated: Array<{ locale: string; translated: number; total: number; changedThisRun: number; qe: Record<QeStatus, number> }>;
  flagged: FlaggedString[];
  mitigations: Mitigation[];
  questions: Question[];
  assumptions: LabeledAssumption[];
  intentionalVariants: IntentionalVariant[];
  reviewList: ReviewRecommendation[];
  markdown: string;
}

const AMBIGUOUS_UI_TERMS = new Set([
  "post", "open", "close", "save", "share", "plan", "home", "free", "lead", "charge",
  "draft", "issue", "book", "run", "match", "check", "order", "view", "file", "bill",
]);

// Escape Markdown table/line breaks and insert zero-width joiner in @mentions so PR comments never ping GitHub users.
const esc = (s: string) =>
  s
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .replace(/@([a-zA-Z0-9_-])/g, "@\u200B$1");

export function generateReport(rootDir: string, options: { since?: string } = {}): LocalizationReport {
  const normalizedSince = normalizeSince(options.since);
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const reviewsFile = store.readReviews();
  const usage = store.readUsage();
  const check = runCheck({ rootDir, limit: 10_000 });
  const assumptions = listAssumptions(rootDir);
  const allQuestions = listQuestions(rootDir);
  const questions = allQuestions.filter((q) => q.status !== "resolved");
  const notes = readContextNotes(rootDir);
  const verdicts = qeIndex(rootDir);
  const events = readRunLog(rootDir);
  const runStartedAt = normalizedSince ?? currentRunStart(events);
  const runStartedMs = runStartedAt ? Date.parse(runStartedAt) : undefined;
  const mitigations = mitigationsSince(events, runStartedAt);

  const { adapter, detection } = detectProjectAdapter(store.rootDir, config.framework, config.paths.locales);
  const srcCatalog = adapter ? loadLocaleCatalog(adapter, detection.localeFiles[config.sourceLocale] ?? [], config.sourceLocale) : null;
  const tgtCatalogs = new Map<string, ReturnType<typeof loadLocaleCatalog> | null>();
  for (const locale of check.targetLocales) {
    tgtCatalogs.set(locale, adapter ? loadLocaleCatalog(adapter, detection.localeFiles[locale] ?? [], locale) : null);
  }
  const siteOf = (key: string) => {
    const s = usage.keys[key]?.sites[0];
    return s ? `${s.file}:${s.line} (${s.component ?? s.element ?? ""})` : undefined;
  };

  const translated: LocalizationReport["translated"] = [];
  const flagged: FlaggedString[] = [];
  const intentionalVariants: IntentionalVariant[] = [];
  const reviewList: ReviewRecommendation[] = [];
  const seenReview = new Set<string>();
  const addReview = (r: ReviewRecommendation) => {
    const id = `${r.locale}|${r.key}`;
    if (seenReview.has(id)) return;
    seenReview.add(id);
    reviewList.push(r);
  };

  for (const locale of check.targetLocales) {
    const tgt = tgtCatalogs.get(locale) ?? null;
    const source = (key: string) => srcCatalog?.entries.get(key)?.value ?? "";
    const target = (key: string) => tgt?.entries.get(key)?.value ?? "";
    const qeOf = (key: string): QeStatus =>
      qeStatusOf(verdicts.get(`${locale}\0${key}`), source(key), tgt?.entries.get(key)?.value, latestAnswerAt(allQuestions, key, locale));
    const issues = check.issues.items.filter((i) => i.locale === locale);

    // Translated + QE coverage
    const qeCounts: Record<QeStatus, number> = { ok: 0, flagged: 0, unreviewed: 0, "human-verified": 0 };
    if (srcCatalog && tgt) for (const key of srcCatalog.entries.keys()) if (target(key)) qeCounts[qeOf(key)]++;
    const changed = new Set(
      events
        .filter((e) => e.type === "applied" && e.locale === locale && (runStartedMs === undefined || Date.parse(e.at) >= runStartedMs))
        .map((e) => e.key)
    );
    translated.push({ locale, translated: check.metrics.translatedByLocale[locale] ?? 0, total: check.totalSourceKeys, changedThisRun: changed.size, qe: qeCounts });

    // Flagged: check errors on strings, then QE flags
    for (const iss of issues) {
      if (iss.severity !== "error" || !iss.key || iss.code === "missing_key") continue;
      flagged.push({ locale, key: iss.key, source: source(iss.key), translation: target(iss.key), by: "check", why: `${iss.code}: ${iss.message.replace(/^\[[^\]]+\]\s*/, "")}` });
    }
    for (const [id, rec] of verdicts) {
      if (!id.startsWith(`${locale}\0`) || qeOf(rec.key) !== "flagged") continue;
      flagged.push({
        locale,
        key: rec.key,
        source: rec.source,
        translation: rec.target,
        by: "qe",
        why: rec.reason ?? "",
        ...(rec.severity ? { severity: rec.severity } : {}),
        ...(rec.category ? { category: rec.category } : {}),
        ...(rec.evidence ? { evidence: rec.evidence } : {}),
        ...(rec.visualEvidence ? { visualEvidence: rec.visualEvidence } : {}),
        ...(rec.suggestedFix ? { suggestedFix: rec.suggestedFix } : {}),
      });
    }
    const flaggedKeys = new Set(flagged.filter((f) => f.locale === locale).map((f) => f.key));

    // Same English, different translations: intentional when every string was reviewed ok in context
    for (const iss of issues) {
      if (iss.code !== "glossary_inconsistency" || !Array.isArray(iss.details?.keys)) continue;
      const keys = iss.details.keys as string[];
      const items = keys.map((k) => {
        const cn = contextNoteFor(notes, k, source(k));
        return { key: k, translation: target(k), ...(cn.status === "current" && cn.note ? { contextNote: cn.note } : {}) };
      });
      const reviewedOk = keys.every((k) => ["ok", "human-verified"].includes(qeOf(k)));
      if (reviewedOk) {
        intentionalVariants.push({ locale, source: String(iss.details.term ?? source(keys[0])), items });
      } else {
        for (const it of items) {
          if (flaggedKeys.has(it.key)) continue;
          addReview({
            key: it.key,
            locale,
            source: source(it.key),
            translation: it.translation,
            reason: `Same source translated differently elsewhere (${(iss.details.variants as string[]).join(" / ")}) and not yet reviewed in context.${it.contextNote ? ` Note: ${it.contextNote}` : ""}`,
            context: siteOf(it.key),
          });
        }
      }
    }

    // Other warnings worth a look
    const REVIEW_CODES: Array<CheckIssue["code"]> = ["context_changed", "length_expansion_risk", "untranslated", "open_review_finding", "char_limit_inferred", "layout_budget_exceeded"];
    for (const iss of issues) {
      if (!iss.key || !REVIEW_CODES.includes(iss.code) || flaggedKeys.has(iss.key)) continue;
      addReview({ key: iss.key, locale, source: source(iss.key), translation: target(iss.key), reason: iss.message.replace(/^\[[^\]]+\]\s*/, ""), context: siteOf(iss.key) });
    }

    // Short ambiguous terms nobody has looked at in context (no current note, not reviewed)
    if (srcCatalog) {
      for (const [key, e] of srcCatalog.entries) {
        if (!AMBIGUOUS_UI_TERMS.has(e.value.trim().toLowerCase()) || !target(key) || flaggedKeys.has(key)) continue;
        if (contextNoteFor(notes, key, e.value).status === "current" || qeOf(key) !== "unreviewed") continue;
        addReview({ key, locale, source: e.value, translation: target(key), reason: `Ambiguous short UI term "${e.value}" with no Context Note or review yet: verify the meaning fits.`, context: siteOf(key) });
      }
    }
  }

  for (const r of reviewsFile.reviews) {
    if (r.status !== "open") continue;
    addReview({ key: r.key, locale: r.locale, source: "", translation: "", reason: `Review finding (${r.category}/${r.severity}): ${r.explanation}` });
  }

  const openQuestions = questions.filter((q) => q.status === "open");
  const pendingFollowUps = questions.filter((q) => q.status === "answered").length + assumptions.filter((a) => a.status === "overridden").length;

  /* ------------------------------- Markdown ------------------------------------------------ */
  const L: string[] = [];
  const outcomeLabel = check.outcome === "PASS" ? "✓ PASS" : check.outcome === "FAIL" ? `✗ FAIL (${check.errorCount} error(s))` : "⚠ INCONCLUSIVE";
  L.push("## Wraith Localization Report", "");
  L.push(
    `**Status:** ${outcomeLabel} · **Source:** \`${check.sourceLocale}\` (${check.totalSourceKeys} keys) · ${translated.map((t) => `\`${t.locale}\` ${t.translated}/${t.total}`).join(" · ") || "no targets"}`
  );
  const changedTotal = translated.reduce((n, t) => n + t.changedThisRun, 0);
  L.push(
    `_This run: ${changedTotal} string(s) written · ${mitigations.length} caught and fixed · ${flagged.length} need attention · ${openQuestions.length} open question(s)${pendingFollowUps ? ` · ${pendingFollowUps} follow-up(s) pending` : ""}_`,
    ""
  );

  L.push("### Translated", "", "| Locale | Translated | Written this run | Reviewed ok | Flagged | Not reviewed |", "|---|---:|---:|---:|---:|---:|");
  for (const t of translated) {
    L.push(`| \`${t.locale}\` | ${t.translated}/${t.total} | ${t.changedThisRun} | ${t.qe.ok + t.qe["human-verified"]} | ${t.qe.flagged} | ${t.qe.unreviewed} |`);
  }
  L.push("");

  if (flagged.length > 0) {
    L.push(`### Needs attention (${flagged.length})`, "", "| Locale | Key | Source | Translation | Why |", "|---|---|---|---|---|");
    for (const f of flagged.slice(0, 40)) {
      const badge = [f.severity, f.category].filter(Boolean).join("/");
      const detail = `${badge ? `[${badge}] ` : ""}${f.why}${f.evidence ? ` (Evidence: ${f.evidence})` : ""}${f.visualEvidence ? ` [Visual: ${f.visualEvidence}]` : ""}`;
      L.push(`| \`${f.locale}\` | \`${f.key}\` | ${esc(f.source)} | ${esc(f.translation)} | ${esc(detail)}${f.suggestedFix ? ` → _${esc(f.suggestedFix)}_` : ""} |`);
    }
    if (flagged.length > 40) L.push("", `…and ${flagged.length - 40} more.`);
    L.push("");
  }

  if (mitigations.length > 0) {
    L.push(`### Caught and fixed (${mitigations.length})`);
    for (const m of mitigations.slice(0, 40)) {
      L.push(`- \`${m.locale}\` \`${m.key}\`: ${m.by === "apply" ? "blocked when written" : "flagged in review"} (${esc(m.code === "qe_flag" ? m.message : `${m.code}: ${m.message.replace(/^\[[^\]]+\]\s*/, "")}`)}), then fixed.`);
    }
    L.push("");
  }

  if (questions.length > 0) {
    L.push("### Still ambiguous");
    for (const q of questions) {
      const guesses = q.keys.map((k) => {
        const t = check.targetLocales.filter((l) => !q.locale || l === q.locale).map((l) => {
          const v = tgtCatalogs.get(l)?.entries.get(k)?.value;
          return v ? `${l}: "${esc(v)}"` : null;
        }).filter(Boolean);
        return `\`${k}\`${t.length ? ` (${t.join(", ")})` : ""}`;
      });
      const state = q.status === "answered" ? ` _(answered: "${esc(q.answer ?? "")}"; agent still has to apply it)_` : "";
      L.push(`- **${q.id}**${q.locale ? ` (\`${q.locale}\`)` : ""}: ${esc(q.question)}${state}`, `  - Current guess: ${guesses.join("; ")}`);
    }
    L.push("");
  }

  if (assumptions.length > 0) {
    L.push("### Assumptions Made");
    for (const a of assumptions) {
      const head = `- **${a.label}** ${a.category}${a.locale ? ` (\`${a.locale}\`)` : ""}: ${esc(a.summary)}${a.rationale ? ` _(${esc(a.rationale)})_` : ""}`;
      if (a.status === "overridden") L.push(`${head}`, `  - **Overridden:** "${esc(a.override ?? "")}" _(agent still has to apply it)_`);
      else if (a.status === "applied") L.push(`${head}`, `  - **Overridden and applied:** "${esc(a.override ?? "")}"`);
      else L.push(head);
    }
    L.push("");
  }

  if (intentionalVariants.length > 0) {
    L.push("### Same English, different meaning (reviewed in context)", "", "| Locale | Source | Key | Translation | Context Note |", "|---|---|---|---|---|");
    for (const g of intentionalVariants) {
      for (const it of g.items) L.push(`| \`${g.locale}\` | ${esc(g.source)} | \`${it.key}\` | ${esc(it.translation)} | ${esc(it.contextNote ?? "_none_")} |`);
    }
    L.push("");
  }

  L.push(`### Strings Worth a Native Speaker's Look${reviewList.length ? ` (${reviewList.length})` : ""}`);
  if (reviewList.length === 0) L.push("_None flagged._");
  else {
    L.push("", "| Locale | Key | Source | Translation | Why |", "|---|---|---|---|---|");
    for (const r of reviewList.slice(0, 20)) L.push(`| \`${r.locale}\` | \`${r.key}\` | ${esc(r.source)} | ${esc(r.translation)} | ${esc(r.reason)} |`);
  }
  L.push("");

  if (questions.length > 0 || assumptions.length > 0) {
    L.push("### Follow up");
    L.push(
      "Reply with an ID: `Q1: it's a social-media post` answers a question, `A2: use informal du` overrides an assumption. In a terminal: `wraith answer Q1 \"…\"`. The agent then revisits only the affected strings and re-reviews them."
    );
    L.push("");
  }

  return {
    generatedAt: new Date().toISOString(),
    framework: check.framework,
    sourceLocale: check.sourceLocale,
    targetLocales: check.targetLocales,
    checkPassed: check.passed,
    outcome: check.outcome,
    ...(runStartedAt ? { runStartedAt } : {}),
    summary: {
      totalSourceKeys: check.totalSourceKeys,
      errorCount: check.errorCount,
      warningCount: check.warningCount,
      issuesByCategory: check.countsByCode,
      assumptionsMade: assumptions.length,
      stringsToReview: reviewList.length,
      flagged: flagged.length,
      mitigated: mitigations.length,
      openQuestions: openQuestions.length,
      pendingFollowUps,
    },
    translated,
    flagged,
    mitigations,
    questions,
    assumptions,
    intentionalVariants,
    reviewList,
    markdown: L.join("\n"),
  };
}
