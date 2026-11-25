import fs from "node:fs";
import path from "node:path";
import * as t from "@babel/types";
import { LayoutRiskFinding } from "../adapters/types.js";
import { walkFiles } from "../adapters/utils.js";

export interface CssLayoutRuleInfo {
  selector: string;
  className: string;
  file: string;
  line: number;
  kind: "truncation_or_fixed_width" | "rtl_physical_direction";
  constraint: string;
  suggestion: string;
  snippet: string;
}

const FIXED_WIDTH_CSS_RE = /\b(?:width|max-width)\s*:\s*(\d+(?:\.\d+)?)\s*(px|rem|em|ch)\b/i;
const FIXED_HEIGHT_CSS_RE = /\b(?:height|max-height)\s*:\s*(\d+(?:\.\d+)?)\s*(px|rem|em)\b/i;
const NOWRAP_CSS_RE = /\bwhite-space\s*:\s*nowrap\b/i;
const OVERFLOW_HIDDEN_CSS_RE = /\boverflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/i;
const ELLIPSIS_CSS_RE = /\btext-overflow\s*:\s*ellipsis\b/i;
const LINE_CLAMP_CSS_RE = /(?:-webkit-)?line-clamp\s*:\s*1\b/i;
const PHYSICAL_CSS_RE = /\b(?:margin-left|margin-right|padding-left|padding-right|border-left|border-right|text-align\s*:\s*(?:left|right))\b/gi;

/**
 * Inspect a raw CSS declaration block (from `.css`, `.module.css`, or styled-components/emotion template literal)
 * for tight truncation/fixed-size or physical RTL constraints.
 */
export function inspectCssDeclarationBlock(cssBody: string): Array<{
  kind: "truncation_or_fixed_width" | "rtl_physical_direction";
  constraint: string;
  suggestion: string;
}> {
  const out: Array<{
    kind: "truncation_or_fixed_width" | "rtl_physical_direction";
    constraint: string;
    suggestion: string;
  }> = [];

  const tightParts: string[] = [];
  const wMatch = FIXED_WIDTH_CSS_RE.exec(cssBody);
  if (wMatch) {
    const val = Number(wMatch[1]);
    const unit = wMatch[2].toLowerCase();
    if ((unit === "px" && val <= 260) || ((unit === "rem" || unit === "em") && val <= 16) || (unit === "ch" && val <= 24)) {
      tightParts.push(wMatch[0]);
    }
  }
  const hMatch = FIXED_HEIGHT_CSS_RE.exec(cssBody);
  if (hMatch) {
    const val = Number(hMatch[1]);
    const unit = hMatch[2].toLowerCase();
    if ((unit === "px" && val <= 80) || ((unit === "rem" || unit === "em") && val <= 5)) {
      tightParts.push(hMatch[0]);
    }
  }
  if (NOWRAP_CSS_RE.test(cssBody)) tightParts.push("white-space: nowrap");
  if (OVERFLOW_HIDDEN_CSS_RE.test(cssBody)) tightParts.push("overflow: hidden");
  if (ELLIPSIS_CSS_RE.test(cssBody)) tightParts.push("text-overflow: ellipsis");
  if (LINE_CLAMP_CSS_RE.test(cssBody)) tightParts.push("line-clamp: 1");

  const hasClipOrNowrap =
    NOWRAP_CSS_RE.test(cssBody) ||
    OVERFLOW_HIDDEN_CSS_RE.test(cssBody) ||
    ELLIPSIS_CSS_RE.test(cssBody) ||
    LINE_CLAMP_CSS_RE.test(cssBody);

  if (tightParts.length > 0 && hasClipOrNowrap) {
    out.push({
      kind: "truncation_or_fixed_width",
      constraint: tightParts.join("; "),
      suggestion:
        "CSS rule combines fixed size/nowrap with overflow clipping; expanded translations or tall scripts may clip. Prefer min-width, allow wrapping, or verify with `polyglot layout`.",
    });
  }

  const physMatches = [...new Set([...cssBody.matchAll(PHYSICAL_CSS_RE)].map((m) => m[0].toLowerCase()))];
  if (physMatches.length > 0) {
    out.push({
      kind: "rtl_physical_direction",
      constraint: physMatches.slice(0, 4).join("; "),
      suggestion:
        "Physical CSS left/right property breaks RTL mirroring. Prefer logical CSS properties (margin-inline-start/end, padding-inline-start/end, text-align: start/end).",
    });
  }

  return out;
}

