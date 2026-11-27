import fs from "node:fs";
import { z } from "zod";
import { runCheck } from "./check.js";
import { prepareBatch, PreparedItem } from "./prepare.js";
import { atomicWriteFileSync, resolveConfinedPath, withWorkspaceLock } from "./security.js";
import { sha256Short, WraithStore } from "./store.js";
import { latestAnswerAt, listQuestions, projectDecisions, CharLimit } from "./context.js";
import { getLocaleConventions, LocaleConventions } from "./locales.js";
import { appendRunEvents } from "./run-log.js";
import { composeQeGuidance, ResolvedStyleGuide, resolveStyleGuide } from "./style-guide.js";

/* ------------------------------------------------------------------------------------------------
 * Diagnostic Quality Review (QE)
 *
 * Diagnostic-only by default: each translated string receives an `ok` or `flag` verdict from a
 * fresh-context reviewer reading the code (or visual QA artifacts) where the string is used.
 * Flags carry structured severity, category, concrete evidence, optional visual evidence, and an
 * optional suggestedFix — never auto-applied without explicit authorization. Wraith never calls a
 * model: it selects what to audit, supplies full linguistic & cross-project context, and stores
 * verdicts pinned to the exact source + target text reviewed.
 * ---------------------------------------------------------------------------------------------- */

export type QeVerdict = "ok" | "flag";
export type QeStatus = "unreviewed" | "ok" | "flagged" | "human-verified";

export const QeSeveritySchema = z.enum(["critical", "major", "minor"]);
export type QeSeverity = z.infer<typeof QeSeveritySchema>;

export const QeCategorySchema = z.enum([
  "accuracy",
  "fluency",
  "terminology",
  "style",
  "locale-conventions",
  "placeholders",
  "visual",
  "ambiguity",
  "other",
]);
export type QeCategory = z.infer<typeof QeCategorySchema>;

export const QE_VERDICTS_FILE = "qe-verdicts.json";

export function qeFingerprint(source: string, target: string): string {
  return sha256Short(`${source}\0${target}`);
}

export const QeVerdictInputSchema = z
  .object({
    locale: z.string(),
    key: z.string(),
    verdict: z.enum(["ok", "flag"]),
    target: z.string().optional(),
    fingerprint: z.string().optional(),
    severity: QeSeveritySchema.optional(),
    category: QeCategorySchema.optional(),
    reason: z.string().optional(),
    evidence: z.string().optional(),
    visualEvidence: z.string().optional(),
    suggestedFix: z.string().optional(),
    reviewer: z.string().optional(),
  })
  .refine((v) => v.verdict === "ok" || (v.reason ?? "").trim().length > 0, { message: "a flag needs a reason" })
  .refine((v) => v.target !== undefined || Boolean((v.fingerprint ?? "").trim()), {
    message: "target or fingerprint is required so verdicts stay pinned to the exact text reviewed",
  });
export type QeVerdictInput = z.infer<typeof QeVerdictInputSchema>;

const QeRecordSchema = z.object({
  locale: z.string(),
  key: z.string(),
  source: z.string(),
  target: z.string(),
  verdict: z.enum(["ok", "flag", "human-verified"]),
  severity: QeSeveritySchema.optional(),
  category: QeCategorySchema.optional(),
  reason: z.string().optional(),
  evidence: z.string().optional(),
  visualEvidence: z.string().optional(),
  suggestedFix: z.string().optional(),
  reviewer: z.string().optional(),
  reviewedAt: z.string(),
});
export type QeRecord = z.infer<typeof QeRecordSchema>;

const QeVerdictsFileSchema = z.object({
  version: z.literal(2).default(2),
  records: z.array(QeRecordSchema).default([]),
});
type QeVerdictsFile = z.infer<typeof QeVerdictsFileSchema>;

