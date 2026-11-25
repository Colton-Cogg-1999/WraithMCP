import fs from "node:fs";
import path from "node:path";
import { parse as babelParse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { JsonFormatAdapter } from "../formats/json.js";
import { PlaceholderSyntax } from "../formats/types.js";
import {
  ConcatenationFinding,
  FrameworkDetection,
  HardcodedStringFinding,
  LayoutRiskFinding,
  ParseFailure,
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import {
  discoverJsonLocaleFiles,
  getAllDependencies,
  inspectLayoutClasses,
  isLikelyUserFacingText,
  isUserFacingPropName,
  normalizeWhitespace,
  readPackageJson,
  walkFiles,
} from "./utils.js";

// Handle ESM/CJS interop for @babel/traverse under NodeNext
type TraverseFn = typeof _traverse.default;
const traverse: TraverseFn =
  typeof _traverse === "function"
    ? (_traverse as unknown as TraverseFn)
    : _traverse.default;

const REACT_EXTS = new Set([".tsx", ".jsx", ".ts", ".js", ".mjs"]);
const TOAST_CALLEES = new Set(["toast", "alert", "confirm", "notify"]);
const TOAST_METHODS = new Set(["success", "error", "info", "warning", "loading", "message", "custom", "alert", "confirm"]);
const LOGGER_CALLEES = new Set(["console", "logger", "log", "pino", "winston", "debug"]);
const ZOD_VALIDATION_METHODS = new Set(["email", "min", "max", "length", "regex", "url", "uuid", "nonempty", "refine", "superRefine"]);
const SQL_QUERY_RE = /^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|WITH)\b/i;
const AUTH_HEADER_PREFIX_RE = /^(?:Bearer|Basic|Token|Digest|ApiKey)\s+$/i;
const CLASS_HELPER_CALLEES = new Set(["cn", "clsx", "classNames", "classnames", "twMerge", "cva"]);

function extractClassLiteralsFromExpr(expr: t.Expression | t.JSXEmptyExpression): string[] {
  const out: string[] = [];
  if (t.isStringLiteral(expr)) {
    out.push(expr.value);
  } else if (t.isTemplateLiteral(expr)) {
    for (const q of expr.quasis) {
      if (q.value.cooked) out.push(q.value.cooked);
    }
    for (const e of expr.expressions) {
      if (t.isExpression(e)) out.push(...extractClassLiteralsFromExpr(e));
    }
  } else if (t.isCallExpression(expr)) {
    const callee = expr.callee;
    const isHelper = t.isIdentifier(callee) && CLASS_HELPER_CALLEES.has(callee.name);
    if (isHelper) {
      for (const arg of expr.arguments) {
        if (t.isExpression(arg)) out.push(...extractClassLiteralsFromExpr(arg));
      }
    }
  } else if (t.isLogicalExpression(expr)) {
    out.push(...extractClassLiteralsFromExpr(expr.left), ...extractClassLiteralsFromExpr(expr.right));
  } else if (t.isConditionalExpression(expr)) {
    out.push(...extractClassLiteralsFromExpr(expr.consequent), ...extractClassLiteralsFromExpr(expr.alternate));
  } else if (t.isArrayExpression(expr)) {
    for (const el of expr.elements) {
      if (el && t.isExpression(el)) out.push(...extractClassLiteralsFromExpr(el));
    }
  } else if (t.isObjectExpression(expr)) {
    for (const prop of expr.properties) {
      if (t.isObjectProperty(prop) && t.isStringLiteral(prop.key)) {
        out.push(prop.key.value);
      }
    }
  }
  return out;
}

function collectJsxExprStrings(
  expr: t.Expression | t.JSXEmptyExpression,
  out: Array<{ text: string; line: number; col: number }>
): void {
  if (t.isStringLiteral(expr)) {
    if (isLikelyUserFacingText(expr.value)) {
      out.push({
        text: normalizeWhitespace(expr.value),
        line: expr.loc?.start.line ?? 1,
        col: expr.loc?.start.column ?? 0,
      });
    }
  } else if (t.isConditionalExpression(expr)) {
    collectJsxExprStrings(expr.consequent, out);
    collectJsxExprStrings(expr.alternate, out);
  } else if (t.isLogicalExpression(expr)) {
    if (expr.operator === "&&" || expr.operator === "||" || expr.operator === "??") {
      collectJsxExprStrings(expr.right, out);
      if (expr.operator !== "&&") collectJsxExprStrings(expr.left, out);
    }
  }
}

function getJsxTagName(opening: t.JSXOpeningElement): string {
  if (t.isJSXIdentifier(opening.name)) return opening.name.name;
  if (t.isJSXMemberExpression(opening.name)) {
    return `${t.isJSXIdentifier(opening.name.object) ? opening.name.object.name : ""}.${opening.name.property.name}`;
  }
  return "element";
}

function findEnclosingComponent(nodePath: NodePath): string | undefined {
  let curr: NodePath | null = nodePath;
  while (curr) {
    const n = curr.node;
    if (t.isFunctionDeclaration(n) && n.id?.name) return n.id.name;
    if (t.isClassDeclaration(n) && n.id?.name) return n.id.name;
    if (
      (t.isArrowFunctionExpression(n) || t.isFunctionExpression(n)) &&
      curr.parentPath &&
      t.isVariableDeclarator(curr.parentPath.node) &&
      t.isIdentifier(curr.parentPath.node.id)
    ) {
      return curr.parentPath.node.id.name;
    }
    curr = curr.parentPath;
  }
  return undefined;
}

function findEnclosingJsxElement(nodePath: NodePath): string | undefined {
  let curr: NodePath | null = nodePath.parentPath;
  while (curr) {
    if (t.isJSXElement(curr.node)) {
      return getJsxTagName(curr.node.openingElement);
    }
    curr = curr.parentPath;
  }
  return undefined;
}

function extractSurroundingLabels(nodePath: NodePath): string[] {
  const labels = new Set<string>();
  // Walk up to nearest component/function or enclosing JSX container
  let container: NodePath | null = nodePath.parentPath;
  let steps = 0;
  while (container && steps < 4) {
    if (t.isJSXElement(container.node) && container.node.children.length > 1) {
      break;
    }
    if (
      t.isFunctionDeclaration(container.node) ||
      t.isArrowFunctionExpression(container.node)
    ) {
      break;
    }
    container = container.parentPath;
    steps++;
  }
  if (!container) return [];

  container.traverse({
    JSXText(p) {
      const txt = normalizeWhitespace(p.node.value);
      if (txt && txt.length <= 40 && isLikelyUserFacingText(txt)) {
        labels.add(txt);
      }
    },
    CallExpression(p) {
      if (
        t.isIdentifier(p.node.callee) &&
        p.node.callee.name === "t" &&
        p.node.arguments[0] &&
        t.isStringLiteral(p.node.arguments[0])
      ) {
        labels.add(`key:${p.node.arguments[0].value}`);
      }
    },
  });

  return [...labels].sort().slice(0, 8);
}

function collectBinaryParts(expr: t.BinaryExpression): t.Expression[] {
  const parts: t.Expression[] = [];
  if (t.isBinaryExpression(expr.left) && expr.left.operator === "+") {
    parts.push(...collectBinaryParts(expr.left));
  } else if (t.isExpression(expr.left)) {
    parts.push(expr.left);
  }
  if (t.isBinaryExpression(expr.right) && expr.right.operator === "+") {
    parts.push(...collectBinaryParts(expr.right));
  } else if (t.isExpression(expr.right)) {
    parts.push(expr.right);
  }
  return parts;
}

export function scanJsTsFile(
  absFile: string,
  relFile: string,
  sourceCode: string,
  options?: { lineOffset?: number }
): {
  hardcodedStrings: HardcodedStringFinding[];
  concatenations: ConcatenationFinding[];
  usageByKey: Record<string, UsageSite[]>;
  layoutRisks: LayoutRiskFinding[];
  parseFailures: ParseFailure[];
  dynamicKeyNamespaces: string[];
} {
  const hardcodedStrings: HardcodedStringFinding[] = [];
  const concatenations: ConcatenationFinding[] = [];
  const usageByKey: Record<string, UsageSite[]> = {};
  const layoutRisks: LayoutRiskFinding[] = [];
  const parseFailures: ParseFailure[] = [];
  const dynamicKeyNamespaces = new Set<string>();
  const lineOffset = options?.lineOffset ?? 0;

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
    const astErrors = (ast as unknown as { errors?: Array<{ message?: string }> }).errors;
    if (Array.isArray(astErrors) && astErrors.length > 0) {
      parseFailures.push({
        file: relFile,
        error: astErrors[0]?.message ?? "Syntax error during Babel parse",
      });
    }
  } catch (err) {
    parseFailures.push({
      file: relFile,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      hardcodedStrings,
      concatenations,
      usageByKey,
      layoutRisks,
      parseFailures,
      dynamicKeyNamespaces: [],
    };
  }

  // Track translator variable -> namespace (e.g. const t = useTranslations('nav') -> { t: 'nav' })
  const translatorNamespaces = new Map<string, string>();
  const lines = sourceCode.split(/\r?\n/);
  const getSnippet = (line: number) => (lines[line - 1] ?? "").trim().slice(0, 120);

  // First pass: find translator bindings
  traverse(ast, {
    VariableDeclarator(p) {
      const init = p.node.init;
      if (!init) return;

      // const t = useTranslations("home") or await getTranslations("home")
      const call = t.isAwaitExpression(init) ? init.argument : init;
      if (!t.isCallExpression(call)) return;

      const calleeName = t.isIdentifier(call.callee) ? call.callee.name : "";
      if (calleeName === "useTranslations" || calleeName === "getTranslations") {
        let ns = "";
        const arg0 = call.arguments[0];
        if (arg0 && t.isStringLiteral(arg0)) {
          ns = arg0.value;
        } else if (arg0 && t.isObjectExpression(arg0)) {
          const nsProp = arg0.properties.find(
            (prop): prop is t.ObjectProperty =>
              t.isObjectProperty(prop) &&
              t.isIdentifier(prop.key, { name: "namespace" }) &&
              t.isStringLiteral(prop.value)
          );
          if (nsProp && t.isStringLiteral(nsProp.value)) ns = nsProp.value.value;
        }
        if (t.isIdentifier(p.node.id)) {
          translatorNamespaces.set(p.node.id.name, ns);
        }
      }

      // const { t } = useTranslation("common") or useTranslation(["common", "auth"])
      if (calleeName === "useTranslation" && t.isObjectPattern(p.node.id)) {
        const arg0 = call.arguments[0];
        let ns = "";
        if (arg0 && t.isStringLiteral(arg0)) {
          ns = arg0.value;
        } else if (arg0 && t.isArrayExpression(arg0)) {
          const first = arg0.elements[0];
          if (first && t.isStringLiteral(first)) ns = first.value;
        }
        for (const prop of p.node.id.properties) {
          if (
            t.isObjectProperty(prop) &&
            t.isIdentifier(prop.key, { name: "t" }) &&
            t.isIdentifier(prop.value)
          ) {
            translatorNamespaces.set(prop.value.name, ns);
          }
        }
      }
    },
  });

  // Second pass: scan strings, concatenations, and key usages
  traverse(ast, {
    JSXElement(p) {
      const tagName = getJsxTagName(p.node.openingElement);
      // Skip <script>, <style>, <code>, <pre>
      if (["script", "style", "code", "pre"].includes(tagName.toLowerCase())) {
        return;
      }

      // Detect <Trans i18nKey="...">
      if (tagName === "Trans") {
        const keyAttr = p.node.openingElement.attributes.find(
          (a): a is t.JSXAttribute =>
            t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "i18nKey" })
        );
        if (keyAttr && t.isStringLiteral(keyAttr.value)) {
          const key = keyAttr.value.value;
          const line = (p.node.loc?.start.line ?? 1) + lineOffset;
          usageByKey[key] = usageByKey[key] ?? [];
          usageByKey[key].push({
            file: relFile,
            line,
            component: findEnclosingComponent(p),
            element: "Trans",
            surrounding: extractSurroundingLabels(p),
          });
        }
        return;
      }

      // Detect sentence-fragment JSX children like <p>You have {count} items</p>
      const meaningfulChildren = p.node.children.filter((c) => {
        if (t.isJSXText(c)) return normalizeWhitespace(c.value).length > 0;
        if (t.isJSXExpressionContainer(c) && !t.isJSXEmptyExpression(c.expression)) return true;
        return false;
      });
      const textChildren = meaningfulChildren.filter((c): c is t.JSXText => t.isJSXText(c));
      const exprChildren = meaningfulChildren.filter((c): c is t.JSXExpressionContainer =>
        t.isJSXExpressionContainer(c)
      );

      if (textChildren.length >= 1 && exprChildren.length >= 1) {
        const combinedText = textChildren.map((c) => normalizeWhitespace(c.value)).join(" ");
        const hasDynamicExpr = exprChildren.some(
          (e) =>
            !t.isCallExpression(e.expression) ||
            !(
              t.isIdentifier(e.expression.callee) &&
              (e.expression.callee.name === "t" ||
                translatorNamespaces.has(e.expression.callee.name))
            )
        );
        if (hasDynamicExpr && isLikelyUserFacingText(combinedText)) {
          const line = (p.node.loc?.start.line ?? 1) + lineOffset;
          concatenations.push({
            file: relFile,
            line,
            column: p.node.loc?.start.column ?? 0,
            expression: getSnippet(p.node.loc?.start.line ?? 1),
            reason: `Sentence split across JSX text and expression inside <${tagName}>. Extract as a single parameterized translation key.`,
            component: findEnclosingComponent(p),
          });
        }
      }
    },

    JSXText(p) {
      const parentEl = p.parentPath?.node;
      if (t.isJSXElement(parentEl)) {
        const tag = getJsxTagName(parentEl.openingElement);
        if (["script", "style", "code", "pre", "Trans"].includes(tag)) return;
      }
      const text = normalizeWhitespace(p.node.value);
      if (!isLikelyUserFacingText(text)) return;

      const line = (p.node.loc?.start.line ?? 1) + lineOffset;
      hardcodedStrings.push({
        file: relFile,
        line,
        column: p.node.loc?.start.column ?? 0,
        text,
        kind: "jsx-text",
        component: findEnclosingComponent(p),
        snippet: getSnippet(p.node.loc?.start.line ?? 1),
      });
    },

    JSXExpressionContainer(p) {
      // Only inspect JSX child expressions (not JSXAttribute values, which JSXAttribute handles)
      if (t.isJSXAttribute(p.parent)) return;
      const found: Array<{ text: string; line: number; col: number }> = [];
      collectJsxExprStrings(p.node.expression, found);
      const comp = findEnclosingComponent(p);
      for (const f of found) {
        hardcodedStrings.push({
          file: relFile,
          line: f.line + lineOffset,
          column: f.col,
          text: f.text,
          kind: "jsx-text",
          component: comp,
          snippet: getSnippet(f.line),
        });
      }
    },

    AssignmentPattern(p) {
      // Component default props: { heading = "No projects yet", description = "..." }
      if (t.isIdentifier(p.node.left) && t.isStringLiteral(p.node.right)) {
        if (isUserFacingPropName(p.node.left.name) && isLikelyUserFacingText(p.node.right.value)) {
          const line = (p.node.right.loc?.start.line ?? 1) + lineOffset;
          hardcodedStrings.push({
            file: relFile,
            line,
            column: p.node.right.loc?.start.column ?? 0,
            text: normalizeWhitespace(p.node.right.value),
            kind: "attribute",
            attribute: p.node.left.name,
            component: findEnclosingComponent(p),
            snippet: getSnippet(p.node.right.loc?.start.line ?? 1),
          });
        }
      }
    },

    VariableDeclarator(p) {
      // Next.js `export const metadata = { title: "...", description: "..." }`
      // and module-level user message maps like `ERROR_MESSAGES = { network: "Check your internet..." }`
      if (!t.isIdentifier(p.node.id) || !p.node.init || !t.isObjectExpression(p.node.init)) return;
      const varName = p.node.id.name;
      const isMetadata = varName === "metadata";
      const isMessageMap = /(?:MESSAGE|ERROR|LABEL|COPY|TEXT|TITLE|PROMPT|ALERT)/i.test(varName);
      if (!isMetadata && !isMessageMap) return;

      for (const prop of p.node.init.properties) {
        if (!t.isObjectProperty(prop) || !t.isStringLiteral(prop.value)) continue;
        const propName = t.isIdentifier(prop.key)
          ? prop.key.name
          : t.isStringLiteral(prop.key)
            ? prop.key.value
            : "";
        if (isMetadata && !["title", "description", "applicationName"].includes(propName)) continue;
        if (!isLikelyUserFacingText(prop.value.value)) continue;
        const line = (prop.value.loc?.start.line ?? 1) + lineOffset;
        hardcodedStrings.push({
          file: relFile,
          line,
          column: prop.value.loc?.start.column ?? 0,
          text: normalizeWhitespace(prop.value.value),
          kind: "attribute",
          attribute: propName || varName,
          component: varName,
          snippet: getSnippet(prop.value.loc?.start.line ?? 1),
        });
      }
    },

    LogicalExpression(p) {
      // Fallback user message in helper functions: `ERROR_MESSAGES[code] ?? "Unknown error"`
      if (p.node.operator !== "??" && p.node.operator !== "||") return;
      if (p.findParent((anc) => t.isJSXExpressionContainer(anc.node))) return;
      if (!t.isStringLiteral(p.node.right)) return;
      const txt = normalizeWhitespace(p.node.right.value);
      if (!isLikelyUserFacingText(txt) || !txt.includes(" ")) return;
      if (t.isMemberExpression(p.node.left)) {
        const line = (p.node.right.loc?.start.line ?? 1) + lineOffset;
        hardcodedStrings.push({
          file: relFile,
          line,
          column: p.node.right.loc?.start.column ?? 0,
          text: txt,
          kind: "jsx-text",
          component: findEnclosingComponent(p),
          snippet: getSnippet(p.node.right.loc?.start.line ?? 1),
        });
      }
    },

    JSXAttribute(p) {
      if (!t.isJSXIdentifier(p.node.name)) return;
      const attrName = p.node.name.name;

      // Inspect className / class (static strings, template literals, AND cn()/clsx()/twMerge())
      if (attrName === "className" || attrName === "class") {
        const classStrings: string[] = [];
        if (t.isStringLiteral(p.node.value)) {
          classStrings.push(p.node.value.value);
        } else if (t.isJSXExpressionContainer(p.node.value)) {
          classStrings.push(...extractClassLiteralsFromExpr(p.node.value.expression));
        }
        const combined = classStrings.join(" ").trim();
        if (combined) {
          const line = (p.node.loc?.start.line ?? 1) + lineOffset;
          const comp = findEnclosingComponent(p);
          const snippet = getSnippet(p.node.loc?.start.line ?? 1);
          for (const risk of inspectLayoutClasses(combined)) {
            layoutRisks.push({
              file: relFile,
              line,
              kind: risk.kind,
              constraint: risk.constraint,
              component: comp,
              suggestion: risk.suggestion,
              snippet,
            });
          }
        }
        return;
      }

      if (!isUserFacingPropName(attrName)) return;

      let literalText: string | null = null;
      if (t.isStringLiteral(p.node.value)) {
        literalText = p.node.value.value;
      } else if (
        t.isJSXExpressionContainer(p.node.value) &&
        t.isStringLiteral(p.node.value.expression)
      ) {
        literalText = p.node.value.expression.value;
      }

      if (literalText && isLikelyUserFacingText(literalText)) {
        const line = (p.node.loc?.start.line ?? 1) + lineOffset;
        hardcodedStrings.push({
          file: relFile,
          line,
          column: p.node.loc?.start.column ?? 0,
          text: normalizeWhitespace(literalText),
          kind: "attribute",
          attribute: attrName,
          component: findEnclosingComponent(p),
          snippet: getSnippet(p.node.loc?.start.line ?? 1),
        });
      }
    },

    CallExpression(p) {
      const callee = p.node.callee;
      const line = (p.node.loc?.start.line ?? 1) + lineOffset;

      // 1. i18n key usage: t("key"), i18n.t("key"), or custom translator variable
      let matchedTranslator: string | null = null;
      if (t.isIdentifier(callee)) {
        if (callee.name === "t" || callee.name === "$t" || translatorNamespaces.has(callee.name)) {
          matchedTranslator = callee.name;
        }
      } else if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        (callee.property.name === "t" || callee.property.name === "rich" || callee.property.name === "raw")
      ) {
        if (t.isIdentifier(callee.object)) {
          if (
            callee.object.name === "i18n" ||
            callee.object.name === "i18next" ||
            callee.object.name === "t" ||
            translatorNamespaces.has(callee.object.name)
          ) {
            matchedTranslator = callee.object.name;
          }
        }
      }

      if (matchedTranslator && p.node.arguments[0]) {
        const arg0 = p.node.arguments[0];
        const ns = translatorNamespaces.get(matchedTranslator) ?? "";
        if (t.isStringLiteral(arg0)) {
          // Support react-i18next namespace separator `t("common:save")` -> `common.save`
          const rawKey = arg0.value.includes(":")
            ? arg0.value.replace(":", ".")
            : arg0.value;
          const fullKey =
            !arg0.value.includes(":") && ns && !rawKey.startsWith(`${ns}.`)
              ? `${ns}.${rawKey}`
              : rawKey;
          usageByKey[fullKey] = usageByKey[fullKey] ?? [];
          usageByKey[fullKey].push({
            file: relFile,
            line,
            component: findEnclosingComponent(p),
            element: findEnclosingJsxElement(p),
            surrounding: extractSurroundingLabels(p),
          });
        } else {
          // Dynamic key usage (e.g. t(item.labelKey), t(code)) -> record namespace uncertainty
          dynamicKeyNamespaces.add(ns || "*");
        }
        return;
      }

      // 2. Toast / alert / window.alert / notification hardcoded strings
      let isToastCall = false;
      if (t.isIdentifier(callee) && TOAST_CALLEES.has(callee.name)) {
        isToastCall = true;
      } else if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object) &&
        (TOAST_CALLEES.has(callee.object.name) || callee.object.name === "window") &&
        t.isIdentifier(callee.property) &&
        TOAST_METHODS.has(callee.property.name)
      ) {
        isToastCall = true;
      }

      if (isToastCall && p.node.arguments[0]) {
        const arg0 = p.node.arguments[0];
        if (t.isStringLiteral(arg0) && isLikelyUserFacingText(arg0.value)) {
          hardcodedStrings.push({
            file: relFile,
            line,
            column: p.node.loc?.start.column ?? 0,
            text: normalizeWhitespace(arg0.value),
            kind: "toast",
            component: findEnclosingComponent(p),
            snippet: getSnippet(p.node.loc?.start.line ?? 1),
          });
        }
        return;
      }

      // 3. Schema validation messages (e.g. z.string().email("Please enter a valid email address"))
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property) &&
        ZOD_VALIDATION_METHODS.has(callee.property.name)
      ) {
        for (const arg of p.node.arguments) {
          if (t.isStringLiteral(arg) && isLikelyUserFacingText(arg.value) && arg.value.includes(" ")) {
            hardcodedStrings.push({
              file: relFile,
              line,
              column: arg.loc?.start.column ?? 0,
              text: normalizeWhitespace(arg.value),
              kind: "toast",
              component: findEnclosingComponent(p),
              snippet: getSnippet(p.node.loc?.start.line ?? 1),
            });
          }
        }
      }
    },

    BinaryExpression(p) {
      if (p.node.operator !== "+") return;
      if (t.isBinaryExpression(p.parent) && p.parent.operator === "+") return;

      const parts = collectBinaryParts(p.node);
      const stringParts = parts.filter((part): part is t.StringLiteral => t.isStringLiteral(part));
      const dynamicParts = parts.filter((part) => !t.isStringLiteral(part));

      if (stringParts.length === 0 || dynamicParts.length === 0) return;

      // Suppress HTTP auth headers ("Bearer " + token) and header objects
      if (stringParts.some((s) => AUTH_HEADER_PREFIX_RE.test(s.value))) return;
      const parentObjProp = p.findParent((anc) => t.isObjectProperty(anc.node));
      if (
        parentObjProp &&
        t.isObjectProperty(parentObjProp.node) &&
        t.isIdentifier(parentObjProp.node.key) &&
        /^(?:authorization|cookie|accept|content-type|x-)/i.test(parentObjProp.node.key.name)
      ) {
        return;
      }

      const joined = stringParts.map((s) => s.value).join(" ");
      if (SQL_QUERY_RE.test(joined)) return;

      if (
        isLikelyUserFacingText(joined) &&
        /[a-zA-Z\p{L}]{2,}/u.test(joined) &&
        !joined.startsWith("/") &&
        !joined.startsWith("http") &&
        stringParts.some((s) => /\s/.test(s.value) || /^[A-Z]/.test(s.value.trim()))
      ) {
        const parentCall = p.findParent((anc) => t.isCallExpression(anc.node));
        if (parentCall && t.isCallExpression(parentCall.node)) {
          const c = parentCall.node.callee;
          if (
            t.isMemberExpression(c) &&
            t.isIdentifier(c.object) &&
            LOGGER_CALLEES.has(c.object.name)
          ) {
            return;
          }
        }
        const parentNew = p.findParent((anc) => t.isNewExpression(anc.node));
        if (parentNew && t.isNewExpression(parentNew.node)) {
          return;
        }

        const line = (p.node.loc?.start.line ?? 1) + lineOffset;
        concatenations.push({
          file: relFile,
          line,
          column: p.node.loc?.start.column ?? 0,
          expression: getSnippet(p.node.loc?.start.line ?? 1),
          reason: "String concatenation with '+' breaks word order in other languages. Use a parameterized translation string.",
          component: findEnclosingComponent(p),
        });
      }
    },

    TemplateLiteral(p) {
      if (p.node.expressions.length === 0) return;
      if (t.isTaggedTemplateExpression(p.parent)) return;

      // Skip non-user-facing JSX attributes (className, href, src, etc.)
      const parentAttr = p.findParent((anc) => t.isJSXAttribute(anc.node));
      if (
        parentAttr &&
        t.isJSXAttribute(parentAttr.node) &&
        t.isJSXIdentifier(parentAttr.node.name) &&
        !isUserFacingPropName(parentAttr.node.name.name)
      ) {
        return;
      }
      // Skip logger/console calls (logger.info(`User ${u} signed in`))
      const parentCall = p.findParent((anc) => t.isCallExpression(anc.node));
      if (parentCall && t.isCallExpression(parentCall.node)) {
        const c = parentCall.node.callee;
        if (
          (t.isMemberExpression(c) && t.isIdentifier(c.object) && LOGGER_CALLEES.has(c.object.name)) ||
          (t.isIdentifier(c) && LOGGER_CALLEES.has(c.name))
        ) {
          return;
        }
      }
      if (p.findParent((anc) => t.isNewExpression(anc.node))) return;

      const quasiText = p.node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
      // Skip SQL queries & URL paths
      if (SQL_QUERY_RE.test(quasiText)) return;
      if (p.node.quasis[0]?.value.raw.trimStart().startsWith("/")) return;

      if (
        isLikelyUserFacingText(quasiText) &&
        p.node.quasis.some((q) => /\p{L}{2,}\s|\s\p{L}{2,}/u.test(q.value.raw))
      ) {
        const line = (p.node.loc?.start.line ?? 1) + lineOffset;
        concatenations.push({
          file: relFile,
          line,
          column: p.node.loc?.start.column ?? 0,
          expression: getSnippet(p.node.loc?.start.line ?? 1),
          reason: "Template literal sentence fragment breaks translation grammar/plurals. Use a parameterized translation key.",
          component: findEnclosingComponent(p),
        });
      }
    },
  });

  return {
    hardcodedStrings,
    concatenations,
    usageByKey,
    layoutRisks,
    parseFailures,
    dynamicKeyNamespaces: [...dynamicKeyNamespaces],
  };
}

