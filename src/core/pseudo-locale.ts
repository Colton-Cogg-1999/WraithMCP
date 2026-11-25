import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { LayoutRiskFinding } from "../adapters/types.js";
import { applyTranslations } from "./apply.js";
import { getLocaleConventions } from "./locales.js";
import {
  PSEUDO_MODE_LOCALE_TAG,
  pseudoLocalizeString,
  PseudoMode,
} from "./pseudo.js";
import { validateLocaleTag } from "./security.js";
import { PolyglotStore } from "./store.js";

const TALL_SCRIPT_LANGUAGES = new Set(["th", "vi", "hi", "bn", "ta", "te", "ml", "kn", "km", "lo", "my"]);
const LONG_WORD_LANGUAGES = new Set(["de", "fi", "nl", "da", "sv", "no", "nb", "nn", "hu", "tr", "el"]);

/**
 * Derive pseudo-locale modes automatically from configured target locales:
 * - expand (+ format overlay) is always on (en-XA)
 * - rtl target (ar/he/fa/ur/...) -> ar-XB
 * - cjk target (ja/zh/ko) -> ja-XC
 * - tall-script target (th/vi/hi/...) -> th-XD
 * - compound-word target (de/fi/nl/...) -> de-XE
 */
export function selectAutoPseudoModes(targetLocales: readonly string[]): PseudoMode[] {
  const modes: PseudoMode[] = ["expand"];
  const langs = new Set(targetLocales.map((l) => l.split(/[-_]/)[0].toLowerCase()));

  if (targetLocales.some((l) => getLocaleConventions(l).direction === "rtl")) {
    modes.push("rtl");
  }
  if (langs.has("ja") || langs.has("zh") || langs.has("ko")) {
    modes.push("cjk");
  }
  if ([...langs].some((l) => TALL_SCRIPT_LANGUAGES.has(l))) {
    modes.push("tall");
  }
  if ([...langs].some((l) => LONG_WORD_LANGUAGES.has(l))) {
    modes.push("long-word");
  }
  return modes;
}

export interface PseudoLocaleEntryResult {
  mode: PseudoMode;
  pseudoLocale: string;
  formatOverlay: boolean;
  embedKeyIds: boolean;
  keysGenerated: number;
  filesWritten: string[];
  sample: Array<{ key: string; source: string; pseudo: string }>;
}

export interface PseudoLocaleResult {
  pseudoLocale: string;
  mode: PseudoMode | "auto";
  modesGenerated: PseudoLocaleEntryResult[];
  keysGenerated: number;
  filesWritten: string[];
  sample: Array<{ key: string; source: string; pseudo: string }>;
  layoutHotspots: {
    total: number;
    items: LayoutRiskFinding[];
  };
  qaChecklist: string[];
}

export interface GeneratePseudoOptions {
  pseudoLocale?: string;
  mode?: PseudoMode | "auto";
  /** Embed invisible zero-width key IDs in pseudo strings (default: true) */
  embedKeyIds?: boolean;
  /** Overlay format pseudo-transforms (Arabic-Indic digits, comma decimal, D/M/Y dates, ¤ currency) */
  formatOverlay?: boolean;
}

