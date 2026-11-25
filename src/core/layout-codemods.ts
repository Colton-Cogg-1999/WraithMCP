import fs from "node:fs";
import path from "node:path";
import { detectProjectAdapter } from "../adapters/registry.js";
import { walkFiles } from "../adapters/utils.js";
import { atomicWriteFileSync, resolveConfinedPath } from "./security.js";
import { WraithStore } from "./store.js";
import { FrameworkName } from "./types.js";

export interface CodemodChange {
  file: string;
  line: number;
  rule: "tailwind_physical_to_logical" | "fixed_width_to_min_width" | "root_html_dir_lang" | "add_hyphens_auto";
  before: string;
  after: string;
}

export interface FileDiffPreview {
  file: string;
  changes: CodemodChange[];
  unifiedDiff: string;
}

export interface LayoutFixResult {
  dryRun: boolean;
  filesModified: string[];
  totalChanges: number;
  previews: FileDiffPreview[];
}

export interface LayoutFixOptions {
  rootDir: string;
  dryRun?: boolean;
  /** Optional list of workspace-relative files to restrict codemods to */
  files?: string[];
  /** Specific (file, line) pairs flagged for fixed-width clipping */
  flaggedWidthLines?: Array<{ file: string; line: number }>;
  /** Specific (file, line) pairs flagged for long-word compound overflow */
  flaggedLongWordLines?: Array<{ file: string; line: number }>;
  /** Whether to rewrite Tailwind physical left/right utilities (default: true) */
  fixLogical?: boolean;
  /** Whether to rewrite fixed w-* -> min-w-* on constrained text elements (default: true) */
  fixFixedWidths?: boolean;
  /** Whether to add dir/lang on root HTML layout templates (default: true) */
  fixRootHtml?: boolean;
}

const TAILWIND_PHYSICAL_TOKEN_RE =
  /(?<![A-Za-z0-9_-])((?:[a-z0-9-]+:)*)(-?)(ml|mr|pl|pr|left|right|text-left|text-right|rounded-tl|rounded-tr|rounded-bl|rounded-br|rounded-l|rounded-r|border-l|border-r)(-[A-Za-z0-9[\]./%]+)?(?![A-Za-z0-9_-])/g;

const PHYSICAL_MAP: Record<string, string> = {
  ml: "ms",
  mr: "me",
  pl: "ps",
  pr: "pe",
  left: "start",
  right: "end",
  "text-left": "text-start",
  "text-right": "text-end",
  "rounded-l": "rounded-s",
  "rounded-r": "rounded-e",
  "rounded-tl": "rounded-ss",
  "rounded-tr": "rounded-se",
  "rounded-bl": "rounded-es",
  "rounded-br": "rounded-ee",
  "border-l": "border-s",
  "border-r": "border-e",
};

/**
 * Rewrite Tailwind physical left/right utilities to CSS logical equivalents inside class strings.
 */
export function rewriteTailwindPhysicalToLogical(classText: string): string {
  return classText.replace(
    TAILWIND_PHYSICAL_TOKEN_RE,
    (full, variant = "", neg = "", prop = "", suffix = "") => {
      const replacement = PHYSICAL_MAP[prop];
      if (!replacement) return full;
      // Only rewrite ml/mr/pl/pr/left/right when followed by a value suffix (e.g. ml-4, left-0)
      if (["ml", "mr", "pl", "pr", "left", "right"].includes(prop) && !suffix) {
        return full;
      }
      return `${variant}${neg}${replacement}${suffix ?? ""}`;
    }
  );
}

const FIXED_WIDTH_TOKEN_RE = /(?<![A-Za-z0-9_-])((?:[a-z0-9-]+:)*)w-(\d+(?:\.\d+)?|\[[0-9]+(?:px|rem|em|ch)\])(?![A-Za-z0-9_-])/g;
const CONSTRAINED_TEXT_HINT_RE = /\b(?:truncate|whitespace-nowrap|overflow-hidden|line-clamp-1)\b/;

