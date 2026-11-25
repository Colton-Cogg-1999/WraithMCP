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
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import {
  discoverJsonLocaleFiles,
  getAllDependencies,
  inspectLayoutClasses,
  isLikelyUserFacingText,
  normalizeWhitespace,
  readPackageJson,
  USER_FACING_ATTRIBUTES,
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
const TOAST_METHODS = new Set(["success", "error", "info", "warning", "loading", "message", "custom"]);

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
} {
  const hardcodedStrings: HardcodedStringFinding[] = [];
  const concatenations: ConcatenationFinding[] = [];
  const usageByKey: Record<string, UsageSite[]> = {};
  const layoutRisks: LayoutRiskFinding[] = [];
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
  } catch {
    return { hardcodedStrings, concatenations, usageByKey, layoutRisks };
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

      // const { t } = useTranslation("common")
      if (calleeName === "useTranslation" && t.isObjectPattern(p.node.id)) {
        const arg0 = call.arguments[0];
        const ns = arg0 && t.isStringLiteral(arg0) ? arg0.value : "";
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

    JSXAttribute(p) {
      if (!t.isJSXIdentifier(p.node.name)) return;
      const attrName = p.node.name.name;

      // Inspect className / class for layout truncation & RTL physical-direction risks
      if (attrName === "className" || attrName === "class") {
        let cls: string | null = null;
        if (t.isStringLiteral(p.node.value)) {
          cls = p.node.value.value;
        } else if (
          t.isJSXExpressionContainer(p.node.value) &&
          t.isStringLiteral(p.node.value.expression)
        ) {
          cls = p.node.value.expression.value;
        }
        if (cls) {
          const line = (p.node.loc?.start.line ?? 1) + lineOffset;
          const comp = findEnclosingComponent(p);
          const snippet = getSnippet(p.node.loc?.start.line ?? 1);
          for (const risk of inspectLayoutClasses(cls)) {
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

      if (!USER_FACING_ATTRIBUTES.has(attrName)) return;

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

      if (matchedTranslator && p.node.arguments[0] && t.isStringLiteral(p.node.arguments[0])) {
        const rawKey = p.node.arguments[0].value;
        const ns = translatorNamespaces.get(matchedTranslator) ?? "";
        const fullKey = ns && !rawKey.startsWith(`${ns}.`) ? `${ns}.${rawKey}` : rawKey;
        usageByKey[fullKey] = usageByKey[fullKey] ?? [];
        usageByKey[fullKey].push({
          file: relFile,
          line,
          component: findEnclosingComponent(p),
          element: findEnclosingJsxElement(p),
          surrounding: extractSurroundingLabels(p),
        });
        return;
      }

      // 2. Toast / alert / notification hardcoded strings
      let isToastCall = false;
      if (t.isIdentifier(callee) && TOAST_CALLEES.has(callee.name)) {
        isToastCall = true;
      } else if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object) &&
        TOAST_CALLEES.has(callee.object.name) &&
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
      }
    },

    BinaryExpression(p) {
      if (p.node.operator !== "+") return;
      // Only inspect outermost '+' chain
      if (t.isBinaryExpression(p.parent) && p.parent.operator === "+") return;

      const parts = collectBinaryParts(p.node);
      const stringParts = parts.filter((part): part is t.StringLiteral => t.isStringLiteral(part));
      const dynamicParts = parts.filter((part) => !t.isStringLiteral(part));

      if (stringParts.length === 0 || dynamicParts.length === 0) return;

      const joined = stringParts.map((s) => s.value).join(" ");
      // Must look like a human phrase with spaces or letters, not URL/class/path concat
      if (
        isLikelyUserFacingText(joined) &&
        /[a-zA-Z\p{L}]{2,}/u.test(joined) &&
        !joined.startsWith("/") &&
        !joined.startsWith("http") &&
        stringParts.some((s) => /\s/.test(s.value) || /^[A-Z]/.test(s.value.trim()))
      ) {
        // Ignore console.log / Error constructor
        const parentCall = p.findParent((anc) => t.isCallExpression(anc.node));
        if (parentCall && t.isCallExpression(parentCall.node)) {
          const c = parentCall.node.callee;
          if (
            t.isMemberExpression(c) &&
            t.isIdentifier(c.object, { name: "console" })
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
      // Skip tagged templates (css`...`, sql`...`)
      if (t.isTaggedTemplateExpression(p.parent)) return;
      // Skip console.* / Error / className / href / src
      const parentAttr = p.findParent((anc) => t.isJSXAttribute(anc.node));
      if (
        parentAttr &&
        t.isJSXAttribute(parentAttr.node) &&
        t.isJSXIdentifier(parentAttr.node.name) &&
        !USER_FACING_ATTRIBUTES.has(parentAttr.node.name.name)
      ) {
        return;
      }
      const parentCall = p.findParent((anc) => t.isCallExpression(anc.node));
      if (parentCall && t.isCallExpression(parentCall.node)) {
        const c = parentCall.node.callee;
        if (t.isMemberExpression(c) && t.isIdentifier(c.object, { name: "console" })) {
          return;
        }
      }
      if (p.findParent((anc) => t.isNewExpression(anc.node))) return;

      const quasiText = p.node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
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

  return { hardcodedStrings, concatenations, usageByKey, layoutRisks };
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
      (f) => !f.endsWith(".d.ts") && !f.includes(".test.") && !f.includes(".spec.") && !f.includes("next.config.")
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const code = fs.readFileSync(absFile, "utf8");
      const res = scanJsTsFile(absFile, relFile, code);
      hardcodedStrings.push(...res.hardcodedStrings);
      concatenations.push(...res.concatenations);
      layoutRisks.push(...res.layoutRisks);
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
