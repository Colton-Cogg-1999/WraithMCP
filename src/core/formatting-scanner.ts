import { parse as babelParse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

type TraverseFn = typeof _traverse.default;
const traverse: TraverseFn =
  typeof _traverse === "function"
    ? (_traverse as unknown as TraverseFn)
    : _traverse.default;

export type FormattingRuleId =
  | "toFixed_displayed"
  | "toLocaleString_missing_locale"
  | "intl_missing_locale"
  | "currency_concatenation"
  | "manual_date_assembly"
  | "case_transform_locale_unsafe"
  | "localeCompare_missing_locale";

export interface HardcodedFormattingFinding {
  file: string;
  line: number;
  column: number;
  rule: FormattingRuleId;
  snippet: string;
  suggestion: string;
}

const CURRENCY_PREFIX_RE = /(?:^|[\s(])[$€£¥₹₩]\s*$/;
const CURRENCY_SUFFIX_RE = /^\s*(?:USD|EUR|GBP|JPY|CAD|AUD|MXN)\b/;
const DATE_GETTER_NAMES = new Set([
  "getFullYear",
  "getYear",
  "getMonth",
  "getDate",
  "getHours",
  "getMinutes",
  "getSeconds",
]);
const LOGGER_CALLEES = new Set(["console", "logger", "log", "pino", "winston", "debug"]);

function isInsideLoggerOrError(p: NodePath): boolean {
  const callAnc = p.findParent((anc) => t.isCallExpression(anc.node));
  if (callAnc && t.isCallExpression(callAnc.node)) {
    const c = callAnc.node.callee;
    if (
      (t.isIdentifier(c) && LOGGER_CALLEES.has(c.name)) ||
      (t.isMemberExpression(c) && t.isIdentifier(c.object) && LOGGER_CALLEES.has(c.object.name))
    ) {
      return true;
    }
  }
  if (p.findParent((anc) => t.isNewExpression(anc.node) && t.isIdentifier(anc.node.callee, { name: "Error" }))) {
    return true;
  }
  return false;
}

function isInsideJsxOrReturnDisplay(p: NodePath): boolean {
  if (p.findParent((anc) => t.isJSXExpressionContainer(anc.node))) return true;
  if (p.findParent((anc) => t.isTemplateLiteral(anc.node))) {
    // Only flag template literals if inside JSX or returned by a component/formatter
    return Boolean(
      p.findParent((anc) => t.isJSXExpressionContainer(anc.node) || t.isReturnStatement(anc.node))
    );
  }
  return false;
}

function isUndefinedExpr(node: t.Node | null | undefined): boolean {
  if (!node) return true;
  return t.isIdentifier(node, { name: "undefined" }) || t.isNullLiteral(node);
}

function collectBinaryParts(expr: t.BinaryExpression): t.Expression[] {
  const out: t.Expression[] = [];
  if (t.isBinaryExpression(expr.left) && expr.left.operator === "+") {
    out.push(...collectBinaryParts(expr.left));
  } else if (t.isExpression(expr.left)) {
    out.push(expr.left);
  }
  if (t.isBinaryExpression(expr.right) && expr.right.operator === "+") {
    out.push(...collectBinaryParts(expr.right));
  } else if (t.isExpression(expr.right)) {
    out.push(expr.right);
  }
  return out;
}

function containsDateGetter(node: t.Node): boolean {
  let found = false;
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.property) &&
    DATE_GETTER_NAMES.has(node.callee.property.name)
  ) {
    return true;
  }
  if (t.isBinaryExpression(node)) {
    return containsDateGetter(node.left) || containsDateGetter(node.right);
  }
  if (t.isCallExpression(node)) {
    if (t.isMemberExpression(node.callee) && containsDateGetter(node.callee.object)) return true;
    for (const arg of node.arguments) {
      if (containsDateGetter(arg)) {
        found = true;
        break;
      }
    }
  }
  return found;
}

