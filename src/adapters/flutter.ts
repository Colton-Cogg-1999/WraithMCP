import fs from "node:fs";
import path from "node:path";
import { resolveConfinedPath, validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { ArbFormatAdapter } from "../formats/arb.js";
import {
  ConcatenationFinding,
  FrameworkDetection,
  HardcodedStringFinding,
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import { isLikelyUserFacingText, normalizeWhitespace, walkFiles } from "./utils.js";

const DART_EXTS = new Set([".dart"]);

function discoverArbFiles(
  rootDir: string,
  localesPathOverride?: string
): { localesDir: string | null; localeFiles: Record<string, string[]> } {
  const candidates = localesPathOverride
    ? [localesPathOverride]
    : ["lib/l10n", "l10n", "assets/l10n", "assets/translations"];

  for (const rel of candidates) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const files = fs
      .readdirSync(abs)
      .filter((f) => f.endsWith(".arb"))
      .sort();
    if (files.length === 0) continue;

    const localeFiles: Record<string, string[]> = {};
    for (const f of files) {
      const full = path.join(abs, f);
      let locale: string | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as { "@@locale"?: string };
        if (typeof parsed["@@locale"] === "string" && parsed["@@locale"].trim()) {
          locale = parsed["@@locale"].trim().replace(/_/g, "-");
        }
      } catch {
        // fallback to filename
      }
      if (!locale) {
        const m = f.match(/(?:app|intl|messages)_([a-zA-Z]{2,3}(?:_[a-zA-Z0-9]+)*)\.arb$/);
        if (m) locale = m[1].replace(/_/g, "-");
        else locale = path.basename(f, ".arb").replace(/_/g, "-");
      }
      localeFiles[locale] = [...(localeFiles[locale] ?? []), full];
    }
    return { localesDir: rel, localeFiles };
  }
  return { localesDir: null, localeFiles: {} };
}

export class FlutterAdapter implements ScannerAdapter {
  readonly id = "flutter";
  readonly frameworks = ["flutter"] as const;
  readonly format = new ArbFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pubspecPath = path.join(rootDir, "pubspec.yaml");
    if (!fs.existsSync(pubspecPath)) return null;
    const pubspec = fs.readFileSync(pubspecPath, "utf8");
    if (!/\bflutter\s*:/.test(pubspec)) return null;

    const discovered = discoverArbFiles(rootDir, localesPathOverride);
    return {
      framework: "flutter",
      i18nLibrary: "flutter_localizations",
      confidence: 0.93,
      localesDir: discovered.localesDir,
      localeFiles: discovered.localeFiles,
      placeholderSyntaxes: ["icu", "single-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, [...options.ignore, ".dart_tool", "ios", "android"], DART_EXTS);
    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};

    for (const filePath of files) {
      const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");
      const componentName = path.basename(filePath, ".dart");
      const source = fs.readFileSync(filePath, "utf8");
      const lines = source.split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx++) {
        const lineText = lines[idx];
        const line = idx + 1;

        // Track AppLocalizations.of(context)!.key / S.of(context).key / l10n.key
        for (const m of lineText.matchAll(
          /(?:AppLocalizations\.of\([^)]+\)!?|S\.of\([^)]+\)|\bl10n|\btr)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g
        )) {
          const key = m[1];
          usageByKey[key] = usageByKey[key] ?? [];
          usageByKey[key].push({
            file: relFile,
            line,
            component: componentName,
            surrounding: [],
          });
        }

        // Detect hardcoded UI strings inside Text('...'), Tooltip(message: '...'), labelText: '...'
        for (const m of lineText.matchAll(
          /\b(?:Text|Tooltip)\s*\(\s*(?:message\s*:\s*)?(['"])([^'"$]+)\1/g
        )) {
          const text = normalizeWhitespace(m[2]);
          if (isLikelyUserFacingText(text)) {
            hardcodedStrings.push({
              file: relFile,
              line,
              column: m.index ?? 0,
              text,
              kind: "jsx-text",
              component: componentName,
              snippet: lineText.trim().slice(0, 120),
            });
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
    _sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    validateLocaleTag(targetLocale, "targetLocale");
    const arbLocale = targetLocale.replace(/-/g, "_");
    const dir = path.dirname(sourceFile);
    const base = path.basename(sourceFile);
    const prefix = base.match(/^([a-zA-Z]+)_/)?.[1] ?? "app";
    return resolveConfinedPath(rootDir, path.join(dir, `${prefix}_${arbLocale}.arb`), {
      label: "target ARB file",
    });
  }
}
