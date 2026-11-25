import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyTranslations } from "../core/apply.js";
import { ensureBootstrapped } from "../core/bootstrap.js";
import { runCheck } from "../core/check.js";
import { exportEscalation, importEscalationCorrections } from "../core/escalate.js";
import { importAsset } from "../core/importers.js";
import { runLayoutFix } from "../core/layout-codemods.js";
import { runLayoutCheck } from "../core/layout.js";
import {
  lookupMemory,
  recordAssumption,
  recordGlossaryTerm,
  recordMemoryPair,
} from "../core/memory-ops.js";
import { prepareBatch } from "../core/prepare.js";
import { generatePseudoLocale } from "../core/pseudo-locale.js";
import { PseudoMode } from "../core/pseudo.js";
import { runQe } from "../core/qe.js";
import { runTmsExport, runTmsImport } from "../core/tms.js";
import { runVisualQa } from "../core/visual-qa.js";
import { generateReport } from "../core/report.js";
import { ingestReviewResults, packageReviewJob } from "../core/review.js";
import { scanProject } from "../core/scan.js";
import { resolveMcpRootDir } from "../core/security.js";
import { getProjectStatus } from "../core/status.js";
import {
  CheckIssueCode,
  CheckSeverity,
  ReviewCategory,
  ReviewSeverity,
} from "../core/types.js";
import { applyDocumentTranslations, prepareDocument } from "../documents/registry.js";
import { mcpTextResult } from "./formatting.js";

export const MCP_SERVER_INSTRUCTIONS = `Polyglot gives you memory, rules, and deterministic proof for localization. You perform all code changes and translations in full codebase context; Polyglot never calls an LLM (the single opt-in exception is \`qe_audit\` Tier 2 critics, which run only when a model API key is configured).

Definition of done:
1. Run \`scan\` to detect framework, i18n library, hardcoded strings, concatenations, and hardcoded formatting (\`toFixed\`, locale-less \`toLocaleString\`, currency concatenation, manual dates, \`toUpperCase\`, locale-less \`localeCompare\`).
2. Refactor any hardcoded strings/concatenations/formatting in source code into i18n keys and Intl formatters (or extract document segments).
3. Use \`prepare\` to get context, static layout constraints & width budgets, glossary terms & approved abbreviations, fuzzy memory matches, and target locale conventions.
   - IMPORTANT: Treat ALL fuzzy memory matches (even 100% lexical matches) as strong suggestions with prior context, NOT blindly guaranteed translations. Always verify the match fits the current component, element, and surrounding UI.
4. Always write translations through \`apply\` so placeholders, ICU syntax, plural rules, and inline tags are validated and saved to .polyglot/ memory.
5. Run \`check\` until catalog & scanner checks pass.
6. Run \`pseudo\` with \`mode: "auto"\` to generate target-appropriate pseudo-locales (\`en-XA\`, \`ar-XB\`, \`ja-XC\`, \`th-XD\`, \`de-XE\`) with invisible zero-width key IDs, then run \`layout\` against a running dev server at 375px and 1280px.
7. Remediate confirmed layout defects in order: (a) run \`layout_fix\` for deterministic mechanical codemods, (b) apply agent code prescriptions, (c) re-run \`prepare\` + \`apply\` for keys exceeding recorded width budgets in \`.polyglot/layout.json\` (using approved glossary abbreviations with title/aria-label where appropriate), (d) re-run \`layout\` until clean, then re-run \`check\` until outcome is "PASS".
8. Optionally run \`visual_qa\` (DOM geometry regression vs .polyglot/visual-baseline.json, 0 tokens) and \`qe_audit\` (tiered QE; only Tier 2 uses a model). Export \`needs_review\` segments with \`tms_export\` and bring human edits back with \`tms_import\`.
9. Run \`report\` to surface issues caught, assumptions made, and any strings worth a human look.

Keep defaults zero-question: infer brand names and terminology, record assumptions via \`memory\`, and report them at the end unless config.review is "confirm".`;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const DESTRUCTIVE_MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const StatusOutputSchema = z
  .object({
    initialized: z.boolean(),
    rootDir: z.string(),
    framework: z.string(),
    i18nLibrary: z.string().nullable(),
    sourceLocale: z.string(),
    targetLocales: z.array(z.string()),
    totalSourceKeys: z.number(),
    orphanedKeys: z.number(),
    checkOutcome: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]).optional(),
    checkPassed: z.boolean(),
    errorCount: z.number(),
    warningCount: z.number(),
    pendingReviews: z.number(),
  })
  .passthrough();