export class ReactNextAdapter implements ScannerAdapter {
  readonly id = "react-nextjs";
  readonly frameworks = ["nextjs", "react"] as const;
  readonly format = new JsonFormatAdapter("json-react", ["icu", "double-mustache"]);

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pkg = readPackageJson(rootDir);
    const deps = getAllDependencies(pkg);

    const hasNext =
      Boolean(deps["next"]) ||
      fs.existsSync(path.join(rootDir, "next.config.js")) ||
      fs.existsSync(path.join(rootDir, "next.config.mjs")) ||
      fs.existsSync(path.join(rootDir, "next.config.ts"));
    const hasReact = Boolean(deps["react"]) || Boolean(deps["react-dom"]);

    if (!hasNext && !hasReact) return null;

    let i18nLibrary: string | null = null;
    let placeholderSyntaxes: PlaceholderSyntax[] = ["icu", "double-mustache"];
    if (deps["next-intl"]) {
      i18nLibrary = "next-intl";
      placeholderSyntaxes = ["icu"];
    } else if (deps["react-i18next"] || deps["i18next"]) {
      i18nLibrary = "react-i18next";
      placeholderSyntaxes = ["double-mustache", "icu"];
    }

    const candidates = [
      ...(localesPathOverride ? [localesPathOverride] : []),
      "messages",
      "src/messages",
      "locales",
      "src/locales",
      "public/locales",
      "i18n",
      "src/i18n",
    ];
    const { localesDir, localeFiles } = discoverJsonLocaleFiles(rootDir, candidates);

