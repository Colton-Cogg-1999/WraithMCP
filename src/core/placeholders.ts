import {
  parse as parseIcu,
  TYPE,
  type MessageFormatElement,
} from "@formatjs/icu-messageformat-parser";
import { PlaceholderSyntax } from "../formats/types.js";
import { getPluralCategories } from "./locales.js";

export interface ExtractedPluralInfo {
  pluralType: "cardinal" | "ordinal";
  options: string[];
  otherUsesCount: boolean;
}

export interface ExtractedPlaceholders {
  /** Normalized placeholder names (sorted unique) */
  names: string[];
  /** Occurrence count per placeholder name */
  counts: Record<string, number>;
  /** Argument formatting kind (e.g. 'argument' | 'number' | 'date' | 'time' | 'plural' | 'select') */
  argTypes: Record<string, string>;
  /** ICU plural variable -> plural metadata */
  plurals: Record<string, ExtractedPluralInfo>;
  /** ICU select variable -> declared option keys */
  selects: Record<string, string[]>;
  /** Rich-text / XML-like inline tags */
  inlineTags: {
    selfClosing: string[];
    paired: string[];
  };
  /** Vue linked messages (@:key) */
  linkedMessages: string[];
  /** i18next nesting references ($t(key)) */
  i18nextNesting: string[];
  /** Vue pipe-plural branch count (1 if not pipe-plural) */
  vuePipeBranches: number;
  /** Raw unescaped '@' in vue-i18n message */
  vueRawAtError: boolean;
  /** ICU syntax error if any */
  icuError?: string;
}

export interface ValidationProblem {
  code:
    | "icu_syntax_error"
    | "placeholder_mismatch"
    | "missing_plural_category"
    | "extra_plural_category"
    | "plural_structure_mismatch"
    | "inline_tag_mismatch";
  message: string;
  details?: Record<string, unknown>;
}