const ScanOutputSchema = z
  .object({
    framework: z.string(),
    i18nLibrary: z.string().nullable(),
    sourceLocale: z.string(),
    sourceKeys: z.number(),
    filesScanned: z.number(),
    counts: z
      .object({
        hardcodedStrings: z.number(),
        concatenations: z.number(),
        hardcodedFormatting: z.number().optional(),
        trackedKeys: z.number(),
        parseFailures: z.number(),
        documents: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

const CheckOutputSchema = z
  .object({
    outcome: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    passed: z.boolean(),
    inconclusiveReasons: z.array(z.string()),
    disclaimer: z.string(),
    framework: z.string(),
    sourceLocale: z.string(),
    targetLocales: z.array(z.string()),
    totalSourceKeys: z.number(),
    errorCount: z.number(),
    warningCount: z.number(),
    infoCount: z.number(),
  })
  .passthrough();

const GenericObjectOutputSchema = z.object({}).passthrough();

export interface McpServerOptions {
  rootDir?: string;
  authorizedRoots?: string[];
}

export function createPolyglotMcpServer(options: McpServerOptions = {}): McpServer {
  ensureBootstrapped();
  const defaultRoot = options.rootDir ?? process.cwd();
  const safeRoot = (requested?: string) =>
    resolveMcpRootDir(defaultRoot, requested, options.authorizedRoots);

  const server = new McpServer(
    {
      name: "polyglot",
      version: "0.1.0",
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    }
  );

  server.registerTool(
    "status",
    {
      title: "Project Localization Status",
      description:
        "Read-only summary of project localization state: detected framework, locales, coverage, untranslated/stale/context-changed/orphaned counts, verification outcome, and pending reviews.",
      inputSchema: {
        rootDir: z
          .string()
          .optional()
          .describe("Project directory inside the authorized workspace (defaults to launch root)."),
      },
      outputSchema: StatusOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir }) => {
      const status = getProjectStatus(safeRoot(rootDir));
      return mcpTextResult(status);
    }
  );

  server.registerTool(
    "scan",
    {
      title: "Scan Source & Documents",
      description:
        "Read-only scan: detect framework & i18n setup; find hardcoded strings, concatenations, sentence fragments, parse failures, glossary candidates, and documents. Returns compact paginated summary.",
      inputSchema: {
        rootDir: z.string().optional(),
        fileFilter: z.string().optional().describe("Optional substring filter on relative file paths."),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      outputSchema: ScanOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, fileFilter, offset, limit }) => {
      const result = scanProject({
        rootDir: safeRoot(rootDir),
        fileFilter,
        saveUsage: false,
        offset,
        limit,
      });
      return mcpTextResult(result);
    }
  );

  server.registerTool(
    "prepare",
    {
      title: "Prepare Translation Batch",
      description:
        "Read-only batch preparation for a target locale (software keys or a document) with source text, usage context, glossary hits, advisory fuzzy memory matches, and locale conventions.",
      inputSchema: {
        rootDir: z.string().optional(),
        targetLocale: z.string().describe("Target BCP-47 locale (e.g. 'es-MX', 'fr', 'zh-Hans')."),
        document: z
          .string()
          .optional()
          .describe("Optional path to a .docx, .md, or .mdx document to prepare with document-level context."),
        keys: z.array(z.string()).optional().describe("Optional specific keys to prepare."),
        includeTranslated: z.boolean().optional().default(false),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, targetLocale, document, keys, includeTranslated, offset, limit }) => {
      const root = safeRoot(rootDir);
      if (document) {
        return mcpTextResult(
          prepareDocument(root, {
            documentPath: document,
            targetLocale,
            offset,
            limit,
          })
        );
      }
      const result = prepareBatch({
        rootDir: root,
        targetLocale,
        keys,
        includeTranslated,
        offset,
        limit,
      });
      return mcpTextResult(result);
    }
  );

  server.registerTool(
    "apply",
    {
      title: "Validate & Apply Translations",
      description:
        "Validate and write translations losslessly to target locale files or documents (.docx/.md/.mdx), and record provenance & translation memory in .polyglot/. Returns isError=true if any item is rejected.",
      inputSchema: {
        rootDir: z.string().optional(),
        targetLocale: z.string().describe("Target BCP-47 locale."),
        document: z
          .string()
          .optional()
          .describe("Optional source document path (.docx/.md/.mdx) when applying document translations."),
        targetFile: z
          .string()
          .optional()
          .describe("Destination file path (must differ from source document and stay inside workspace)."),
        translations: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
              plurals: z.record(z.string(), z.string()).optional(),
              notes: z.string().optional(),
            })
          )
          .min(1),
        strictGlossary: z.boolean().optional().default(true),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, targetLocale, document, targetFile, translations, strictGlossary }) => {
      const root = safeRoot(rootDir);
      if (document) {
        if (!targetFile) {
          return mcpTextResult(
            { error: "targetFile is required when applying document translations" },
            true
          );
        }
        const docRes = applyDocumentTranslations(root, {
          sourceFile: document,
          targetFile,
          targetLocale,
          updates: translations.map((t) => ({ id: t.key, text: t.value })),
        });
        return mcpTextResult(docRes, !docRes.ok);
      }
      const result = applyTranslations({
        rootDir: root,
        targetLocale,
        translations,
        strictGlossary,
      });
      return mcpTextResult(result, !result.ok);
    }
  );

  server.registerTool(
    "check",
    {
      title: "Deterministic Verification Gate",
      description:
        "Read-only verification returning PASS, FAIL, or INCONCLUSIVE plus coverage details: catalog parity, placeholders, framework-specific plurals, inline tags, glossary rules, untranslated/fuzzy entries, hardcoded strings, concatenations, layout/RTL risks, staleness, and configured documents.",
      inputSchema: {
        rootDir: z.string().optional(),
        locale: z.string().optional().describe("Filter issues by target locale."),
        severity: z.enum(["error", "warning", "info"]).optional(),
        code: z.string().optional().describe("Filter by issue code."),
        file: z.string().optional().describe("Filter by relative file path substring."),
        skipScan: z.boolean().optional().default(false),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      outputSchema: CheckOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, locale, severity, code, file, skipScan, offset, limit }) => {
      const res = runCheck({
        rootDir: safeRoot(rootDir),
        locale,
        severity: severity as CheckSeverity | undefined,
        code: code as CheckIssueCode | undefined,
        file,
        skipScan,
        offset,
        limit,
      });
      const { metrics: _metrics, ...compact } = res;
      return mcpTextResult(compact);
    }
  );

  const MemoryOperationSchema = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("lookup"),
      query: z.string().min(1).describe("Source text or term to look up."),
      targetLocale: z.string().optional(),
      minScore: z.number().int().min(0).max(100).optional().default(50),
      limit: z.number().int().min(1).max(50).optional().default(10),
    }),
    z.object({
      action: z.literal("set_glossary"),
      term: z.string().min(1),
      doNotTranslate: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      translations: z.record(z.string(), z.string()).optional(),
      abbreviations: z.record(z.string(), z.string()).optional(),
      notes: z.string().optional(),
      origin: z.enum(["inferred", "user", "imported"]).optional(),
    }),
    z.object({
      action: z.literal("add_assumption"),
      category: z
        .enum(["terminology", "brand", "tone", "disambiguation", "formatting", "scope", "other"])
        .optional(),
      targetLocale: z.string().optional(),
      summary: z.string().min(1),
      rationale: z.string().optional(),
    }),
    z.object({
      action: z.literal("add_pair"),
      source: z.string().min(1),
      target: z.string().min(1),
      targetLocale: z.string().min(1),
      context: z.string().optional(),
    }),
  ]);

  server.registerTool(
    "memory",
    {
      title: "Glossary, Assumptions & Translation Memory",
      description:
        "Look up lexical fuzzy matches and glossary entries, or record a glossary decision (propagating changes to affected keys), assumption, or translation pair.",
      inputSchema: {
        rootDir: z.string().optional(),
        operation: MemoryOperationSchema.describe(
          "Discriminated memory operation: lookup | set_glossary | add_assumption | add_pair."
        ),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, operation }) => {
      const root = safeRoot(rootDir);
      switch (operation.action) {
        case "lookup":
          return mcpTextResult(
            lookupMemory(root, {
              query: operation.query,
              targetLocale: operation.targetLocale,
              minScore: operation.minScore,
              limit: operation.limit,
            })
          );
        case "set_glossary":
          return mcpTextResult(
            recordGlossaryTerm(root, {
              term: operation.term,
              doNotTranslate: operation.doNotTranslate,
              caseSensitive: operation.caseSensitive,
              translations: operation.translations,
              abbreviations: operation.abbreviations,
              notes: operation.notes,
              origin: operation.origin,
            })
          );
        case "add_assumption":
          return mcpTextResult(
            recordAssumption(root, {
              category: operation.category ?? "other",
              locale: operation.targetLocale,
              summary: operation.summary,
              rationale: operation.rationale,
            })
          );
        case "add_pair":
          return mcpTextResult(
            recordMemoryPair(root, {
              source: operation.source,
              target: operation.target,
              targetLocale: operation.targetLocale,
              context: operation.context,
            })
          );
      }
    }
  );

  server.registerTool(
    "import",
    {
      title: "Import Localization Assets",
      description:
        "Import optional localization assets into .polyglot/: glossary (CSV, TBX), translation memory (TMX), or existing repository locale files.",
      inputSchema: {
        rootDir: z.string().optional(),
        file: z.string().optional().describe("Workspace-relative path to .csv, .tbx, or .tmx file."),
        format: z.enum(["auto", "csv", "tbx", "tmx", "locales"]).optional().default("auto"),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, file, format }) => {
      const res = importAsset(safeRoot(rootDir), { file, format });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "pseudo",
    {
      title: "Generate Pseudo-Locale(s) & Layout Hotspots",
      description:
        "Generate target-aware pseudo-locale(s) (mode: auto|expand|rtl|cjk|tall|long-word|format) with IBM length-scaled expansion, invisible zero-width key IDs, and placeholder/ICU/tag preservation, plus layout/RTL hotspots.",
      inputSchema: {
        rootDir: z.string().optional(),
        pseudoLocale: z.string().optional().describe("Explicit pseudo-locale tag (defaults to en-x-pseudo or mode tag like en-XA, ar-XB, ja-XC, th-XD, de-XE)."),
        mode: z.enum(["auto", "expand", "rtl", "cjk", "tall", "long-word", "format"]).optional(),
        embedKeyIds: z.boolean().optional().default(true),
        formatOverlay: z.boolean().optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, pseudoLocale, mode, embedKeyIds, formatOverlay }) => {
      const res = generatePseudoLocale(safeRoot(rootDir), {
        pseudoLocale,
        mode: mode as PseudoMode | "auto" | undefined,
        embedKeyIds,
        formatOverlay,
      });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "layout",
    {
      title: "Rendered Layout & Formatting Check",
      description:
        "Render routes with Playwright (optional peer dep) at 375px and 1280px across pseudo and target locales to detect overflow, clipping, overlap, tofu glyphs, dir/lang mismatches, and surviving hardcoded formats; maps findings back to keys and file:line and records width budgets in .polyglot/layout.json. Returns INCONCLUSIVE (never PASS) without Playwright or baseUrl.",
      inputSchema: {
        rootDir: z.string().optional(),
        baseUrl: z.string().optional().describe("Running dev server URL (e.g. http://localhost:3000)."),
        routes: z.array(z.string()).optional(),
        locales: z.array(z.string()).optional(),
        localeUrlPattern: z.enum(["query", "prefix", "cookie"]).optional(),
        saveBudgets: z.boolean().optional().default(true),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, baseUrl, routes, locales, localeUrlPattern, saveBudgets }) => {
      const res = await runLayoutCheck({
        rootDir: safeRoot(rootDir),
        baseUrl,
        routes,
        locales,
        localeUrlPattern,
        saveBudgets,
      });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "layout_fix",
    {
      title: "Apply Mechanical Layout Codemods",
      description:
        "Deterministically apply mechanical layout codemods only (Tailwind physical->logical spacing/alignment/borders/radius, fixed w-* -> min-w-* on constrained text, root <html> dir/lang, and hyphens-auto on flagged lines) and return unified diffs.",
      inputSchema: {
        rootDir: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        files: z.array(z.string()).optional(),
        flaggedWidthLines: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
        flaggedLongWordLines: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, dryRun, files, flaggedWidthLines, flaggedLongWordLines }) => {
      const res = runLayoutFix({
        rootDir: safeRoot(rootDir),
        dryRun,
        files,
        flaggedWidthLines,
        flaggedLongWordLines,
      });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "visual_qa",
    {
      title: "Token-Free Visual QA (DOM Geometry Regression)",
      description:
        "Render routes with Playwright and fingerprint every zero-width-traced element (lineCount, size, overflow, clipping, occlusion, font/tofu, WCAG contrast). captureBaseline writes .polyglot/visual-baseline.json; otherwise diffs against it and flags line_wrap_regression, container_blowout, text_truncation, element_occlusion, missing_glyph_tofu, contrast_regression with failure-only element crops. 0 LLM tokens. INCONCLUSIVE without Playwright/baseUrl/baseline.",
      inputSchema: {
        rootDir: z.string().optional(),
        baseUrl: z.string().optional(),
        routes: z.array(z.string()).optional(),
        locales: z.array(z.string()).optional(),
        captureBaseline: z.boolean().optional().default(false),
        basePath: z.string().optional().describe("Baseline path (default .polyglot/visual-baseline.json)."),
        localeUrlPattern: z.enum(["query", "prefix", "cookie"]).optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, baseUrl, routes, locales, captureBaseline, basePath, localeUrlPattern }) => {
      const res = await runVisualQa({
        rootDir: safeRoot(rootDir),
        baseUrl,
        routes,
        locales,
        captureBaseline,
        basePath,
        localeUrlPattern,
      });
      return mcpTextResult({ ...res, defects: res.defects.slice(0, 25), defectsTruncated: res.defects.length > 25 });
    }
  );

  server.registerTool(
    "qe_audit",
    {
      title: "Tiered Quality Estimation & Error Swarm",
      description:
        "Score translated segments: Tier 1 deterministic gate (check + width budgets, 0 tokens; failures escalate at risk 100), Tier 2 three parallel critics (terminology/TM drift, UI context/conciseness, semantic/omission) on a fast model when ANTHROPIC_API_KEY or GEMINI_API_KEY is set, Tier 3 composite risk with routing (<25 verified, 25-60 one auto-repair pass when autoRepair=true, else needs_review). Writes .polyglot/qe-report.json; only modifies locale catalogs when autoRepair=true (through validated apply). Without a model key, segments are 'unscored' (never verified).",
      inputSchema: {
        rootDir: z.string().optional(),
        locales: z.array(z.string()).optional(),
        keys: z.array(z.string()).optional(),
        autoRepair: z.boolean().optional().default(false),
        failAbove: z.number().min(0).max(100).optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, locales, keys, autoRepair, failAbove }) => {
      const res = await runQe({ rootDir: safeRoot(rootDir), locales, keys, autoRepair, failAbove });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "tms_export",
    {
      title: "Export for TMS Post-Editing (XLIFF 2.0 / TMX / TBX)",
      description:
        "Export segments as XLIFF 2.0 (<unit> per key with mda metadata: file, line, component, qe_risk_score, max_chars, max_width_px, tm_similarity; <notes> with QE flags and top fuzzy TM; placeholders as <ph disp/>), optionally TMX 1.4b (tm.tmx), TBX-Basic (glossary.tbx), and visual-qa failure crops. Writes only inside the explicit output directory. 0 LLM tokens.",
      inputSchema: {
        rootDir: z.string().optional(),
        outDir: z.string().optional().describe("Workspace-relative output dir (default .polyglot/exports/tms)."),
        locales: z.array(z.string()).optional(),
        onlyFlagged: z.boolean().optional().default(false),
        includeTm: z.boolean().optional().default(false),
        includeGlossary: z.boolean().optional().default(false),
        bundleScreenshots: z.boolean().optional().default(false),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: true },
    },
    async ({ rootDir, outDir, locales, onlyFlagged, includeTm, includeGlossary, bundleScreenshots }) => {
      const res = runTmsExport({
        rootDir: safeRoot(rootDir),
        format: "xliff2",
        outDir,
        locales,
        onlyFlagged,
        includeTm,
        includeGlossary,
        bundleScreenshots,
      });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "tms_import",
    {
      title: "Import Reviewed XLIFF 2.0 from a TMS",
      description:
        "Import human post-edited XLIFF 2.0 (file or directory): validates every target through the apply pipeline (placeholders, ICU, tags, glossary), writes locale catalogs preserving key order, upserts .polyglot/tm.json with provenance human-reviewed + verifiedAt, marks qe-report segments human-verified, then runs check (and visual_qa when layout.baseUrl is configured). Returns a compact diff.",
      inputSchema: {
        rootDir: z.string().optional(),
        input: z.string().describe("Workspace-relative .xliff/.xlf file or directory."),
        runVerification: z.boolean().optional().default(true),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, input, runVerification }) => {
      const res = await runTmsImport({ rootDir: safeRoot(rootDir), input, runVerification });
      return mcpTextResult({ ...res, diff: res.diff.slice(0, 50) }, !res.ok);
    }
  );

  server.registerTool(
    "review",
    {
      title: "Cross-Model MQM Review",
      description:
        "Package an MQM-style cross-model review job (with two-pass false-positive filtering instructions and output schema) for a different agent/model, or ingest review findings into .polyglot/reviews.json.",
      inputSchema: {
        rootDir: z.string().optional(),
        action: z.enum(["package", "ingest"]),
        targetLocale: z.string().describe("Target BCP-47 locale."),
        keys: z.array(z.string()).optional(),
        outputPath: z.string().optional().describe("Optional workspace-relative path to write the review job JSON."),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(200).optional().default(40),
        reviewer: z.string().optional(),
        findings: z
          .array(
            z.object({
              key: z.string(),
              locale: z.string().optional(),
              category: z.enum([
                "accuracy",
                "fluency",
                "terminology",
                "style",
                "locale-conventions",
                "placeholders",
                "other",
              ]),
              severity: z.enum(["critical", "major", "minor", "neutral"]),
              span: z.string().optional(),
              explanation: z.string(),
              suggestion: z.string().optional(),
              verified: z.boolean().optional().default(true),
            })
          )
          .optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (args) => {
      const root = safeRoot(args.rootDir);
      if (args.action === "package") {
        const pkg = packageReviewJob(root, {
          targetLocale: args.targetLocale,
          keys: args.keys,
          offset: args.offset,
          limit: args.limit,
          outputPath: args.outputPath,
        });
        return mcpTextResult(pkg);
      }
      const res = ingestReviewResults(root, {
        reviewer: args.reviewer,
        targetLocale: args.targetLocale,
        findings: (args.findings ?? []).map((f) => ({
          ...f,
          category: f.category as ReviewCategory,
          severity: f.severity as ReviewSeverity,
        })),
      });
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "escalate",
    {
      title: "Human Review Escalation",
      description:
        "Export flagged strings for a human reviewer (CSV, XLSX, self-contained HTML), or import reviewer corrections back into locale files and memory.",
      inputSchema: {
        rootDir: z.string().optional(),
        action: z.enum(["export", "import"]),
        locale: z.string().optional(),
        outputDir: z.string().optional(),
        formats: z.array(z.enum(["csv", "xlsx", "html"])).optional(),
        file: z.string().optional().describe("Workspace-relative path to reviewer corrections (.csv, .xlsx, or .json)."),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async (args) => {
      const root = safeRoot(args.rootDir);
      if (args.action === "export") {
        const res = exportEscalation(root, {
          outputDir: args.outputDir,
          locale: args.locale,
          formats: args.formats,
        });
        return mcpTextResult({
          flaggedCount: res.flaggedCount,
          filesWritten: res.filesWritten,
          sample: res.rows.slice(0, 10),
        });
      }
      if (!args.file) {
        return mcpTextResult({ error: "file is required for escalate import" }, true);
      }
      const res = importEscalationCorrections(root, args.file);
      return mcpTextResult(res);
    }
  );

  server.registerTool(
    "report",
    {
      title: "Localization Report",
      description:
        "Read-only end-of-run localization report (issues caught, assumptions made, strings worth a native speaker's look) as structured JSON and PR-ready Markdown.",
      inputSchema: {
        rootDir: z.string().optional(),
        format: z.enum(["both", "json", "markdown"]).optional().default("both"),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, format }) => {
      const rep = generateReport(safeRoot(rootDir));
      if (format === "markdown") return mcpTextResult({ markdown: rep.markdown });
      if (format === "json") {
        const { markdown: _md, ...rest } = rep;
        return mcpTextResult(rest);
      }
      return mcpTextResult(rep);
    }
  );

  server.prompt(
    "localize",
    "Guided workflow to internationalize, translate, verify, and report localization for a project or document.",
    {
      locales: z.string().optional().describe("Comma-separated target BCP-47 locales (e.g. 'es-MX,fr,zh-Hans')."),
    },
    async ({ locales }) => {
      const targetNote = locales
        ? `Target locales requested: ${locales}.`
        : "Use the target locales from .polyglot/config.json or ask only if none were specified by the user.";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Localize this project using Polyglot. ${targetNote}

Follow these steps:
1. Call \`status\` and \`scan\` to understand the framework, i18n setup, hardcoded strings, concatenations, hardcoded formatting, and documents.
2. If the project has hardcoded strings, concatenations, or hardcoded formatting, set up the framework's standard i18n library, extract strings into source locale files, and replace locale-unsafe formatting with Intl formatters.
3. Infer brand/do-not-translate terms and key UI terminology (and approved abbreviations for tight UI slots); record assumptions via \`memory\`. If config.review === "confirm", pause briefly to confirm key glossary terms first; otherwise proceed without interrupting.
4. Use \`prepare\` in batches per target locale (pay attention to \`layout\` constraints and width budgets). Treat all fuzzy memory matches (even 100% matches) as strong suggestions to verify against component context — never blindly trust them. Write translations exclusively through \`apply\`.
5. Run \`check\` to verify catalog parity, placeholders, plurals, tags, glossary, and scanner rules.
6. Run \`pseudo\` with \`mode: "auto"\` and then \`layout\` against the running app at 375px and 1280px. Run \`layout_fix\` for deterministic codemods, apply agent code prescriptions, and retranslate any keys over their recorded width budget via \`prepare\` + \`apply\`. Repeat \`layout\` until clean, then re-run \`check\` until outcome is "PASS".
7. Call \`report\` and present the summary: issues caught, assumptions made, and any strings worth a native speaker's review.`,
            },
          },
        ],
      };
    }
  );

  return server;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createPolyglotMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
