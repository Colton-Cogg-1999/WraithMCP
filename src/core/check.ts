import fs from "node:fs";
import { RTL_BASE_LANGS, scanDirectionalAssets } from "./static-layout.js";
import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog, loadSourceCatalog } from "../adapters/registry.js";
import { detectUnscannedFileTypes } from "../adapters/utils.js";
import { checkGlossaryCompliance } from "./glossary.js";
import { charCount, listAssumptions, listQuestions, questionsFor, resolveCharLimit } from "./context.js";
import { getLocaleConventions, getPluralCategories } from "./locales.js";
import { findMissingAdvisoryPluralCategories, PluralValidationContext, validateTranslationString } from "./placeholders.js";
import { evaluateDocumentForCheck, scanDocumentsInProject } from "../documents/registry.js";
import { computeContextFingerprint, WraithStore, sha256Short } from "./store.js";
import {
  CheckIssue,
  CheckIssueCode,
  CheckOutcome,
  CheckSeverity,
  UsageFile,
} from "./types.js";

export interface CheckOptions {
  rootDir: string;
  locale?: string;
  severity?: CheckSeverity;
  code?: CheckIssueCode;
  file?: string;
  offset?: number;
  limit?: number;
  /** Skip source scanner checks (e.g. for fast format-only checks) */
  skipScan?: boolean;
}

export interface VerificationCoverage {
  adapterId: string | null;
  filesScanned: number;
  skippedFiles: Array<{ file: string; reason: string }>;
  parseFailures: Array<{ file: string; error: string }>;
  unsupportedConstructs: Array<{ file?: string; key?: string; description: string }>;
  unscannedFileTypes: Record<string, number>;
  executedChecks: string[];
  documentsChecked: number;
  documentsUnchecked: number;
}

export interface CheckSummary {
  outcome: CheckOutcome;
  passed: boolean;
  inconclusiveReasons: string[];
  disclaimer: string;
  framework: string;
  sourceLocale: string;
  targetLocales: string[];
  totalSourceKeys: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  countsByCode: Record<string, number>;
  countsByLocale: Record<string, { errors: number; warnings: number }>;
  coverage: VerificationCoverage;
  issues: {
    items: CheckIssue[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  /** Internal metrics for status() */
  metrics: {
    orphanedKeys: number;
    missingByLocale: Record<string, number>;
    extraByLocale: Record<string, number>;
    staleByLocale: Record<string, number>;
    contextChangedByLocale: Record<string, number>;
    translatedByLocale: Record<string, number>;
    detectedLocales: string[];
  };
}

const UNIVERSAL_UNTRANSLATABLES = new Set([
  "ok",
  "email",
  "e-mail",
  "api",
  "id",
  "url",
  "http",
  "https",
  "faq",
  "pdf",
  "csv",
  "json",
  "beta",
  "pro",
  "blog",
  "menu",
  "wifi",
  "wi-fi",
  "sms",
]);

function isSuspiciouslyUntranslated(
  source: string,
  target: string,
  sourceLocale: string,
  targetLocale: string,
  dntTerms: string[]
): boolean {
  // Same base language (e.g. en -> en-GB) often shares identical strings
  if (sourceLocale.split("-")[0].toLowerCase() === targetLocale.split("-")[0].toLowerCase()) {
    return false;
  }
  const s = source.trim();
  const t = target.trim();
  if (!s || s !== t) return false;

  // Strip placeholders & inline tags
  const stripped = s
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/\{[^}]+\}/g, "")
    .replace(/%\{[^}]+\}/g, "")
    .replace(/%\([^)]+\)[a-z]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();

  if (stripped.length < 3) return false;
  if (!/\p{L}/u.test(stripped)) return false;
  if (UNIVERSAL_UNTRANSLATABLES.has(stripped.toLowerCase())) return false;

  // If the entire string consists of DNT terms, it's intentionally identical
  let remaining = stripped;
  for (const term of dntTerms) {
    remaining = remaining.replaceAll(term, "").trim();
  }
  if (!/\p{L}/u.test(remaining)) return false;

  return true;
}