export const QE_REVIEW_INSTRUCTIONS = `You are performing a DIAGNOSTIC-ONLY quality audit of translations as they appear in the product. Work in a fresh context (a subagent if your host supports one), not the context that produced the translations.
NEVER automatically edit locale files or apply fixes without explicit authorization. Your job is strictly to inspect and report findings for human review, TMS handoff (Crowdin/Phrase), or a separately authorized follow-up pass.
For each task: open the file and read how each key is used (element, surrounding UI, neighbouring strings, user action) and review any attached visualDefects.
Enforce the same linguistic requirements as the translator: conventionsByLocale (register, formality, punctuation, RTL, plural forms), charLimit/formatting constraints, placeholders, termBase & doNotTranslate entries, projectDecisions, human Answers, and any Project Style Guide / translation prompt rules below.
Mark a string "flag" only when a user in the target locale would find it wrong, misleading, visually broken, or in clear violation of an explicit rule (wrong sense for this UI, meaning added/dropped/negated/inverted, wrong grammatical form for the element, regional/formality mismatch, unjustified terminology drift from sameSourceElsewhere, visual clipping/overflow, or conflict with a project decision, Answer, Term Base, or Style Guide rule).
Otherwise mark it "ok". Style preferences and acceptable alternatives are "ok" unless they violate an explicit Project Style Guide or prompt rule below. Never add units, nouns, or facts absent from the source to patch an apparent source UI omission; keep the translation faithful to the source and note any source UI gap as an Open Question instead.
For every "flag", provide: reason (one-line summary), severity ("critical"|"major"|"minor"), category ("accuracy"|"fluency"|"terminology"|"style"|"locale-conventions"|"placeholders"|"visual"|"ambiguity"|"other"), evidence (concrete code usage, rule, neighbouring key, or visual measurement supporting the flag), optional visualEvidence (screenshot path or DOM geometry note), and optional suggestedFix (full target with placeholders, ICU branches, and tags preserved) when the correction is clear. If source meaning is unclear even after reading code, flag with reason starting "Unclear meaning:" unless openQuestions already lists it.`;

export const QE_RESPONSE_FORMAT =
  'Return one diagnostic verdict per string, echoing its fingerprint (or target): {"locale","key","fingerprint","verdict":"ok"|"flag","severity"?:"critical"|"major"|"minor","category"?,"reason"?,"evidence"?,"visualEvidence"?,"suggestedFix"?}. Submit with `wraith qe --submit <file>` or qe_audit mode=submit. Do not apply edits without explicit authorization.';

export interface QeVisualDefect {
  type: string;
  message: string;
  viewport?: string;
  screenshot?: string;
}

export interface QeReviewString {
  key: string;
  source: string;
  target: string;
  /** Content hash of source + target at prepare time; echo on submit so edits in between cannot be misattributed. */
  fingerprint: string;
  line?: number;
  element?: string;
  comment?: string;
  /** Placeholders that must be preserved verbatim. */
  placeholders?: string[];
  /** Character/width constraint for this UI element, if any. */
  charLimit?: CharLimit;
  /** Plain-language meaning recorded for the source string. */
  contextNote?: string;
  /** Human answers about this string: binding. */
  answers?: Array<{ id: string; question: string; answer: string }>;
  /** Strings with open questions are reviewed against the best guess; flag only clear errors. */
  openQuestions?: Array<{ id: string; question: string }>;
  termBase?: Array<{ term: string; approved: string | null; doNotTranslate: boolean }>;
  /** How the same source text is translated elsewhere in the project (other keys, same locale). */
  sameSourceElsewhere?: Array<{ key: string; target: string; file?: string }>;
  /** Visual/layout defects measured for this key+locale from visual-qa artifacts, if any. */
  visualDefects?: QeVisualDefect[];
  /** Risk signals present on this string (populated when scope="risk"). */
  riskSignals?: string[];
}

export interface QeReviewTask {
  locale: string;
  /** Open this file to see how the strings are used. "(no usage site)" when the scanner found none. */
  file: string;
  strings: QeReviewString[];
}

