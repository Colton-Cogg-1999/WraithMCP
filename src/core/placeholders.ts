import {
  parse as parseIcu,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { PlaceholderSyntax } from "../formats/types.js";
import { getPluralCategories } from "./locales.js";

export interface ExtractedPlaceholders {
  /** Normalized placeholder names (sorted unique) */
  names: string[];
  /** Occurrence count per placeholder name */
  counts: Record<string, number>;
  /** ICU plural variable -> declared option keys (e.g. ['one', 'other', '=0']) */
  plurals: Record<string, string[]>;
  /** ICU select variable -> declared option keys */
  selects: Record<string, string[]>;
  /** Rich-text / XML-like inline tags */
  inlineTags: {
    selfClosing: string[];
    paired: string[];
  };
  /** Vue linked messages (@:key) */
  linkedMessages: string[];
  /** ICU syntax error if any */
  icuError?: string;
}

export interface ValidationProblem {
  code:
    | "icu_syntax_error"
    | "placeholder_mismatch"
    | "missing_plural_category"
    | "extra_plural_category"
    | "inline_tag_mismatch";
  message: string;
  details?: Record<string, unknown>;
}

const DOUBLE_MUSTACHE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*,[^}]*)?\s*\}\}/g;
const PERCENT_BRACE_RE = /%\{([a-zA-Z0-9_.-]+)\}/g;
const PYTHON_NAMED_PRINTF_RE = /%\(([a-zA-Z0-9_.-]+)\)[#0\- +]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?[diouxXeEfFgGcrsa%]/g;
const PYTHON_POS_PRINTF_RE = /(?<!%)%(?:[#0\- +]*(?:\d+)?(?:\.\d+)?[diouxXeEfFgGcrsa])/g;
const SINGLE_BRACE_RE = /(?<!\{)\{([a-zA-Z0-9_.-]+)\}(?!\})/g;
const VUE_LINKED_RE = /@(?:\.[a-zA-Z]+)?:([a-zA-Z0-9_.-]+)/g;

const SELF_CLOSING_TAG_RE = /<x\b([^>]*)\/>/g;
const OPEN_GROUP_TAG_RE = /<g\b([^>]*)>/g;
const CLOSE_GROUP_TAG_RE = /<\/g>/g;

function extractTagId(attrs: string): string {
  const m = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs);
  return m ? m[1] : attrs.trim();
}

export function extractInlineTags(text: string): {
  selfClosing: string[];
  paired: string[];
  balanced: boolean;
  error?: string;
} {
  const selfClosing: string[] = [];
  const paired: string[] = [];

  for (const m of text.matchAll(SELF_CLOSING_TAG_RE)) {
    selfClosing.push(extractTagId(m[1]));
  }

  // Check balanced <g ...>...</g>
  const tokenRe = /<g\b([^>]*)>|<\/g>/g;
  const stack: string[] = [];
  let balanced = true;
  let error: string | undefined;

  for (const m of text.matchAll(tokenRe)) {
    if (m[0].startsWith("</g")) {
      if (stack.length === 0) {
        balanced = false;
        error = "Unexpected closing </g> tag without matching opening <g>.";
      } else {
        stack.pop();
      }
    } else {
      const id = extractTagId(m[1]);
      paired.push(id);
      stack.push(id);
    }
  }

  if (stack.length > 0) {
    balanced = false;
    error = `Unclosed <g id="${stack[stack.length - 1]}"> tag.`;
  }

  return {
    selfClosing: selfClosing.sort(),
    paired: paired.sort(),
    balanced,
    error,
  };
}

function walkIcuAst(
  elements: MessageFormatElement[],
  counts: Record<string, number>,
  plurals: Record<string, string[]>,
  selects: Record<string, string[]>,
  richTags: string[]
): void {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        break;
      case TYPE.plural:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        plurals[el.value] = Object.keys(el.options).sort();
        for (const opt of Object.values(el.options)) {
          walkIcuAst(opt.value, counts, plurals, selects, richTags);
        }
        break;
      case TYPE.select:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        selects[el.value] = Object.keys(el.options).sort();
        for (const opt of Object.values(el.options)) {
          walkIcuAst(opt.value, counts, plurals, selects, richTags);
        }
        break;
      case TYPE.tag:
        richTags.push(el.value);
        walkIcuAst(el.children, counts, plurals, selects, richTags);
        break;
      default:
        break;
    }
  }
}