const SEVERITY_RANK: Record<CheckSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function runCheck(options: CheckOptions): CheckSummary {
  const store = new WraithStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const records = store.readRecords();
  const reviews = store.readReviews();
  const prevUsage = store.readUsage();
  const layoutState = store.readLayout();
  const questions = listQuestions(store.rootDir);

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const issues: CheckIssue[] = [];
  const dntTerms = glossary.entries.filter((e) => e.doNotTranslate).map((e) => e.term);

  const PSEUDO_TAG_RE = /^(?:en-x-pseudo|pseudo|en-XA|ar-XB|ja-XC|th-XD|de-XE|en-XF)$/i;
  const detectedNonSourceLocales = Object.keys(detection.localeFiles)
    .filter((l) => l !== config.sourceLocale && !PSEUDO_TAG_RE.test(l))
    .sort();

  const targetLocales =
    config.targetLocales.length > 0 ? config.targetLocales : detectedNonSourceLocales;

  const missingByLocale: Record<string, number> = {};
  const extraByLocale: Record<string, number> = {};
  const staleByLocale: Record<string, number> = {};
  const contextChangedByLocale: Record<string, number> = {};
  const translatedByLocale: Record<string, number> = {};

  let totalSourceKeys = 0;
  let orphanedKeys = 0;
  let filesScanned = 0;
  const skippedFiles: Array<{ file: string; reason: string }> = [];
  const parseFailures: Array<{ file: string; error: string }> = [];
  const unsupportedConstructs: Array<{ file?: string; key?: string; description: string }> = [];
  const executedChecks: string[] = [];
  const inconclusiveReasons: string[] = [];
  let documentsChecked = 0;
  let documentsUnchecked = 0;
  let unscannedFileTypes: Record<string, number> = {};

  let liveUsage: UsageFile = prevUsage;
  let scannedUsageByKey: Record<string, import("./types.js").UsageSite[]> | null = null;
  const dynamicNamespaces = new Set<string>();

  if (adapter) {
    // 1. Source scan: hardcoded strings, concatenations, and live key usage sites (READ-ONLY: never mutates .wraith/usage.json)
    if (!options.skipScan) {
      executedChecks.push("source_scan");
      const scanRes = adapter.scanSource(store.rootDir, {
        sourcePaths: config.paths.source,
        ignore: config.paths.ignore,
        i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
      });
      filesScanned = scanRes.filesScanned;
      scannedUsageByKey = scanRes.usageByKey;
      if (scanRes.skippedFiles) skippedFiles.push(...scanRes.skippedFiles);
      for (const ns of scanRes.dynamicKeyNamespaces ?? []) dynamicNamespaces.add(ns);

      for (const pf of scanRes.parseFailures ?? []) {
        parseFailures.push(pf);
        issues.push({
          code: "source_parse_error",
          severity: "error",
          file: pf.file,
          message: `Failed to parse "${pf.file}": ${pf.error}`,
        });
      }

      for (const h of scanRes.hardcodedStrings) {
        issues.push({
          code: "hardcoded_string",
          severity: "error",
          file: h.file,
          line: h.line,
          message: `Hardcoded user-facing string "${h.text}" (${h.kind}${h.attribute ? `:${h.attribute}` : ""})`,
          details: { text: h.text, kind: h.kind, attribute: h.attribute, component: h.component },
        });
      }

      for (const c of scanRes.concatenations) {
        issues.push({
          code: "string_concatenation",
          severity: "error",
          file: c.file,
          line: c.line,
          message: `${c.reason} (${c.expression})`,
          details: { expression: c.expression, component: c.component },
        });
      }

      const hasRtlTarget = targetLocales.some((l) => getLocaleConventions(l).direction === "rtl");
      for (const lr of scanRes.layoutRisks ?? []) {
        if (lr.kind === "rtl_physical_direction" && !hasRtlTarget) continue;
        issues.push({
          code: lr.kind === "rtl_physical_direction" ? "rtl_layout_risk" : "layout_risk",
          severity: "warning",
          file: lr.file,
          line: lr.line,
          key: lr.key,
          message: `Layout/formatting risk (${lr.constraint}): ${lr.suggestion}`,
          details: { constraint: lr.constraint, component: lr.component, snippet: lr.snippet },
        });
      }

      for (const hf of scanRes.hardcodedFormatting ?? []) {
        issues.push({
          code: "hardcoded_formatting",
          severity: "warning",
          file: hf.file,
          line: hf.line,
          message: `Hardcoded formatting (${hf.rule}): ${hf.suggestion}`,
          details: { rule: hf.rule, snippet: hf.snippet },
        });
      }

      if (targetLocales.some((l) => RTL_BASE_LANGS.has(l.toLowerCase().split("-")[0]))) {
        for (const da of scanDirectionalAssets(store.rootDir, config.paths.source, config.paths.ignore)) {
          issues.push({
            code: "directional_asset",
            severity: "warning",
            file: da.file,
            line: da.line,
            message: `Directional asset (${da.asset}) does not mirror in RTL: ${da.suggestion}`,
            details: { asset: da.asset, snippet: da.snippet },
          });
        }
      }

      if (Object.keys(scanRes.usageByKey).length > 0) {
        liveUsage = { version: 1, keys: {} };
        for (const [k, sites] of Object.entries(scanRes.usageByKey)) {
          liveUsage.keys[k] = {
            fingerprint: computeContextFingerprint(sites),
            sites,
          };
        }
      }
    }

    // 2. Load source & target locale catalogs with per-file error isolation
    const srcCatalog = loadSourceCatalog(adapter, detection, config.sourceLocale);
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
    for (const err of srcCatalog.errors) {
      const rel = path.relative(store.rootDir, err.file).replace(/\\/g, "/");
      parseFailures.push({ file: rel, error: err.error });
      issues.push({
        code: "locale_parse_error",
        severity: "error",
        locale: err.locale,
        file: rel,
        message: `Failed to parse source locale file "${rel}": ${err.error}`,
      });
    }
    for (const u of srcCatalog.unsupportedConstructs) {
      unsupportedConstructs.push({
        file: path.relative(store.rootDir, u.file).replace(/\\/g, "/"),
        key: u.key,
        description: u.description,
      });
    }
    totalSourceKeys = srcCatalog.entries.size;
    if (totalSourceKeys > 0) {
      executedChecks.push("catalog_parity", "placeholders", "plurals", "glossary", "staleness");
    }

    // 3. Source-code key reference check (B4/B5, MISS-1/MISS-2): static keys referenced in code must exist in source catalog
    const resolvedUsedKeys = new Set<string>(Object.keys(liveUsage.keys));
    const isI18next =
      pluralModel === "i18next" || detection.placeholderSyntaxes.includes("double-mustache");
    // When a single namespace file sits under `<locale>/<ns>.json` (e.g. public/locales/en/common.json),
    // loadLocaleCatalog omits the `<ns>.` prefix, while `useTranslation("common")` prefixes keys with `common.`.
    const singleFileNamespace =
      srcCatalog.files.length === 1 &&
      path.basename(path.dirname(srcCatalog.files[0])) === config.sourceLocale
        ? path.basename(srcCatalog.files[0], path.extname(srcCatalog.files[0]))
        : null;

    const I18NEXT_PLURAL_CATS = ["zero", "one", "two", "few", "many", "other"];

    const resolveMatchingCatalogKeys = (usedKey: string): string[] => {
      const candidates = [usedKey];
      if (singleFileNamespace && usedKey.startsWith(`${singleFileNamespace}.`)) {
        candidates.push(usedKey.slice(singleFileNamespace.length + 1));
      }
      const matched: string[] = [];
      for (const cand of candidates) {
        if (srcCatalog.entries.has(cand)) {
          matched.push(cand);
        }
        if (isI18next) {
          // i18next plural suffixes (_zero/_one/_two/_few/_many/_other, _ordinal_*) and context suffixes (key_<ctx>, key_<ctx>_<plural>)
          const prefix = `${cand}_`;
          for (const catKey of srcCatalog.entries.keys()) {
            if (!catKey.startsWith(prefix)) continue;
            const suffix = catKey.slice(prefix.length);
            if (
              I18NEXT_PLURAL_CATS.includes(suffix) ||
              /^ordinal_(?:zero|one|two|few|many|other)$/.test(suffix) ||
              /^[a-zA-Z0-9-]+(?:_(?:zero|one|two|few|many|other))?$/.test(suffix)
            ) {
              matched.push(catKey);
            }
          }
        }
        if (pluralModel === "rails") {
          for (const cat of I18NEXT_PLURAL_CATS) {
            const rk = `${cand}.${cat}`;
            if (srcCatalog.entries.has(rk)) matched.push(rk);
          }
        }
      }
      return matched;
    };

    if (!options.skipScan && scannedUsageByKey && Object.keys(scannedUsageByKey).length > 0) {
      executedChecks.push("source_key_references");
      for (const [key, sites] of Object.entries(scannedUsageByKey)) {
        const matched = resolveMatchingCatalogKeys(key);
        for (const m of matched) resolvedUsedKeys.add(m);

        if (matched.length === 0) {
          const firstSite = sites[0];
          issues.push({
            code: "missing_source_key",
            severity: "error",
            key,
            file: firstSite?.file,
            line: firstSite?.line,
            message:
              adapter.id === "django" && totalSourceKeys === 0
                ? `Marked Django string "${key}" is referenced in code (${firstSite?.file ?? "source"}) but no gettext .po catalog exists yet (run django-admin makemessages).`
                : `Key "${key}" is referenced in code (${firstSite?.file ?? "source"}) but missing from the "${config.sourceLocale}" source catalog.`,
            details: { sites: sites.slice(0, 5) },
          });
        }
      }
    } else {
      // Even when skipScan is true, resolve plural/context/namespace keys from cached usage
      for (const key of Object.keys(liveUsage.keys)) {
        for (const m of resolveMatchingCatalogKeys(key)) resolvedUsedKeys.add(m);
      }
    }

    // 3b. Orphaned keys check (suppress when dynamic keys cover that namespace or resolved plural/context/namespace matches)
    if (resolvedUsedKeys.size > 0 && !dynamicNamespaces.has("*")) {
      executedChecks.push("orphan_keys");
      for (const key of srcCatalog.entries.keys()) {
        if (resolvedUsedKeys.has(key)) continue;
        const coveredByDynamic = [...dynamicNamespaces].some(
          (ns) => ns !== "" && (key === ns || key.startsWith(`${ns}.`))
        );
        if (coveredByDynamic) continue;
        orphanedKeys++;
        issues.push({
          code: "orphaned_key",
          severity: "warning",
          key,
          message: `Key "${key}" exists in ${config.sourceLocale} locale file but was not found in scanned source files.`,
        });
      }
    }

    // 4. Per-locale deterministic checks
    for (const locale of targetLocales) {
      missingByLocale[locale] = 0;
      extraByLocale[locale] = 0;
      staleByLocale[locale] = 0;
      contextChangedByLocale[locale] = 0;
      translatedByLocale[locale] = 0;

      const tgtFiles = detection.localeFiles[locale] ?? [];
      const tgtCatalog = loadLocaleCatalog(adapter, tgtFiles, locale);
      for (const err of tgtCatalog.errors) {
        const rel = path.relative(store.rootDir, err.file).replace(/\\/g, "/");
        parseFailures.push({ file: rel, error: err.error });
        issues.push({
          code: "locale_parse_error",
          severity: "error",
          locale,
          file: rel,
          message: `Failed to parse ${locale} locale file "${rel}": ${err.error}`,
        });
      }
      for (const u of tgtCatalog.unsupportedConstructs) {
        unsupportedConstructs.push({
          file: path.relative(store.rootDir, u.file).replace(/\\/g, "/"),
          key: u.key,
          description: u.description,
        });
      }
      // If target files failed to parse, don't generate cascading false missing_key errors for that broken file
      if (tgtCatalog.errors.length > 0 && tgtCatalog.entries.size === 0) {
        continue;
      }
      const conv = getLocaleConventions(locale);

      // Track same-source-text inconsistency across keys in this locale
      const sourceToTranslations = new Map<string, Map<string, string[]>>();

      for (const [key, srcEntry] of srcCatalog.entries) {
        const tgtEntry = tgtCatalog.entries.get(key);
        if (!tgtEntry || tgtEntry.value.trim() === "") {
          missingByLocale[locale]++;
          issues.push({
            code: "missing_key",
            severity: "error",
            locale,
            key,
            message: `Missing translation for "${key}" in ${locale}.`,
          });
          continue;
        }

        // Gettext #, fuzzy entries are ignored at runtime by Django/gettext -> must fail check!
        if (tgtEntry.fuzzy) {
          missingByLocale[locale]++;
          issues.push({
            code: "fuzzy_translation",
            severity: "error",
            locale,
            key,
            message: `[${locale}] ${key}: marked '#, fuzzy' (ignored at runtime by gettext/Django until reviewed and applied).`,
          });
          continue;
        }

        translatedByLocale[locale]++;

        // Placeholder, ICU, plural, select, inline tag validation
        const problems = validateTranslationString(
          srcEntry.value,
          tgtEntry.value,
          locale,
          detection.placeholderSyntaxes,
          {
            sourcePlurals: srcEntry.plurals,
            targetPlurals: tgtEntry.plurals,
            pluralModel,
            gettextNplurals: tgtEntry.pluralForms?.nplurals,
          }
        );
        for (const p of problems) {
          issues.push({
            code: p.code,
            severity: "error",
            locale,
            key,
            message: `[${locale}] ${key}: ${p.message}`,
            details: p.details,
          });
        }

        // N10: Surface optional CLDR advisory plural categories (e.g. 'many' for cs/lt fractions or fr/es/it/pt millions) as info
        if (pluralModel === "icu") {
          const advisoryNotes = findMissingAdvisoryPluralCategories(
            srcEntry.value,
            tgtEntry.value,
            locale,
            detection.placeholderSyntaxes
          );
          for (const adv of advisoryNotes) {
            issues.push({
              code: "advisory_plural_category",
              severity: "info",
              locale,
              key,
              message: `[${locale}] ${key}: ICU plural "${adv.variable}" omits optional CLDR advisory category [${adv.missingAdvisory.join(", ")}] (applies to fractions or large numbers like millions).`,
              details: { variable: adv.variable, advisory: adv.missingAdvisory },
            });
          }
        }

        // Glossary consistency & DNT (explicit user/imported glossary rules are blocking errors -> O4)
        const glossaryViolations = checkGlossaryCompliance(
          srcEntry.value,
          tgtEntry.value,
          locale,
          glossary.entries
        );
        for (const v of glossaryViolations) {
          issues.push({
            code: v.code,
            severity: v.code === "dnt_violation" || v.origin !== "inferred" ? "error" : "warning",
            locale,
            key,
            message: `[${locale}] ${key}: ${v.message}`,
            details: { term: v.term, expected: v.expected },
          });
        }

        // Untranslated detection
        if (
          isSuspiciouslyUntranslated(
            srcEntry.value,
            tgtEntry.value,
            config.sourceLocale,
            locale,
            dntTerms
          )
        ) {
          issues.push({
            code: "untranslated",
            severity: "warning",
            locale,
            key,
            message: `[${locale}] ${key}: translation matches source "${srcEntry.value}" verbatim.`,
          });
        }

        // Length expansion risk (especially important for short UI strings)
        const srcLen = srcEntry.value.length;
        const tgtLen = tgtEntry.value.length;
        const maxSafeRatio = srcLen <= 15 ? 2.4 : Math.max(1.8, conv.expectedExpansionRatio * 1.45);
        if (srcLen >= 4 && tgtLen / srcLen > maxSafeRatio && tgtLen - srcLen >= 10) {
          issues.push({
            code: "length_expansion_risk",
            severity: "warning",
            locale,
            key,
            message: `[${locale}] ${key}: translated length (${tgtLen}) is ${(tgtLen / srcLen).toFixed(1)}x source (${srcLen}); check UI truncation.`,
            details: { sourceLength: srcLen, targetLength: tgtLen },
          });
        }

        // Character Limits: Declared (config) fail check; Inferred (rendered measurement or a length
        // budget for constrained elements) are advisory: the agent shortens, or asks if it cannot.
        const site0 = liveUsage.keys[key]?.sites?.[0];
        const limit = resolveCharLimit({ config, layout: layoutState, key, locale, source: srcEntry.value, element: site0?.element });
        const tgtChars = charCount(tgtEntry.value);
        if (limit && tgtChars > limit.maxChars) {
          const budget = layoutState.budgets[key]?.[locale];
          const code = limit.kind === "declared" ? "char_limit_exceeded" : limit.basis === "rendered" ? "layout_budget_exceeded" : "char_limit_inferred";
          const why =
            limit.basis === "config"
              ? "declared Character Limit (.wraith/config.json charLimits)"
              : limit.basis === "rendered"
                ? `width measured in the rendered UI (${budget?.maxWidthPx}px on <${budget?.element ?? "element"}>)`
                : `inferred length budget for a <${site0?.element ?? "element"}> label`;
          issues.push({
            code,
            severity: limit.kind === "declared" ? "error" : "warning",
            locale,
            key,
            file: budget?.file ?? site0?.file,
            line: budget?.line ?? site0?.line,
            message: `[${locale}] ${key}: ${tgtChars} chars exceeds the ${limit.maxChars}-char ${why}. Shorten it (an approved glossary abbreviation may help, keeping the full label in title/aria-label)${limit.kind === "inferred" ? "; if it cannot be shortened without losing meaning, record an Open Question" : ""}.`,
            details: { targetLength: tgtChars, maxChars: limit.maxChars, kind: limit.kind, basis: limit.basis, ...(budget ? { maxWidthPx: budget.maxWidthPx, constraint: budget.constraint } : {}) },
          });
        }

        // Open Questions about this string: still open, or answered but not yet reflected
        for (const q of questionsFor(questions, key, locale)) {
          if (q.status === "open") {
            issues.push({ code: "open_question", severity: "warning", locale, key, message: `[${locale}] ${key}: ${q.id} is open: ${q.question}`, details: { id: q.id } });
          } else if (q.status === "answered") {
            issues.push({
              code: "answer_pending",
              severity: "warning",
              locale,
              key,
              message: `[${locale}] ${key}: ${q.id} was answered ("${q.answer}"). Revisit this translation, then resolve ${q.id}.`,
              details: { id: q.id },
            });
          }
        }

        // Staleness: source changed, context changed, manual edit divergence, & glossary-flagged records
        const rec = records.records[key]?.[locale];
        const currentHash = sha256Short(
          srcEntry.plurals ? JSON.stringify(srcEntry.plurals) : srcEntry.value
        );
        const liveSerializedTarget = tgtEntry.plurals
          ? JSON.stringify(tgtEntry.plurals)
          : tgtEntry.value;
        if (rec && rec.reviewStatus === "flagged" && glossaryViolations.length === 0) {
          issues.push({
            code: "glossary_flagged",
            severity: "error",
            locale,
            key,
            message: `[${locale}] ${key}: flagged for re-translation after glossary or review update.`,
          });
        }
        const targetChangedManually = Boolean(
          rec && rec.translation && rec.translation !== liveSerializedTarget
        );
        if (targetChangedManually) {
          issues.push({
            code: "manual_edit_detected",
            severity: "info",
            locale,
            key,
            message: `[${locale}] ${key}: target file differs from last recorded translation (manual edit detected; run \`wraith import --format locales\` to update baseline).`,
          });
        }
        const baselineHash = records.sourceBaselines?.[key];
        if (rec && rec.sourceHash !== currentHash) {
          // STALE-1 + N2/MT2: A manual edit to the target file ONLY suppresses stale_source if the
          // target file was modified AT OR AFTER the source file (co-edited together). An earlier
          // translator tweak (source file modified strictly AFTER target file) must NEVER launder
          // future source meaning changes!
          let targetUpdatedAfterSource = false;
          if (targetChangedManually) {
            try {
              const srcFilePath = srcCatalog.keyToFile.get(key) ?? srcEntry.file;
              const tgtFilePath = tgtCatalog.keyToFile.get(key) ?? tgtEntry.file;
              if (srcFilePath && tgtFilePath && fs.existsSync(srcFilePath) && fs.existsSync(tgtFilePath)) {
                const srcMtimeNs = fs.statSync(srcFilePath, { bigint: true }).mtimeNs;
                const tgtMtimeNs = fs.statSync(tgtFilePath, { bigint: true }).mtimeNs;
                targetUpdatedAfterSource = tgtMtimeNs >= srcMtimeNs;
              }
            } catch {
              targetUpdatedAfterSource = false;
            }
          }
          if (!targetUpdatedAfterSource) {
            staleByLocale[locale]++;
            issues.push({
              code: "stale_source",
              severity: "error",
              locale,
              key,
              message: `[${locale}] ${key}: source text changed since last translation.`,
            });
          }
        } else if (!rec && baselineHash && baselineHash !== currentHash) {
          // N3 / MT1: Translation was added by hand after init (no record), and source later changed
          // relative to the recorded source baseline -> report stale_source!
          staleByLocale[locale]++;
          issues.push({
            code: "stale_source",
            severity: "error",
            locale,
            key,
            message: `[${locale}] ${key}: source text changed since baseline; hand-added translation needs verification (or run \`wraith import --format locales\` after updating).`,
          });
        } else if (rec) {
          const currentFp = liveUsage.keys[key]?.fingerprint ?? "";
          if (currentFp && rec.contextFingerprint && rec.contextFingerprint !== currentFp) {
            contextChangedByLocale[locale]++;
            issues.push({
              code: "context_changed",
              severity: "warning",
              locale,
              key,
              message: `[${locale}] ${key}: usage context changed (moved component/element/surrounding labels) — verify meaning still fits.`,
              details: {
                previousFingerprint: rec.contextFingerprint,
                currentFingerprint: currentFp,
              },
            });
          }
        }

        // Track exact short source phrases translated inconsistently across keys
        const normSrc = srcEntry.value.trim();
        if (normSrc.length >= 2 && normSrc.length <= 28 && !/[{}]/.test(normSrc)) {
          const map = sourceToTranslations.get(normSrc) ?? new Map<string, string[]>();
          const normTgt = tgtEntry.value.trim().toLowerCase();
          map.set(normTgt, [...(map.get(normTgt) ?? []), key]);
          sourceToTranslations.set(normSrc, map);
        }
      }

      // Report inconsistent translations of identical short source phrases
      for (const [srcPhrase, tgtVariants] of sourceToTranslations) {
        if (tgtVariants.size > 1) {
          const variants = [...tgtVariants.keys()];
          const keys = [...tgtVariants.values()].flat();
          // Skip if already covered by a glossary entry
          const hasGlossary = glossary.entries.some(
            (e) => e.term.toLowerCase() === srcPhrase.toLowerCase()
          );
          if (!hasGlossary) {
            issues.push({
              code: "glossary_inconsistency",
              severity: "warning",
              locale,
              key: keys[0],
              message: `[${locale}] "${srcPhrase}" translated inconsistently as ${variants.join(" / ")} across keys (${keys.join(", ")}).`,
              details: { term: srcPhrase, variants, keys },
            });
          }
        }
      }

      // i18next key-suffix plural check (e.g. items_one / items_other -> ru requires items_few / items_many)
      if (pluralModel === "i18next" || detection.placeholderSyntaxes.includes("double-mustache")) {
        const suffixRe = /^(.*)_(zero|one|two|few|many|other)$/;
        const srcPluralBases = new Set<string>();
        for (const k of srcCatalog.entries.keys()) {
          const m = suffixRe.exec(k);
          if (m && srcCatalog.entries.has(`${m[1]}_other`)) {
            srcPluralBases.add(m[1]);
          }
        }
        const requiredCats = getPluralCategories(locale, "cardinal");
        for (const base of srcPluralBases) {
          const missingSuffixes = requiredCats.filter(
            (cat) => !tgtCatalog.entries.has(`${base}_${cat}`)
          );
          if (missingSuffixes.length > 0) {
            issues.push({
              code: "missing_plural_category",
              severity: "error",
              locale,
              key: base,
              message: `[${locale}] i18next plural key "${base}" is missing required plural suffix key(s): ${missingSuffixes.map((c) => `${base}_${c}`).join(", ")}.`,
              details: { base, missing: missingSuffixes, required: requiredCats },
            });
          }
        }
      }

      // Extra keys in target locale not in source (excluding valid i18next target-locale plural suffix keys like _few/_many!)
      for (const key of tgtCatalog.entries.keys()) {
        if (!srcCatalog.entries.has(key)) {
          const i18nextSuffix = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
          if (
            i18nextSuffix &&
            (pluralModel === "i18next" || detection.placeholderSyntaxes.includes("double-mustache")) &&
            srcCatalog.entries.has(`${i18nextSuffix[1]}_other`)
          ) {
            continue;
          }
          extraByLocale[locale]++;
          issues.push({
            code: "extra_key",
            severity: "warning",
            locale,
            key,
            message: `[${locale}] Extra key "${key}" does not exist in source locale "${config.sourceLocale}".`,
          });
        }
      }
    }
  }

  // 5. Configured documents verification
  const configuredDocs =
    config.paths.documents.length > 0
      ? scanDocumentsInProject(store.rootDir, config.paths.documents)
      : [];

  if (configuredDocs.length > 0) {
    executedChecks.push("documents");

    for (const doc of configuredDocs) {
      if (targetLocales.length === 0) {
        documentsUnchecked++;
        inconclusiveReasons.push(`Document "${doc.file}" is configured, but no targetLocales are set.`);
        continue;
      }
      documentsChecked++;
      for (const locale of targetLocales) {
        const docEval = evaluateDocumentForCheck(store.rootDir, doc.file, locale);

        if (docEval.targetPathError) {
          issues.push({
            code: "missing_document_translation",
            severity: "error",
            locale,
            file: doc.file,
            message: `[${locale}] Configured document "${doc.file}" has an invalid target path: ${docEval.targetPathError}`,
          });
          continue;
        }

        if (!docEval.targetExists) {
          issues.push({
            code: "missing_document_translation",
            severity: "error",
            locale,
            file: doc.file,
            message: `[${locale}] Configured document "${doc.file}" (${doc.segments} segments) has no translated output file.`,
          });
          continue;
        }

        if (docEval.hasStateRecord && docEval.evaluation) {
          const ev = docEval.evaluation;
          for (const seg of ev.segments) {
            if (seg.status === "stale") {
              staleByLocale[locale] = (staleByLocale[locale] ?? 0) + 1;
              issues.push({
                code: "stale_source",
                severity: "error",
                locale,
                file: doc.file,
                key: seg.segment.id,
                message: `[${locale}] Document "${doc.file}" segment "${seg.segment.id}" source changed since last translation; re-translation required.`,
                details: seg.staleInfo
                  ? {
                      previousSource: seg.staleInfo.previousSource,
                      currentSource: seg.staleInfo.currentSource,
                    }
                  : undefined,
              });
            }
          }

          if (ev.untranslatedCount > 0) {
            issues.push({
              code: "missing_document_translation",
              severity: "error",
              locale,
              file: doc.file,
              message: `[${locale}] Configured document "${doc.file}" has ${ev.untranslatedCount} untranslated segment(s) (${ev.translatedCount}/${ev.segments.length} current segments translated).`,
            });
          }
        }
      }
    }
  } else if (config.paths.documents.length > 0) {
    inconclusiveReasons.push(
      `paths.documents configured (${config.paths.documents.join(", ")}), but no supported .docx/.md/.mdx files were found.`
    );
  }

  // 6. Open verified review findings
  for (const rev of reviews.reviews) {
    if (rev.status === "open" && rev.verified) {
      issues.push({
        code: "open_review_finding",
        severity: rev.severity === "critical" || rev.severity === "major" ? "error" : "warning",
        locale: rev.locale,
        key: rev.key,
        message: `[${rev.locale}] ${rev.key} (${rev.category}/${rev.severity}): ${rev.explanation}`,
        details: { reviewId: rev.id, suggestion: rev.suggestion },
      });
    }
  }

  // 6b. Human overrides of agent assumptions not yet reflected in the translations
  for (const a of listAssumptions(store.rootDir)) {
    if (a.status !== "overridden") continue;
    if (a.locale && !targetLocales.includes(a.locale)) continue;
    issues.push({
      code: "assumption_overridden",
      severity: "warning",
      ...(a.locale ? { locale: a.locale } : {}),
      message: `${a.label} was overridden${a.locale ? ` for ${a.locale}` : ""}: "${a.override}" (was: ${a.summary}). Revisit the affected strings, then mark ${a.label} applied.`,
      details: { label: a.label },
    });
  }

  // 7. Determine coverage sufficiency (fail closed: INCONCLUSIVE when nothing verifiable was checked
  // or when unscanned UI template/MDX files exist under sourcePaths)
  if (adapter && !options.skipScan) {
    const adapterExts: Record<string, string[]> = {
      "react-nextjs": [".tsx", ".jsx", ".ts", ".js", ".mjs"],
      "vue-nuxt": [".vue", ".ts", ".js"],
      sveltekit: [".svelte", ".ts", ".js"],
      rails: [".erb", ".rb"],
      django: [".html", ".py"],
    };
    const scannedExts = new Set(adapterExts[adapter.id] ?? []);
    const configuredDocSet = new Set(configuredDocs.map((d) => d.file));
    const unscanned = detectUnscannedFileTypes(
      store.rootDir,
      config.paths.source,
      config.paths.ignore,
      scannedExts,
      configuredDocSet
    );
    unscannedFileTypes = unscanned.unscannedFileTypes;
    const templateEntries = Object.entries(unscanned.unscannedTemplateTypes).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    if (templateEntries.length > 0) {
      const desc = templateEntries.map(([ext, cnt]) => `${cnt} ${ext}`).join(", ");
      inconclusiveReasons.push(
        `Unscanned template/content file type(s) found under source paths (${desc}) not covered by the ${detection.framework} scanner${templateEntries.some(([e]) => e === ".mdx") ? " (configure .mdx files in paths.documents to verify them)" : ""}.`
      );
    }
  }

  if (!adapter && configuredDocs.length === 0) {
    inconclusiveReasons.push(
      detection.notes[0] ??
        "No supported framework adapter or configured documents were detected; cannot verify localization."
    );
  } else if (adapter && !options.skipScan && filesScanned === 0 && configuredDocs.length === 0) {
    inconclusiveReasons.push(
      `Detected ${detection.framework}, but scanned 0 source files (check paths.source: ${JSON.stringify(config.paths.source)}).`
    );
  } else if (adapter && totalSourceKeys === 0 && filesScanned === 0 && configuredDocs.length === 0) {
    inconclusiveReasons.push(
      `Detected ${detection.framework}, but found 0 source keys and scanned 0 source files.`
    );
  }

  // Sort deterministically: error > warning > info, then code, locale, file, key
  issues.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.code.localeCompare(b.code) ||
      (a.locale ?? "").localeCompare(b.locale ?? "") ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.key ?? "").localeCompare(b.key ?? "")
  );

  const countsByCode: Record<string, number> = {};
  const countsByLocale: Record<string, { errors: number; warnings: number }> = {};
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const iss of issues) {
    countsByCode[iss.code] = (countsByCode[iss.code] ?? 0) + 1;
    if (iss.severity === "error") errorCount++;
    else if (iss.severity === "warning") warningCount++;
    else infoCount++;

    if (iss.locale) {
      countsByLocale[iss.locale] = countsByLocale[iss.locale] ?? { errors: 0, warnings: 0 };
      if (iss.severity === "error") countsByLocale[iss.locale].errors++;
      else if (iss.severity === "warning") countsByLocale[iss.locale].warnings++;
    }
  }

  const outcome: CheckOutcome =
    errorCount > 0 ? "FAIL" : inconclusiveReasons.length > 0 ? "INCONCLUSIVE" : "PASS";
  const passed = outcome === "PASS";

  // Apply user filters for paginated output
  let filtered = issues;
  if (options.locale) filtered = filtered.filter((i) => i.locale === options.locale);
  if (options.severity) filtered = filtered.filter((i) => i.severity === options.severity);
  if (options.code) filtered = filtered.filter((i) => i.code === options.code);
  if (options.file) filtered = filtered.filter((i) => i.file?.includes(options.file!));

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));

  return {
    outcome,
    passed,
    inconclusiveReasons,
    disclaimer:
      "Deterministic checks verify catalog parity, placeholders, plurals, glossary rules, and static scanner heuristics; they do not guarantee linguistic accuracy or native fluency.",
    framework: detection.framework,
    sourceLocale: config.sourceLocale,
    targetLocales,
    totalSourceKeys,
    errorCount,
    warningCount,
    infoCount,
    countsByCode,
    countsByLocale,
    coverage: {
      adapterId: adapter?.id ?? null,
      filesScanned,
      skippedFiles,
      parseFailures,
      unsupportedConstructs,
      unscannedFileTypes,
      executedChecks,
      documentsChecked,
      documentsUnchecked,
    },
    issues: {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + limit < filtered.length,
    },
    metrics: {
      orphanedKeys,
      missingByLocale,
      extraByLocale,
      staleByLocale,
      contextChangedByLocale,
      translatedByLocale,
      detectedLocales: detectedNonSourceLocales,
    },
  };
}