/**
 * Scan JS/TS/JSX/TSX code for locale-unsafe hardcoded formatting idioms:
 * 1. `.toFixed(...)` on displayed values
 * 2. `.toLocaleString()` / `.toLocaleDateString()` / `.toLocaleTimeString()` / `new Intl.*Format()` without a locale arg
 * 3. Currency symbol concatenation (`"$" + price`, `` `$${amount}` ``)
 * 4. Dates manually assembled from `getMonth()`/`getDate()`/`getFullYear()` parts
 * 5. `.toUpperCase()` / `.toLowerCase()` on user-visible text (breaks Turkish I/İ/ı/i & German ß)
 * 6. `.localeCompare(b)` without an explicit locale argument
 */
export function scanHardcodedFormattingInJs(
  relFile: string,
  sourceCode: string,
  lineOffset = 0
): HardcodedFormattingFinding[] {
  const findings: HardcodedFormattingFinding[] = [];
  const lines = sourceCode.split(/\r?\n/);
  const getSnippet = (line: number) => (lines[line - 1] ?? "").trim().slice(0, 120);

  let ast: t.File;
  try {
    ast = babelParse(sourceCode, {
      sourceType: "unambiguous",
      plugins: [
        "jsx",
        "typescript",
        "decorators-legacy",
        "classProperties",
        "objectRestSpread",
        "dynamicImport",
      ],
      errorRecovery: true,
    });
  } catch {
    return findings;
  }

  const seen = new Set<string>();
  const push = (
    node: t.Node,
    rule: FormattingRuleId,
    suggestion: string
  ) => {
    const rawLine = node.loc?.start.line ?? 1;
    const line = rawLine + lineOffset;
    const col = node.loc?.start.column ?? 0;
    const key = `${line}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      file: relFile,
      line,
      column: col,
      rule,
      snippet: getSnippet(rawLine),
      suggestion,
    });
  };

  traverse(ast, {
    CallExpression(p) {
      if (isInsideLoggerOrError(p)) return;
      const callee = p.node.callee;
      if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.property)) return;
      const method = callee.property.name;

      // 1. toFixed() on displayed values (JSX, template literal, or string concatenation)
      if (method === "toFixed") {
        const displayed =
          isInsideJsxOrReturnDisplay(p) ||
          Boolean(p.findParent((anc) => t.isBinaryExpression(anc.node) && anc.node.operator === "+"));
        if (displayed) {
          push(
            p.node,
            "toFixed_displayed",
            "Avoid .toFixed() for displayed numbers (always uses ASCII '.' decimal separator). Use Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits })."
          );
        }
        return;
      }

      // 2. toLocaleString / toLocaleDateString / toLocaleTimeString called without an explicit locale
      if (
        method === "toLocaleString" ||
        method === "toLocaleDateString" ||
        method === "toLocaleTimeString"
      ) {
        if (p.node.arguments.length === 0 || isUndefinedExpr(p.node.arguments[0])) {
          push(
            p.node,
            "toLocaleString_missing_locale",
            `${method}() called without an explicit locale depends on host/browser defaults. Pass the active locale (e.g. ${method}(locale, options)) or use Intl.NumberFormat / Intl.DateTimeFormat.`
          );
        }
        return;
      }

      // 5. toUpperCase / toLowerCase on user-visible / JSX text (fails in Turkish i/İ/ı/I and German ß)
      if (method === "toUpperCase" || method === "toLowerCase") {
        // Skip clearly technical contexts (HTTP method, currency code, env var)
        const objName = t.isIdentifier(callee.object) ? callee.object.name.toLowerCase() : "";
        const isTechnical = /^(?:method|currency|code|id|key|slug|env|header|locale|lang|ext|tag)$/.test(objName);
        if (!isTechnical && isInsideJsxOrReturnDisplay(p)) {
          push(
            p.node,
            "case_transform_locale_unsafe",
            `${method}() is locale-unaware (corrupts Turkish i/İ/ı/I and German ß). Use .toLocale${method.slice(2)}(locale) or CSS text-transform with lang set.`
          );
        }
        return;
      }

      // 6. localeCompare without explicit locale argument (or Array.sort() with no comparator on UI strings)
      if (method === "localeCompare") {
        if (p.node.arguments.length < 2 || isUndefinedExpr(p.node.arguments[1])) {
          push(
            p.node,
            "localeCompare_missing_locale",
            "localeCompare() called without a locale argument uses runtime defaults. Pass the active locale: a.localeCompare(b, locale) or use Intl.Collator(locale)."
          );
        }
        return;
      }
    },

    NewExpression(p) {
      if (isInsideLoggerOrError(p)) return;
      const callee = p.node.callee;
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object, { name: "Intl" }) &&
        t.isIdentifier(callee.property) &&
        /^(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|Collator)$/.test(callee.property.name)
      ) {
        if (p.node.arguments.length === 0 || isUndefinedExpr(p.node.arguments[0])) {
          push(
            p.node,
            "intl_missing_locale",
            `new Intl.${callee.property.name}() called without an explicit locale argument. Pass the active app locale.`
          );
        }
      }
    },

    BinaryExpression(p) {
      if (p.node.operator !== "+") return;
      if (t.isBinaryExpression(p.parent) && p.parent.operator === "+") return;
      if (isInsideLoggerOrError(p)) return;

      const parts = collectBinaryParts(p.node);
      const hasDynamic = parts.some((pt) => !t.isStringLiteral(pt));
      if (!hasDynamic) return;

      // 3. Currency symbol concatenation: "$" + price
      const hasCurrencyLiteral = parts.some(
        (pt) => t.isStringLiteral(pt) && (CURRENCY_PREFIX_RE.test(pt.value) || CURRENCY_SUFFIX_RE.test(pt.value))
      );
      if (hasCurrencyLiteral) {
        push(
          p.node,
          "currency_concatenation",
          'Hardcoded currency concatenation (e.g. "$" + amount) breaks symbol placement and separators across locales. Use Intl.NumberFormat(locale, { style: "currency", currency }).'
        );
        return;
      }

      // 4. Dates built from parts: d.getMonth() + 1 + "/" + d.getDate()
      const dateGetterCount = parts.filter((pt) => containsDateGetter(pt)).length;
      const hasDateSep = parts.some((pt) => t.isStringLiteral(pt) && /^[/.-]$/.test(pt.value.trim()));
      if (dateGetterCount >= 2 && hasDateSep) {
        push(
          p.node,
          "manual_date_assembly",
          "Date assembled manually from numeric parts hardcodes date order (e.g. MM/DD vs DD/MM). Use Intl.DateTimeFormat(locale, options)."
        );
      }
    },

    TemplateLiteral(p) {
      if (p.node.expressions.length === 0) return;
      if (t.isTaggedTemplateExpression(p.parent)) return;
      if (isInsideLoggerOrError(p)) return;

      // 3. Template literal currency concatenation: `$${price}`
      const hasCurrencyQuasi = p.node.quasis.some((q) => {
        const raw = q.value.cooked ?? q.value.raw;
        return CURRENCY_PREFIX_RE.test(raw) || CURRENCY_SUFFIX_RE.test(raw);
      });
      if (hasCurrencyQuasi) {
        push(
          p.node,
          "currency_concatenation",
          'Hardcoded currency template literal (e.g. `$${price}`) breaks currency placement and decimals. Use Intl.NumberFormat(locale, { style: "currency", currency }).'
        );
        return;
      }

      // 4. Template literal date assembly: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
      const dateGetterExprs = p.node.expressions.filter((e) => containsDateGetter(e)).length;
      const joinedQuasis = p.node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
      if (dateGetterExprs >= 2 && /[/-]/.test(joinedQuasis)) {
        push(
          p.node,
          "manual_date_assembly",
          "Date formatted via template literal parts hardcodes locale date order. Use Intl.DateTimeFormat(locale, options)."
        );
      }
    },
  });

  return findings;
}
