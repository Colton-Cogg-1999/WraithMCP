import fs from "node:fs";
import path from "node:path";
import { parse as parseSfc } from "@vue/compiler-sfc";
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

const VUE_EXTS = new Set([".vue", ".ts", ".js"]);

interface VueAstNode {
  type: number;
  tag?: string;
  content?: string | VueAstNode;
  children?: VueAstNode[];
  props?: VueAstNode[];
  name?: string;
  value?: { content?: string };
  exp?: { content?: string };
  loc?: { start: { line: number; column: number } };
}

function walkVueTemplate(
  node: VueAstNode,
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
  const line = node.loc?.start.line ?? 1;
  const col = node.loc?.start.column ?? 0;
  const snippet = (lines[line - 1] ?? "").trim().slice(0, 120);

  // NodeTypes.TEXT === 2
  if (node.type === 2 && typeof node.content === "string") {
    const text = normalizeWhitespace(node.content);
    if (isLikelyUserFacingText(text) && !["script", "style", "code", "pre"].includes(parentTag ?? "")) {
      out.hardcoded.push({
        file: relFile,
        line,
        column: col,
        text,
        kind: "template-text",
        component: componentName,
        snippet,
      });
    }
  }

  // NodeTypes.INTERPOLATION === 5
  if (node.type === 5 && node.content && typeof node.content !== "string") {
    const expr = typeof node.content.content === "string" ? node.content.content : "";
    for (const m of expr.matchAll(/(?:\$t|\bt)\(\s*['"]([^'"]+)['"]/g)) {
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
    if (/['"][^'"]*\p{L}{2,}[^'"]*['"]\s*\+|\+\s*['"][^'"]*\p{L}{2,}[^'"]*['"]/u.test(expr)) {
      out.concats.push({
        file: relFile,
        line,
        column: col,
        expression: expr.trim(),
        reason: "String concatenation in Vue template breaks word order. Use a parameterized vue-i18n message.",
        component: componentName,
      });
    }
  }

  // Attributes & Directives
  if (Array.isArray(node.props)) {
    for (const prop of node.props) {
      // Attribute === 6
      if (prop.type === 6 && prop.name && prop.value?.content) {
        const pLine = prop.loc?.start.line ?? line;
        if (prop.name === "class") {
          for (const risk of inspectLayoutClasses(prop.value.content)) {
            out.layoutRisks.push({
              file: relFile,
              line: pLine,
              kind: risk.kind,
              constraint: risk.constraint,
              component: componentName,
              suggestion: risk.suggestion,
              snippet: (lines[pLine - 1] ?? "").trim().slice(0, 120),
            });
          }
        } else if (USER_FACING_ATTRIBUTES.has(prop.name) && isLikelyUserFacingText(prop.value.content)) {
          out.hardcoded.push({
            file: relFile,
            line: pLine,
            column: prop.loc?.start.column ?? 0,
            text: normalizeWhitespace(prop.value.content),
            kind: "attribute",
            attribute: prop.name,
            component: componentName,
            snippet: (lines[pLine - 1] ?? "").trim().slice(0, 120),
          });
        }
      }
      // Directive === 7 (e.g. :placeholder="$t('search')")
      if (prop.type === 7 && prop.exp?.content) {
        for (const m of prop.exp.content.matchAll(/(?:\$t|\bt)\(\s*['"]([^'"]+)['"]/g)) {
          const key = m[1];
          out.usageByKey[key] = out.usageByKey[key] ?? [];
          out.usageByKey[key].push({
            file: relFile,
            line: prop.loc?.start.line ?? line,
            component: componentName,
            element: node.tag,
            surrounding: [],
          });
        }
      }
    }
  }

  if (Array.isArray(node.children)) {
    // Detect mixed text + dynamic expression fragments inside same element
    const textKids = node.children.filter(
      (c) => c.type === 2 && typeof c.content === "string" && isLikelyUserFacingText(c.content)
    );
    const exprKids = node.children.filter(
      (c) =>
        c.type === 5 &&
        c.content &&
        typeof c.content !== "string" &&
        typeof c.content.content === "string" &&
        !/(?:\$t|\bt)\(/.test(c.content.content)
    );
    if (textKids.length >= 1 && exprKids.length >= 1) {
      out.concats.push({
        file: relFile,
        line,
        column: col,
        expression: snippet,
        reason: `Sentence split across Vue template text and interpolation inside <${node.tag ?? "element"}>.`,
        component: componentName,
      });
    }

    for (const child of node.children) {
      walkVueTemplate(child, relFile, componentName, lines, out, node.tag ?? parentTag);
    }
  }
}

export class VueNuxtAdapter implements ScannerAdapter {
  readonly id = "vue-nuxt";
  readonly frameworks = ["nuxt", "vue"] as const;
  readonly format = new JsonFormatAdapter("json-vue", ["single-brace"]);

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pkg = readPackageJson(rootDir);
    const deps = getAllDependencies(pkg);

    const hasNuxt =
      Boolean(deps["nuxt"]) ||
      fs.existsSync(path.join(rootDir, "nuxt.config.ts")) ||
      fs.existsSync(path.join(rootDir, "nuxt.config.js"));
    const hasVue = Boolean(deps["vue"]);
    if (!hasNuxt && !hasVue) return null;

    const i18nLibrary = deps["@nuxtjs/i18n"]
      ? "@nuxtjs/i18n"
      : deps["vue-i18n"]
        ? "vue-i18n"
        : null;

    const candidates = [
      ...(localesPathOverride ? [localesPathOverride] : []),
      "locales",
      "i18n/locales",
      "src/locales",
      "messages",
      "lang",
    ];
    const { localesDir, localeFiles } = discoverJsonLocaleFiles(rootDir, candidates);

    return {
      framework: hasNuxt ? "nuxt" : "vue",
      i18nLibrary,
      confidence: hasNuxt ? 0.95 : 0.9,
      localesDir,
      localeFiles,
      placeholderSyntaxes: ["single-brace"],
      notes: i18nLibrary ? [] : ["No vue-i18n library detected in package.json."],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[] }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, VUE_EXTS).filter(
      (f) => !f.endsWith(".d.ts") && !f.includes(".test.") && !f.includes("nuxt.config.")
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];

    for (const absFile of files) {
      const relFile = path.relative(rootDir, absFile).replace(/\\/g, "/");
      const source = fs.readFileSync(absFile, "utf8");

      if (absFile.endsWith(".vue")) {
        const componentName = path.basename(absFile, ".vue");
        const lines = source.split(/\r?\n/);
        const { descriptor } = parseSfc(source, { filename: relFile });

        if (descriptor.template?.ast) {
          walkVueTemplate(descriptor.template.ast as unknown as VueAstNode, relFile, componentName, lines, {
            hardcoded: hardcodedStrings,
            concats: concatenations,
            usageByKey,
            layoutRisks,
          });
        }

        const scriptBlock = descriptor.scriptSetup ?? descriptor.script;
        if (scriptBlock?.content) {
          const lineOffset = (scriptBlock.loc.start.line ?? 1) - 1;
          const res = scanJsTsFile(absFile, relFile, scriptBlock.content, { lineOffset });
          hardcodedStrings.push(...res.hardcodedStrings);
          concatenations.push(...res.concatenations);
          layoutRisks.push(...res.layoutRisks);
          for (const [k, sites] of Object.entries(res.usageByKey)) {
            usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
          }
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
    _rootDir: string,
    sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    const dir = path.dirname(sourceFile);
    if (path.basename(sourceFile) === `${sourceLocale}.json`) {
      return path.join(dir, `${targetLocale}.json`);
    }
    return path.join(path.dirname(dir), targetLocale, path.basename(sourceFile));
  }
}
