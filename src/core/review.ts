import fs from "node:fs";
import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { GlossaryHit, matchGlossaryTerms } from "./glossary.js";
import { getLocaleConventions } from "./locales.js";
import { atomicWriteFileSync, resolveConfinedPath, validateLocaleTag, withWorkspaceLock } from "./security.js";
import { WraithStore, sha256Short } from "./store.js";
import { composeQeGuidance, ResolvedStyleGuide, resolveStyleGuide } from "./style-guide.js";
import { ReviewCategory, ReviewFinding, ReviewSeverity, UsageSite } from "./types.js";

export const MQM_TAXONOMY = {
  categories: {
    accuracy: "Mistranslation, omission, addition, or untranslated text that changes meaning.",
    fluency: "Grammar, spelling, register inconsistency, or unnatural phrasing in target locale.",
    terminology: "Violates glossary, inconsistent product term, or altered do-not-translate brand.",
    style: "Wrong tone/formality for UI context (e.g. overly stiff legal tone in casual consumer button).",
    "locale-conventions": "Wrong punctuation/spacing, date/number style, or regional vocabulary mismatch.",
    placeholders: "Broken or misplaced variables, plural grammar mismatch, or corrupted inline tags.",
  },
  severities: {
    critical: "Breaks app functionality, corrupts data/placeholders, or causes serious misunderstanding.",
    major: "Clearly wrong meaning, wrong part of speech for UI context, or major fluency error.",
    minor: "Small naturalness/style improvement; translation is understandable.",
    neutral: "Informational note; no fix required.",
  },
} as const;

export interface ReviewJobItem {
  key: string;
  source: string;
  translation: string;
  usageSites: UsageSite[];
  glossaryHits: GlossaryHit[];
}

export interface ReviewJobPackage {
  version: 1;
  diagnosticOnly: true;
  createdAt: string;
  sourceLocale: string;
  targetLocale: string;
  conventions: ReturnType<typeof getLocaleConventions>;
  styleGuide?: ResolvedStyleGuide;
  instructions: string;
  taxonomy: typeof MQM_TAXONOMY;
  outputSchema: Record<string, unknown>;
  items: ReviewJobItem[];
  totalItems: number;
  outputPath?: string;
}

export function packageReviewJob(
  rootDir: string,
  options: {
    targetLocale: string;
    keys?: string[];
    offset?: number;
    limit?: number;
    outputPath?: string;
  }
): ReviewJobPackage {
  validateLocaleTag(options.targetLocale, "targetLocale");
  const resolvedOutPath = options.outputPath
    ? resolveConfinedPath(rootDir, options.outputPath, { label: "review outputPath" })
    : undefined;
  const store = new WraithStore(rootDir);
  const config = store.readConfig();
  const glossary = store.readGlossary();
  const usage = store.readUsage();
  const records = store.readRecords();

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );

  const items: ReviewJobItem[] = [];
  if (adapter) {
    const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
    const tgtFiles = detection.localeFiles[options.targetLocale] ?? [];
    const srcCatalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
    const tgtCatalog = loadLocaleCatalog(adapter, tgtFiles, options.targetLocale);
    const keyFilter = options.keys && options.keys.length > 0 ? new Set(options.keys) : null;

    for (const [key, srcEntry] of srcCatalog.entries) {
      if (keyFilter && !keyFilter.has(key)) continue;
      const tgtEntry = tgtCatalog.entries.get(key);
      if (!tgtEntry || !tgtEntry.value.trim()) continue;
      // Skip already approved items unless explicitly requested
      const rec = records.records[key]?.[options.targetLocale];
      if (!keyFilter && rec?.reviewStatus === "approved") continue;

      items.push({
        key,
        source: srcEntry.value,
        translation: tgtEntry.value,
        usageSites: (usage.keys[key]?.sites ?? []).slice(0, 3),
        glossaryHits: matchGlossaryTerms(srcEntry.value, glossary.entries, options.targetLocale),
      });
    }
  }

  items.sort((a, b) => a.key.localeCompare(b.key));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const slice = items.slice(offset, offset + limit);

  const resolvedStyle = resolveStyleGuide(store.rootDir, config, [options.targetLocale]);
  const baseInstructions = `You are an independent, DIAGNOSTIC-ONLY localization quality reviewer evaluating ${config.sourceLocale} -> ${options.targetLocale} translations. Never automatically edit target files without authorization.

Perform TWO passes to eliminate false positives:
- Pass 1 (MQM Annotation): Compare each translation against its source, UI usage context, glossary, style guide, and locale conventions. Annotate genuine defects with category, severity, error span, concise explanation/evidence, and optional suggestion.
- Pass 2 (Verification Filter): Re-read every candidate finding critically. Drop stylistic preferences where the current translation is already natural and accurate. Only set "verified": true for issues a native speaker would genuinely want fixed.

Return ONLY valid JSON matching outputSchema, then ingest via \`wraith review --ingest <file>\` or \`qe_audit\` (\`mode: "ingest_mqm"\`).`;
  const instructions = composeQeGuidance(baseInstructions, resolvedStyle);

  const outputSchema = {
    type: "object",
    required: ["reviewer", "targetLocale", "findings"],
    properties: {
      reviewer: { type: "string", description: "Model or agent name (e.g. 'gemini-cli', 'codex')" },
      targetLocale: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "category", "severity", "explanation", "verified"],
          properties: {
            key: { type: "string" },
            category: { type: "string", enum: Object.keys(MQM_TAXONOMY.categories) },
            severity: { type: "string", enum: Object.keys(MQM_TAXONOMY.severities) },
            span: { type: "string" },
            explanation: { type: "string" },
            suggestion: { type: "string" },
            verified: { type: "boolean" },
          },
        },
      },
    },
  };

  const pkg: ReviewJobPackage = {
    version: 1,
    diagnosticOnly: true,
    createdAt: new Date().toISOString(),
    sourceLocale: config.sourceLocale,
    targetLocale: options.targetLocale,
    conventions: getLocaleConventions(options.targetLocale),
    ...(resolvedStyle.hasAny ? { styleGuide: resolvedStyle } : {}),
    instructions,
    taxonomy: MQM_TAXONOMY,
    outputSchema,
    items: slice,
    totalItems: items.length,
  };

  if (resolvedOutPath) {
    atomicWriteFileSync(resolvedOutPath, JSON.stringify(pkg, null, 2) + "\n");
    pkg.outputPath = path.relative(store.rootDir, resolvedOutPath).replace(/\\/g, "/");
  }

  return pkg;
}

