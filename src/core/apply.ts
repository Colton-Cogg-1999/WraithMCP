import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog, loadSourceCatalog } from "../adapters/registry.js";
import { FormatWriteUpdate } from "../formats/types.js";
import { checkGlossaryCompliance } from "./glossary.js";
import { PluralValidationContext, validateTranslationString } from "./placeholders.js";
import { resolveConfinedPath, SecurityBoundaryError, validateLocaleTag } from "./security.js";
import { computeContextFingerprint, PolyglotStore, sha256Short } from "./store.js";
import { MemoryEntry, RecordOrigin, UsageFile } from "./types.js";

export interface ApplyTranslationInput {
  key: string;
  value: string;
  plurals?: Record<string, string>;
  notes?: string;
}

export interface ApplyOptions {
  rootDir: string;
  targetLocale: string;
  translations: ApplyTranslationInput[];
  origin?: RecordOrigin;
  /** If true, reject glossary DNT violations on apply (default true) */
  strictGlossary?: boolean;
  /** Allow writing pseudo-locale without source key glossary/DNT restrictions */
  isPseudo?: boolean;
}

export interface ApplyError {
  key: string;
  code: string;
  message: string;
}

export interface ApplyResult {
  ok: boolean;
  targetLocale: string;
  appliedCount: number;
  rejectedCount: number;
  filesWritten: string[];
  errors: ApplyError[];
  warnings: ApplyError[];
}

