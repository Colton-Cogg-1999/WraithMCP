import fs from "node:fs";
import path from "node:path";
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

const ASTRO_EXTS = new Set([".astro", ".ts", ".tsx", ".js", ".jsx"]);

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function scanAstroTemplate(
  template: string,
  baseLineOffset: number,
  relFile: string,
  componentName: string,
  out: {
    hardcoded: HardcodedStringFinding[];
    concats: ConcatenationFinding[];
    usageByKey: Record<string, UsageSite[]>;
    layoutRisks: LayoutRiskFinding[];
  }
): void {
  // Strip <script> and <style> blocks from template scanning
  const stripped = template
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));

  const lines = stripped.split(/\r?\n/);

  // 1. Scan class attributes for layout risks
  for (const m of stripped.matchAll(/\bclass(?:Name)?\s*=\s*["']([^"']+)["']/g)) {
    const line = baseLineOffset + offsetToLine(stripped, m.index ?? 0);
    const snippet = (lines[line - baseLineOffset - 1] ?? "").trim().slice(0, 120);
    for (const r of inspectLayoutClasses(m[1])) {
      out.layoutRisks.push({ ...r, file: relFile, line, snippet });
    }
  }

  // 2. Scan user-facing static attributes (placeholder, title, aria-label, alt, label)
  for (const m of stripped.matchAll(/\b([a-zA-Z0-9_-]+)\s*=\s*["']([^"'{}]+)["']/g)) {
    const attr = m[1].toLowerCase();
    const val = normalizeWhitespace(m[2]);
    if (USER_FACING_ATTRIBUTES.has(attr) && isLikelyUserFacingText(val)) {
      const line = baseLineOffset + offsetToLine(stripped, m.index ?? 0);
      out.hardcoded.push({
        file: relFile,
        line,
        column: 0,
        text: val,
        kind: "attribute",
        component: componentName,
        snippet: (lines[line - baseLineOffset - 1] ?? "").trim().slice(0, 120),
      });
    }
  }

  // 3. Scan template expressions `{ ... }` for t('key'), m.key(), and string concatenations
  for (const m of stripped.matchAll(/\{([^{}]+)\}/g)) {
    const expr = m[1];
    const line = baseLineOffset + offsetToLine(stripped, m.index ?? 0);
    for (const km of expr.matchAll(/\b(?:t|useTranslations\(\)?)\(\s*['"]([^'"]+)['"]/g)) {
      const key = km[1];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({ file: relFile, line, component: componentName, surrounding: [] });
    }
    for (const pm of expr.matchAll(/\bm\.([a-zA-Z0-9_]+)\s*\(/g)) {
      const key = pm[1];
      out.usageByKey[key] = out.usageByKey[key] ?? [];
      out.usageByKey[key].push({ file: relFile, line, component: componentName, surrounding: [] });
    }
    if (/['"][^'"]*\p{L}{2,}[^'"]*['"]\s*\+|\+\s*['"][^'"]*\p{L}{2,}[^'"]*['"]/u.test(expr)) {
      out.concats.push({
        file: relFile,
        line,
        column: 0,
        expression: expr.trim().slice(0, 120),
        reason: "String concatenation inside Astro template expression breaks word order.",
        component: componentName,
      });
    }
  }

  // 4. Scan visible text between tags `>text<`
  for (const m of stripped.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)(?:\s[^>]*)?>([^<>]+)</g)) {
    const tag = m[1].toLowerCase();
    if (["script", "style", "code", "pre"].includes(tag)) continue;
    const rawText = m[2].replace(/\{[^{}]*\}/g, " ");
    const text = normalizeWhitespace(rawText);
    if (isLikelyUserFacingText(text)) {
      const line = baseLineOffset + offsetToLine(stripped, (m.index ?? 0) + m[0].indexOf(">") + 1);
      out.hardcoded.push({
        file: relFile,
        line,
        column: 0,
        text,
        kind: "template-text",
        component: componentName,
        snippet: (lines[line - baseLineOffset - 1] ?? "").trim().slice(0, 120),
      });
    }
  }
}

export class AstroAdapter implements ScannerAdapter {
  readonly id = "astro";
  readonly frameworks = ["astro"] as const;
  readonly format = new JsonFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pkg = readPackageJson(rootDir);
    const deps = getAllDependencies(pkg);
    const hasAstroConfig = ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.cjs"].some((f) =>
      fs.existsSync(path.join(rootDir, f))
    );
    if (!("astro" in deps) && !hasAstroConfig) return null;

    const i18nLibrary = "@inlang/paraglide-astro" in deps || "@inlang/paraglide-js" in deps
      ? "paraglide"
      : "astro-i18next" in deps || "i18next" in deps
        ? "i18next"
        : "astro-i18n";

    const discovered = discoverJsonLocaleFiles(
      rootDir,
      localesPathOverride ? [localesPathOverride] : ["src/i18n", "src/content/i18n", "messages", "locales", "src/locales"]
    );
    return {
      framework: "astro",
      i18nLibrary,
      confidence: 0.95,
      localesDir: discovered.localesDir,
      localeFiles: discovered.localeFiles,
      placeholderSyntaxes: ["icu", "double-mustache", "single-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, options.ignore, ASTRO_EXTS);
    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const hardcodedFormatting: HardcodedFormattingFinding[] = [];
    const layoutRisks: LayoutRiskFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};

    for (const filePath of files) {
      const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");
      const ext = path.extname(filePath);
      const source = fs.readFileSync(filePath, "utf8");

      if (ext === ".astro") {
        const componentName = path.basename(filePath, ".astro");
        const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        let template = source;
        let baseLineOffset = 0;

        if (fmMatch) {
          const frontmatter = fmMatch[1];
          const fmScan = scanJsTsFile(filePath, relFile, frontmatter, { lineOffset: 1 });
          hardcodedStrings.push(...fmScan.hardcodedStrings);
          concatenations.push(...fmScan.concatenations);
          hardcodedFormatting.push(...(fmScan.hardcodedFormatting ?? []));
          layoutRisks.push(...fmScan.layoutRisks);
          for (const [k, sites] of Object.entries(fmScan.usageByKey)) {
            usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
          }
          baseLineOffset = fmMatch[0].split(/\r?\n/).length - 1;
          template = source.slice(fmMatch[0].length);
        }

        scanAstroTemplate(template, baseLineOffset, relFile, componentName, {
          hardcoded: hardcodedStrings,
          concats: concatenations,
          usageByKey,
          layoutRisks,
        });
      } else {
        const res = scanJsTsFile(filePath, relFile, source);
        hardcodedStrings.push(...res.hardcodedStrings);
        concatenations.push(...res.concatenations);
        hardcodedFormatting.push(...(res.hardcodedFormatting ?? []));
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
      hardcodedFormatting,
      layoutRisks,
      usageByKey,
      parseFailures: [],
    };
  }

  resolveTargetLocaleFile(
    rootDir: string,
    _sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    validateLocaleTag(targetLocale, "targetLocale");
    const dir = path.dirname(sourceFile);
    return resolveConfinedPath(rootDir, path.join(dir, `${targetLocale}.json`), {
      label: "target locale file",
    });
  }
}
