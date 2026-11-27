import fs from "node:fs";
import path from "node:path";
import { validateLocaleTag } from "../core/security.js";
import { UsageSite } from "../core/types.js";
import { XcstringsFormatAdapter } from "../formats/xcstrings.js";
import {
  ConcatenationFinding,
  FrameworkDetection,
  HardcodedStringFinding,
  ScannerAdapter,
  ScanSourceResult,
} from "./types.js";
import { walkFiles } from "./utils.js";

const SWIFT_EXTS = new Set([".swift"]);

function findXcstringsFiles(rootDir: string, localesPathOverride?: string): string[] {
  const searchRoots = localesPathOverride ? [localesPathOverride] : ["."];
  return walkFiles(
    rootDir,
    searchRoots,
    [".git", ".build", "DerivedData", "Pods", "node_modules", ".wraith"],
    new Set([".xcstrings"])
  );
}

export class IosAdapter implements ScannerAdapter {
  readonly id = "ios";
  readonly frameworks = ["ios"] as const;
  readonly format = new XcstringsFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const xcstringsFiles = findXcstringsFiles(rootDir, localesPathOverride);
    const hasAppleProject =
      xcstringsFiles.length > 0 ||
      fs.existsSync(path.join(rootDir, "Package.swift")) ||
      fs.readdirSync(rootDir).some((n) => n.endsWith(".xcodeproj") || n.endsWith(".xcworkspace"));

    if (!hasAppleProject) return null;

    const localeFiles: Record<string, string[]> = {};
    for (const file of xcstringsFiles) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
          sourceLanguage?: string;
          strings?: Record<string, { localizations?: Record<string, unknown> }>;
        };
        const srcLang = parsed.sourceLanguage ?? "en";
        const locales = new Set<string>([srcLang]);
        for (const item of Object.values(parsed.strings ?? {})) {
          for (const loc of Object.keys(item.localizations ?? {})) {
            locales.add(loc);
          }
        }
        for (const loc of locales) {
          localeFiles[loc] = [...(localeFiles[loc] ?? []), file];
        }
      } catch {
        // ignore invalid xcstrings
      }
    }

    const localesDir =
      xcstringsFiles.length > 0
        ? path.relative(rootDir, path.dirname(xcstringsFiles[0])).replace(/\\/g, "/") || "."
        : null;

    return {
      framework: "ios",
      i18nLibrary: "xcstrings",
      confidence: xcstringsFiles.length > 0 ? 0.94 : 0.85,
      localesDir,
      localeFiles,
      placeholderSyntaxes: ["python-printf", "single-brace"],
      notes: [],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(
      rootDir,
      options.sourcePaths,
      [...options.ignore, ".build", "DerivedData", "Pods"],
      SWIFT_EXTS
    );
    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};

    for (const filePath of files) {
      const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");
      const componentName = path.basename(filePath, ".swift");
      const source = fs.readFileSync(filePath, "utf8");
      const lines = source.split(/\r?\n/);

      for (let idx = 0; idx < lines.length; idx++) {
        const lineText = lines[idx];
        const line = idx + 1;

        // 1. Standard Swift / SwiftUI localization calls & modifiers:
        //    String(localized: "key"), NSLocalizedString("key", ...), LocalizedStringKey("key"),
        //    Text("key"), Button("key", ...), Label("key", ...), Toggle("key", ...),
        //    Section("key"), Picker("key", ...), navigationTitle("key"), accessibilityLabel("key"),
        //    alert("key", ...), confirmationDialog("key", ...)
        for (const m of lineText.matchAll(
          /\b(?:String\(\s*localized:\s*|NSLocalizedString\(\s*|LocalizedStringKey\(\s*|(?:Text|Button|Label|Toggle|Section|Picker|Link|Menu|DisclosureGroup|navigationTitle|accessibilityLabel|accessibilityHint|alert|confirmationDialog)\(\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g
        )) {
          const rawLit = m[1];
          // Convert SwiftUI string interpolation `\(expr)` to xcstrings format specifiers (%@ / %lld)
          const candidates = new Set<string>();
          if (!rawLit.includes("\\(")) {
            candidates.add(rawLit);
          } else {
            candidates.add(rawLit.replace(/\\\([^)]*\)/g, "%@"));
            candidates.add(rawLit.replace(/\\\([^)]*\)/g, "%lld"));
            candidates.add(rawLit.replace(/\\\([^)]*\)/g, "%d"));
          }
          for (const key of candidates) {
            usageByKey[key] = usageByKey[key] ?? [];
            usageByKey[key].push({
              file: relFile,
              line,
              component: componentName,
              surrounding: [],
            });
          }
        }

        // 2. Typed LocalizedStringKey assignments: `let title: LocalizedStringKey = "key"` or `return "key"` inside LocalizedStringKey
        for (const m of lineText.matchAll(
          /:\s*LocalizedStringKey\s*=\s*"([^"\\]+)"/g
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
    _rootDir: string,
    _sourceLocale: string,
    targetLocale: string,
    sourceFile: string
  ): string {
    validateLocaleTag(targetLocale, "targetLocale");
    // `.xcstrings` is a single multi-locale String Catalog file: all locales live in the same file
    return sourceFile;
  }
}
