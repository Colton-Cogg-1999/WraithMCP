import fs from "node:fs";
import { z } from "zod";
import { applyTranslations } from "./apply.js";
import { runCheck } from "./check.js";
import { prepareBatch, PreparedItem } from "./prepare.js";
import { atomicWriteFileSync } from "./security.js";
import { WraithStore } from "./store.js";
import { findTmMatches, TmMatch } from "./tm.js";
import { CheckIssue } from "./types.js";

/* ------------------------------------------------------------------------------------------------
 * Tiered Quality Estimation (QE)
 *
 * Tier 1  deterministic gate (0 tokens): check.ts validations + width-budget utilization.
 * Tier 2  three parallel micro-critics (strict JSON) over a fast low-cost model — the ONLY place
 *         Wraith calls a model, and only when explicitly invoked via `qe` / `qe_audit` with an
 *         API key present. Without a key Tier 2 is skipped and nothing is marked verified.
 * Tier 3  composite risk score, optional single auto-repair pass, escalation.
 * ---------------------------------------------------------------------------------------------- */

export type CriticName = "terminology" | "ui_context" | "semantic";
export type CriticSeverity = "none" | "minor" | "major" | "critical";
export type QeStatus = "verified" | "needs_review" | "unscored" | "human-verified";

export const CriticFindingSchema = z.object({
  key: z.string(),
  severity: z.enum(["none", "minor", "major", "critical"]),
  score: z.number().min(0).max(1),
  issue: z.string().default(""),
  suggestedFix: z.string().optional(),
});
export type CriticFindingRaw = z.infer<typeof CriticFindingSchema>;
export interface CriticFinding extends CriticFindingRaw {
  critic: CriticName;
}

export const SEVERITY_WEIGHTS: Record<CriticSeverity, number> = {
  critical: 1.0,
  major: 0.75,
  minor: 0.35,
  none: 0,
};

export const CONSTRAINED_ELEMENTS = ["Button", "Badge", "NavItem", "Tab", "TableHeader"];

export interface CriticRequest {
  critic: CriticName;
  locale: string;
  file: string;
  items: Array<Record<string, unknown>>;
}

export interface RepairRequest {
  key: string;
  source: string;
  target: string;
  locale: string;
  issues: Array<{ critic: CriticName; severity: CriticSeverity; issue: string; suggestedFix?: string }>;
  maxChars?: number;
}

/** Pluggable model client (Anthropic / Gemini over HTTPS, or a mock in tests). */
export interface QeModelClient {
  model: string;
  runCritic(req: CriticRequest): Promise<CriticFindingRaw[]>;
  repair?(req: RepairRequest): Promise<string | undefined>;
}

export interface QeSegmentResult {
  key: string;
  locale: string;
  file?: string;
  line?: number;
  component?: string;
  source: string;
  target: string;
  tier1: { passed: boolean; issues: Array<{ code: string; severity: string; message: string }> };
  budgetUtilization: number;
  maxChars?: number;
  maxWidthPx?: number;
  tmSimilarity: number;
  topFuzzyTM?: TmMatch;
  novelty: number;
  swarm: CriticFinding[];
  sSwarm: number;
  riskScore: number;
  status: QeStatus;
  tier: "tier1_escalate" | "tier2" | "tier2_unavailable";
  repaired?: boolean;
  repairNote?: string;
}

export interface QeReportFile {
  version: 1;
  generatedAt: string;
  model: string | null;
  tier2: "ran" | "unavailable";
  autoRepair: boolean;
  segments: QeSegmentResult[];
  summary: QeSummary;
}

export interface QeSummary {
  total: number;
  verified: number;
  needsReview: number;
  unscored: number;
  humanVerified: number;
  tier1Escalations: number;
  repairedVerified: number;
  maxRisk: number;
  meanRisk: number;
  llmCalls: number;
}

