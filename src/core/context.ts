import fs from "node:fs";
import { z } from "zod";
import { detectProjectAdapter, loadSourceCatalog } from "../adapters/registry.js";
import { atomicWriteFileSync } from "./security.js";
import { sha256Short, WraithStore } from "./store.js";
import { Assumption, LayoutFile, WraithConfig } from "./types.js";

/* ------------------------------------------------------------------------------------------------
 * Context the agent needs to translate a string correctly, beyond the code itself:
 *
 *  Context Note     plain-language meaning of a source string, written once by the agent and reused
 *                   by every later translation, review and TMS export. Pinned to the source text.
 *  Character Limit  Declared (config; binding, fails check) or Inferred (rendered layout measurement,
 *                   else a length budget for constrained UI elements; advisory, the agent shortens).
 *  Open Question    a string whose meaning the agent could not settle from context. The agent
 *                   translates its best guess and asks; the human's Answer becomes durable context.
 * ---------------------------------------------------------------------------------------------- */

/* ------------------------------- Context Notes ---------------------------------------------- */

const ContextNoteSchema = z.object({
  note: z.string().min(1),
  sourceHash: z.string(),
  updatedAt: z.string(),
});
const ContextNotesFileSchema = z.object({
  version: z.literal(1).default(1),
  notes: z.record(z.string(), ContextNoteSchema).default({}),
});
export type ContextNotesFile = z.infer<typeof ContextNotesFileSchema>;

export type ContextNoteStatus = "missing" | "stale" | "current";

const NOTES_FILE = "context-notes.json";
const QUESTIONS_FILE = "questions.json";

