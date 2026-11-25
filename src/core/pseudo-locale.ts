import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { LayoutRiskFinding } from "../adapters/types.js";
import { applyTranslations } from "./apply.js";
import { getLocaleConventions } from "./locales.js";
import { pseudoLocalizeString } from "./pseudo.js";
import { PolyglotStore } from "./store.js";

export interface PseudoLocaleResult {
  pseudoLocale: string;
  keysGenerated: number;
  filesWritten: string[];
  sample: Array<{ key: string; source: string; pseudo: string }>;
  layoutHotspots: {
    total: number;
    items: LayoutRiskFinding[];
  };
  qaChecklist: string[];
}

export function generatePseudoLocale(
  rootDir: string,
  pseudoLocale = "en-x-pseudo"
): PseudoLocaleResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
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
  const translations: Array<{ key: string; value: string; plurals?: Record<string, string> }> = [];
  const sample: Array<{ key: string; source: string; pseudo: string }> = [];

  for (const [key, entry] of catalog.entries) {
    const pseudo = pseudoLocalizeString(entry.value, detection.placeholderSyntaxes);
    let pseudoPlurals: Record<string, string> | undefined;
    if (entry.plurals) {
      pseudoPlurals = {};
      for (const [pk, pv] of Object.entries(entry.plurals)) {
        pseudoPlurals[pk] = pseudoLocalizeString(pv, detection.placeholderSyntaxes);
      }
    }
    translations.push({ key, value: pseudo, plurals: pseudoPlurals });
    if (sample.length < 5) {
      sample.push({ key, source: entry.value, pseudo });
    }
  }

  const applied = applyTranslations({
    rootDir: store.rootDir,
    targetLocale: pseudoLocale,
    translations,
    origin: "pseudo",
    isPseudo: true,
    strictGlossary: false,
  });

  // Scan for layout/formatting hotspots so the agent knows where to QA visual continuity
  const scanRes = adapter.scanSource(store.rootDir, {
    sourcePaths: config.paths.source,
    ignore: config.paths.ignore,
    i18nLibrary: config.i18nLibrary ?? detection.i18nLibrary,
  });
  const hasRtlTarget = config.targetLocales.some(
    (l) => getLocaleConventions(l).direction === "rtl"
  );
  const hotspots = (scanRes.layoutRisks ?? []).filter(
    (r) => r.kind !== "rtl_physical_direction" || hasRtlTarget
  );

  const filesWritten = applied.filesWritten.map((f) =>
    path.isAbsolute(f) ? path.relative(store.rootDir, f).replace(/\\/g, "/") : f
  );

  const qaChecklist = [
    `Render key routes with locale="${pseudoLocale}" (and inspect with a headless browser/screenshot if available).`,
    "Any visible text NOT wrapped in [...] is still hardcoded — extract it to a translation key.",
    "Check buttons, tabs, navbars, badges, and table headers for clipped brackets ([...]), overflow, or broken wrapping.",
    "Fix layout breakage in CSS/Tailwind (prefer min-w, flex-wrap, logical spacing ms-/me-/ps-/pe-, avoid rigid fixed widths or nowrap on translated labels) or shorten copy where appropriate, then re-run `polyglot check`.",
  ];
  if (hasRtlTarget) {
    qaChecklist.push(
      'Verify RTL visual continuity with dir="rtl" (alignment, icons, margins/paddings using CSS logical properties).'
    );
  }

  return {
    pseudoLocale,
    keysGenerated: applied.appliedCount,
    filesWritten,
    sample,
    layoutHotspots: {
      total: hotspots.length,
      items: hotspots.slice(0, 15),
    },
    qaChecklist,
  };
}
