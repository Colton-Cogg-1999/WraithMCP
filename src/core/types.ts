import { z } from "zod";

export const FrameworkNameSchema = z.enum([
  "auto",
  "react",
  "nextjs",
  "vue",
  "nuxt",
  "sveltekit",
  "rails",
  "django",
  "documents",
  "unknown",
]);
export type FrameworkName = z.infer<typeof FrameworkNameSchema>;

export const ReviewModeSchema = z.enum(["auto", "confirm"]);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

export const ConfigPathsSchema = z.object({
  locales: z.string().optional(),
  source: z.array(z.string()).default(["."]),
  documents: z.array(z.string()).default([]),
  ignore: z
    .array(z.string())
    .default([
      "node_modules",
      ".next",
      ".nuxt",
      ".svelte-kit",
      "dist",
      "build",
      "coverage",
      ".git",
      ".polyglot",
      "__pycache__",
      ".venv",
      "venv",
      "vendor",
      "tmp",
      "log",
    ]),
});

export const LayoutViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type LayoutViewport = z.infer<typeof LayoutViewportSchema>;

export const LayoutConfigSchema = z.object({
  baseUrl: z.string().optional(),
  routes: z.array(z.string()).default(["/"]),
  localeUrlPattern: z.enum(["query", "prefix", "cookie"]).default("query"),
  viewports: z
    .array(LayoutViewportSchema)
    .default([
      { width: 375, height: 812 },
      { width: 1280, height: 800 },
    ]),
  screenshotsDir: z.string().default(".polyglot/screenshots"),
});
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>;

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  sourceLocale: z.string().default("en"),
  targetLocales: z.array(z.string()).default([]),
  review: ReviewModeSchema.default("auto"),
  framework: FrameworkNameSchema.default("auto"),
  i18nLibrary: z.string().optional(),
  paths: ConfigPathsSchema.default({}),
  layout: LayoutConfigSchema.optional(),
});
export type PolyglotConfig = z.infer<typeof ConfigSchema>;

export const GlossaryOriginSchema = z.enum(["inferred", "user", "imported"]);
export type GlossaryOrigin = z.infer<typeof GlossaryOriginSchema>;

export const GlossaryEntrySchema = z.object({
  term: z.string().min(1),
  doNotTranslate: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  translations: z.record(z.string(), z.string()).default({}),
  /** Approved short abbreviations per locale (full text kept in title or aria-label) */
  abbreviations: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
  origin: GlossaryOriginSchema.default("inferred"),
  updatedAt: z.string(),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const LayoutBudgetEntrySchema = z.object({
  maxWidthPx: z.number().positive(),
  budgetChars: z.number().int().positive(),
  element: z.string().optional(),
  constraint: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
});
export type LayoutBudgetEntry = z.infer<typeof LayoutBudgetEntrySchema>;

export const LayoutFileSchema = z.object({
  version: z.literal(1).default(1),
  budgets: z.record(z.string(), z.record(z.string(), LayoutBudgetEntrySchema)).default({}),
  lastRun: z
    .object({
      checkedAt: z.string(),
      outcome: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
      baseUrl: z.string().optional(),
      findingCount: z.number().int().nonnegative(),
      screenshots: z.array(z.string()).default([]),
    })
    .optional(),
});
export type LayoutFile = z.infer<typeof LayoutFileSchema>;

export const GlossaryFileSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(GlossaryEntrySchema).default([]),
});
export type GlossaryFile = z.infer<typeof GlossaryFileSchema>;

export const UsageSiteSchema = z.object({
  file: z.string(),
  line: z.number().int().nonnegative(),
  component: z.string().optional(),
  element: z.string().optional(),
  surrounding: z.array(z.string()).default([]),
});
export type UsageSite = z.infer<typeof UsageSiteSchema>;

export const KeyUsageSchema = z.object({
  fingerprint: z.string(),
  sites: z.array(UsageSiteSchema).default([]),
});
export type KeyUsage = z.infer<typeof KeyUsageSchema>;

export const UsageFileSchema = z.object({
  version: z.literal(1).default(1),
  keys: z.record(z.string(), KeyUsageSchema).default({}),
});
export type UsageFile = z.infer<typeof UsageFileSchema>;

export const RecordOriginSchema = z.enum(["agent", "imported", "human", "pseudo"]);
export type RecordOrigin = z.infer<typeof RecordOriginSchema>;

export const RecordReviewStatusSchema = z.enum([
  "unreviewed",
  "reviewed",
  "approved",
  "flagged",
]);
export type RecordReviewStatus = z.infer<typeof RecordReviewStatusSchema>;