function readJson<S extends z.ZodTypeAny>(rootDir: string, name: string, schema: S, empty: z.output<S>): z.output<S> {
  const p = new WraithStore(rootDir).filePath(name);
  if (!fs.existsSync(p)) return empty;
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(p, "utf8")));
  if (!parsed.success) throw new Error(`.wraith/${name} is invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function writeJson(rootDir: string, name: string, data: unknown): void {
  const store = new WraithStore(rootDir);
  store.ensureDir();
  atomicWriteFileSync(store.filePath(name), JSON.stringify(data, null, 2) + "\n");
}

export function sourceHashOf(source: string): string {
  return sha256Short(source);
}

export function readContextNotes(rootDir: string): ContextNotesFile {
  return readJson(rootDir, NOTES_FILE, ContextNotesFileSchema, { version: 1, notes: {} });
}

/** Store Context Notes, each pinned to the source text it describes. */
export function setContextNotes(rootDir: string, entries: Array<{ key: string; source: string; note: string }>): number {
  const file = readContextNotes(rootDir);
  const now = new Date().toISOString();
  let n = 0;
  for (const e of entries) {
    const note = e.note.trim();
    if (!note) continue;
    file.notes[e.key] = { note, sourceHash: sourceHashOf(e.source), updatedAt: now };
    n++;
  }
  const sorted: ContextNotesFile["notes"] = {};
  for (const k of Object.keys(file.notes).sort()) sorted[k] = file.notes[k];
  writeJson(rootDir, NOTES_FILE, { version: 1, notes: sorted });
  return n;
}

/** Set one Context Note by key, reading its current source text from the source catalog. */
export function setContextNoteForKey(rootDir: string, key: string, note: string): { key: string; source: string } {
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const { adapter, detection } = detectProjectAdapter(store.rootDir, config.framework, config.paths.locales);
  if (!adapter) throw new Error("no supported i18n setup detected");
  const source = loadSourceCatalog(adapter, detection, config.sourceLocale).entries.get(key)?.value;
  if (source === undefined) throw new Error(`no source string with key ${key}`);
  setContextNotes(rootDir, [{ key, source, note }]);
  return { key, source };
}

export function contextNoteFor(file: ContextNotesFile, key: string, source: string): { note?: string; status: ContextNoteStatus } {
  const n = file.notes[key];
  if (!n) return { status: "missing" };
  return { note: n.note, status: n.sourceHash === sourceHashOf(source) ? "current" : "stale" };
}

/* ------------------------------- Character Limits ------------------------------------------- */

export interface CharLimit {
  maxChars: number;
  kind: "declared" | "inferred";
  basis: "config" | "rendered" | "heuristic";
}

/** Character count as users see it (code points, not UTF-16 units). */
export function charCount(s: string): number {
  return [...s].length;
}

function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/** Most specific matching pattern wins (an exact key beats any wildcard; longer patterns beat shorter). */
export function declaredLimit(config: WraithConfig, key: string): number | undefined {
  const limits = config.charLimits ?? {};
  if (limits[key] !== undefined) return limits[key];
  let best: { len: number; max: number } | undefined;
  for (const [pattern, max] of Object.entries(limits)) {
    if (!pattern.includes("*") && !pattern.includes("?")) continue;
    if (!globToRegExp(pattern).test(key)) continue;
    const len = pattern.replace(/[*?]/g, "").length;
    if (!best || len > best.len) best = { len, max };
  }
  return best?.max;
}

const CONSTRAINED_ELEMENT_RE = /^(button|th|option|summary)$|button|btn|tab|nav|menuitem|badge|chip|pill|tag\b/i;

export function isConstrainedElement(element: string | undefined): boolean {
  return Boolean(element && CONSTRAINED_ELEMENT_RE.test(element));
}

/**
 * Length budget for a label on a constrained element, from the IBM translation-expansion guideline
 * (short strings expand far more than long ones): ≤10 chars ×3 (at least +6), 11–20 ×2, 21–30 ×1.8,
 * 31–50 ×1.6. Longer strings and ICU plural/select messages get no inferred budget.
 */
export function heuristicLimit(source: string): number | undefined {
  if (/\{\s*[\w.]+\s*,\s*(?:plural|select|selectordinal)\s*,/.test(source)) return undefined;
  const len = charCount(source);
  if (len === 0 || len > 50) return undefined;
  if (len <= 10) return Math.max(len * 3, len + 6);
  if (len <= 20) return len * 2;
  if (len <= 30) return Math.ceil(len * 1.8);
  return Math.ceil(len * 1.6);
}

/** Declared limit (config) > rendered measurement (layout.json) > heuristic for constrained elements. */
export function resolveCharLimit(input: {
  config: WraithConfig;
  layout: LayoutFile;
  key: string;
  locale: string;
  source: string;
  element?: string;
}): CharLimit | undefined {
  const declared = declaredLimit(input.config, input.key);
  if (declared !== undefined) return { maxChars: declared, kind: "declared", basis: "config" };
  const rendered = input.layout.budgets[input.key]?.[input.locale];
  if (rendered) return { maxChars: rendered.budgetChars, kind: "inferred", basis: "rendered" };
  if (isConstrainedElement(input.element)) {
    const h = heuristicLimit(input.source);
    if (h !== undefined) return { maxChars: h, kind: "inferred", basis: "heuristic" };
  }
  return undefined;
}

/* ------------------------------- Open Questions --------------------------------------------- */

const QuestionSchema = z.object({
  id: z.string().regex(/^Q\d+$/),
  keys: z.array(z.string()).min(1),
  locale: z.string().optional(),
  question: z.string().min(1),
  status: z.enum(["open", "answered", "resolved"]),
  answer: z.string().optional(),
  askedAt: z.string(),
  answeredAt: z.string().optional(),
  answeredVia: z.string().optional(),
  resolvedAt: z.string().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionStatus = Question["status"];

const QuestionsFileSchema = z.object({
  version: z.literal(1).default(1),
  questions: z.array(QuestionSchema).default([]),
});
type QuestionsFile = z.infer<typeof QuestionsFileSchema>;

export function readQuestions(rootDir: string): QuestionsFile {
  return readJson(rootDir, QUESTIONS_FILE, QuestionsFileSchema, { version: 1, questions: [] });
}

function writeQuestions(rootDir: string, file: QuestionsFile): void {
  const questions = [...file.questions].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  writeJson(rootDir, QUESTIONS_FILE, { version: 1, questions });
}

/** File an Open Question. An identical open question (same keys, locale and text) is returned instead of duplicated. */
export function askQuestion(rootDir: string, input: { keys: string[]; locale?: string; question: string }): { question: Question; created: boolean } {
  const file = readQuestions(rootDir);
  const keys = [...new Set(input.keys)].sort();
  const text = input.question.trim();
  if (keys.length === 0 || !text) throw new Error("a question needs at least one key and some text");
  const dup = file.questions.find(
    (q) => q.status === "open" && q.question === text && (q.locale ?? "") === (input.locale ?? "") && q.keys.join("\0") === keys.join("\0")
  );
  if (dup) return { question: dup, created: false };
  const next = file.questions.reduce((m, q) => Math.max(m, Number(q.id.slice(1))), 0) + 1;
  const question: Question = {
    id: `Q${next}`,
    keys,
    ...(input.locale ? { locale: input.locale } : {}),
    question: text,
    status: "open",
    askedAt: new Date().toISOString(),
  };
  file.questions.push(question);
  writeQuestions(rootDir, file);
  return { question, created: true };
}

function findQuestion(file: QuestionsFile, id: string): Question {
  const q = file.questions.find((x) => x.id.toUpperCase() === id.trim().toUpperCase());
  if (!q) throw new Error(`no question ${id}`);
  return q;
}

/** Record a human's Answer. The affected strings must then be revisited and the question resolved. */
export function answerQuestion(rootDir: string, input: { id: string; answer: string; via?: string }): Question {
  const file = readQuestions(rootDir);
  const q = findQuestion(file, input.id);
  const answer = input.answer.trim();
  if (!answer) throw new Error("an answer cannot be empty");
  q.answer = answer;
  q.status = "answered";
  q.answeredAt = new Date().toISOString();
  if (input.via) q.answeredVia = input.via;
  delete q.resolvedAt;
  writeQuestions(rootDir, file);
  return q;
}

/** The agent marks an answered question resolved once every affected string reflects the Answer. */
export function resolveQuestion(rootDir: string, id: string): Question {
  const file = readQuestions(rootDir);
  const q = findQuestion(file, id);
  if (q.status !== "answered") throw new Error(`${q.id} is ${q.status}; only answered questions can be resolved`);
  q.status = "resolved";
  q.resolvedAt = new Date().toISOString();
  writeQuestions(rootDir, file);
  return q;
}

export function listQuestions(rootDir: string, status?: QuestionStatus | "all"): Question[] {
  const all = readQuestions(rootDir).questions;
  return !status || status === "all" ? all : all.filter((q) => q.status === status);
}

/** Questions touching a key: locale-specific ones only for that locale, locale-less ones everywhere. */
export function questionsFor(questions: Question[], key: string, locale?: string): Question[] {
  return questions.filter((q) => q.keys.includes(key) && (!q.locale || !locale || q.locale === locale));
}

/** Most recent Answer time for any question touching this key (ISO string), if any. */
export function latestAnswerAt(questions: Question[], key: string, locale?: string): string | undefined {
  let latest: string | undefined;
  for (const q of questionsFor(questions, key, locale)) {
    if (q.answeredAt && (!latest || q.answeredAt > latest)) latest = q.answeredAt;
  }
  return latest;
}

/* ------------------------------- Assumptions (A1, A2, …) ------------------------------------ */

export interface LabeledAssumption extends Assumption {
  label: string;
}

/** Assumptions are append-only, so their position gives a stable short label: A1, A2, … */
export function listAssumptions(rootDir: string): LabeledAssumption[] {
  return new WraithStore(rootDir).readAssumptions().assumptions.map((a, i) => ({ ...a, label: `A${i + 1}` }));
}

function updateAssumption(rootDir: string, label: string, fn: (a: Assumption) => void): LabeledAssumption {
  const store = new WraithStore(rootDir);
  const file = store.readAssumptions();
  const idx = Number(/^A(\d+)$/i.exec(label.trim())?.[1]) - 1;
  const a = file.assumptions[idx];
  if (!a) throw new Error(`no assumption ${label}`);
  fn(a);
  store.writeAssumptions(file);
  return { ...a, label: `A${idx + 1}` };
}

/** A human overrides an assumption ("A3: use informal du"). The override is binding from now on. */
export function overrideAssumption(rootDir: string, input: { label: string; decision: string; via?: string }): LabeledAssumption {
  const decision = input.decision.trim();
  if (!decision) throw new Error("an override cannot be empty");
  return updateAssumption(rootDir, input.label, (a) => {
    a.status = "overridden";
    a.override = decision;
    a.overriddenAt = new Date().toISOString();
    if (input.via) a.overriddenVia = input.via;
    delete a.appliedAt;
  });
}

/** The agent marks an override applied once every affected string follows it. */
export function applyAssumptionOverride(rootDir: string, label: string): LabeledAssumption {
  return updateAssumption(rootDir, label, (a) => {
    if (a.status !== "overridden") throw new Error(`${label} has no pending override`);
    a.status = "applied";
    a.appliedAt = new Date().toISOString();
  });
}

/** Decisions the translator and reviewer must follow: an override replaces the original assumption. */
export function projectDecisions(rootDir: string, locales?: string[]): Array<{ label: string; locale?: string; category: string; decision: string; source: "agent" | "human" }> {
  return listAssumptions(rootDir)
    .filter((a) => !a.locale || !locales || locales.includes(a.locale))
    .map((a) => ({
      label: a.label,
      ...(a.locale ? { locale: a.locale } : {}),
      category: a.category,
      decision: a.override ?? a.summary,
      source: a.override ? ("human" as const) : ("agent" as const),
    }));
}
