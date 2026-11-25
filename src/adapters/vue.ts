import fs from "node:fs";
import path from "node:path";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { HardcodedFormattingFinding } from "../core/formatting-scanner.js";
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
    for (const m of expr.matchAll(/(?:\$t|\bt)\(\s*(['"])([^'"]+)\1\s*(?=[,)])/g)) {
      const key = m[2];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({
        file: relFile,
        line,
        component: componentName,
        element: parentTag,
        surrounding: [],
      });
    }
    // Direct string literal inside mustache interpolation: {{ 'Recent activity' }}
    const literalMatch = /^\s*(['"])([^'"]+)\1\s*$/.exec(expr);
    if (literalMatch && isLikelyUserFacingText(literalMatch[2])) {
      out.hardcoded.push({
        file: relFile,
        line,
        column: col,
        text: normalizeWhitespace(literalMatch[2]),
        kind: "template-text",
        component: componentName,
        snippet,
      });
    }
    if (
      !/(?:\$t|\bt)\s*\(/.test(expr) &&
      /['"][^'"]*\p{L}{2,}[^'"]*['"]\s*\+|\+\s*['"][^'"]*\p{L}{2,}[^'"]*['"]/u.test(expr)
    ) {
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
        // vue-i18n <i18n-t keypath="terms">
        if (prop.name === "keypath" && (node.tag === "i18n-t" || node.tag === "i18n")) {
          const key = prop.value.content.trim();
          out.usageByKey[key] = out.usageByKey[key] ?? [];
          out.usageByKey[key].push({
            file: relFile,
            line: pLine,
            component: componentName,
            element: node.tag,
            surrounding: [],
          });
          continue;
        }
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
      // Directive === 7 (e.g. :placeholder="$t('search')", v-t="'save'")
      if (prop.type === 7 && prop.exp?.content) {
        const expText = prop.exp.content.trim();
        if (prop.name === "t") {
          const vtMatch = /^['"]([^'"]+)['"]$/.exec(expText) ?? /path\s*:\s*['"]([^'"]+)['"]/.exec(expText);
          if (vtMatch) {
            const key = vtMatch[1];
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
        for (const m of expText.matchAll(/(?:\$t|\bt)\(\s*(['"])([^'"]+)\1\s*(?=[,)])/g)) {
          const key = m[2];
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
      (f) => {
        const rel = path.relative(rootDir, f).replace(/\\/g, "/");
        return !rel.endsWith(".d.ts") && !rel.includes(".test.") && !rel.includes(".spec.") && !rel.includes("nuxt.config.");
      }
    );

    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};
    const layoutRisks: LayoutRiskFinding[] = [];
    const hardcodedFormatting: HardcodedFormattingFinding[] = [];

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
          hardcodedFormatting.push(...res.hardcodedFormatting);
          for (const [k, sites] of Object.entries(res.usageByKey)) {
            usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
          }
        }
      } else {
        const res = scanJsTsFile(absFile, relFile, source);
        hardcodedStrings.push(...res.hardcodedStrings);
        concatenations.push(...res.concatenations);
        layoutRisks.push(...res.layoutRisks);
        hardcodedFormatting.push(...res.hardcodedFormatting);
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
      hardcodedFormatting,
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