/**
 * Inspect an inline JSX `style={{ ... }}` ObjectExpression for tight layout or physical RTL properties.
 */
export function inspectInlineStyleObject(obj: t.ObjectExpression): Array<{
  kind: "truncation_or_fixed_width" | "rtl_physical_direction";
  constraint: string;
  suggestion: string;
}> {
  const decls: string[] = [];
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const rawKey = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : "";
    if (!rawKey) continue;
    const kebab = rawKey.replace(/([A-Z])/g, "-$1").toLowerCase();
    let valStr = "";
    if (t.isStringLiteral(prop.value)) {
      valStr = prop.value.value;
    } else if (t.isNumericLiteral(prop.value)) {
      valStr = kebab === "line-clamp" || kebab === "webkit-line-clamp" ? String(prop.value.value) : `${prop.value.value}px`;
    }
    if (valStr) decls.push(`${kebab}: ${valStr}`);
  }
  if (decls.length === 0) return [];
  return inspectCssDeclarationBlock(decls.join("; "));
}

/**
 * Index CSS rules across `.css` and `.module.css` files in the project so translated elements
 * referencing `styles.foo` or `className="foo"` inherit their static CSS constraints.
 */
export function indexProjectCssLayoutRules(
  rootDir: string,
  sourcePaths: string[],
  ignore: string[]
): Map<string, CssLayoutRuleInfo[]> {
  const byClass = new Map<string, CssLayoutRuleInfo[]>();
  const cssFiles = walkFiles(rootDir, sourcePaths, ignore, new Set([".css", ".scss"]));

  const ruleRe = /([^{}@]+)\{([^{}]+)\}/g;

  for (const absFile of cssFiles) {
    const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
    let content: string;
    try {
      content = fs.readFileSync(absFile, "utf8");
    } catch {
      continue;
    }
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
    for (const match of stripped.matchAll(ruleRe)) {
      const selectorText = match[1].trim();
      const bodyText = match[2].trim();
      if (!selectorText || !bodyText) continue;

      const risks = inspectCssDeclarationBlock(bodyText);
      if (risks.length === 0) continue;

      const idx = match.index ?? 0;
      const line = stripped.slice(0, idx).split(/\r?\n/).length;
      const classMatches = [...selectorText.matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g)].map((m) => m[1]);
      if (classMatches.length === 0) continue;

      for (const cls of classMatches) {
        for (const risk of risks) {
          const entry: CssLayoutRuleInfo = {
            selector: selectorText,
            className: cls,
            file: relFile,
            line,
            kind: risk.kind,
            constraint: risk.constraint,
            suggestion: risk.suggestion,
            snippet: `${selectorText} { ${bodyText.replace(/\s+/g, " ").slice(0, 90)} }`,
          };
          const list = byClass.get(cls) ?? [];
          list.push(entry);
          byClass.set(cls, list);
        }
      }
    }
  }

  return byClass;
}

/**
 * Convert matched CSS rules into `LayoutRiskFinding` items bound to a specific translation key.
 */
export function cssRulesToFindings(
  rules: CssLayoutRuleInfo[],
  key?: string,
  component?: string
): LayoutRiskFinding[] {
  return rules.map((r) => ({
    file: r.file,
    line: r.line,
    kind: r.kind,
    constraint: `${r.selector} (${r.constraint})`,
    key,
    component,
    suggestion: r.suggestion,
    snippet: r.snippet,
  }));
}
