import { WraithStore, sha256Short } from "./store.js";
import { LocaleStatus, ProjectStatus } from "./types.js";
import type { FrameworkDetection, ScannerAdapter } from "../adapters/types.js";

export interface ProjectContextHooks {
  detectProject?: (
    rootDir: string,
    configFramework?: string,
    localesPath?: string
  ) => { adapter: ScannerAdapter | null; detection: FrameworkDetection };
  runQuickCheck?: (rootDir: string) => {
    outcome: "PASS" | "FAIL" | "INCONCLUSIVE";
    passed: boolean;
    errorCount: number;
    warningCount: number;
    orphanedKeys: number;
    staleByLocale: Record<string, number>;
    contextChangedByLocale: Record<string, number>;
    missingByLocale: Record<string, number>;
    extraByLocale: Record<string, number>;
    totalSourceKeys: number;
    translatedByLocale: Record<string, number>;
    detectedLocales: string[];
  };
}

let registeredHooks: ProjectContextHooks = {};

export function registerStatusHooks(hooks: ProjectContextHooks): void {
  registeredHooks = hooks;
}

export function getProjectStatus(rootDir: string): ProjectStatus {
  const store = new WraithStore(rootDir);
  const initialized = store.exists();
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const memory = store.readMemory();
  const assumptions = store.readAssumptions();
  const reviews = store.readReviews();
  const records = store.readRecords();
  const usage = store.readUsage();

  let framework: string = config.framework;
  let i18nLibrary: string | null = config.i18nLibrary ?? null;
  let detectedTargetLocales: string[] = [];

  if (registeredHooks.detectProject) {
    const { detection } = registeredHooks.detectProject(
      store.rootDir,
      config.framework,
      config.paths.locales
    );
    framework = detection.framework;
    i18nLibrary = detection.i18nLibrary;
    detectedTargetLocales = Object.keys(detection.localeFiles).filter(
      (l) => l !== config.sourceLocale && !l.startsWith("en-x-pseudo") && l !== "pseudo"
    );
  }

  const targetLocales =
    config.targetLocales.length > 0 ? config.targetLocales : detectedTargetLocales;

  const openReviews = reviews.reviews.filter((r) => r.status === "open");

  if (registeredHooks.runQuickCheck) {
    const quick = registeredHooks.runQuickCheck(store.rootDir);
    const locales: LocaleStatus[] = targetLocales.map((locale) => {
      const total = quick.totalSourceKeys;
      const translated = quick.translatedByLocale[locale] ?? 0;
      const missing = quick.missingByLocale[locale] ?? Math.max(0, total - translated);
      const extra = quick.extraByLocale[locale] ?? 0;
      const staleSource = quick.staleByLocale[locale] ?? 0;
      const contextChanged = quick.contextChangedByLocale[locale] ?? 0;
      const coveragePct = total === 0 ? 100 : Math.round((translated / total) * 100);
      const localeOpenReviews = openReviews.filter((r) => r.locale === locale).length;
      return {
        locale,
        totalKeys: total,
        translatedKeys: translated,
        missingKeys: missing,
        extraKeys: extra,
        staleSource,
        contextChanged,
        coveragePct,
        openReviews: localeOpenReviews,
      };
    });

    return {
      initialized,
      rootDir: store.rootDir,
      framework,
      i18nLibrary,
      sourceLocale: config.sourceLocale,
      targetLocales,
      totalSourceKeys: quick.totalSourceKeys,
      orphanedKeys: quick.orphanedKeys,
      documents: config.paths.documents,
      locales,
      checkOutcome: quick.outcome,
      checkPassed: quick.passed,
      errorCount: quick.errorCount,
      warningCount: quick.warningCount,
      pendingReviews: openReviews.length,
      glossaryCount: glossary.entries.length,
      memoryCount: memory.length,
      assumptionsCount: assumptions.assumptions.length,
    };
  }

  // Fallback before adapters/check are wired
  const recordKeys = Object.keys(records.records);
  const usageKeys = new Set(Object.keys(usage.keys));
  const orphanedKeys = recordKeys.filter((k) => usageKeys.size > 0 && !usageKeys.has(k)).length;

  const locales: LocaleStatus[] = targetLocales.map((locale) => {
    const translatedKeys = recordKeys.filter((k) => Boolean(records.records[k]?.[locale])).length;
    const totalKeys = recordKeys.length;
    const missingKeys = Math.max(0, totalKeys - translatedKeys);
    const coveragePct = totalKeys === 0 ? 100 : Math.round((translatedKeys / totalKeys) * 100);
    return {
      locale,
      totalKeys,
      translatedKeys,
      missingKeys,
      extraKeys: 0,
      staleSource: 0,
      contextChanged: 0,
      coveragePct,
      openReviews: openReviews.filter((r) => r.locale === locale).length,
    };
  });

  // Avoid unused import warning for sha256Short if refactored later
  void sha256Short;

  return {
    initialized,
    rootDir: store.rootDir,
    framework,
    i18nLibrary,
    sourceLocale: config.sourceLocale,
    targetLocales,
    totalSourceKeys: recordKeys.length,
    orphanedKeys,
    documents: config.paths.documents,
    locales,
    checkPassed: true,
    errorCount: 0,
    warningCount: 0,
    pendingReviews: openReviews.length,
    glossaryCount: glossary.entries.length,
    memoryCount: memory.length,
    assumptionsCount: assumptions.assumptions.length,
  };
}
