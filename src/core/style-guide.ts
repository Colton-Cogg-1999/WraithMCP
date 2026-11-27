import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath } from "./security.js";
import { WRAITH_DIR } from "./store.js";
import { WraithConfig } from "./types.js";

export const DEFAULT_STYLE_GUIDE_FILE = `${WRAITH_DIR}/STYLE_GUIDE.md`;
const MAX_STYLE_GUIDE_BYTES = 32 * 1024;

export interface ResolvedStyleGuide {
  /** Whether any style guide, locale rule, or custom prompt is active. */
  hasAny: boolean;
  /** Repo-relative path of the loaded style guide file, if any. */
  file?: string;
  /** Combined style guide text (file content + inline instructions). */
  styleGuide?: string;
  /** Additional project translation prompt appended to system guidance. */
  translationPrompt?: string;
  /** Additional project QE review prompt appended to QE instructions. */
  qePrompt?: string;
  /** Locale-specific rules matched for the requested target locale(s). */
  localeRules?: Record<string, string>;
}

function trimNonEmpty(value?: string | null): string | undefined {
  const t = (value ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function readConfinedStyleFile(rootDir: string, relPath: string): string {
  const abs = resolveConfinedPath(rootDir, relPath, { label: "styleGuide.file" });
  if (!fs.existsSync(abs)) {
    throw new Error(`Configured styleGuide.file not found: ${relPath}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`Configured styleGuide.file is not a file: ${relPath}`);
  }
  const raw = fs.readFileSync(abs, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_STYLE_GUIDE_BYTES) {
    return raw.slice(0, MAX_STYLE_GUIDE_BYTES) + "\n[...truncated at 32KB]";
  }
  return raw;
}

function matchLocaleRules(
  byLocale: Record<string, string> | undefined,
  targetLocales?: string[]
): Record<string, string> | undefined {
  if (!byLocale || Object.keys(byLocale).length === 0) return undefined;
  const normalizedMap = new Map<string, string>();
  for (const [loc, rule] of Object.entries(byLocale)) {
    const cleaned = trimNonEmpty(rule);
    if (cleaned) normalizedMap.set(loc.toLowerCase(), cleaned);
  }
  if (normalizedMap.size === 0) return undefined;

  if (!targetLocales || targetLocales.length === 0) {
    const all: Record<string, string> = {};
    for (const [loc, rule] of Object.entries(byLocale)) {
      const cleaned = trimNonEmpty(rule);
      if (cleaned) all[loc] = cleaned;
    }
    return Object.keys(all).length > 0 ? all : undefined;
  }

  const matched: Record<string, string> = {};
  for (const loc of targetLocales) {
    const parts: string[] = [];
    const lower = loc.toLowerCase();
    const base = lower.split("-")[0];
    if (base !== lower && normalizedMap.has(base)) {
      parts.push(normalizedMap.get(base)!);
    }
    if (normalizedMap.has(lower)) {
      parts.push(normalizedMap.get(lower)!);
    }
    if (parts.length > 0) {
      matched[loc] = parts.join("\n");
    }
  }
  return Object.keys(matched).length > 0 ? matched : undefined;
}

/**
 * Resolve project style guide & custom prompt additions from `.wraith/config.json`
 * and/or `.wraith/STYLE_GUIDE.md`. Never throws when unconfigured.
 */
export function resolveStyleGuide(
  rootDir: string,
  config: WraithConfig,
  targetLocales?: string[]
): ResolvedStyleGuide {
  const cfg = config.styleGuide;
  const styleParts: string[] = [];
  let loadedFile: string | undefined;

  if (cfg?.file) {
    const fileText = trimNonEmpty(readConfinedStyleFile(rootDir, cfg.file));
    if (fileText) {
      loadedFile = cfg.file;
      styleParts.push(fileText);
    }
  } else {
    const defaultAbs = path.join(rootDir, DEFAULT_STYLE_GUIDE_FILE);
    if (fs.existsSync(defaultAbs) && fs.statSync(defaultAbs).isFile()) {
      const fileText = trimNonEmpty(readConfinedStyleFile(rootDir, DEFAULT_STYLE_GUIDE_FILE));
      if (fileText) {
        loadedFile = DEFAULT_STYLE_GUIDE_FILE;
        styleParts.push(fileText);
      }
    }
  }

  const inlineInstructions = trimNonEmpty(cfg?.instructions);
  if (inlineInstructions) {
    styleParts.push(inlineInstructions);
  }

  const styleGuide = styleParts.length > 0 ? styleParts.join("\n\n") : undefined;
  const translationPrompt = trimNonEmpty(cfg?.translationPrompt);
  const qePrompt = trimNonEmpty(cfg?.qePrompt);
  const localeRules = matchLocaleRules(cfg?.byLocale, targetLocales);
  const hasAny = Boolean(styleGuide || translationPrompt || qePrompt || localeRules);

  return {
    hasAny,
    ...(loadedFile ? { file: loadedFile } : {}),
    ...(styleGuide ? { styleGuide } : {}),
    ...(translationPrompt ? { translationPrompt } : {}),
    ...(qePrompt ? { qePrompt } : {}),
    ...(localeRules ? { localeRules } : {}),
  };
}

/**
 * Build upon Wraith's built-in translation guidance with project style guide,
 * locale rules, and custom translation prompt. Always preserves baseGuidance verbatim first.
 */
export function composeTranslationGuidance(
  baseGuidance: string,
  resolved: ResolvedStyleGuide
): string {
  const extras: string[] = [];
  if (resolved.styleGuide) {
    extras.push(`Project Style Guide:\n${resolved.styleGuide}`);
  }
  if (resolved.localeRules && Object.keys(resolved.localeRules).length > 0) {
    const lines = Object.entries(resolved.localeRules)
      .map(([loc, rule]) => `- ${loc}: ${rule}`)
      .join("\n");
    extras.push(`Locale-Specific Style Rules:\n${lines}`);
  }
  if (resolved.translationPrompt) {
    extras.push(`Additional Project Translation Prompt:\n${resolved.translationPrompt}`);
  }
  if (extras.length === 0) return baseGuidance;
  return `${baseGuidance}\n\n---\nThe following project preferences build upon (and never replace) the core rules above (placeholders, ICU syntax, inline tags, glossary, and character limits still apply):\n\n${extras.join("\n\n")}`;
}

/**
 * Build upon Wraith's built-in QE instructions with project style guide,
 * locale rules, and optional custom QE prompt. Always preserves baseInstructions verbatim first.
 */
export function composeQeGuidance(
  baseInstructions: string,
  resolved: ResolvedStyleGuide
): string {
  const extras: string[] = [];
  if (resolved.styleGuide) {
    extras.push(`Project Style Guide (flag clear violations of explicit rules below):\n${resolved.styleGuide}`);
  }
  if (resolved.localeRules && Object.keys(resolved.localeRules).length > 0) {
    const lines = Object.entries(resolved.localeRules)
      .map(([loc, rule]) => `- ${loc}: ${rule}`)
      .join("\n");
    extras.push(`Locale-Specific Style Rules:\n${lines}`);
  }
  if (resolved.translationPrompt) {
    extras.push(`Project Translation Prompt (requirements translations must satisfy):\n${resolved.translationPrompt}`);
  }
  if (resolved.qePrompt) {
    extras.push(`Additional Project QE Prompt:\n${resolved.qePrompt}`);
  }
  if (extras.length === 0) return baseInstructions;
  return `${baseInstructions}\n\n---\nThe following project preferences build upon (and never replace) the core QE rules above:\n\n${extras.join("\n\n")}`;
}
