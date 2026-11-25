import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { runCheck } from "./check.js";
import { PolyglotStore } from "./store.js";
import { Assumption } from "./types.js";

export interface ReviewRecommendation {
  key: string;
  locale: string;
  source: string;
  translation: string;
  reason: string;
  context?: string;
}

export interface LocalizationReport {
  generatedAt: string;
  framework: string;
  sourceLocale: string;
  targetLocales: string[];
  checkPassed: boolean;
  summary: {
    totalSourceKeys: number;
    errorCount: number;
    warningCount: number;
    issuesByCategory: Record<string, number>;
    assumptionsMade: number;
    stringsToReview: number;
  };
  assumptions: Assumption[];
  reviewList: ReviewRecommendation[];
  markdown: string;
}

const AMBIGUOUS_UI_TERMS = new Set([
  "post",
  "open",
  "close",
  "save",
  "share",
  "plan",
  "home",
  "free",
  "lead",
  "charge",
  "draft",
  "issue",
  "book",
  "run",
  "match",
  "check",
  "order",
  "view",
  "file",
  "bill",
]);

export function generateReport(rootDir: string): LocalizationReport {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const assumptionsFile = store.readAssumptions();
  const reviewsFile = store.readReviews();
  const usage = store.readUsage();
  const check = runCheck({ rootDir, limit: 100 });

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const reviewList: ReviewRecommendation[] = [];
  const seenReviewKey = new Set<string>();

  if (adapter) {
    const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
    const srcCatalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);

    for (const locale of check.targetLocales) {
      const tgtFiles = detection.localeFiles[locale] ?? [];
      const tgtCatalog = loadLocaleCatalog(adapter, tgtFiles, locale);

      // 1. Flagged warnings from check (context_changed, glossary_inconsistency, length_expansion_risk, untranslated)
      for (const iss of check.issues.items) {
        if (iss.locale !== locale || !iss.key) continue;
        if (
          iss.code === "context_changed" ||
          iss.code === "glossary_inconsistency" ||
          iss.code === "length_expansion_risk" ||
          iss.code === "untranslated" ||
          iss.code === "open_review_finding"
        ) {
          const rk = `${locale}|${iss.key}`;
          if (seenReviewKey.has(rk)) continue;
          seenReviewKey.add(rk);
          const site = usage.keys[iss.key]?.sites[0];
          reviewList.push({
            key: iss.key,
            locale,
            source: srcCatalog.entries.get(iss.key)?.value ?? "",
            translation: tgtCatalog.entries.get(iss.key)?.value ?? "",
            reason: iss.message,
            context: site ? `${site.file}:${site.line} (${site.component ?? site.element ?? ""})` : undefined,
          });
        }
      }

      // 2. Ambiguous short UI terms without an explicit user/imported glossary entry
      const glossary = store.readGlossary();
      for (const [key, srcEntry] of srcCatalog.entries) {
        const trimmed = srcEntry.value.trim().toLowerCase();
        if (!AMBIGUOUS_UI_TERMS.has(trimmed)) continue;
        const confirmedInGlossary = glossary.entries.some(
          (g) => g.term.toLowerCase() === trimmed && g.origin !== "inferred"
        );
        if (confirmedInGlossary) continue;
        const rk = `${locale}|${key}`;
        if (seenReviewKey.has(rk)) continue;
        const tgt = tgtCatalog.entries.get(key)?.value;
        if (!tgt) continue;
        seenReviewKey.add(rk);
        const site = usage.keys[key]?.sites[0];
        reviewList.push({
          key,
          locale,
          source: srcEntry.value,
          translation: tgt,
          reason: `Ambiguous short UI term "${srcEntry.value}" — verify meaning matches context.`,
          context: site ? `${site.file}:${site.line} (${site.component ?? site.element ?? ""})` : undefined,
        });
      }
    }
  }

  // Include open human/cross-model reviews not already listed
  for (const r of reviewsFile.reviews) {
    if (r.status !== "open") continue;
    const rk = `${r.locale}|${r.key}`;
    if (seenReviewKey.has(rk)) continue;
    seenReviewKey.add(rk);
    reviewList.push({
      key: r.key,
      locale: r.locale,
      source: "",
      translation: "",
      reason: `Review finding (${r.category}/${r.severity}): ${r.explanation}`,
    });
  }

  const lines: string[] = [];
  lines.push(`## Polyglot Localization Report`);
  lines.push("");
  lines.push(
    `**Status:** ${check.passed ? "✓ Clean (0 errors)" : `✗ ${check.errorCount} error(s)`} · **Warnings:** ${check.warningCount} · **Source:** \`${check.sourceLocale}\` (${check.totalSourceKeys} keys) · **Targets:** ${check.targetLocales.map((l) => `\`${l}\``).join(", ") || "_none_"}`
  );
  lines.push("");

  if (Object.keys(check.countsByCode).length > 0) {
    lines.push("### Issues Detected");
    for (const [code, count] of Object.entries(check.countsByCode).sort()) {
      lines.push(`- \`${code}\`: **${count}**`);
    }
    lines.push("");
  }

  if (assumptionsFile.assumptions.length > 0) {
    lines.push("### Assumptions Made");
    for (const a of assumptionsFile.assumptions) {
      lines.push(
        `- **${a.category}**${a.locale ? ` (\`${a.locale}\`)` : ""}: ${a.summary}${a.rationale ? ` — _${a.rationale}_` : ""}`
      );
    }
    lines.push("");
  }

  if (reviewList.length > 0) {
    lines.push(`### Strings Worth a Native Speaker's Look (${reviewList.length})`);
    lines.push("");
    lines.push("| Locale | Key | Source | Translation | Why |");
    lines.push("|---|---|---|---|---|");
    for (const item of reviewList.slice(0, 20)) {
      const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(
        `| \`${item.locale}\` | \`${item.key}\` | ${esc(item.source)} | ${esc(item.translation)} | ${esc(item.reason)} |`
      );
    }
    lines.push("");
  } else {
    lines.push("### Strings Worth a Native Speaker's Look");
    lines.push("_None flagged._");
    lines.push("");
  }

  return {
    generatedAt: new Date().toISOString(),
    framework: check.framework,
    sourceLocale: check.sourceLocale,
    targetLocales: check.targetLocales,
    checkPassed: check.passed,
    summary: {
      totalSourceKeys: check.totalSourceKeys,
      errorCount: check.errorCount,
      warningCount: check.warningCount,
      issuesByCategory: check.countsByCode,
      assumptionsMade: assumptionsFile.assumptions.length,
      stringsToReview: reviewList.length,
    },
    assumptions: assumptionsFile.assumptions,
    reviewList,
    markdown: lines.join("\n"),
  };
}