export interface QeOptions {
  rootDir: string;
  locales?: string[];
  keys?: string[];
  autoRepair?: boolean;
  failAbove?: number;
  /** Explicit client; `null` disables Tier 2. Defaults to resolveQeClient(process.env). */
  client?: QeModelClient | null;
  batchSize?: number;
  /** Persist to .wraith/qe-report.json (default true) */
  write?: boolean;
}

export interface QeResult {
  outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
  passed: boolean;
  reportPath: string;
  model: string | null;
  tier2: "ran" | "unavailable";
  summary: QeSummary;
  flagged: Array<Pick<QeSegmentResult, "key" | "locale" | "riskScore" | "status" | "tier"> & { topIssue?: string }>;
  nextSteps: string[];
}

/* ------------------------------- pure scoring functions ------------------------------------- */

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** S_swarm = max over critics of severityWeight × confidence score. */
export function computeSwarmScore(findings: Array<Pick<CriticFindingRaw, "severity" | "score">>): number {
  let max = 0;
  for (const f of findings) {
    max = Math.max(max, SEVERITY_WEIGHTS[f.severity] * clamp01(f.score));
  }
  return max;
}

/**
 * Risk = round(min(100, 100 × (0.35·S_swarm + 0.25·(1 − TM_sim) + 0.20·U_budget + 0.20·C_novelty)))
 */
export function computeRiskScore(input: { sSwarm: number; tmSimilarity: number; budgetUtilization: number; novelty: number }): number {
  const raw =
    0.35 * clamp01(input.sSwarm) +
    0.25 * (1 - clamp01(input.tmSimilarity)) +
    0.2 * clamp01(input.budgetUtilization) +
    0.2 * clamp01(input.novelty);
  return Math.round(Math.min(100, 100 * raw));
}

export function routeRisk(risk: number, autoRepair: boolean): "verified" | "repair" | "needs_review" {
  if (risk < 25) return "verified";
  if (autoRepair && risk <= 60) return "repair";
  return "needs_review";
}

const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

/** Deterministic text width estimate (px) used when no rendered width exists. */
export function estimateTextWidthPx(text: string, fontSizePx = 14): number {
  let units = 0;
  for (const ch of text.replace(/\{[^{}]*\}/g, "XXXX")) {
    units += WIDE_CHAR_RE.test(ch) ? 1.0 : 0.56;
  }
  return Math.round(units * fontSizePx);
}

/**
 * U_budget = min(1, width / maxBudgetWidth). Returns raw ratio too so callers can escalate when
 * the raw ratio exceeds 1.0 (over budget).
 */
export function computeBudgetUtilization(
  target: string,
  budget?: { maxWidthPx?: number; budgetChars?: number }
): { utilization: number; raw: number } {
  if (!budget) return { utilization: 0, raw: 0 };
  let raw = 0;
  if (budget.maxWidthPx && budget.maxWidthPx > 0) {
    raw = estimateTextWidthPx(target) / budget.maxWidthPx;
  }
  if (budget.budgetChars && budget.budgetChars > 0) {
    raw = Math.max(raw, [...target].length / budget.budgetChars);
  }
  return { utilization: Math.min(1, raw), raw };
}

/**
 * C_novelty ∈ [0,1]: lack of AST context (0.4) + ICU plural/select complexity not covered by a
 * close TM neighbor (0.3) + inline tags/markup not covered by a close TM neighbor (0.3).
 */