export interface QePrepareResult {
  /** Always true: QE is diagnostic-only by default and never auto-edits deliverables. */
  diagnosticOnly: true;
  scope: "all" | "risk";
  instructions: string;
  responseFormat: string;
  /** Active project style guide and additive QE/translation prompts, when configured. */
  styleGuide?: ResolvedStyleGuide;
  /** Locale-specific linguistic conventions (register, direction, plural categories, punctuation). */
  conventionsByLocale: Record<string, LocaleConventions>;
  /** Project-wide do-not-translate terms from the glossary. */
  doNotTranslate?: string[];
  /** Project-level decisions (register, brand handling, …) the reviewer must respect. */
  projectDecisions: ReturnType<typeof projectDecisions>;
  tasks: QeReviewTask[];
  toReview: number;
  alreadyReviewed: number;
  skippedLowRisk?: number;
  /** Strings with deterministic check errors: not sent for review until fixed. */
  blockedByCheck: Array<{ locale: string; key: string; issue: string }>;
  tasksPath?: string;
}

export interface QeOptions {
  rootDir: string;
  locales?: string[];
  keys?: string[];
}

/* ------------------------------- verdict store ---------------------------------------------- */

export function readQeVerdicts(rootDir: string): QeVerdictsFile {
  const p = new WraithStore(rootDir).filePath(QE_VERDICTS_FILE);
  if (!fs.existsSync(p)) return { version: 2, records: [] };
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Corrupt QE verdicts file "${p}" (invalid JSON: ${msg}). Refusing to treat it as empty or overwrite stored verdicts; restore from git or fix the JSON syntax.`
    );
  }
  const parsed = QeVerdictsFileSchema.safeParse(rawJson);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? ` at ${first.path.join(".")}` : "";
    throw new Error(
      `Invalid QE verdicts file "${p}"${where}: ${first?.message ?? "schema validation failed"}. Refusing to overwrite stored verdicts; restore from git or fix the file.`
    );
  }
  return parsed.data;
}

function writeQeVerdicts(rootDir: string, file: QeVerdictsFile): void {
  const store = new WraithStore(rootDir);
  store.ensureDir();
  const records = [...file.records].sort((a, b) => a.locale.localeCompare(b.locale) || a.key.localeCompare(b.key));
  atomicWriteFileSync(store.filePath(QE_VERDICTS_FILE), JSON.stringify({ version: 2, records }, null, 2) + "\n");
}

function upsertRecords(rootDir: string, records: QeRecord[]): void {
  withWorkspaceLock(rootDir, () => {
    const file = readQeVerdicts(rootDir);
    const byId = new Map(file.records.map((r) => [`${r.locale}\0${r.key}`, r]));
    for (const r of records) byId.set(`${r.locale}\0${r.key}`, r);
    writeQeVerdicts(rootDir, { version: 2, records: [...byId.values()] });
  });
}

/**
 * Status of one string: a stored verdict only counts if it judged this exact source + target, and
 * (for agent verdicts) was given after the latest human Answer about the string: an Answer is new
 * context, so the string must be reviewed again.
 */
export function qeStatusOf(record: QeRecord | undefined, source: string, target: string | undefined, answeredAt?: string): QeStatus {
  if (!record || target === undefined || record.source !== source || record.target !== target) return "unreviewed";
  if (answeredAt && record.verdict !== "human-verified" && record.reviewedAt < answeredAt) return "unreviewed";
  if (record.verdict === "human-verified") return "human-verified";
  return record.verdict === "ok" ? "ok" : "flagged";
}

export function qeIndex(rootDir: string): Map<string, QeRecord> {
  return new Map(readQeVerdicts(rootDir).records.map((r) => [`${r.locale}\0${r.key}`, r]));
}

/** Human post-edits from a TMS are final: record them as human-verified for their exact text. */
export function markHumanVerified(rootDir: string, entries: Array<{ locale: string; key: string; source: string; target: string }>): number {
  const now = new Date().toISOString();
  upsertRecords(rootDir, entries.map((e) => ({ ...e, verdict: "human-verified" as const, reviewedAt: now })));
  return entries.length;
}

/* ------------------------------- collection ------------------------------------------------- */

function collectTranslated(rootDir: string, locale: string, keys?: string[]): PreparedItem[] {
  const res = prepareBatch({
    rootDir,
    targetLocale: locale,
    includeTranslated: true,
    skipFuzzy: true,
    keys,
    offset: 0,
    limit: 50_000,
  });
  return res.items.filter((i) => i.currentTarget !== undefined && i.currentTarget !== "");
}

function checkErrorsByKey(rootDir: string, locale: string): Map<string, string> {
  const out = new Map<string, string>();
  for (let offset = 0, guard = 0; guard < 10_000; guard++) {
    const res = runCheck({ rootDir, locale, skipScan: true, offset, limit: 100 });
    for (const iss of res.issues.items) {
      if (!iss.key || iss.severity !== "error") continue;
      if (iss.locale && iss.locale !== locale) continue;
      if (!out.has(iss.key)) out.set(iss.key, `${iss.code}: ${iss.message}`);
    }
    if (!res.issues.hasMore || res.issues.items.length === 0) break;
    offset += res.issues.items.length;
  }
  return out;
}

const AMBIGUOUS_SHORT_TERMS = new Set([
  "post", "open", "close", "save", "share", "plan", "home", "free", "lead", "charge",
  "draft", "issue", "book", "run", "match", "check", "order", "view", "file", "bill",
  "cover", "drop", "pin", "mute", "boost", "block", "report", "status", "clear", "reset",
]);

function readVisualDefectsMap(rootDir: string): Map<string, QeVisualDefect[]> {
  const out = new Map<string, QeVisualDefect[]>();
  try {
    const p = resolveConfinedPath(rootDir, ".wraith/artifacts/visual-qa/manifest.json", { label: "visual-qa manifest" });
    if (!fs.existsSync(p)) return out;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { defects?: Array<Record<string, unknown>> };
    for (const d of parsed.defects ?? []) {
      if (typeof d.key !== "string" || typeof d.locale !== "string") continue;
      const id = `${d.locale}\0${d.key}`;
      const list = out.get(id) ?? [];
      list.push({
        type: String(d.type ?? "visual_defect"),
        message: String(d.message ?? ""),
        ...(typeof d.viewport === "string" ? { viewport: d.viewport } : {}),
        ...(typeof d.screenshot === "string" ? { screenshot: d.screenshot } : {}),
      });
      out.set(id, list);
    }
  } catch {
    // Ignore absent or malformed optional visual-qa manifest
  }
  return out;
}

function collectRiskSignals(
  item: PreparedItem,
  elsewhere: Array<{ key: string; target: string; file?: string }>,
  visualDefects: QeVisualDefect[] | undefined
): string[] {
  const signals: string[] = [];
  const trimmed = item.source.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (AMBIGUOUS_SHORT_TERMS.has(trimmed.toLowerCase())) signals.push("ambiguous_term");
  else if (wordCount <= 2 && trimmed.length <= 20) signals.push("short_ui_string");
  if (elsewhere.some((e) => e.target !== item.currentTarget)) signals.push("same_source_variant");
  if (item.glossaryHits.length > 0) signals.push("glossary_or_dnt");
  if (item.hasPlurals || item.placeholders.length > 0) signals.push("icu_or_placeholders");
  if (item.charLimit || item.layout?.constraint) signals.push("layout_constrained");
  if ((item.questions ?? []).length > 0) signals.push("question_or_answer");
  if (visualDefects && visualDefects.length > 0) signals.push("visual_defect");
  return signals;
}

/* ------------------------------- prepare ---------------------------------------------------- */

/** Build diagnostic review tasks (one per locale × file) for translated strings without a current verdict. */
export function prepareQeReview(
  options: QeOptions & { includeReviewed?: boolean; scope?: "all" | "risk"; write?: boolean }
): QePrepareResult {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const locales = options.locales && options.locales.length > 0 ? options.locales : config.targetLocales;
  const scopeMode: "all" | "risk" = options.scope ?? "all";
  const index = qeIndex(options.rootDir);
  const questions = listQuestions(options.rootDir);
  const visualDefectsByKey = readVisualDefectsMap(options.rootDir);
  const tasks = new Map<string, QeReviewTask>();
  const blockedByCheck: QePrepareResult["blockedByCheck"] = [];
  let alreadyReviewed = 0;
  let skippedLowRisk = 0;

  for (const locale of locales) {
    const all = collectTranslated(options.rootDir, locale);
    const scope = options.keys ? all.filter((i) => options.keys!.includes(i.key)) : all;
    const errors = checkErrorsByKey(options.rootDir, locale);
    const bySource = new Map<string, PreparedItem[]>();
    for (const i of all) bySource.set(i.source, [...(bySource.get(i.source) ?? []), i]);

    for (const item of scope) {
      const err = errors.get(item.key);
      if (err) {
        blockedByCheck.push({ locale, key: item.key, issue: err });
        continue;
      }
      const status = qeStatusOf(index.get(`${locale}\0${item.key}`), item.source, item.currentTarget, latestAnswerAt(questions, item.key, locale));
      if (status === "human-verified" || (status !== "unreviewed" && !options.includeReviewed)) {
        alreadyReviewed++;
        continue;
      }
      const site = item.usageSites[0];
      const file = site?.file ?? "(no usage site)";
      const elsewhere = (bySource.get(item.source) ?? [])
        .filter((o) => o.key !== item.key)
        .map((o) => ({ key: o.key, target: o.currentTarget!, file: o.usageSites[0]?.file }));
      const visualDefects = visualDefectsByKey.get(`${locale}\0${item.key}`);
      const riskSignals = collectRiskSignals(item, elsewhere, visualDefects);
      if (scopeMode === "risk" && riskSignals.length === 0) {
        skippedLowRisk++;
        continue;
      }
      const str: QeReviewString = {
        key: item.key,
        source: item.source,
        target: item.currentTarget!,
        fingerprint: qeFingerprint(item.source, item.currentTarget!),
      };
      if (site?.line) str.line = site.line;
      if (site?.element) str.element = site.element;
      if (item.comment) str.comment = item.comment;
      if (item.placeholders.length > 0) str.placeholders = item.placeholders;
      if (item.charLimit) str.charLimit = item.charLimit;
      if (item.contextNote && item.contextNoteStatus === "current") str.contextNote = item.contextNote;
      const answered = (item.questions ?? []).filter((q) => q.answer);
      if (answered.length > 0) str.answers = answered.map((q) => ({ id: q.id, question: q.question, answer: q.answer! }));
      const open = (item.questions ?? []).filter((q) => q.status === "open");
      if (open.length > 0) str.openQuestions = open.map((q) => ({ id: q.id, question: q.question }));
      if (item.glossaryHits.length > 0) {
        str.termBase = item.glossaryHits.map((g) => ({
          term: g.term,
          approved: g.doNotTranslate ? g.term : g.preferredTranslation ?? null,
          doNotTranslate: g.doNotTranslate,
        }));
      }
      if (elsewhere.length > 0) str.sameSourceElsewhere = elsewhere;
      if (visualDefects && visualDefects.length > 0) str.visualDefects = visualDefects;
      if (scopeMode === "risk" && riskSignals.length > 0) str.riskSignals = riskSignals;
      const id = `${locale}\0${file}`;
      const task = tasks.get(id) ?? { locale, file, strings: [] };
      task.strings.push(str);
      tasks.set(id, task);
    }
  }

  const resolvedStyle = resolveStyleGuide(options.rootDir, config, locales);
  const conventionsByLocale: Record<string, LocaleConventions> = {};
  for (const loc of locales) {
    conventionsByLocale[loc] = getLocaleConventions(loc);
  }
  const dntTerms = store
    .readGlossary()
    .entries.filter((e) => e.doNotTranslate)
    .map((e) => e.term);
  const taskList = [...tasks.values()];
  const result: QePrepareResult = {
    diagnosticOnly: true,
    scope: scopeMode,
    instructions: composeQeGuidance(QE_REVIEW_INSTRUCTIONS, resolvedStyle),
    responseFormat: QE_RESPONSE_FORMAT,
    ...(resolvedStyle.hasAny ? { styleGuide: resolvedStyle } : {}),
    conventionsByLocale,
    ...(dntTerms.length > 0 ? { doNotTranslate: dntTerms } : {}),
    projectDecisions: projectDecisions(options.rootDir, locales),
    tasks: taskList,
    toReview: taskList.reduce((n, t) => n + t.strings.length, 0),
    alreadyReviewed,
    ...(scopeMode === "risk" ? { skippedLowRisk } : {}),
    blockedByCheck,
  };
  if (options.write !== false) {
    store.ensureDir();
    atomicWriteFileSync(store.filePath("qe-tasks.json"), JSON.stringify(result, null, 2) + "\n");
    result.tasksPath = ".wraith/qe-tasks.json";
  }
  return result;
}

/* ------------------------------- submit ----------------------------------------------------- */

export interface QeSubmitResult {
  accepted: number;
  rejected: Array<{ locale?: string; key?: string; code?: string; reason: string }>;
  summary: QeSummary;
}

export function parseQeVerdicts(raw: unknown): { verdicts: QeVerdictInput[]; rejected: QeSubmitResult["rejected"] } {
  const arr = Array.isArray(raw) ? raw : (raw as { verdicts?: unknown })?.verdicts;
  const verdicts: QeVerdictInput[] = [];
  const rejected: QeSubmitResult["rejected"] = [];
  if (!Array.isArray(arr)) return { verdicts, rejected: [{ code: "invalid_verdict", reason: 'expected an array or {"verdicts": [...]}' }] };
  for (const item of arr) {
    const parsed = QeVerdictInputSchema.safeParse(item);
    if (parsed.success) verdicts.push(parsed.data);
    else {
      const o = (item ?? {}) as { locale?: string; key?: string };
      rejected.push({ locale: o.locale, key: o.key, code: "invalid_verdict", reason: parsed.error.issues[0]?.message ?? "invalid verdict" });
    }
  }
  return { verdicts, rejected };
}

/** Store verdicts, each verified against the exact source + target that was reviewed. */
export function submitQeVerdicts(options: { rootDir: string; verdicts: unknown }): QeSubmitResult {
  // Validate existing verdict store upfront so corrupt files fail immediately even if 0 records are accepted
  const existingIndex = qeIndex(options.rootDir);
  const { verdicts, rejected } = parseQeVerdicts(options.verdicts);
  const now = new Date().toISOString();
  const current = new Map<string, PreparedItem>();
  for (const locale of new Set(verdicts.map((v) => v.locale))) {
    for (const i of collectTranslated(options.rootDir, locale, verdicts.filter((v) => v.locale === locale).map((v) => v.key))) {
      current.set(`${locale}\0${i.key}`, i);
    }
  }
  const records: QeRecord[] = [];
  for (const v of verdicts) {
    const id = `${v.locale}\0${v.key}`;
    const item = current.get(id);
    if (!item) {
      rejected.push({ locale: v.locale, key: v.key, code: "unknown_key", reason: "no translated string with this key/locale" });
      continue;
    }
    const existing = existingIndex.get(id);
    if (existing && existing.verdict === "human-verified" && existing.source === item.source && existing.target === item.currentTarget) {
      rejected.push({
        locale: v.locale,
        key: v.key,
        code: "human_verified",
        reason: "string is human-verified for this exact source and target; agent verdicts cannot overwrite human sign-off",
      });
      continue;
    }
    const expectedFp = qeFingerprint(item.source, item.currentTarget!);
    if (
      (v.target !== undefined && v.target !== item.currentTarget) ||
      (v.fingerprint !== undefined && v.fingerprint !== expectedFp)
    ) {
      rejected.push({
        locale: v.locale,
        key: v.key,
        code: "text_changed",
        reason: "source or target text changed since review tasks were prepared; re-prepare and review the current text",
      });
      continue;
    }
    records.push({
      locale: v.locale,
      key: v.key,
      source: item.source,
      target: item.currentTarget!,
      verdict: v.verdict,
      ...(v.severity ? { severity: v.severity } : {}),
      ...(v.category ? { category: v.category } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.evidence ? { evidence: v.evidence } : {}),
      ...(v.visualEvidence ? { visualEvidence: v.visualEvidence } : {}),
      ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
      ...(v.reviewer ? { reviewer: v.reviewer } : {}),
      reviewedAt: now,
    });
  }
  if (records.length > 0) upsertRecords(options.rootDir, records);
  appendRunEvents(
    options.rootDir,
    records
      .filter((r) => r.verdict === "flag")
      .map((r) => ({ type: "caught" as const, by: "qe" as const, locale: r.locale, key: r.key, code: "qe_flag", message: r.reason ?? "", at: now }))
  );
  return { accepted: records.length, rejected, summary: summarizeQe({ rootDir: options.rootDir, locales: [...new Set(verdicts.map((v) => v.locale))] }).summary };
}

/* ------------------------------- status ----------------------------------------------------- */

export interface QeSummary {
  total: number;
  ok: number;
  flagged: number;
  unreviewed: number;
  humanVerified: number;
}

export interface QeFlaggedItem {
  locale: string;
  key: string;
  source: string;
  target: string;
  severity?: QeSeverity;
  category?: QeCategory;
  reason?: string;
  evidence?: string;
  visualEvidence?: string;
  suggestedFix?: string;
  reviewer?: string;
}

export interface QeStatusResult {
  diagnosticOnly: true;
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
  summary: QeSummary;
  bySeverity: { critical: number; major: number; minor: number; unspecified: number };
  flagged: QeFlaggedItem[];
  nextSteps: string[];
}

export function summarizeQe(options: QeOptions): QeStatusResult {
  const store = new WraithStore(options.rootDir);
  const locales = options.locales && options.locales.length > 0 ? options.locales : store.readConfig().targetLocales;
  const index = qeIndex(options.rootDir);
  const questions = listQuestions(options.rootDir);
  const summary: QeSummary = { total: 0, ok: 0, flagged: 0, unreviewed: 0, humanVerified: 0 };
  const bySeverity = { critical: 0, major: 0, minor: 0, unspecified: 0 };
  const flagged: QeFlaggedItem[] = [];
  for (const locale of locales) {
    for (const item of collectTranslated(options.rootDir, locale, options.keys)) {
      const rec = index.get(`${locale}\0${item.key}`);
      const status = qeStatusOf(rec, item.source, item.currentTarget, latestAnswerAt(questions, item.key, locale));
      summary.total++;
      if (status === "ok") summary.ok++;
      else if (status === "human-verified") summary.humanVerified++;
      else if (status === "unreviewed") summary.unreviewed++;
      else {
        summary.flagged++;
        if (rec?.severity === "critical") bySeverity.critical++;
        else if (rec?.severity === "major") bySeverity.major++;
        else if (rec?.severity === "minor") bySeverity.minor++;
        else bySeverity.unspecified++;
        flagged.push({
          locale,
          key: item.key,
          source: item.source,
          target: item.currentTarget!,
          ...(rec?.severity ? { severity: rec.severity } : {}),
          ...(rec?.category ? { category: rec.category } : {}),
          reason: rec?.reason,
          ...(rec?.evidence ? { evidence: rec.evidence } : {}),
          ...(rec?.visualEvidence ? { visualEvidence: rec.visualEvidence } : {}),
          suggestedFix: rec?.suggestedFix,
          ...(rec?.reviewer ? { reviewer: rec.reviewer } : {}),
        });
      }
    }
  }
  const nextSteps: string[] = [];
  if (summary.flagged > 0) {
    nextSteps.push(
      "Triage flagged findings for human review or TMS handoff (`wraith export --only-flagged` / MCP `export`), or apply corrections only after explicit authorization; edited strings return to unreviewed."
    );
  }
  if (summary.unreviewed > 0) {
    nextSteps.push("Audit remaining strings in a fresh context: `wraith qe --prepare` (`qe_audit` mode=prepare), then submit diagnostic verdicts.");
  }
  return {
    diagnosticOnly: true,
    outcome: summary.flagged > 0 ? "FAIL" : summary.unreviewed > 0 ? "INCONCLUSIVE" : "PASS",
    summary,
    bySeverity,
    flagged,
    nextSteps,
  };
}