export function applyTranslations(options: ApplyOptions): ApplyResult {
  // Enforce locale tag safety BEFORE reading/mutating anything
  try {
    validateLocaleTag(options.targetLocale, "targetLocale");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      targetLocale: options.targetLocale,
      appliedCount: 0,
      rejectedCount: options.translations.length,
      filesWritten: [],
      errors: [{ key: "*", code: err instanceof SecurityBoundaryError ? err.code : "invalid_locale", message }],
      warnings: [],
    };
  }

  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const usage = store.readUsage();
  const records = store.readRecords();

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  if (!adapter) {
    return {
      ok: false,
      targetLocale: options.targetLocale,
      appliedCount: 0,
      rejectedCount: options.translations.length,
      filesWritten: [],
      errors: [
        {
          key: "*",
          code: "no_adapter",
          message: "No supported framework/locale setup detected. Set up locale files first.",
        },
      ],
      warnings: [],
    };
  }

  const srcCatalog = loadSourceCatalog(adapter, detection, config.sourceLocale);
  const srcFiles = srcCatalog.files;
  if (srcFiles.length === 0) {
    return {
      ok: false,
      targetLocale: options.targetLocale,
      appliedCount: 0,
      rejectedCount: options.translations.length,
      filesWritten: [],
      errors: [
        {
          key: "*",
          code: "no_source_locale",
          message: `No source locale files found for "${config.sourceLocale}".`,
        },
      ],
      warnings: [],
    };
  }

  // Load target catalog metadata (e.g. PO Plural-Forms header nplurals) so validation matches runtime!
  const tgtFiles = detection.localeFiles[options.targetLocale] ?? [];
  const tgtCatalog = loadLocaleCatalog(adapter, tgtFiles, options.targetLocale);
  const pluralModel: PluralValidationContext["pluralModel"] =
    adapter.id === "django"
      ? "gettext"
      : adapter.id === "rails"
        ? "rails"
        : adapter.id === "vue-nuxt"
          ? "vue"
          : detection.i18nLibrary === "react-i18next"
            ? "i18next"
            : "icu";

  const errors: ApplyError[] = [];
  const warnings: ApplyError[] = [];
  const validItems: { input: ApplyTranslationInput; sourceFile: string; sourceValue: string; sourcePlurals?: Record<string, string> }[] = [];

  for (const item of options.translations) {
    const srcEntry = srcCatalog.entries.get(item.key);
    if (!srcEntry) {
      errors.push({
        key: item.key,
        code: "unknown_key",
        message: `Key "${item.key}" does not exist in source locale "${config.sourceLocale}".`,
      });
      continue;
    }

    const existingTgtEntry = tgtCatalog.entries.get(item.key);
    const problems = validateTranslationString(
      srcEntry.value,
      item.value,
      options.targetLocale,
      detection.placeholderSyntaxes,
      {
        sourcePlurals: srcEntry.plurals,
        targetPlurals: item.plurals,
        pluralModel,
        gettextNplurals: existingTgtEntry?.pluralForms?.nplurals,
      }
    );

    if (problems.length > 0) {
      for (const p of problems) {
        errors.push({ key: item.key, code: p.code, message: p.message });
      }
      continue;
    }

    if (!options.isPseudo) {
      const glossaryViolations = checkGlossaryCompliance(
        srcEntry.value,
        item.value,
        options.targetLocale,
        glossary.entries
      );
      let blocked = false;
      for (const v of glossaryViolations) {
        if (v.code === "dnt_violation" && options.strictGlossary !== false) {
          errors.push({ key: item.key, code: v.code, message: v.message });
          blocked = true;
        } else {
          warnings.push({ key: item.key, code: v.code, message: v.message });
        }
      }
      if (blocked) continue;
    }

    validItems.push({
      input: item,
      sourceFile: srcCatalog.keyToFile.get(item.key) ?? srcFiles[0],
      sourceValue: srcEntry.value,
      sourcePlurals: srcEntry.plurals,
    });
  }

  // Group valid updates by target locale file
  const updatesByTargetFile = new Map<
    string,
    { sourceFile: string; updates: FormatWriteUpdate[] }
  >();

  for (const v of validItems) {
    const targetFile = resolveConfinedPath(
      store.rootDir,
      adapter.resolveTargetLocaleFile(
        store.rootDir,
        config.sourceLocale,
        options.targetLocale,
        v.sourceFile
      ),
      { label: "targetLocaleFile" }
    );
    const useNamespacePrefix =
      srcFiles.length > 1 && path.basename(path.dirname(v.sourceFile)) === config.sourceLocale;
    const ns = path.basename(v.sourceFile, path.extname(v.sourceFile));
    const localKey =
      useNamespacePrefix && v.input.key.startsWith(`${ns}.`)
        ? v.input.key.slice(ns.length + 1)
        : v.input.key;

    const bucket = updatesByTargetFile.get(targetFile) ?? {
      sourceFile: v.sourceFile,
      updates: [],
    };
    bucket.updates.push({
      key: localKey,
      value: v.input.value,
      plurals: v.input.plurals,
    });
    updatesByTargetFile.set(targetFile, bucket);
  }

  const filesWritten: string[] = [];
  for (const [targetFile, bucket] of updatesByTargetFile) {
    adapter.format.applyUpdates(targetFile, options.targetLocale, bucket.updates, {
      sourceFilePath: bucket.sourceFile,
      write: true,
    });
    filesWritten.push(path.relative(store.rootDir, targetFile).replace(/\\/g, "/"));
  }

  // Record provenance & memory automatically (unless pseudo)
  const now = new Date().toISOString();
  if (!options.isPseudo && validItems.length > 0) {
    // Compute live usage sites so contextFingerprint is ALWAYS recorded even if apply() runs before scan() (M1)
    let liveUsage: UsageFile = usage;
    const scanRes = adapter.scanSource(store.rootDir, {
      sourcePaths: config.paths.source,
      ignore: config.paths.ignore,
      i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
    });
    if (Object.keys(scanRes.usageByKey).length > 0) {
      liveUsage = { version: 1, keys: {} };
      for (const [k, sites] of Object.entries(scanRes.usageByKey)) {
        liveUsage.keys[k] = {
          fingerprint: computeContextFingerprint(sites),
          sites,
        };
      }
    }

    const memoryAdditions: MemoryEntry[] = [];
    for (const v of validItems) {
      const sourceHash = sha256Short(
        v.sourcePlurals ? JSON.stringify(v.sourcePlurals) : v.sourceValue
      );
      const contextFingerprint = liveUsage.keys[v.input.key]?.fingerprint ?? "";
      if (!records.records[v.input.key]) {
        records.records[v.input.key] = {};
      }
      records.records[v.input.key][options.targetLocale] = {
        sourceHash,
        contextFingerprint,
        translation: v.input.plurals ? JSON.stringify(v.input.plurals) : v.input.value,
        updatedAt: now,
        origin: options.origin ?? "agent",
        reviewStatus: "unreviewed",
        notes: v.input.notes,
      };

      const site = liveUsage.keys[v.input.key]?.sites[0];
      memoryAdditions.push({
        sourceLocale: config.sourceLocale,
        targetLocale: options.targetLocale,
        source: v.sourceValue,
        target: v.input.value,
        context: site
          ? `${site.component ?? site.file}${site.element ? ` <${site.element}>` : ""}`
          : undefined,
        origin: options.origin ?? "apply",
        updatedAt: now,
      });
    }
    store.writeRecords(records);
    store.appendMemory(memoryAdditions);

    // Ensure targetLocale is tracked in config if config exists
    if (store.exists() && !config.targetLocales.includes(options.targetLocale)) {
      config.targetLocales = [...config.targetLocales, options.targetLocale];
      store.writeConfig(config);
    }
  }

  return {
    ok: errors.length === 0,
    targetLocale: options.targetLocale,
    appliedCount: validItems.length,
    rejectedCount: errors.length,
    filesWritten: filesWritten.sort(),
    errors,
    warnings,
  };
}