export function looksLikeIcu(text: string): boolean {
  // Detect ICU expressions like {count, plural, ...} or {name} (not {{name}} or %{name})
  if (/\{\{[^{}]+\}\}/.test(text)) return false;
  if (/%\{[^}]+\}/.test(text)) return false;
  return /\{[a-zA-Z0-9_]+(?:\s*,\s*(?:plural|select|selectordinal|number|date|time)\b[^}]*)?\}/.test(
    text
  );
}

export function extractPlaceholders(
  text: string,
  syntaxes: readonly PlaceholderSyntax[]
): ExtractedPlaceholders {
  const counts: Record<string, number> = {};
  const plurals: Record<string, string[]> = {};
  const selects: Record<string, string[]> = {};
  const linkedMessages: string[] = [];
  const richTags: string[] = [];
  let icuError: string | undefined;

  const inline = extractInlineTags(text);

  // Strip document <x .../> and <g ...> tags before ICU parsing so ICU doesn't treat them as rich text tags
  const strippedForIcu = text
    .replace(SELF_CLOSING_TAG_RE, "")
    .replace(OPEN_GROUP_TAG_RE, "")
    .replace(CLOSE_GROUP_TAG_RE, "");

  if (syntaxes.includes("double-mustache")) {
    for (const m of text.matchAll(DOUBLE_MUSTACHE_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }

  if (syntaxes.includes("percent-brace")) {
    for (const m of text.matchAll(PERCENT_BRACE_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }

  if (syntaxes.includes("python-printf")) {
    for (const m of text.matchAll(PYTHON_NAMED_PRINTF_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    let posIdx = 0;
    for (const m of text.matchAll(PYTHON_POS_PRINTF_RE)) {
      const key = `$pos_${posIdx++}_${m[0]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  if (syntaxes.includes("icu")) {
    // Only parse with ICU parser when the string contains `{` or `}` and isn't purely double-mustache
    const hasDoubleMustache = DOUBLE_MUSTACHE_RE.test(strippedForIcu);
    DOUBLE_MUSTACHE_RE.lastIndex = 0;
    if (!hasDoubleMustache && /[{}]/.test(strippedForIcu)) {
      try {
        const ast = parseIcu(strippedForIcu, {
          ignoreTag: false,
          requiresOtherClause: true,
        });
        walkIcuAst(ast, counts, plurals, selects, richTags);
      } catch (err) {
        icuError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (syntaxes.includes("single-brace") && !syntaxes.includes("icu")) {
    for (const m of text.matchAll(SINGLE_BRACE_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    for (const m of text.matchAll(VUE_LINKED_RE)) {
      linkedMessages.push(m[1]);
    }
  }

  const names = Object.keys(counts).sort();
  return {
    names,
    counts,
    plurals,
    selects,
    inlineTags: {
      selfClosing: inline.selfClosing,
      paired: [...inline.paired, ...richTags].sort(),
    },
    linkedMessages: linkedMessages.sort(),
    icuError,
  };
}

/**
 * Validate a target translation string against its source string for placeholder parity,
 * ICU syntax, CLDR plural categories required by targetLocale, select branches, and inline tags.
 */
export function validateTranslationString(
  sourceText: string,
  targetText: string,
  targetLocale: string,
  syntaxes: readonly PlaceholderSyntax[],
  options?: { sourcePlurals?: Record<string, string>; targetPlurals?: Record<string, string> }
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  // Inline tag balance check
  const srcInline = extractInlineTags(sourceText);
  const tgtInline = extractInlineTags(targetText);
  if (!tgtInline.balanced) {
    problems.push({
      code: "inline_tag_mismatch",
      message: tgtInline.error ?? "Unbalanced inline <g> tags in translation.",
    });
  }
  if (
    JSON.stringify(srcInline.selfClosing) !== JSON.stringify(tgtInline.selfClosing) ||
    JSON.stringify(srcInline.paired) !== JSON.stringify(tgtInline.paired)
  ) {
    problems.push({
      code: "inline_tag_mismatch",
      message: `Inline tags do not match source. Expected self-closing [${srcInline.selfClosing.join(", ")}] and paired [${srcInline.paired.join(", ")}], got [${tgtInline.selfClosing.join(", ")}] and [${tgtInline.paired.join(", ")}].`,
      details: { expected: srcInline, actual: tgtInline },
    });
  }

  const src = extractPlaceholders(sourceText, syntaxes);
  const tgt = extractPlaceholders(targetText, syntaxes);

  if (tgt.icuError) {
    problems.push({
      code: "icu_syntax_error",
      message: `Invalid ICU MessageFormat syntax: ${tgt.icuError}`,
    });
    return problems;
  }

  // Check placeholder names
  const srcSet = new Set(src.names);
  const tgtSet = new Set(tgt.names);
  const missing = src.names.filter((n) => !tgtSet.has(n));
  const extra = tgt.names.filter((n) => !srcSet.has(n));

  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing {${missing.join("}, {")}}`);
    if (extra.length > 0) parts.push(`unexpected {${extra.join("}, {")}}`);
    problems.push({
      code: "placeholder_mismatch",
      message: `Placeholder mismatch: ${parts.join("; ")}.`,
      details: { missing, extra },
    });
  }

  // Check non-plural/select placeholder counts (inside plurals, variables may repeat across branches)
  for (const name of src.names) {
    if (src.plurals[name] || src.selects[name]) continue;
    if (Object.keys(src.plurals).length > 0 || Object.keys(src.selects).length > 0) continue;
    if (tgt.counts[name] !== undefined && tgt.counts[name] !== src.counts[name]) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Placeholder "${name}" appears ${tgt.counts[name]} time(s), expected ${src.counts[name]}.`,
        details: { name, expected: src.counts[name], actual: tgt.counts[name] },
      });
    }
  }

  // Check rich tags extracted via ICU parser
  if (JSON.stringify(src.inlineTags.paired) !== JSON.stringify(tgt.inlineTags.paired)) {
    // Only add if not already flagged by inline tag check
    if (!problems.some((p) => p.code === "inline_tag_mismatch")) {
      problems.push({
        code: "inline_tag_mismatch",
        message: `Rich-text tags mismatch. Expected [${src.inlineTags.paired.join(", ")}], got [${tgt.inlineTags.paired.join(", ")}].`,
      });
    }
  }

  // Check ICU plural categories against target locale's CLDR plural rules
  const requiredCategories = getPluralCategories(targetLocale);
  for (const pluralVar of Object.keys(src.plurals)) {
    const tgtOpts = tgt.plurals[pluralVar];
    if (!tgtOpts) {
      problems.push({
        code: "missing_plural_category",
        message: `Missing ICU plural expression for variable "${pluralVar}".`,
      });
      continue;
    }
    const tgtOptSet = new Set(tgtOpts);
    const missingCats = requiredCategories.filter((cat) => !tgtOptSet.has(cat));
    if (missingCats.length > 0) {
      problems.push({
        code: "missing_plural_category",
        message: `Locale "${targetLocale}" requires plural categor${missingCats.length === 1 ? "y" : "ies"} [${missingCats.join(", ")}] for "${pluralVar}".`,
        details: { variable: pluralVar, missing: missingCats, required: requiredCategories },
      });
    }
  }

  // Check ICU select branches
  for (const [selectVar, srcBranches] of Object.entries(src.selects)) {
    const tgtBranches = tgt.selects[selectVar];
    if (!tgtBranches) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Missing ICU select expression for variable "${selectVar}".`,
      });
      continue;
    }
    const tgtBranchSet = new Set(tgtBranches);
    const missingBranches = srcBranches.filter((b) => !tgtBranchSet.has(b));
    if (missingBranches.length > 0) {
      problems.push({
        code: "missing_plural_category",
        message: `Missing select branch(es) [${missingBranches.join(", ")}] for "${selectVar}".`,
        details: { variable: selectVar, missing: missingBranches },
      });
    }
  }

  // Check linked messages (vue-i18n)
  if (JSON.stringify(src.linkedMessages) !== JSON.stringify(tgt.linkedMessages)) {
    problems.push({
      code: "placeholder_mismatch",
      message: `Linked message references mismatch. Expected [${src.linkedMessages.join(", ")}], got [${tgt.linkedMessages.join(", ")}].`,
    });
  }

  // Check map-based plurals (e.g. Rails YAML one/other, PO msgstr[n])
  if (options?.sourcePlurals && options?.targetPlurals) {
    const tgtKeys = new Set(Object.keys(options.targetPlurals));
    const missingCats = requiredCategories.filter((cat) => !tgtKeys.has(cat));
    if (missingCats.length > 0) {
      problems.push({
        code: "missing_plural_category",
        message: `Locale "${targetLocale}" requires plural subkeys [${missingCats.join(", ")}].`,
        details: { missing: missingCats, required: requiredCategories },
      });
    }
  }

  return problems;
}