/**
 * Rewrite fixed `w-<N>` -> `min-w-<N>` on constrained text elements (or explicitly flagged lines).
 */
export function rewriteFixedWidthToMinWidth(classText: string, force = false): string {
  if (!force && !CONSTRAINED_TEXT_HINT_RE.test(classText)) {
    return classText;
  }
  return classText.replace(FIXED_WIDTH_TOKEN_RE, (_full, variant = "", val = "") => {
    // Avoid rewriting full-width utilities or huge layout containers (> 320px / > w-64)
    if (!val.startsWith("[")) {
      const num = Number(val);
      if (Number.isFinite(num) && num > 64) return _full;
    } else {
      const px = /^\[(\d+)px\]$/.exec(val);
      if (px && Number(px[1]) > 320) return _full;
    }
    return `${variant}min-w-${val}`;
  });
}

function addHyphensAutoToClassText(classText: string): string {
  if (/\bhyphens-auto\b/.test(classText)) return classText;
  return `${classText.trim()} hyphens-auto`.trim();
}

function buildUnifiedDiff(relFile: string, oldLines: string[], newLines: string[]): string {
  const hunks: string[] = [`--- a/${relFile}`, `+++ b/${relFile}`];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      hunks.push(`@@ -${i + 1},1 +${i + 1},1 @@`);
      if (oldLines[i] !== undefined) hunks.push(`-${oldLines[i]}`);
      if (newLines[i] !== undefined) hunks.push(`+${newLines[i]}`);
    }
  }
  return hunks.join("\n");
}

function patchHtmlOpeningTag(line: string, framework: FrameworkName): string {
  if (!/<html\b[^>]*>/i.test(line)) return line;
  return line.replace(/<html\b([^>]*)>/i, (full, attrs: string) => {
    const hasLang = /\blang\s*=/.test(attrs);
    const hasDir = /\bdir\s*=/.test(attrs);
    if (hasLang && hasDir) return full;

    let langAttr = 'lang="en"';
    let dirAttr = 'dir="ltr"';
    if (framework === "rails") {
      langAttr = 'lang="<%= I18n.locale %>"';
      dirAttr = `dir="<%= %w[ar he fa ur].include?(I18n.locale.to_s.split('-').first) ? 'rtl' : 'ltr' %>"`;
    } else if (framework === "django") {
      langAttr = 'lang="{{ LANGUAGE_CODE }}"';
      dirAttr = 'dir="{% if LANGUAGE_BIDI %}rtl{% else %}ltr{% endif %}"';
    } else if (framework === "sveltekit") {
      langAttr = 'lang="%lang%"';
      dirAttr = 'dir="%dir%"';
    } else if (framework === "nextjs" || framework === "react") {
      if (line.includes("{locale}") || line.includes("locale")) {
        langAttr = "lang={locale}";
        dirAttr = 'dir={/^(?:ar|he|fa|ur)/i.test(locale) ? "rtl" : "ltr"}';
      }
    }

    const extra: string[] = [];
    if (!hasLang) extra.push(langAttr);
    if (!hasDir) extra.push(dirAttr);
    const trimmedAttrs = attrs.trimEnd();
    return `<html${trimmedAttrs} ${extra.join(" ")}>`;
  });
}

