import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { checkGlossaryCompliance } from "./glossary.js";
import { getLocaleConventions } from "./locales.js";
import { validateTranslationString } from "./placeholders.js";
import { computeContextFingerprint, PolyglotStore, sha256Short } from "./store.js";
import { CheckIssue, CheckIssueCode, CheckSeverity, UsageFile } from "./types.js";

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

export interface CheckSummary {
  passed: boolean;
  framework: string;
  sourceLocale: string;
  targetLocales: string[];
  totalSourceKeys: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  countsByCode: Record<string, number>;
  countsByLocale: Record<string, { errors: number; warnings: number }>;
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
  const store = new PolyglotStore(options.rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const records = store.readRecords();
  const reviews = store.readReviews();
  const prevUsage = store.readUsage();

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const issues: CheckIssue[] = [];
  const dntTerms = glossary.entries.filter((e) => e.doNotTranslate).map((e) => e.term);

  const detectedNonSourceLocales = Object.keys(detection.localeFiles)
    .filter((l) => l !== config.sourceLocale && !l.startsWith("en-x-pseudo") && l !== "pseudo")
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

  let liveUsage: UsageFile = prevUsage;

  if (adapter) {
    // 1. Source scan: hardcoded strings, concatenations, and live key usage sites
    if (!options.skipScan) {
      const scanRes = adapter.scanSource(store.rootDir, {
        sourcePaths: config.paths.source,
        ignore: config.paths.ignore,
        i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
      });

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
          message: `Layout/formatting risk (${lr.constraint}): ${lr.suggestion}`,
          details: { constraint: lr.constraint, component: lr.component, snippet: lr.snippet },
        });
      }

      if (Object.keys(scanRes.usageByKey).length > 0) {
        liveUsage = { version: 1, keys: {} };
        for (const [k, sites] of Object.entries(scanRes.usageByKey)) {
          liveUsage.keys[k] = {
            fingerprint: computeContextFingerprint(sites),
            sites,
          };
        }
        if (store.exists()) {
          store.writeUsage(liveUsage);
        }
      }
    }

    // 2. Load source & target locale catalogs
    const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
    const srcCatalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
    totalSourceKeys = srcCatalog.entries.size;

    // 3. Orphaned keys check (only when usage tracking actually found keys in source)
    const usedKeySet = new Set(Object.keys(liveUsage.keys));
    if (usedKeySet.size > 0) {
      for (const key of srcCatalog.entries.keys()) {
        if (!usedKeySet.has(key)) {
          orphanedKeys++;
          issues.push({
            code: "orphaned_key",
            severity: "warning",
            key,
            message: `Key "${key}" exists in ${config.sourceLocale} locale file but was not found in scanned source files.`,
          });
        }
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

        translatedByLocale[locale]++;

        // Placeholder, ICU, plural, select, inline tag validation
        const problems = validateTranslationString(
          srcEntry.value,
          tgtEntry.value,
          locale,
          detection.placeholderSyntaxes,
          { sourcePlurals: srcEntry.plurals, targetPlurals: tgtEntry.plurals }
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

        // Glossary consistency & DNT
        const glossaryViolations = checkGlossaryCompliance(
          srcEntry.value,
          tgtEntry.value,
          locale,
          glossary.entries
        );
        for (const v of glossaryViolations) {
          issues.push({
            code: v.code,
            severity: v.code === "dnt_violation" ? "error" : "warning",
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

        // Staleness: source changed & context changed
        const rec = records.records[key]?.[locale];
        const currentHash = sha256Short(
          srcEntry.plurals ? JSON.stringify(srcEntry.plurals) : srcEntry.value
        );
        if (rec && rec.sourceHash !== currentHash) {
          staleByLocale[locale]++;
          issues.push({
            code: "stale_source",
            severity: "error",
            locale,
            key,
            message: `[${locale}] ${key}: source text changed since last translation.`,
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

      // Extra keys in target locale not in source
      for (const key of tgtCatalog.entries.keys()) {
        if (!srcCatalog.entries.has(key)) {
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

  // 5. Open verified review findings
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

  // Apply user filters for paginated output
  let filtered = issues;
  if (options.locale) filtered = filtered.filter((i) => i.locale === options.locale);
  if (options.severity) filtered = filtered.filter((i) => i.severity === options.severity);
  if (options.code) filtered = filtered.filter((i) => i.code === options.code);
  if (options.file) filtered = filtered.filter((i) => i.file?.includes(options.file!));

  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));

  return {
    passed: errorCount === 0,
    framework: detection.framework,
    sourceLocale: config.sourceLocale,
    targetLocales,
    totalSourceKeys,
    errorCount,
    warningCount,
    infoCount,
    countsByCode,
    countsByLocale,
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