const DOUBLE_MUSTACHE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*,[^}]*)?\s*\}\}/g;
const I18NEXT_NESTING_RE = /\$t\(\s*([^)]+?)\s*\)/g;
const PERCENT_BRACE_RE = /%\{([a-zA-Z0-9_.-]+)\}/g;
const RAILS_SPRINTF_RE = /%<([a-zA-Z0-9_.-]+)>[^a-zA-Z]*[a-zA-Z]/g;
const PYTHON_NAMED_PRINTF_RE =
  /%\(([a-zA-Z0-9_.-]+)\)[#0\- +]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?[diouxXeEfFgGcrsa%]/g;
/**
 * Python positional printf conversions.
 * Carefully avoids false positives on literal percentages like "50% off" by rejecting
 * a space flag followed by an alphabetic word (like `% off`).
 */
const PYTHON_POS_PRINTF_RE =
  /(?<!%)%(?:[#0\-+]*(?:\d+)?(?:\.\d+)?[diouxXeEfFgGcrsa]| (?:\d+(?:\.\d+)?|\.\d+)?[diouxXeEfFgG](?![a-zA-Z]))/g;
const SINGLE_BRACE_RE = /(?<!\{)\{([a-zA-Z0-9_.-]+)\}(?!\})/g;
const VUE_LINKED_RE = /@(?:\.[a-zA-Z]+)?:\(?([a-zA-Z0-9_.'-]+)\)?/g;

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

function branchContainsCount(elements: MessageFormatElement[], pluralVar: string): boolean {
  for (const el of elements) {
    if (el.type === TYPE.pound) return true;
    if (
      (el.type === TYPE.argument || el.type === TYPE.number) &&
      el.value === pluralVar
    ) {
      return true;
    }
    if (el.type === TYPE.tag && branchContainsCount(el.children, pluralVar)) return true;
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const opt of Object.values(el.options)) {
        if (branchContainsCount(opt.value, pluralVar)) return true;
      }
    }
  }
  return false;
}

function walkIcuAst(
  elements: MessageFormatElement[],
  counts: Record<string, number>,
  argTypes: Record<string, string>,
  plurals: Record<string, ExtractedPluralInfo>,
  selects: Record<string, string[]>,
  richTags: string[]
): void {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        if (!argTypes[el.value]) argTypes[el.value] = "argument";
        break;
      case TYPE.number:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        argTypes[el.value] = "number";
        break;
      case TYPE.date:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        argTypes[el.value] = "date";
        break;
      case TYPE.time:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        argTypes[el.value] = "time";
        break;
      case TYPE.plural: {
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        const pluralType: "cardinal" | "ordinal" =
          el.pluralType === "ordinal" ? "ordinal" : "cardinal";
        argTypes[el.value] = pluralType === "ordinal" ? "selectordinal" : "plural";
        const otherClause = el.options["other"];
        plurals[el.value] = {
          pluralType,
          options: Object.keys(el.options).sort(),
          otherUsesCount: otherClause ? branchContainsCount(otherClause.value, el.value) : false,
        };
        for (const opt of Object.values(el.options)) {
          walkIcuAst(opt.value, counts, argTypes, plurals, selects, richTags);
        }
        break;
      }
      case TYPE.select:
        counts[el.value] = (counts[el.value] ?? 0) + 1;
        argTypes[el.value] = "select";
        selects[el.value] = Object.keys(el.options).sort();
        for (const opt of Object.values(el.options)) {
          walkIcuAst(opt.value, counts, argTypes, plurals, selects, richTags);
        }
        break;
      case TYPE.tag:
        richTags.push(el.value);
        walkIcuAst(el.children, counts, argTypes, plurals, selects, richTags);
        break;
      default:
        break;
    }
  }
}

function hasVueRawAtError(text: string): boolean {
  // Remove valid vue-i18n linked syntax `@:key`, `@.mod:key`, `@('key')` and escaped `{'@'}`
  const stripped = text
    .replace(/\{['"]@['"]\}/g, "")
    .replace(/@(?:\.[a-zA-Z]+)?:\(?[a-zA-Z0-9_.'-]+\)?/g, "");
  return stripped.includes("@");
}

function countVuePipeBranches(text: string): number {
  const stripped = text.replace(/\{['"]\|['"]\}/g, "");
  if (!stripped.includes("|")) return 1;
  return stripped.split("|").length;
}

export function extractPlaceholders(
  text: string,
  syntaxes: readonly PlaceholderSyntax[]
): ExtractedPlaceholders {
  const counts: Record<string, number> = {};
  const argTypes: Record<string, string> = {};
  const plurals: Record<string, ExtractedPluralInfo> = {};
  const selects: Record<string, string[]> = {};
  const linkedMessages: string[] = [];
  const i18nextNesting: string[] = [];
  const richTags: string[] = [];
  let icuError: string | undefined;
  let vuePipeBranches = 1;
  let vueRawAtError = false;

  const inline = extractInlineTags(text);

  const strippedForIcu = text
    .replace(SELF_CLOSING_TAG_RE, "")
    .replace(OPEN_GROUP_TAG_RE, "")
    .replace(CLOSE_GROUP_TAG_RE, "");

  if (syntaxes.includes("double-mustache")) {
    for (const m of text.matchAll(DOUBLE_MUSTACHE_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    for (const m of text.matchAll(I18NEXT_NESTING_RE)) {
      i18nextNesting.push(m[1].trim());
    }
  }

  if (syntaxes.includes("percent-brace")) {
    for (const m of text.matchAll(PERCENT_BRACE_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    for (const m of text.matchAll(RAILS_SPRINTF_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }

  if (syntaxes.includes("python-printf")) {
    for (const m of text.matchAll(PYTHON_NAMED_PRINTF_RE)) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
    let posIdx = 0;
    for (const m of text.matchAll(PYTHON_POS_PRINTF_RE)) {
      const key = `$pos_${posIdx++}_${m[0].trim()}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  if (syntaxes.includes("icu")) {
    const hasDoubleMustache = DOUBLE_MUSTACHE_RE.test(strippedForIcu);
    DOUBLE_MUSTACHE_RE.lastIndex = 0;
    // Parse with ICU parser when string has braces OR rich-text tags (like <b>...</b>)
    const hasRichTag = /<[a-zA-Z][a-zA-Z0-9_-]*\b[^>]*>/.test(strippedForIcu);
    if (!hasDoubleMustache && (/[{}]/.test(strippedForIcu) || hasRichTag)) {
      try {
        const ast = parseIcu(strippedForIcu, {
          ignoreTag: false,
          requiresOtherClause: true,
        });
        walkIcuAst(ast, counts, argTypes, plurals, selects, richTags);
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
    if (!syntaxes.includes("python-printf")) {
      vuePipeBranches = countVuePipeBranches(text);
      vueRawAtError = hasVueRawAtError(text);
    }
  }

  const names = Object.keys(counts).sort();
  return {
    names,
    counts,
    argTypes,
    plurals,
    selects,
    inlineTags: {
      selfClosing: inline.selfClosing,
      paired: [...inline.paired, ...richTags].sort(),
    },
    linkedMessages: linkedMessages.sort(),
    i18nextNesting: i18nextNesting.sort(),
    vuePipeBranches,
    vueRawAtError,
    icuError,
  };
}

export interface PluralValidationContext {
  sourcePlurals?: Record<string, string>;
  targetPlurals?: Record<string, string>;
  /** Framework plural model: 'icu' | 'gettext' | 'rails' | 'i18next' | 'vue' */
  pluralModel?: "icu" | "gettext" | "rails" | "i18next" | "vue";
  /** For gettext PO files: nplurals from the file's Plural-Forms header */
  gettextNplurals?: number;
}

/**
 * Validate a target translation string against its source string using framework-specific
 * placeholder and pluralization semantics.
 */
export function validateTranslationString(
  sourceText: string,
  targetText: string,
  targetLocale: string,
  syntaxes: readonly PlaceholderSyntax[],
  options?: PluralValidationContext
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];

  // 1. Document inline tag balance & parity check (<x/>, <g>)
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

  // 2. Placeholder names
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

  // 3. ICU argument type parity (e.g. {amount, number, ::currency/USD} downgraded to {amount})
  for (const [argName, srcType] of Object.entries(src.argTypes)) {
    const tgtType = tgt.argTypes[argName];
    if (
      tgtType &&
      srcType !== tgtType &&
      ["number", "date", "time", "plural", "select", "selectordinal"].includes(srcType)
    ) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Placeholder "${argName}" changed ICU format type from "${srcType}" to "${tgtType}".`,
        details: { name: argName, expectedType: srcType, actualType: tgtType },
      });
    }
  }

  // 4. Placeholder occurrence counts for non-plural/select messages
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

  // 5. Rich-text tags extracted via ICU parser (e.g. <b>...</b> -> <strong>...</strong>)
  if (JSON.stringify(src.inlineTags.paired) !== JSON.stringify(tgt.inlineTags.paired)) {
    if (!problems.some((p) => p.code === "inline_tag_mismatch")) {
      problems.push({
        code: "inline_tag_mismatch",
        message: `Rich-text tags mismatch. Expected [${src.inlineTags.paired.join(", ")}], got [${tgt.inlineTags.paired.join(", ")}].`,
      });
    }
  }

  // 6. ICU plurals & selectordinal — separate cardinal vs ordinal everyday categories!
  for (const [pluralVar, srcPlural] of Object.entries(src.plurals)) {
    const tgtPlural = tgt.plurals[pluralVar];
    if (!tgtPlural) {
      problems.push({
        code: "missing_plural_category",
        message: `Missing ICU ${srcPlural.pluralType === "ordinal" ? "selectordinal" : "plural"} expression for variable "${pluralVar}".`,
      });
      continue;
    }

    const requiredCategories = getPluralCategories(targetLocale, srcPlural.pluralType);
    const tgtOptSet = new Set(tgtPlural.options);
    const missingCats = requiredCategories.filter((cat) => !tgtOptSet.has(cat));
    if (missingCats.length > 0) {
      problems.push({
        code: "missing_plural_category",
        message: `Locale "${targetLocale}" requires ${srcPlural.pluralType} plural categor${missingCats.length === 1 ? "y" : "ies"} [${missingCats.join(", ")}] for "${pluralVar}".`,
        details: {
          variable: pluralVar,
          pluralType: srcPlural.pluralType,
          missing: missingCats,
          required: requiredCategories,
        },
      });
    }

    // Check that 'other' branch retains the count (# or {var}) when the source 'other' branch displays it
    if (srcPlural.otherUsesCount && !tgtPlural.otherUsesCount) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Plural "${pluralVar}" 'other' branch dropped count placeholder (# or {${pluralVar}}).`,
        details: { variable: pluralVar, branch: "other" },
      });
    }
  }

  // 7. ICU select branches
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

  // 8. i18next nesting ($t(key))
  if (JSON.stringify(src.i18nextNesting) !== JSON.stringify(tgt.i18nextNesting)) {
    problems.push({
      code: "placeholder_mismatch",
      message: `i18next nested key references $t(...) mismatch. Expected [${src.i18nextNesting.join(", ")}], got [${tgt.i18nextNesting.join(", ")}].`,
    });
  }

  // 9. vue-i18n linked messages, pipe plurals, and raw '@' syntax errors
  if (JSON.stringify(src.linkedMessages) !== JSON.stringify(tgt.linkedMessages)) {
    problems.push({
      code: "placeholder_mismatch",
      message: `Linked message references mismatch. Expected [${src.linkedMessages.join(", ")}], got [${tgt.linkedMessages.join(", ")}].`,
    });
  }
  if (syntaxes.includes("single-brace") && !syntaxes.includes("icu") && !syntaxes.includes("python-printf")) {
    const requiredCount = getPluralCategories(targetLocale, "cardinal").length;
    if (src.vuePipeBranches >= 2 && tgt.vuePipeBranches < requiredCount) {
      problems.push({
        code: "missing_plural_category",
        message: `vue-i18n pipe plural collapsed from ${src.vuePipeBranches} branch(es) to ${tgt.vuePipeBranches}; locale "${targetLocale}" needs at least ${requiredCount} plural branches.`,
      });
    }
    if (src.vuePipeBranches === 1 && tgt.vuePipeBranches > 1) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Stray '|' pipe character in vue-i18n translation accidentally creates a pluralized message (escape as {'|'}).`,
      });
    }
    if (!src.vueRawAtError && tgt.vueRawAtError) {
      problems.push({
        code: "placeholder_mismatch",
        message: `Unescaped '@' in vue-i18n translation causes a linked-message compile error (escape as {'@'}).`,
      });
    }
  }

  // 10. Map-based plurals (Rails YAML / GNU Gettext PO)
  if (options?.sourcePlurals) {
    if (!options.targetPlurals || Object.keys(options.targetPlurals).length === 0) {
      problems.push({
        code: "missing_plural_category",
        message: `Source key is a plural map; refusing scalar string overwrite. Supply structured plural variants for "${targetLocale}".`,
      });
      return problems;
    }

    const tgtKeys = Object.keys(options.targetPlurals);
    const tgtKeySet = new Set(tgtKeys);

    if (options.pluralModel === "gettext" && options.gettextNplurals !== undefined) {
      // GNU Gettext: validate strictly against the PO file's declared Plural-Forms nplurals!
      const nplurals = options.gettextNplurals;
      if (tgtKeys.length < nplurals) {
        problems.push({
          code: "missing_plural_category",
          message: `PO Plural-Forms declares nplurals=${nplurals}, but only ${tgtKeys.length} plural form(s) were provided.`,
          details: { nplurals, actual: tgtKeys.length },
        });
      } else if (tgtKeys.length > nplurals) {
        problems.push({
          code: "extra_plural_category",
          message: `PO Plural-Forms declares nplurals=${nplurals}, but ${tgtKeys.length} plural form(s) were provided (would fail msgfmt).`,
          details: { nplurals, actual: tgtKeys.length },
        });
      }
    } else {
      // Rails YAML / generic map-based plural: validate everyday integer cardinal categories
      const requiredCategories = getPluralCategories(targetLocale, "cardinal");
      const missingCats = requiredCategories.filter((cat) => !tgtKeySet.has(cat));
      if (missingCats.length > 0) {
        problems.push({
          code: "missing_plural_category",
          message: `Locale "${targetLocale}" requires plural subkeys [${missingCats.join(", ")}].`,
          details: { missing: missingCats, required: requiredCategories },
        });
      }
    }

    // Validate per-variant placeholders against source plural variants!
    const srcOther = options.sourcePlurals.other ?? sourceText;
    const srcOtherPh = extractPlaceholders(srcOther, syntaxes);
    const srcOne = options.sourcePlurals.one;
    const srcOnePh = srcOne !== undefined ? extractPlaceholders(srcOne, syntaxes) : null;
    const allAllowedPh = new Set([...srcOtherPh.names, ...(srcOnePh?.names ?? [])]);

    for (const [variant, variantText] of Object.entries(options.targetPlurals)) {
      const vPh = extractPlaceholders(variantText, syntaxes);
      // Unexpected/renamed placeholders are ALWAYS an error in any variant (e.g. %{cnt} instead of %{count})
      const unexpected = vPh.names.filter((n) => !allAllowedPh.has(n));
      if (unexpected.length > 0) {
        problems.push({
          code: "placeholder_mismatch",
          message: `Plural variant "${variant}" contains unexpected placeholder(s) {${unexpected.join("}, {")}}.`,
          details: { variant, unexpected },
        });
      }
      // Missing required placeholders: compare 'one' against source 'one' if present, other variants against source 'other'
      const expectedForVariant =
        variant === "one" && srcOnePh ? srcOnePh.names : srcOtherPh.names;
      const missingInVariant = expectedForVariant.filter((n) => !vPh.names.includes(n));
      if (missingInVariant.length > 0) {
        problems.push({
          code: "placeholder_mismatch",
          message: `Plural variant "${variant}" is missing placeholder(s) {${missingInVariant.join("}, {")}}.`,
          details: { variant, missing: missingInVariant },
        });
      }
    }
  }

  return problems;
}