    const notes: string[] = [];
    if (!i18nLibrary) {
      notes.push("No i18n library detected in package.json (recommended: next-intl for Next.js, react-i18next for React).");
    }

    return {
      framework: hasNext ? "nextjs" : "react",
      i18nLibrary,
      confidence: hasNext ? 0.95 : 0.9,
      localesDir,
      localeFiles,
      placeholderSyntaxes,
      notes,
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, REACT_EXTS).filter(
      (f) => {
        const rel = path.relative(rootDir, f).replace(/\\/g, "/");
        return (
          !rel.endsWith(".d.ts") &&
          !rel.includes(".test.") &&
          !rel.includes(".spec.") &&
          !rel.includes("next.config.") &&
          !rel.startsWith("audit/")
        );
      }
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];
    const parseFailures: ParseFailure[] = [];
    const dynamicKeyNamespaces = new Set<string>();

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const code = fs.readFileSync(absFile, "utf8");
      const res = scanJsTsFile(absFile, relFile, code);
      hardcodedStrings.push(...res.hardcodedStrings);
      concatenations.push(...res.concatenations);
      layoutRisks.push(...res.layoutRisks);
      parseFailures.push(...res.parseFailures);
      for (const ns of res.dynamicKeyNamespaces) dynamicKeyNamespaces.add(ns);
      for (const [k, sites] of Object.entries(res.usageByKey)) {
        usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
      }
    }

    return {
      filesScanned: files.length,
      hardcodedStrings,
      concatenations,
      usageByKey,
      layoutRisks,
      parseFailures,
      dynamicKeyNamespaces: [...dynamicKeyNamespaces],
    };
  }

  resolveTargetLocaleFile(
    rootDir: string,
    sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    const safeLocale = validateLocaleTag(targetLocale, "targetLocale");
    const confinedSource = resolveConfinedPath(rootDir, sourceFile, { label: "sourceFile" });
    const dir = path.dirname(confinedSource);
    const base = path.basename(confinedSource);
    let candidate: string;
    if (base === `${sourceLocale}.json`) {
      candidate = path.join(dir, `${safeLocale}.json`);
    } else if (path.basename(dir) === sourceLocale) {
      candidate = path.join(path.dirname(dir), safeLocale, base);
    } else {
      candidate = path.join(dir, `${safeLocale}.json`);
    }
    return resolveConfinedPath(rootDir, candidate, { label: "targetLocaleFile" });
  }
}
