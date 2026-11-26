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
  readPackageJson,
  walkFiles,
} from "./utils.js";
import fs from "node:fs";

const ELECTRON_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export class ElectronAdapter implements ScannerAdapter {
  readonly id = "electron";
  readonly frameworks = ["electron"] as const;
  readonly format = new JsonFormatAdapter();

  detect(rootDir: string, localesPathOverride?: string): FrameworkDetection | null {
    const pkg = readPackageJson(rootDir);
    const deps = getAllDependencies(pkg);
    if (!("electron" in deps) && !("electron-builder" in deps) && !("@electron-forge/cli" in deps)) {
      return null;
    }

    const i18nLibrary =
      "react-i18next" in deps
        ? "react-i18next"
        : "i18next" in deps
          ? "i18next"
          : "electron-i18n";

    const discovered = discoverJsonLocaleFiles(
      rootDir,
      localesPathOverride ? [localesPathOverride] : ["locales", "src/locales", "messages", "resources/locales"]
    );

    return {
      framework: "electron",
      i18nLibrary,
      confidence: 0.96,
      localesDir: discovered.localesDir,
      localeFiles: discovered.localeFiles,
      placeholderSyntaxes: ["icu", "double-mustache", "single-brace"],
      notes: ["Electron desktop app detected (scans main + renderer JS/TS sources)."],
    };
  }

  scanSource(
    rootDir: string,
    options: { sourcePaths: string[]; ignore: string[]; i18nLibrary?: string | null }
  ): ScanSourceResult {
    const files = walkFiles(rootDir, options.sourcePaths, [...options.ignore, "out", "release"], ELECTRON_EXTS);
    const hardcodedStrings: HardcodedStringFinding[] = [];
    const concatenations: ConcatenationFinding[] = [];
    const hardcodedFormatting: HardcodedFormattingFinding[] = [];
    const layoutRisks: LayoutRiskFinding[] = [];
    const usageByKey: Record<string, UsageSite[]> = {};

    for (const filePath of files) {
      const relFile = path.relative(rootDir, filePath).replace(/\\/g, "/");
      const source = fs.readFileSync(filePath, "utf8");
      const res = scanJsTsFile(filePath, relFile, source);
      hardcodedStrings.push(...res.hardcodedStrings);
      concatenations.push(...res.concatenations);
      hardcodedFormatting.push(...(res.hardcodedFormatting ?? []));
      layoutRisks.push(...res.layoutRisks);
      for (const [k, sites] of Object.entries(res.usageByKey)) {
        usageByKey[k] = [...(usageByKey[k] ?? []), ...sites];
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