export const TranslationRecordSchema = z.object({
  sourceHash: z.string(),
  contextFingerprint: z.string().default(""),
  translation: z.string(),
  updatedAt: z.string(),
  origin: RecordOriginSchema.default("agent"),
  reviewStatus: RecordReviewStatusSchema.default("unreviewed"),
  notes: z.string().optional(),
});
export type TranslationRecord = z.infer<typeof TranslationRecordSchema>;

export const RecordsFileSchema = z.object({
  version: z.literal(1).default(1),
  records: z.record(z.string(), z.record(z.string(), TranslationRecordSchema)).default({}),
  sourceBaselines: z.record(z.string(), z.string()).default({}),
});
export type RecordsFile = z.infer<typeof RecordsFileSchema>;

export const MemoryEntrySchema = z.object({
  sourceLocale: z.string(),
  targetLocale: z.string(),
  source: z.string(),
  target: z.string(),
  context: z.string().optional(),
  origin: z.string().default("apply"),
  updatedAt: z.string(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const AssumptionCategorySchema = z.enum([
  "terminology",
  "brand",
  "tone",
  "disambiguation",
  "formatting",
  "scope",
  "other",
]);
export type AssumptionCategory = z.infer<typeof AssumptionCategorySchema>;

export const AssumptionSchema = z.object({
  id: z.string(),
  category: AssumptionCategorySchema.default("other"),
  locale: z.string().optional(),
  summary: z.string(),
  rationale: z.string().optional(),
  createdAt: z.string(),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const AssumptionsFileSchema = z.object({
  version: z.literal(1).default(1),
  assumptions: z.array(AssumptionSchema).default([]),
});
export type AssumptionsFile = z.infer<typeof AssumptionsFileSchema>;

export const ReviewCategorySchema = z.enum([
  "accuracy",
  "fluency",
  "terminology",
  "style",
  "locale-conventions",
  "placeholders",
  "other",
]);
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

export const ReviewSeveritySchema = z.enum([
  "critical",
  "major",
  "minor",
  "neutral",
]);
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;

export const ReviewStatusSchema = z.enum([
  "open",
  "resolved",
  "dismissed",
  "escalated",
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const ReviewFindingSchema = z.object({
  id: z.string(),
  key: z.string(),
  locale: z.string(),
  reviewer: z.string().default("cross-model"),
  category: ReviewCategorySchema.default("other"),
  severity: ReviewSeveritySchema.default("minor"),
  span: z.string().optional(),
  explanation: z.string(),
  suggestion: z.string().optional(),
  verified: z.boolean().default(true),
  status: ReviewStatusSchema.default("open"),
  createdAt: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewsFileSchema = z.object({
  version: z.literal(1).default(1),
  reviews: z.array(ReviewFindingSchema).default([]),
});
export type ReviewsFile = z.infer<typeof ReviewsFileSchema>;

export type CheckSeverity = "error" | "warning" | "info";
export type CheckOutcome = "PASS" | "FAIL" | "INCONCLUSIVE";

export type CheckIssueCode =
  | "missing_key"
  | "missing_source_key"
  | "extra_key"
  | "orphaned_key"
  | "placeholder_mismatch"
  | "icu_syntax_error"
  | "missing_plural_category"
  | "advisory_plural_category"
  | "extra_plural_category"
  | "plural_structure_mismatch"
  | "inline_tag_mismatch"
  | "glossary_inconsistency"
  | "dnt_violation"
  | "glossary_flagged"
  | "untranslated"
  | "fuzzy_translation"
  | "hardcoded_string"
  | "string_concatenation"
  | "length_expansion_risk"
  | "layout_risk"
  | "rtl_layout_risk"
  | "layout_budget_exceeded"
  | "hardcoded_formatting"
  | "stale_source"
  | "context_changed"
  | "manual_edit_detected"
  | "open_review_finding"
  | "locale_parse_error"
  | "source_parse_error"
  | "missing_document_translation"
  | "inconclusive_coverage";

export interface CheckIssue {
  code: CheckIssueCode;
  severity: CheckSeverity;
  locale?: string;
  key?: string;
  file?: string;
  line?: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface LocaleStatus {
  locale: string;
  totalKeys: number;
  translatedKeys: number;
  missingKeys: number;
  extraKeys: number;
  staleSource: number;
  contextChanged: number;
  coveragePct: number;
  openReviews: number;
}

export interface ProjectStatus {
  initialized: boolean;
  rootDir: string;
  framework: string;
  i18nLibrary: string | null;
  sourceLocale: string;
  targetLocales: string[];
  totalSourceKeys: number;
  orphanedKeys: number;
  documents: string[];
  locales: LocaleStatus[];
  checkOutcome?: CheckOutcome;
  checkPassed: boolean;
  errorCount: number;
  warningCount: number;
  pendingReviews: number;
  glossaryCount: number;
  memoryCount: number;
  assumptionsCount: number;
}
