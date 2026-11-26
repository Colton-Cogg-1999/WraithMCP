import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { AndroidXmlFormatAdapter } from "../formats/android-xml.js";
import {
  ConcatenationFinding,
  FrameworkDetection,
  HardcodedStringFinding,
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import { isLikelyUserFacingText, normalizeWhitespace, walkFiles } from "./utils.js";

const ANDROID_EXTS = new Set([".kt", ".java", ".xml"]);

function androidValuesDirToLocale(dirName: string): string | null {
  if (dirName === "values") return "en";
  const m = dirName.match(/^values-([a-z]{2,3})(?:-r([A-Z]{2}))?$/);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : m[1];
}

function localeToAndroidValuesDir(locale: string, sourceLocale: string): string {
  if (locale === sourceLocale) return "values";
  const parts = locale.split("-");
  if (parts.length === 2 && parts[1].length === 2) {
    return `values-${parts[0].toLowerCase()}-r${parts[1].toUpperCase()}`;
  }
  return `values-${locale.toLowerCase()}`;
}

function discoverAndroidResDirs(
  rootDir: string,
  localesPathOverride?: string
): { localesDir: string | null; localeFiles: Record<string, string[]> } {
  const candidates = localesPathOverride
    ? [localesPathOverride]
    : ["app/src/main/res", "src/main/res", "res"];

  for (const rel of candidates) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const localeFiles: Record<string, string[]> = {};
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const loc = androidValuesDirToLocale(entry.name);
      if (!loc) continue;
      const stringsFile = path.join(abs, entry.name, "strings.xml");
      if (fs.existsSync(stringsFile)) {
        localeFiles[loc] = [...(localeFiles[loc] ?? []), stringsFile];
      }
    }
    if (Object.keys(localeFiles).length > 0) {
      return { localesDir: rel, localeFiles };
    }
  }
  return { localesDir: null, localeFiles: {} };
}

export class AndroidAdapter implements ScannerAdapter {
  readonly id = "android";
  readonly frameworks = ["android"] as const;
  readonly format = new AndroidXmlFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const hasManifest =
      fs.existsSync(path.join(rootDir, "app/src/main/AndroidManifest.xml")) ||
      fs.existsSync(path.join(rootDir, "src/main/AndroidManifest.xml")) ||
      fs.existsSync(path.join(rootDir, "AndroidManifest.xml"));
    const discovered = discoverAndroidResDirs(rootDir, localesPathOverride);
    if (!hasManifest && Object.keys(discovered.localeFiles).length === 0) return null;

    return {
      framework: "android",
      i18nLibrary: "android-resources",
      confidence: 0.92,
      localesDir: discovered.localesDir,
      localeFiles: discovered.localeFiles,
      placeholderSyntaxes: ["python-printf", "single-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, [...options.ignore, ".gradle", "build"], ANDROID_EXTS);
    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};

    for (const filePath of files) {
      const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");
      if (relFile.endsWith("strings.xml") || relFile.endsWith("AndroidManifest.xml")) continue;
      const ext = path.extname(filePath);
      const componentName = path.basename(filePath, ext);
      const source = fs.readFileSync(filePath, "utf8");
      const lines = source.split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx++) {
        const lineText = lines[idx];
        const line = idx + 1;

        if (ext === ".xml") {
          for (const m of lineText.matchAll(/@string\/([a-zA-Z0-9_]+)/g)) {
            const key = m[1];
            usageByKey[key] = usageByKey[key] ?? [];
            usageByKey[key].push({ file: relFile, line, component: componentName, surrounding: [] });
          }
          for (const m of lineText.matchAll(/android:(?:text|hint|contentDescription)\s*=\s*"([^"@]+)"/g)) {
            const text = normalizeWhitespace(m[1]);
            if (isLikelyUserFacingText(text)) {
              hardcodedStrings.push({
                file: relFile,
                line,
                column: m.index ?? 0,
                text,
                kind: "attribute",
                component: componentName,
                snippet: lineText.trim().slice(0, 120),
              });
            }
          }
        } else {
          for (const m of lineText.matchAll(/\bR\.(?:string|plurals)\.([a-zA-Z0-9_]+)/g)) {
            const key = m[1];
            usageByKey[key] = usageByKey[key] ?? [];
            usageByKey[key].push({ file: relFile, line, component: componentName, surrounding: [] });
          }
        }
      }
    }

    return {
      filesScanned: files.length,
      hardcodedStrings,
      concatenations,
      hardcodedFormatting: [],
      layoutRisks: [],
      usageByKey,
      parseFailures: [],
    };
  }

  resolveTargetLocaleFile(
    rootDir: string,
    sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    validateLocaleTag(targetLocale, "targetLocale");
    const resDir = path.dirname(path.dirname(sourceFile));
    const valuesDir = localeToAndroidValuesDir(targetLocale, sourceLocale);
    return resolveConfinedPath(rootDir, path.join(resDir, valuesDir, "strings.xml"), {
      label: "target Android strings.xml",
    });
  }
}