const CLASS_ATTR_LINE_RE = /(class(?:Name)?\s*=\s*)(["'`])([^"'`]*)\2/g;
const CODEMOD_EXTS = new Set([".tsx", ".jsx", ".vue", ".svelte", ".erb", ".html", ".htm"]);

/**
 * Apply strictly deterministic mechanical layout codemods across workspace files.
 * Never makes judgment edits (e.g. removing nowrap from navbars or redesigning cards);
 * those remain structured agent prescriptions.
 */
export function runLayoutFix(options: LayoutFixOptions): LayoutFixResult {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const { detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );
  const framework: FrameworkName =
    config.framework !== "auto" ? config.framework : detection.framework;

  const fixLogical = options.fixLogical ?? true;
  const fixFixedWidths = options.fixFixedWidths ?? true;
  const fixRootHtml = options.fixRootHtml ?? true;

  const flaggedWidthSet = new Set(
    (options.flaggedWidthLines ?? []).map((x) => `${x.file}:${x.line}`)
  );
  const flaggedLongWordSet = new Set(
    (options.flaggedLongWordLines ?? []).map((x) => `${x.file}:${x.line}`)
  );

  const absFiles =
    options.files && options.files.length > 0
      ? options.files.map((f) => resolveConfinedPath(store.rootDir, f, { label: "codemod file" }))
      : walkFiles(store.rootDir, config.paths.source, config.paths.ignore, CODEMOD_EXTS);

  const previews: FileDiffPreview[] = [];
  const filesModified: string[] = [];
  let totalChanges = 0;

  for (const absFile of absFiles) {
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) continue;
    const relFile = path.relative(store.rootDir, absFile).replace(/\\/g, "/");
    const original = fs.readFileSync(absFile, "utf8");
    const oldLines = original.split(/\r?\n/);
    const newLines = [...oldLines];
    const fileChanges: CodemodChange[] = [];

    for (let i = 0; i < newLines.length; i++) {
      const lineNum = i + 1;
      const beforeLine = newLines[i];
      let line = beforeLine;

      // 1. Root <html> dir + lang injection
      if (fixRootHtml && /<html\b/i.test(line)) {
        const patched = patchHtmlOpeningTag(line, framework);
        if (patched !== line) {
          fileChanges.push({
            file: relFile,
            line: lineNum,
            rule: "root_html_dir_lang",
            before: line.trim(),
            after: patched.trim(),
          });
          line = patched;
        }
      }

      // 2. Class attribute mechanical rewrites (Tailwind physical->logical, fixed w->min-w, hyphens-auto)
      if (CLASS_ATTR_LINE_RE.test(line)) {
        CLASS_ATTR_LINE_RE.lastIndex = 0;
        const isWidthFlagged = flaggedWidthSet.has(`${relFile}:${lineNum}`);
        const isLongWordFlagged = flaggedLongWordSet.has(`${relFile}:${lineNum}`);

        line = line.replace(CLASS_ATTR_LINE_RE, (_full, prefix: string, quote: string, body: string) => {
          let nextBody = body;

          if (fixLogical) {
            const logicalBody = rewriteTailwindPhysicalToLogical(nextBody);
            if (logicalBody !== nextBody) {
              fileChanges.push({
                file: relFile,
                line: lineNum,
                rule: "tailwind_physical_to_logical",
                before: nextBody,
                after: logicalBody,
              });
              nextBody = logicalBody;
            }
          }

          if (fixFixedWidths) {
            const minWBody = rewriteFixedWidthToMinWidth(nextBody, isWidthFlagged);
            if (minWBody !== nextBody) {
              fileChanges.push({
                file: relFile,
                line: lineNum,
                rule: "fixed_width_to_min_width",
                before: nextBody,
                after: minWBody,
              });
              nextBody = minWBody;
            }
          }

          if (isLongWordFlagged) {
            const hyphBody = addHyphensAutoToClassText(nextBody);
            if (hyphBody !== nextBody) {
              fileChanges.push({
                file: relFile,
                line: lineNum,
                rule: "add_hyphens_auto",
                before: nextBody,
                after: hyphBody,
              });
              nextBody = hyphBody;
            }
          }

          return `${prefix}${quote}${nextBody}${quote}`;
        });
      }

      newLines[i] = line;
    }

    if (fileChanges.length > 0) {
      const updated = newLines.join("\n");
      const unifiedDiff = buildUnifiedDiff(relFile, oldLines, newLines);
      previews.push({ file: relFile, changes: fileChanges, unifiedDiff });
      totalChanges += fileChanges.length;
      if (!options.dryRun) {
        atomicWriteFileSync(absFile, updated);
        filesModified.push(relFile);
      }
    }
  }

  return {
    dryRun: Boolean(options.dryRun),
    filesModified,
    totalChanges,
    previews,
  };
}