export interface IngestFindingInput {
  key: string;
  locale?: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  span?: string;
  explanation: string;
  suggestion?: string;
  verified?: boolean;
}

export interface IngestReviewResult {
  reviewer: string;
  targetLocale: string;
  totalReceived: number;
  verifiedOpen: number;
  filteredFalsePositives: number;
  recordsFlagged: number;
  reviewsPath: string;
}

export function ingestReviewResults(
  rootDir: string,
  input: {
    reviewer?: string;
    targetLocale: string;
    findings: IngestFindingInput[];
  }
): IngestReviewResult {
  validateLocaleTag(input.targetLocale, "targetLocale");
  return withWorkspaceLock(rootDir, () => ingestReviewResultsUnlocked(rootDir, input));
}

function ingestReviewResultsUnlocked(
  rootDir: string,
  input: {
    reviewer?: string;
    targetLocale: string;
    findings: IngestFindingInput[];
  }
): IngestReviewResult {
  const store = new WraithStore(rootDir);
  const reviewsFile = store.readReviews();
  const recordsFile = store.readRecords();
  const reviewer = input.reviewer ?? "cross-model";
  const now = new Date().toISOString();

  let verifiedOpen = 0;
  let filteredFalsePositives = 0;
  let recordsFlagged = 0;

  for (const f of input.findings) {
    const locale = f.locale ?? input.targetLocale;
    const verified = f.verified !== false;
    const id = `rev-${sha256Short(`${locale}|${f.key}|${f.category}|${f.explanation}`, 8)}`;

    const finding: ReviewFinding = {
      id,
      key: f.key,
      locale,
      reviewer,
      category: f.category,
      severity: f.severity,
      span: f.span,
      explanation: f.explanation,
      suggestion: f.suggestion,
      verified,
      status: verified ? "open" : "dismissed",
      createdAt: now,
    };

    const existingIdx = reviewsFile.reviews.findIndex((r) => r.id === id);
    if (existingIdx >= 0) {
      reviewsFile.reviews[existingIdx] = finding;
    } else {
      reviewsFile.reviews.push(finding);
    }

    if (verified) {
      verifiedOpen++;
      const rec = recordsFile.records[f.key]?.[locale];
      if (rec && (f.severity === "critical" || f.severity === "major")) {
        rec.reviewStatus = "flagged";
        recordsFlagged++;
      }
    } else {
      filteredFalsePositives++;
    }
  }

  store.writeReviews(reviewsFile);
  if (recordsFlagged > 0) {
    store.writeRecords(recordsFile);
  }

  return {
    reviewer,
    targetLocale: input.targetLocale,
    totalReceived: input.findings.length,
    verifiedOpen,
    filteredFalsePositives,
    recordsFlagged,
    reviewsPath: path.relative(store.rootDir, store.filePath("reviews.json")).replace(/\\/g, "/"),
  };
}
