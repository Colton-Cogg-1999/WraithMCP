import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = "/home/colton/Projects/Polyglot MCP";
export const EVAL_ROOT = __dirname;
export const CACHE_DIR = path.join(EVAL_ROOT, "cache");
export const RESULTS_DIR = path.join(EVAL_ROOT, "results");
export const WORK_DIR = path.join(EVAL_ROOT, "work");
export const CORPORA_DIR = path.join(EVAL_ROOT, "corpora");
export const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots");
export const DOCX_OUT_DIR = path.join(RESULTS_DIR, "docx");

export const POLYGLOT_BIN = path.join(REPO_ROOT, "release", "polyglot-linux-x64");
export const POLYGLOT_NODE_BIN = path.join(REPO_ROOT, "dist", "bin.js");
export const DEEPL_ENV_PATH = "/home/colton/Projects/LocRAG/.env";

// User-configured caps
export const DEEPL_STAGE_CHAR_CAP = 100_000;
/**
 * Safety guardrail on estimated API-equivalent spend (note: Codex/Claude/agy CLIs
 * are subscription-authenticated on this machine, so billed API spend is $0; we
 * still compute list-price API-equivalent cost for transparent cost/1k-strings comparison).
 */
export const ESTIMATED_SPEND_CAP_USD = 25.0;

export const ALL_LANGUAGES = ["es-MX", "de", "ja", "ar", "pl"];
export const PILOT_LANGUAGES = ["es-MX", "de"];

export const CODEX_CONFIG = {
  model: "gpt-6.2-astra",
  reasoningEffort: "high",
  /**
   * Training knowledge cutoff for contamination control (strings added in commits
   * after this date are evaluated as the clean post-cutoff subset alongside synthetic apps).
   */
  modelCutoffDate: "2026-03-01",
  /**
   * Populated/verified by Stage 1 approval probe; narrowest flag allowing unattended
   * execution of Polyglot's mutating MCP tools inside disposable copies.
   */
  approvalFlags: ["--approve-for-me"],
};

export const JUDGE_CONFIG = {
  claude: {
    cli: "claude",
    model: "sonnet",
    effort: "medium",
  },
  gemini: {
    cli: "agy",
    model: "gemini-4-carbon-medium",
  },
};

/**
 * List-price API-equivalent USD rates per 1M tokens (used when CLI doesn't emit total_cost_usd
 * directly, e.g. Codex / agy) plus DeepL Pro reference rate ($25 / 1M chars = $0.000025/char)
 * so cost-per-1,000-strings comparisons are transparent even on subscription/free tiers.
 */
export const LIST_PRICING_PER_1M = {
  codex: { input: 2.5, cachedInput: 0.25, output: 10.0 },
  claude: { input: 3.0, cachedInput: 0.3, output: 15.0 },
  gemini: { input: 1.25, cachedInput: 0.125, output: 5.0 },
  deeplPerCharUsd: 25.0 / 1_000_000,
};

/**
 * DeepL API language & formality mapping.
 * Note: DeepL has no distinct ES-MX target code (only ES); documented in REPORT.md.
 */
export const DEEPL_LANG_MAP = {
  "es-MX": { targetLang: "ES", formality: "prefer_less", glossaryTarget: "es" },
  de: { targetLang: "DE", formality: "prefer_more", glossaryTarget: "de" },
  ja: { targetLang: "JA", formality: "prefer_more", glossaryTarget: "ja" },
  ar: { targetLang: "AR", formality: null, glossaryTarget: null },
  pl: { targetLang: "PL", formality: "prefer_more", glossaryTarget: "pl" },
};

export const LOCALE_CONVENTIONS_TEXT = {
  "es-MX":
    "Mexican Spanish (es-MX): use natural Mexican phrasing (e.g. 'computadora', 'celular', 'iniciar sesión', 'guardar'), informal 'tú' for consumer/dev apps, opening ¿/¡ punctuation, and avoid Spain-only 'vosotros'.",
  de: "German (de): capitalize all nouns, polite 'Sie' consistently for SaaS/commerce UIs, natural German word order, watch compound noun length in tight buttons.",
  ja: "Japanese (ja): polite desu/masu (です/ます) for UI copy, full-width Japanese punctuation (、。！？), natural katakana loanwords where standard.",
  ar: "Modern Standard Arabic (ar): RTL direction, natural Arabic phrasing, proper Arabic plural forms (zero/one/two/few/many/other), Arabic comma (،) and question mark (؟).",
  pl: "Polish (pl): natural Polish phrasing, proper grammatical cases and 4 CLDR plural forms (one/few/many/other), imperative or polite UI tone consistently.",
};