export function computeNovelty(input: { source: string; hasUsageContext: boolean; tmSimilarity: number }): number {
  let n = input.hasUsageContext ? 0 : 0.4;
  const covered = input.tmSimilarity >= 0.75;
  if (!covered && /\{\s*[\w.]+\s*,\s*(?:plural|select|selectordinal)\s*,/.test(input.source)) n += 0.3;
  if (!covered && /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>|<\/?\d+\/?>/.test(input.source)) n += 0.3;
  return clamp01(n);
}

/* ------------------------------- model clients ---------------------------------------------- */

const CRITIC_INSTRUCTIONS: Record<CriticName, string> = {
  terminology:
    "You are the Terminology & TM Drift Auditor for software UI localization. For each item, flag unapproved substitutions of glossary terms (glossaryMatches gives approved target terms), phrasing inconsistent with the top fuzzy translation-memory neighbor (topFuzzyTM, only when similarity >= 0.75), and register/tone shifts (e.g. formal vs informal address). Do not comment on anything else.",
  ui_context:
    "You are the UI-Context & Conciseness Critic. For each item, flag translations that are too verbose for constrained elements (Button, Badge, NavItem, Tab, TableHeader) given maxChars/budgetRatio, and wrong grammatical form for the UI element (e.g. infinitive vs imperative mismatch for action buttons, sentence case vs title case conventions of the locale). Do not comment on anything else.",
  semantic:
    "You are the Semantic & Omission Verifier. For each item, check STRICTLY for dropped negations, inverted conditionals, altered numbers or units, omitted content, or hallucinated claims not present in the source. Ignore style, terminology and length.",
};

function criticPrompt(req: CriticRequest): string {
  return `${CRITIC_INSTRUCTIONS[req.critic]}

Target locale: ${req.locale}. Source file: ${req.file}.
Return exactly one finding per item key. Use severity "none" with score 0 when there is no problem. score is your confidence (0..1) that the problem is real. suggestedFix is a full corrected target string (preserve every placeholder, ICU branch and tag exactly) and only when severity is not "none".

Items (JSON):
${JSON.stringify(req.items)}`;
}

const FINDINGS_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          severity: { type: "string", enum: ["none", "minor", "major", "critical"] },
          score: { type: "number" },
          issue: { type: "string" },
          suggestedFix: { type: "string" },
        },
        required: ["key", "severity", "score", "issue"],
      },
    },
  },
  required: ["findings"],
} as const;

function repairPrompt(req: RepairRequest): string {
  return `Repair this ${req.locale} UI translation. Fix ONLY the listed issues; preserve every placeholder ({var}), ICU plural/select branch and inline tag exactly.${req.maxChars ? ` It must fit in ${req.maxChars} characters.` : ""}
Source: ${JSON.stringify(req.source)}
Current translation: ${JSON.stringify(req.target)}
Issues: ${JSON.stringify(req.issues)}
Respond with JSON {"target": "<repaired translation>"}.`;
}

