import fs from "node:fs";
import path from "node:path";
import { parse as parseSvelte } from "svelte/compiler";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { JsonFormatAdapter } from "../formats/json.js";
import { scanJsTsFile } from "./react.js";
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

const SVELTE_EXTS = new Set([".svelte", ".ts", ".js"]);

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

interface SvelteNode {
  type?: string;
  name?: string;
  data?: string;
  raw?: string;
  start?: number;
  end?: number;
  attributes?: SvelteNode[];
  value?: SvelteNode[] | SvelteNode | boolean;
  fragment?: { nodes?: SvelteNode[] };
  nodes?: SvelteNode[];
  body?: SvelteNode;
  consequent?: SvelteNode;
  alternate?: SvelteNode;
  expression?: { start?: number; end?: number };
}

function walkSvelteNode(
  node: SvelteNode | undefined,
  source: string,
  relFile: string,
  componentName: string,
  lines: string[],
  out: {
    hardcoded: HardcodedStringFinding[];
    concats: ConcatenationFinding[];
    usageByKey: Record<string, UsageSite[]>;
    layoutRisks: LayoutRiskFinding[];
  },
  parentTag?: string
): void {
  if (!node || typeof node !== "object") return;
  const line = offsetToLine(source, node.start ?? 0);
  const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

  if (node.type === "Text" && typeof node.data === "string") {
    const text = normalizeWhitespace(node.data);
    if (isLikelyUserFacingText(text) && !["script", "style", "code", "pre"].includes(parentTag ?? "")) {
      out.hardcoded.push({
        file: relFile,
        line,
        column: 0,
        text,
        kind: "template-text",
        component: componentName,
        snippet,
      });
    }
  }

  if (node.type === "ExpressionTag" && node.start !== undefined && node.end !== undefined) {
    const rawExpr = source.slice(node.start, node.end);
    // Paraglide m.some_key() or svelte-i18n $_('key') / $t('key')
    for (const m of rawExpr.matchAll(/\bm\.([a-zA-Z0-9_]+)\s*\(/g)) {
      const key = m[1];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line,
        component: componentName,
        element: parentTag,
        surrounding: [],
      });
    }
    for (const m of rawExpr.matchAll(/(?:\$_|\$t|\bt)\(\s*['"]([^'"]+)['"]/g)) {
      const key = m[1];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line,
        component: componentName,
        element: parentTag,
        surrounding: [],
      });
    }
    if (/['"][^'"]*\p{L}{2,}[^'"]*['"]\s*\+|\+\s*['"][^'"]*\p{L}{2,}[^'"]*['"]/u.test(rawExpr)) {
      out.concats.push({
        file: relFile,
        line,
        column: 0,
        expression: rawExpr.trim(),
        reason: "String concatenation inside Svelte expression breaks word order.",
        component: componentName,
      });
    }
  }

  if (Array.isArray(node.attributes)) {
    for (const attr of node.attributes) {
      if (attr.type === "Attribute" && attr.name) {
        const aLine = offsetToLine(source, attr.start ?? 0);
        const valNodes = Array.isArray(attr.value)
          ? attr.value
          : attr.value && typeof attr.value === "object"
            ? [attr.value]
            : [];
        const literal = valNodes
          .filter((v) => v.type === "Text" && typeof v.data === "string")
          .map((v) => v.data)
          .join("");
        if (attr.name === "class" && literal) {
          for (const risk of inspectLayoutClasses(literal)) {
            out.layoutRisks.push({
              file: relFile,
              line: aLine,
              kind: risk.kind,
              constraint: risk.constraint,
              component: componentName,
              suggestion: risk.suggestion,
              snippet: (lines[aLine - 1] ?? "").trim().slice(0, 120),
            });
          }
        } else if (USER_FACING_ATTRIBUTES.has(attr.name) && isLikelyUserFacingText(literal)) {
          out.hardcoded.push({
            file: relFile,
            line: aLine,
            column: 0,
            text: normalizeWhitespace(literal),
            kind: "attribute",
            attribute: attr.name,
            component: componentName,
            snippet: (lines[aLine - 1] ?? "").trim().slice(0, 120),
          });
        }
        for (const v of valNodes) {
          if (v.type === "ExpressionTag") {
            walkSvelteNode(v, source, relFile, componentName, lines, out, node.name);
          }
        }
      }
    }
  }

  const children = node.fragment?.nodes ?? node.nodes;
  if (Array.isArray(children)) {
    const textKids = children.filter(
      (c) => c.type === "Text" && typeof c.data === "string" && isLikelyUserFacingText(c.data)
    );
    const exprKids = children.filter((c) => {
      if (c.type !== "ExpressionTag" || c.start === undefined || c.end === undefined) return false;
      const expr = source.slice(c.start, c.end);
      return !/\bm\.[a-zA-Z0-9_]+\s*\(|(?:\$_|\$t|\bt)\(/.test(expr);
    });
    if (textKids.length >= 1 && exprKids.length >= 1) {
      out.concats.push({
        file: relFile,
        line,
        column: 0,
        expression: snippet,
        reason: `Sentence split across Svelte text and expression inside <${node.name ?? "element"}>.`,
        component: componentName,
      });
    }
    for (const child of children) {
      walkSvelteNode(child, source, relFile, componentName, lines, out, node.name ?? parentTag);
    }
  }

  if (node.body) walkSvelteNode(node.body, source, relFile, componentName, lines, out, parentTag);
  if (node.consequent) walkSvelteNode(node.consequent, source, relFile, componentName, lines, out, parentTag);
  if (node.alternate) walkSvelteNode(node.alternate, source, relFile, componentName, lines, out, parentTag);
}

export class SvelteKitAdapter implements ScannerAdapter {
  readonly id = "sveltekit";
  readonly frameworks = ["sveltekit"] as const;
  readonly format = new JsonFormatAdapter("json-svelte", ["icu", "single-brace"]);

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pkg = readPackageJson(rootDir);
    const deps = getAllDependencies(pkg);
    const hasSvelte =
      Boolean(deps["@sveltejs/kit"]) ||
      Boolean(deps["svelte"]) ||
      fs.existsSync(path.join(rootDir, "svelte.config.js"));
    if (!hasSvelte) return null;

    const i18nLibrary =
      deps["@inlang/paraglide-sveltekit"] || deps["@inlang/paraglide-js"]
        ? "paraglide"
        : deps["svelte-i18n"]
          ? "svelte-i18n"
          : null;

    const candidates = [
      ...(localesPathOverride ? [localesPathOverride] : []),
      "messages",
      "src/lib/i18n",
      "src/locales",
      "locales",
    ];
    const { localesDir, localeFiles } = discoverJsonLocaleFiles(rootDir, candidates);

    return {
      framework: "sveltekit",
      i18nLibrary,
      confidence: 0.95,
      localesDir,
      localeFiles,
      placeholderSyntaxes: ["icu", "single-brace"],
      notes: i18nLibrary ? [] : ["No Paraglide or svelte-i18n dependency detected in package.json."],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[] }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, SVELTE_EXTS).filter(
      (f) => !f.endsWith(".d.ts") && !f.includes(".test.") && !f.includes("svelte.config.")
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const source = fs.readFileSync(absFile, "utf8");

      if (absFile.endsWith(".svelte")) {
        const componentName = path.basename(absFile, ".svelte");
        const lines = source.split(/\r?\n/);
        try {
          const ast = parseSvelte(source, { modern: true }) as unknown as {
            fragment?: SvelteNode;
            instance?: { start: number; end: number };
          };
          if (ast.fragment) {
            walkSvelteNode(ast.fragment, source, relFile, componentName, lines, {
              hardcoded: hardcodedStrings,
              concats: concatenations,
              usageByKey,
              layoutRisks,
            });
          }
          // Extract <script> inner content for Babel analysis
          const scriptMatch = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(source);
          if (scriptMatch) {
            const lineOffset = offsetToLine(source, scriptMatch.index) - 1;
            const res = scanJsTsFile(absFile, relFile, scriptMatch[1], { lineOffset });
            hardcodedStrings.push(...res.hardcodedStrings);
            concatenations.push(...res.concatenations);
            layoutRisks.push(...res.layoutRisks);
            for (const [k, sites] of Object.entries(res.usageByKey)) {
              usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
            }
          }
        } catch {
          // Skip unparseable template
        }
      } else {
        const res = scanJsTsFile(absFile, relFile, source);
        hardcodedStrings.push(...res.hardcodedStrings);
        concatenations.push(...res.concatenations);
        layoutRisks.push(...res.layoutRisks);
        for (const [k, sites] of Object.entries(res.usageByKey)) {
          usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
        }
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
    const candidate =
      path.basename(confinedSource) === `${sourceLocale}.json`
        ? path.join(dir, `${safeLocale}.json`)
        : path.join(path.dirname(dir), safeLocale, path.basename(confinedSource));
    return resolveConfinedPath(rootDir, candidate, { label: "targetLocaleFile" });
  }
}
