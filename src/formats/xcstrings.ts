import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../core/security.js";
import { FormatAdapter, FormatWriteUpdate, LocaleEntry, LocaleFileData } from "./types.js";

/**
 * Lossless Apple String Catalog (`.xcstrings`) format adapter for iOS / macOS / visionOS.
 *
 * `.xcstrings` stores all locales in a single JSON file:
 *   { sourceLanguage: "en", version: "1.0", strings: { [key]: { comment?, shouldTranslate?, localizations?: { [lang]: ... } } } }
 *
 * - Skips entries with `shouldTranslate: false`.
 * - Attaches `comment` as `entry.comment` for translators and QE reviewers.
 * - Supports both `stringUnit` and `variations.plural` entries.
 * - `applyUpdates` updates ONLY the requested locale inside `strings[key].localizations[locale]`,
 *   preserving all other locales, comments, `extractionState`, and `shouldTranslate` flags.
 */

interface XcStringUnit {
  state?: string;
  value?: string;
}

interface XcLocalization {
  stringUnit?: XcStringUnit;
  variations?: {
    plural?: Record<string, { stringUnit?: XcStringUnit }>;
  };
}

interface XcStringEntry {
  comment?: string;
  extractionState?: string;
  shouldTranslate?: boolean;
  localizations?: Record<string, XcLocalization>;
}

interface XcStringsCatalog {
  sourceLanguage?: string;
  version?: string;
  strings?: Record<string, XcStringEntry>;
}

export class XcstringsFormatAdapter implements FormatAdapter {
  readonly id = "xcstrings";
  readonly extensions = [".xcstrings"] as const;
  readonly placeholderSyntaxes = ["python-printf", "single-brace"] as const;

  readFile(filePath: string, locale: string): LocaleFileData {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as XcStringsCatalog;
    const sourceLang = parsed.sourceLanguage ?? "en";
    const entries = new Map<string, LocaleEntry>();

    for (const [key, item] of Object.entries(parsed.strings ?? {})) {
      if (item.shouldTranslate === false) continue;
      const locObj = item.localizations?.[locale];

      if (locObj?.variations?.plural) {
        const plurals: Record<string, string> = {};
        for (const [qty, variant] of Object.entries(locObj.variations.plural)) {
          if (typeof variant?.stringUnit?.value === "string") {
            plurals[qty] = variant.stringUnit.value;
          }
        }
        if (Object.keys(plurals).length > 0) {
          entries.set(key, {
            key,
            value: plurals.other ?? Object.values(plurals)[0] ?? "",
            plurals,
            comment: item.comment,
            file: filePath,
          });
        }
        continue;
      }

      if (typeof locObj?.stringUnit?.value === "string") {
        entries.set(key, {
          key,
          value: locObj.stringUnit.value,
          comment: item.comment,
          file: filePath,
        });
      } else if (locale === sourceLang) {
        // In Apple String Catalogs, keys themselves are the source language text when no explicit source stringUnit exists
        entries.set(key, {
          key,
          value: key,
          comment: item.comment,
          file: filePath,
        });
      }
    }

    return { locale, filePath, entries };
  }

  applyUpdates(
    filePath: string,
    locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    const sourceToRead = fs.existsSync(filePath)
      ? filePath
      : options?.sourceFilePath && fs.existsSync(options.sourceFilePath)
        ? options.sourceFilePath
        : null;

    let catalog: XcStringsCatalog = { sourceLanguage: "en", version: "1.0", strings: {} };
    let indent = 2;
    let trailingNewline = true;

    if (sourceToRead) {
      const raw = fs.readFileSync(sourceToRead, "utf8");
      trailingNewline = raw.endsWith("\n");
      const m = raw.match(/\n([ \t]+)"/);
      if (m) indent = m[1].length;
      catalog = JSON.parse(raw) as XcStringsCatalog;
    }

    catalog.strings = catalog.strings ?? {};

    for (const u of updates) {
      const entry = catalog.strings[u.key] ?? {};
      entry.localizations = entry.localizations ?? {};

      if (u.plurals && Object.keys(u.plurals).length > 0) {
        const pluralMap: Record<string, { stringUnit: XcStringUnit }> = {};
        for (const [qty, val] of Object.entries(u.plurals)) {
          pluralMap[qty] = { stringUnit: { state: "translated", value: val } };
        }
        entry.localizations[locale] = { variations: { plural: pluralMap } };
      } else {
        entry.localizations[locale] = {
          stringUnit: { state: "translated", value: u.value },
        };
      }
      catalog.strings[u.key] = entry;
    }

    const out = JSON.stringify(catalog, null, indent) + (trailingNewline ? "\n" : "");
    if (options?.write !== false) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      atomicWriteFileSync(filePath, out);
    }
    return out;
  }
}