function parseFindings(raw: unknown): CriticFindingRaw[] {
  const arr = Array.isArray(raw) ? raw : (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(arr)) return [];
  const out: CriticFindingRaw[] = [];
  for (const item of arr) {
    const parsed = CriticFindingSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = /[[{][\s\S]*[\]}]/.exec(trimmed);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function anthropicClient(apiKey: string, model: string): QeModelClient {
  const call = async (prompt: string, tool: { name: string; schema: object }) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        tools: [{ name: tool.name, description: "Structured output", input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { content?: Array<{ type: string; input?: unknown; text?: string }> };
    const toolUse = body.content?.find((c) => c.type === "tool_use");
    if (toolUse?.input) return toolUse.input;
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    return extractJson(text);
  };
  return {
    model,
    async runCritic(req) {
      return parseFindings(await call(criticPrompt(req), { name: "report_findings", schema: FINDINGS_JSON_SCHEMA }));
    },
    async repair(req) {
      const out = (await call(repairPrompt(req), {
        name: "repaired_translation",
        schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      })) as { target?: unknown };
      return typeof out?.target === "string" ? out.target : undefined;
    },
  };
}

function geminiClient(apiKey: string, model: string): QeModelClient {
  const call = async (prompt: string, schema: object) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return extractJson(text);
  };
  return {
    model,
    async runCritic(req) {
      return parseFindings(await call(criticPrompt(req), FINDINGS_JSON_SCHEMA));
    },
    async repair(req) {
      const out = (await call(repairPrompt(req), {
        type: "object",
        properties: { target: { type: "string" } },
        required: ["target"],
      })) as { target?: unknown };
      return typeof out?.target === "string" ? out.target : undefined;
    },
  };
}

/**
 * Resolve the Tier 2 client from environment. `WRAITH_QE_MODEL` overrides the model; provider is
 * inferred from the model name (claude-* → Anthropic, gemini-* → Gemini) or from available keys.
 */
export function resolveQeClient(env: NodeJS.ProcessEnv = process.env): QeModelClient | null {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  const requested = env.WRAITH_QE_MODEL?.trim();
  if (requested) {
    if (/^gemini/i.test(requested) && geminiKey) return geminiClient(geminiKey, requested);
    if (/^claude/i.test(requested) && anthropicKey) return anthropicClient(anthropicKey, requested);
    return null;
  }
  if (anthropicKey) return anthropicClient(anthropicKey, "claude-haiku-4-5-20251001");
  if (geminiKey) return geminiClient(geminiKey, "gemini-2.5-flash");
  return null;
}

/* ------------------------------- pipeline ---------------------------------------------------- */

interface SegmentDraft {
  item: PreparedItem;
  locale: string;
  target: string;
  file: string;
  tier1Issues: CheckIssue[];
  hardFail: boolean;
  budget: { utilization: number; raw: number };
  maxChars?: number;
  maxWidthPx?: number;
  tm?: TmMatch;
  tmSimilarity: number;
  novelty: number;
  elementType?: string;
}

function collectPreparedItems(rootDir: string, locale: string, keys?: string[]): PreparedItem[] {
  const items: PreparedItem[] = [];
  let offset = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const res = prepareBatch({ rootDir, targetLocale: locale, includeTranslated: true, keys, offset, limit: 100 });
    items.push(...res.items);
    if (!res.hasMore || res.items.length === 0) break;
    offset += res.items.length;
  }
  return items;
}

function tier1IssuesByKey(rootDir: string, locale: string): Map<string, CheckIssue[]> {
  const all: CheckIssue[] = [];
  for (let offset = 0, guard = 0; guard < 10_000; guard++) {
    const res = runCheck({ rootDir, locale, skipScan: true, offset, limit: 100 });
    all.push(...res.issues.items);
    if (!res.issues.hasMore || res.issues.items.length === 0) break;
    offset += res.issues.items.length;
  }
  const map = new Map<string, CheckIssue[]>();
  for (const iss of all) {
    if (!iss.key) continue;
    if (iss.locale && iss.locale !== locale) continue;
    const list = map.get(iss.key) ?? [];
    list.push(iss);
    map.set(iss.key, list);
  }
  return map;
}

function elementTypeFor(item: PreparedItem): string | undefined {
  const site = item.usageSites[0];
  const raw = item.layout?.element ?? site?.element;
  if (!raw) return undefined;
  const low = raw.toLowerCase();
  if (low === "button" || /button|btn/.test(low)) return "Button";
  if (/badge|chip|pill|tag/.test(low)) return "Badge";
  if (/nav|menuitem/.test(low)) return "NavItem";
  if (/tab/.test(low)) return "Tab";
  if (low === "th" || /tableheader|columnheader/.test(low)) return "TableHeader";
  return raw;
}

function buildDraft(rootDir: string, item: PreparedItem, locale: string, issues: CheckIssue[], budgets: Record<string, Record<string, { maxWidthPx: number; budgetChars: number }>>): SegmentDraft | null {
  const target = item.currentTarget;
  if (target === undefined || target === "") return null;
  const hardFail = issues.some((i) => i.severity === "error");
  const budgetEntry = budgets[item.key]?.[locale] ?? (item.layout?.maxWidthPx || item.layout?.budgetChars ? { maxWidthPx: item.layout?.maxWidthPx ?? 0, budgetChars: item.layout?.budgetChars ?? 0 } : undefined);
  const budget = computeBudgetUtilization(target, budgetEntry);
  const tm = findTmMatches(rootDir, item.source, locale, {
    minSimilarity: 0.5,
    limit: 1,
    excludeKey: item.key,
    excludeSelf: { source: item.source, target },
  })[0];
  const tmSimilarity = tm?.similarity ?? 0;
  const novelty = computeNovelty({ source: item.source, hasUsageContext: item.usageSites.length > 0, tmSimilarity });
  return {
    item,
    locale,
    target,
    file: item.usageSites[0]?.file ?? "(no usage site)",
    tier1Issues: issues,
    hardFail: hardFail || budget.raw > 1.0,
    budget,
    maxChars: budgetEntry?.budgetChars || undefined,
    maxWidthPx: budgetEntry?.maxWidthPx || undefined,
    tm,
    tmSimilarity,
    novelty,
    elementType: elementTypeFor(item),
  };
}

function criticItems(critic: CriticName, drafts: SegmentDraft[]): Array<Record<string, unknown>> {
  return drafts.map((d) => {
    const base = { key: d.item.key, source: d.item.source, target: d.target, locale: d.locale };
    if (critic === "terminology") {
      return {
        ...base,
        glossaryMatches: d.item.glossaryHits.map((g) => ({ term: g.term, approved: g.doNotTranslate ? g.term : g.preferredTranslation ?? null, doNotTranslate: g.doNotTranslate })),
        topFuzzyTM: d.tm && d.tm.similarity >= 0.75 ? { source: d.tm.source, target: d.tm.target, similarity: d.tm.similarity, provenance: d.tm.provenance } : null,
      };
    }
    if (critic === "ui_context") {
      return {
        ...base,
        astElementType: d.elementType ?? null,
        constrained: d.elementType ? CONSTRAINED_ELEMENTS.includes(d.elementType) : false,
        maxChars: d.maxChars ?? null,
        budgetRatio: Number(d.budget.raw.toFixed(3)),
      };
    }
    return base;
  });
}

async function runSwarm(
  client: QeModelClient,
  drafts: SegmentDraft[],
  batchSize: number,
  counter: { calls: number }
): Promise<Map<string, CriticFinding[]>> {
  const out = new Map<string, CriticFinding[]>();
  const byFileLocale = new Map<string, SegmentDraft[]>();
  for (const d of drafts) {
    const k = `${d.locale}\0${d.file}`;
    const list = byFileLocale.get(k) ?? [];
    list.push(d);
    byFileLocale.set(k, list);
  }
  const critics: CriticName[] = ["terminology", "ui_context", "semantic"];
  for (const group of byFileLocale.values()) {
    for (let i = 0; i < group.length; i += batchSize) {
      const batch = group.slice(i, i + batchSize);
      const validKeys = new Set(batch.map((b) => b.item.key));
      const results = await Promise.all(
        critics.map(async (critic) => {
          counter.calls++;
          try {
            const findings = await client.runCritic({
              critic,
              locale: batch[0].locale,
              file: batch[0].file,
              items: criticItems(critic, batch),
            });
            return findings.filter((f) => validKeys.has(f.key)).map((f) => ({ ...f, critic }));
          } catch (err) {
            // A failed critic call must never make a segment look clean: record as unscored marker
            return batch.map((b) => ({
              critic,
              key: b.item.key,
              severity: "none" as const,
              score: 0,
              issue: `__critic_error__: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
            }));
          }
        })
      );
      for (const list of results) {
        for (const f of list) {
          const id = `${batch[0].locale}\0${f.key}`;
          const arr = out.get(id) ?? [];
          arr.push(f);
          out.set(id, arr);
        }
      }
    }
  }
  return out;
}

function toSegmentResult(d: SegmentDraft, swarm: CriticFinding[] | undefined, tier2Available: boolean, autoRepair: boolean): QeSegmentResult {
  const site = d.item.usageSites[0];
  const base = {
    key: d.item.key,
    locale: d.locale,
    file: site?.file,
    line: site?.line,
    component: site?.component,
    source: d.item.source,
    target: d.target,
    tier1: {
      passed: !d.hardFail,
      issues: d.tier1Issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
    },
    budgetUtilization: Number(d.budget.utilization.toFixed(3)),
    maxChars: d.maxChars,
    maxWidthPx: d.maxWidthPx,
    tmSimilarity: Number(d.tmSimilarity.toFixed(3)),
    topFuzzyTM: d.tm,
    novelty: Number(d.novelty.toFixed(3)),
  };
  if (d.hardFail) {
    if (d.budget.raw > 1.0 && !d.tier1Issues.some((i) => i.code === "layout_budget_exceeded")) {
      base.tier1.issues.push({
        code: "layout_budget_exceeded",
        severity: "error",
        message: `Estimated width utilization ${(d.budget.raw * 100).toFixed(0)}% of recorded budget`,
      });
    }
    return { ...base, swarm: [], sSwarm: 0, riskScore: 100, status: "needs_review", tier: "tier1_escalate" };
  }
  const findings = swarm ?? [];
  const criticErrored = findings.some((f) => f.issue.startsWith("__critic_error__"));
  const sSwarm = computeSwarmScore(findings);
  const riskScore = computeRiskScore({ sSwarm, tmSimilarity: d.tmSimilarity, budgetUtilization: d.budget.utilization, novelty: d.novelty });
  if (!tier2Available || criticErrored) {
    return { ...base, swarm: findings, sSwarm, riskScore, status: "unscored", tier: "tier2_unavailable" };
  }
  const route = routeRisk(riskScore, autoRepair);
  return {
    ...base,
    swarm: findings.filter((f) => f.severity !== "none" || f.issue),
    sSwarm,
    riskScore,
    status: route === "verified" ? "verified" : "needs_review",
    tier: "tier2",
  };
}

function summarize(segments: QeSegmentResult[], llmCalls: number): QeSummary {
  const risks = segments.map((s) => s.riskScore);
  return {
    total: segments.length,
    verified: segments.filter((s) => s.status === "verified").length,
    needsReview: segments.filter((s) => s.status === "needs_review").length,
    unscored: segments.filter((s) => s.status === "unscored").length,
    humanVerified: segments.filter((s) => s.status === "human-verified").length,
    tier1Escalations: segments.filter((s) => s.tier === "tier1_escalate").length,
    repairedVerified: segments.filter((s) => s.repaired && s.status === "verified").length,
    maxRisk: risks.length ? Math.max(...risks) : 0,
    meanRisk: risks.length ? Math.round(risks.reduce((a, b) => a + b, 0) / risks.length) : 0,
    llmCalls,
  };
}

export function readQeReport(rootDir: string): QeReportFile | null {
  const p = new WraithStore(rootDir).filePath("qe-report.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as QeReportFile;
  } catch {
    return null;
  }
}

export function writeQeReport(rootDir: string, report: QeReportFile): string {
  const store = new WraithStore(rootDir);
  store.ensureDir();
  const p = store.filePath("qe-report.json");
  atomicWriteFileSync(p, JSON.stringify(report, null, 2) + "\n");
  return p;
}

/** Recompute summary after external status changes (e.g. TMS import → human-verified). */
export function refreshQeSummary(report: QeReportFile): QeReportFile {
  return { ...report, summary: summarize(report.segments, report.summary?.llmCalls ?? 0) };
}

export async function runQe(options: QeOptions): Promise<QeResult> {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const layout = store.readLayout();
  const locales = options.locales && options.locales.length > 0 ? options.locales : config.targetLocales;
  const client = options.client === undefined ? resolveQeClient() : options.client;
  const autoRepair = Boolean(options.autoRepair);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 25));
  const counter = { calls: 0 };

  const draftsFor = (locale: string, keys?: string[]) => {
    const issues = tier1IssuesByKey(options.rootDir, locale);
    const drafts: SegmentDraft[] = [];
    for (const item of collectPreparedItems(options.rootDir, locale, keys)) {
      const d = buildDraft(options.rootDir, item, locale, issues.get(item.key) ?? [], store.readLayout().budgets);
      if (d) drafts.push(d);
    }
    return drafts;
  };

  const segments: QeSegmentResult[] = [];
  for (const locale of locales) {
    const drafts = draftsFor(locale, options.keys);
    const passing = drafts.filter((d) => !d.hardFail);
    const swarm = client && passing.length > 0 ? await runSwarm(client, passing, batchSize, counter) : new Map<string, CriticFinding[]>();
    for (const d of drafts) {
      let seg = toSegmentResult(d, swarm.get(`${locale}\0${d.item.key}`), Boolean(client), autoRepair);
      // Tier 3: one targeted repair pass for 25 <= risk <= 60
      if (autoRepair && client?.repair && seg.tier === "tier2" && seg.riskScore >= 25 && seg.riskScore <= 60) {
        const issues = seg.swarm
          .filter((f) => f.severity !== "none")
          .map((f) => ({ critic: f.critic, severity: f.severity, issue: f.issue, suggestedFix: f.suggestedFix }));
        let repairedTarget: string | undefined;
        counter.calls++;
        try {
          repairedTarget = await client.repair({ key: d.item.key, source: d.item.source, target: d.target, locale, issues, maxChars: d.maxChars });
        } catch {
          repairedTarget = undefined;
        }
        if (repairedTarget && repairedTarget !== d.target) {
          const applied = applyTranslations({
            rootDir: options.rootDir,
            targetLocale: locale,
            translations: [{ key: d.item.key, value: repairedTarget, notes: "qe auto-repair" }],
            origin: "agent",
          });
          if (applied.ok) {
            const reDraft = draftsFor(locale, [d.item.key])[0];
            if (reDraft) {
              const reSwarm = !reDraft.hardFail ? await runSwarm(client, [reDraft], batchSize, counter) : new Map();
              const re = toSegmentResult(reDraft, reSwarm.get(`${locale}\0${d.item.key}`), true, false);
              seg = { ...re, repaired: true, repairNote: `auto-repaired from ${JSON.stringify(d.target)}`, status: re.status === "verified" ? "verified" : "needs_review" };
            }
          } else {
            seg = { ...seg, repaired: false, repairNote: `repair rejected by apply: ${applied.errors.map((e) => e.code).join(", ")}`, status: "needs_review" };
          }
        } else {
          seg = { ...seg, repaired: false, repairNote: "no repair produced", status: "needs_review" };
        }
      }
      segments.push(seg);
    }
  }
  void layout;

  const summary = summarize(segments, counter.calls);
  const report: QeReportFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model: client?.model ?? null,
    tier2: client ? "ran" : "unavailable",
    autoRepair,
    segments,
    summary,
  };
  const reportPath = options.write === false ? store.filePath("qe-report.json") : writeQeReport(options.rootDir, report);

  const failAbove = options.failAbove;
  const overThreshold = failAbove !== undefined ? segments.some((s) => s.riskScore > failAbove) : false;
  const outcome: QeResult["outcome"] =
    summary.needsReview > 0 || overThreshold ? "FAIL" : summary.unscored > 0 ? "INCONCLUSIVE" : "PASS";

  const nextSteps: string[] = [];
  if (!client) {
    nextSteps.push("Tier 2 skipped: set ANTHROPIC_API_KEY or GEMINI_API_KEY (optionally WRAITH_QE_MODEL) to score segments that passed Tier 1.");
  }
  if (summary.tier1Escalations > 0) nextSteps.push("Fix Tier 1 failures (run `wraith check`) — they were escalated without LLM calls.");
  if (summary.needsReview > 0) {
    nextSteps.push("Export flagged segments for human review: `wraith export --only-flagged --include-tm --include-glossary --bundle-screenshots`.");
  }

  return {
    outcome,
    passed: outcome === "PASS",
    reportPath: store.filePath("qe-report.json") === reportPath ? ".wraith/qe-report.json" : reportPath,
    model: report.model,
    tier2: report.tier2,
    summary,
    flagged: segments
      .filter((s) => s.status !== "verified" && s.status !== "human-verified")
      .sort((a, b) => b.riskScore - a.riskScore)
      .slice(0, 25)
      .map((s) => ({
        key: s.key,
        locale: s.locale,
        riskScore: s.riskScore,
        status: s.status,
        tier: s.tier,
        topIssue: s.tier1.issues[0]?.message ?? s.swarm.find((f) => f.severity !== "none")?.issue,
      })),
    nextSteps,
  };
}