export function generatePseudoLocale(
  rootDir: string,
  pseudoLocaleOrOptions: string | GeneratePseudoOptions = "en-x-pseudo"
): PseudoLocaleResult {
  const opts: GeneratePseudoOptions =
    typeof pseudoLocaleOrOptions === "string"
      ? { pseudoLocale: pseudoLocaleOrOptions }
      : pseudoLocaleOrOptions;

  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const dntTerms = glossary.entries.filter((e) => e.doNotTranslate).map((e) => e.term);
  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  if (!adapter) {
    throw new Error("No supported framework/locale setup detected for pseudo-locale generation.");
  }

  const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
  if (srcFiles.length === 0) {
    throw new Error(`No source locale files found for "${config.sourceLocale}".`);
  }

  const catalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
  const embedKeyIds = opts.embedKeyIds ?? true;

  // Determine which (mode, localeTag, formatOverlay) tuples to generate
  const plan: Array<{ mode: PseudoMode; localeTag: string; formatOverlay: boolean }> = [];
  if (opts.mode === "auto") {
    const autoModes = selectAutoPseudoModes(config.targetLocales);
    for (const m of autoModes) {
      plan.push({
        mode: m,
        localeTag: PSEUDO_MODE_LOCALE_TAG[m],
        formatOverlay: opts.formatOverlay ?? true,
      });
    }
  } else if (opts.mode) {
    const localeTag = opts.pseudoLocale ?? PSEUDO_MODE_LOCALE_TAG[opts.mode];
    plan.push({
      mode: opts.mode,
      localeTag,
      formatOverlay: opts.formatOverlay ?? (opts.mode === "format"),
    });
  } else {
    const localeTag = opts.pseudoLocale ?? "en-x-pseudo";
    plan.push({
      mode: "expand",
      localeTag,
      formatOverlay: opts.formatOverlay ?? false,
    });
  }

  const modesGenerated: PseudoLocaleEntryResult[] = [];
  const allFilesWritten: string[] = [];

  for (const step of plan) {
    validateLocaleTag(step.localeTag, "pseudoLocale");
    const translations: Array<{ key: string; value: string; plurals?: Record<string, string> }> = [];
    const sample: Array<{ key: string; source: string; pseudo: string }> = [];

    for (const [key, entry] of catalog.entries) {
      const pseudoOpts = {
        mode: step.mode,
        formatOverlay: step.formatOverlay,
        keyId: embedKeyIds ? key : undefined,
        dntTerms,
      };
      const pseudo = pseudoLocalizeString(entry.value, detection.placeholderSyntaxes, pseudoOpts);
      let pseudoPlurals: Record<string, string> | undefined;
      if (entry.plurals) {
        pseudoPlurals = {};
        for (const [pk, pv] of Object.entries(entry.plurals)) {
          pseudoPlurals[pk] = pseudoLocalizeString(pv, detection.placeholderSyntaxes, pseudoOpts);
        }
      }
      translations.push({ key, value: pseudo, plurals: pseudoPlurals });
      if (sample.length < 5) {
        sample.push({ key, source: entry.value, pseudo });
      }
    }

    const applied = applyTranslations({
      rootDir: store.rootDir,
      targetLocale: step.localeTag,
      translations,
      origin: "pseudo",
      isPseudo: true,
      strictGlossary: false,
    });

    const filesWritten = applied.filesWritten.map((f) =>
      path.isAbsolute(f) ? path.relative(store.rootDir, f).replace(/\\/g, "/") : f
    );
    allFilesWritten.push(...filesWritten);
    modesGenerated.push({
      mode: step.mode,
      pseudoLocale: step.localeTag,
      formatOverlay: step.formatOverlay,
      embedKeyIds,
      keysGenerated: applied.appliedCount,
      filesWritten,
      sample,
    });
  }

  // Scan for layout/formatting hotspots
  const scanRes = adapter.scanSource(store.rootDir, {
    sourcePaths: config.paths.source,
    ignore: config.paths.ignore,
    i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
  });
  const hasRtlTarget =
    config.targetLocales.some((l) => getLocaleConventions(l).direction === "rtl") ||
    plan.some((p) => p.mode === "rtl");
  const hotspots = (scanRes.layoutRisks ?? []).filter(
    (r) => r.kind !== "rtl_physical_direction" || hasRtlTarget
  );

  const primary = modesGenerated[0];
  const qaChecklist = [
    `Run \`polyglot layout\` (with a running dev server URL configured) to render routes across [${modesGenerated.map((m) => m.pseudoLocale).join(", ")}] at 375px and 1280px.`,
    "Any visible text NOT wrapped in [...] / 「...」 is hardcoded; any `$1,234.56` or `MM/DD` surviving in format mode skipped locale formatting.",
    "Run `polyglot layout --fix` to apply deterministic Tailwind/HTML codemods, then address any remaining agent prescriptions or width budgets.",
  ];
  if (hasRtlTarget) {
    qaChecklist.push(
      'Verify RTL visual continuity with dir="rtl" in ar-XB (logical margins/paddings ms-/me-/ps-/pe-, text-start/end, icon mirroring).'
    );
  }

  return {
    pseudoLocale: primary?.pseudoLocale ?? "en-x-pseudo",
    mode: opts.mode ?? "expand",
    modesGenerated,
    keysGenerated: modesGenerated.reduce((s, m) => s + m.keysGenerated, 0),
    filesWritten: [...new Set(allFilesWritten)],
    sample: primary?.sample ?? [],
    layoutHotspots: {
      total: hotspots.length,
      items: hotspots.slice(0, 15),
    },
    qaChecklist,
  };
}
