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
import { prepareQeReview, submitQeVerdicts, summarizeQe } from "../core/qe.js";
import { answerQuestion, applyAssumptionOverride, askQuestion, listQuestions, overrideAssumption, resolveQuestion, setContextNoteForKey } from "../core/context.js";
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

export const MCP_SERVER_INSTRUCTIONS = `Wraith gives you memory, rules, and deterministic proof for localization. You perform all code changes and translations in full codebase context; Wraith never calls an LLM.

Definition of done:
1. Run \`scan\` to detect framework, i18n library, hardcoded strings, concatenations, and hardcoded formatting (\`toFixed\`, locale-less \`toLocaleString\`, currency concatenation, manual dates, \`toUpperCase\`, locale-less \`localeCompare\`).
2. Refactor any hardcoded strings/concatenations/formatting in source code into i18n keys and Intl formatters (or extract document segments).
3. Use \`prepare\` to get context, static layout constraints & width budgets, glossary terms & approved abbreviations, fuzzy memory matches, and target locale conventions.
   - IMPORTANT: Treat ALL fuzzy memory matches (even 100% lexical matches) as strong suggestions with prior context, NOT blindly guaranteed translations. Always verify the match fits the current component, element, and surrounding UI.
   - Read the code at each usage site. Follow \`contextGuidance\`: write a \`contextNote\` when it is missing or stale, stay within \`charLimit\` (declared = binding; inferred = shorten to fit), and treat every Answer as binding.
4. Always write translations through \`apply\` so placeholders, ICU syntax, plural rules, and inline tags are validated and saved to .wraith/ memory.
   - If a string's meaning is still unclear after reading the code, translate your best guess and file an Open Question (\`memory\` add_question). Don't stop to ask mid-run: put all open questions to the user in ONE batch at the end, record their replies with answer_question, revisit the affected strings (prepare reason \`question_answered\`), then resolve_question.
5. Run \`check\` until catalog & scanner checks pass.
6. Run \`pseudo\` with \`mode: "auto"\` to generate target-appropriate pseudo-locales (\`en-XA\`, \`ar-XB\`, \`ja-XC\`, \`th-XD\`, \`de-XE\`) with invisible zero-width key IDs, then run \`layout\` against a running dev server at 375px and 1280px.
7. Remediate confirmed layout defects in order: (a) run \`layout_fix\` for deterministic mechanical codemods, (b) apply agent code prescriptions, (c) re-run \`prepare\` + \`apply\` for keys exceeding recorded width budgets in \`.wraith/layout.json\` (using approved glossary abbreviations with title/aria-label where appropriate), (d) re-run \`layout\` until clean, then re-run \`check\` until outcome is "PASS".
8. Optionally run \`visual_qa\` (DOM geometry regression vs .wraith/visual-baseline.json, 0 tokens) and \`qe_audit\` (ok/flag review of each string in its code context, done by you in a fresh context). Export flagged strings with \`tms_export\` and bring human edits back with \`tms_import\`.
9. Run \`report\` and show its Markdown as your final message: translated, needs attention, caught and fixed, still ambiguous (Q1…), assumptions (A1…), and how to follow up.

Progress: on long runs, post a one-line update after each \`apply\` batch or locale, using its \`progress\` field (e.g. "de: 40/63 translated, 1 open question so far"). When the user replies to an ID from the report ("Q1: …", "A2: …"), record it (answer_question / override_assumption), revisit only the affected strings, re-review them, then resolve_question / apply_override.

Keep defaults low-question: infer brand names and terminology, record assumptions via \`memory\`, and report them at the end unless config.review is "confirm". Ask only what the code cannot tell you, as Open Questions batched at the end.`;

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

export function createWraithMcpServer(options: McpServerOptions = {}): McpServer {
  ensureBootstrapped();
  const defaultRoot = options.rootDir ?? process.cwd();
  const safeRoot = (requested?: string) =>
    resolveMcpRootDir(defaultRoot, requested, options.authorizedRoots);

  const server = new McpServer(
    {
      name: "wraith",
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
        limit: z.number().int().min(1).max(200).optional().default(50),
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
        "Validate and write translations losslessly to target locale files or documents (.docx/.md/.mdx), and record provenance & translation memory in .wraith/. Returns isError=true if any item is rejected.",
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
              contextNote: z
                .string()
                .optional()
                .describe("Plain-language meaning of the source string for translators; send it when prepare reports contextNoteStatus missing or stale."),
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
        scope: z
          .enum(["all", "translations"])
          .optional()
          .default("all")
          .describe('Verification scope: "all" runs full source scan + catalog checks; "translations" validates catalogs, placeholders, plurals, glossary, layout budgets, and staleness without re-scanning source files.'),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      outputSchema: CheckOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, locale, severity, code, file, skipScan, scope, offset, limit }) => {
      const res = runCheck({
        rootDir: safeRoot(rootDir),
        locale,
        severity: severity as CheckSeverity | undefined,
        code: code as CheckIssueCode | undefined,
        file,
        skipScan,
        scope,
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
      action: z.literal("add_question"),
      keys: z.array(z.string()).min(1).describe("Keys whose meaning is unclear (one question may cover several)."),
      targetLocale: z.string().optional().describe("Only when the question is specific to one locale."),
      question: z.string().min(1).describe("What a human must clarify, phrased so they can answer without opening the code."),
    }),
    z.object({
      action: z.literal("answer_question"),
      id: z.string().describe("Question id, e.g. Q2."),
      answer: z.string().min(1).describe("The human's answer, verbatim. Only record answers the user actually gave."),
    }),
    z.object({
      action: z.literal("resolve_question"),
      id: z.string().describe("Answered question whose strings now reflect the answer."),
    }),
    z.object({
      action: z.literal("list_questions"),
      status: z.enum(["open", "answered", "resolved", "all"]).optional().default("open"),
    }),
    z.object({
      action: z.literal("override_assumption"),
      id: z.string().describe("Assumption label from the report, e.g. A3."),
      decision: z.string().min(1).describe("The human's decision, verbatim. Only record overrides the user actually gave."),
    }),
    z.object({
      action: z.literal("apply_override"),
      id: z.string().describe("Overridden assumption whose strings now follow the override."),
    }),
    z.object({
      action: z.literal("set_context_note"),
      key: z.string(),
      note: z.string().min(1),
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
        "Look up lexical fuzzy matches and glossary entries, or record a glossary decision (propagating changes to affected keys), assumption, translation pair, or Context Note. Open Questions: add_question when a string's meaning is unclear even after reading the code (translate your best guess meanwhile); ask the user the open questions in one batch at the end of your run; answer_question records their reply; resolve_question once the affected strings reflect it. When the user overrides an assumption from the report (\"A3: use du\"), record it with override_assumption, revisit the affected strings, then apply_override.",
      inputSchema: {
        rootDir: z.string().optional(),
        operation: MemoryOperationSchema.describe(
          "Discriminated memory operation: lookup | set_glossary | add_assumption | add_question | answer_question | resolve_question | list_questions | override_assumption | apply_override | set_context_note | add_pair."
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
        case "add_question":
          return mcpTextResult(askQuestion(root, { keys: operation.keys, locale: operation.targetLocale, question: operation.question }));
        case "answer_question":
          return mcpTextResult({ question: answerQuestion(root, { id: operation.id, answer: operation.answer, via: "agent" }) });
        case "resolve_question":
          return mcpTextResult({ question: resolveQuestion(root, operation.id) });
        case "list_questions":
          return mcpTextResult({ questions: listQuestions(root, operation.status) });
        case "override_assumption":
          return mcpTextResult({ assumption: overrideAssumption(root, { label: operation.id, decision: operation.decision, via: "agent" }) });
        case "apply_override":
          return mcpTextResult({ assumption: applyAssumptionOverride(root, operation.id) });
        case "set_context_note":
          return mcpTextResult({ ok: true, ...setContextNoteForKey(root, operation.key, operation.note) });
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
        "Import optional localization assets into .wraith/: glossary (CSV, TBX), translation memory (TMX), or existing repository locale files.",
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
        "Render routes with Playwright (optional peer dep) at 375px and 1280px across pseudo and target locales to detect overflow, clipping, overlap, tofu glyphs, dir/lang mismatches, and surviving hardcoded formats; maps findings back to keys and file:line and records width budgets in .wraith/layout.json. Returns INCONCLUSIVE (never PASS) without Playwright or baseUrl.",
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
        "Render routes with Playwright and fingerprint every zero-width-traced element (lineCount, size, overflow, clipping, occlusion, font/tofu, WCAG contrast). captureBaseline writes .wraith/visual-baseline.json; otherwise diffs against it and flags line_wrap_regression, container_blowout, text_truncation, element_occlusion, missing_glyph_tofu, contrast_regression with failure-only element crops. 0 LLM tokens. INCONCLUSIVE without Playwright/baseUrl/baseline.",
      inputSchema: {
        rootDir: z.string().optional(),
        baseUrl: z.string().optional(),
        routes: z.array(z.string()).optional(),
        locales: z.array(z.string()).optional(),
        captureBaseline: z.boolean().optional().default(false),
        basePath: z.string().optional().describe("Baseline path (default .wraith/visual-baseline.json)."),
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
      title: "Quality Review (ok/flag verdicts in context)",
      description:
        "Binary quality review done by YOU, in a fresh context (use a subagent if you can; do not review your own translations in the context that produced them). mode=prepare returns review tasks, one per file: open each file, read how every key is used, and judge each translation ok or flag. Each string includes a fingerprint of source+target; echo fingerprint (or target) when submitting so verdicts stay pinned to the exact text reviewed. mode=submit with verdicts[] stores them (rejecting edits since prepare or attempts to overwrite human-verified strings). mode=status (default) returns ok/flagged/unreviewed counts and the flagged list. Strings with check errors are not sent for review. Wraith calls no model and never edits catalogs here: fix flagged strings with apply.",
      inputSchema: {
        rootDir: z.string().optional(),
        locales: z.array(z.string()).optional(),
        keys: z.array(z.string()).optional(),
        mode: z.enum(["status", "prepare", "submit"]).optional().default("status"),
        includeReviewed: z.boolean().optional().describe("prepare: also include agent-reviewed strings (human-verified strings remain excluded)"),
        verdicts: z
          .array(
            z.object({
              locale: z.string(),
              key: z.string(),
              verdict: z.enum(["ok", "flag"]),
              fingerprint: z.string().optional().describe("Fingerprint from mode=prepare (provide fingerprint or target)"),
              target: z.string().optional().describe("Reviewed target text (provide fingerprint or target)"),
              reason: z.string().optional(),
              suggestedFix: z.string().optional(),
            })
          )
          .optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, locales, keys, mode, includeReviewed, verdicts }) => {
      const root = safeRoot(rootDir);
      if (mode === "prepare") {
        const prep = prepareQeReview({ rootDir: root, locales, keys, includeReviewed });
        return mcpTextResult({ ...prep, tasks: prep.tasks.slice(0, 40), tasksTruncated: prep.tasks.length > 40 });
      }
      if (mode === "submit") return mcpTextResult(submitQeVerdicts({ rootDir: root, verdicts: verdicts ?? [] }));
      const res = summarizeQe({ rootDir: root, locales, keys });
      return mcpTextResult({ ...res, flagged: res.flagged.slice(0, 25), flaggedTruncated: res.flagged.length > 25 });
    }
  );

  server.registerTool(
    "tms_export",
    {
      title: "Export for TMS Post-Editing (XLIFF 2.0 / TMX / TBX)",
      description:
        "Export segments as XLIFF 2.0 (<unit> per key with mda metadata: file, line, component, qe_status, max_chars, max_width_px, tm_similarity; <notes> with review flags and top fuzzy TM; placeholders as <ph disp/>), optionally TMX 1.4b (tm.tmx), TBX-Basic (glossary.tbx), and visual-qa failure crops. Writes only inside the explicit output directory. 0 LLM tokens.",
      inputSchema: {
        rootDir: z.string().optional(),
        outDir: z.string().optional().describe("Workspace-relative output dir (default .wraith/exports/tms)."),
        format: z.enum(["xliff2", "xliff12"]).optional().default("xliff2").describe("xliff12 for Crowdin: source.xlf + <locale>.xlf with <note> context and maxwidth limits."),
        locales: z.array(z.string()).optional(),
        onlyFlagged: z.boolean().optional().default(false),
        includeTm: z.boolean().optional().default(false),
        includeGlossary: z.boolean().optional().default(false),
        bundleScreenshots: z.boolean().optional().default(false),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: true },
    },
    async ({ rootDir, outDir, format, locales, onlyFlagged, includeTm, includeGlossary, bundleScreenshots }) => {
      const res = runTmsExport({
        rootDir: safeRoot(rootDir),
        format,
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
        "Import human post-edited XLIFF 2.0 (file or directory): validates every target through the apply pipeline (placeholders, ICU, tags, glossary), writes locale catalogs preserving key order, upserts .wraith/tm.json with provenance human-reviewed + verifiedAt, records those strings as human-verified in QE, then runs check (and visual_qa when layout.baseUrl is configured). Returns a compact diff.",
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
        "Package an MQM-style cross-model review job (with two-pass false-positive filtering instructions and output schema) for a different agent/model, or ingest review findings into .wraith/reviews.json.",
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
        "Read-only end-of-run report as JSON and PR-ready Markdown: translated per locale, strings that need attention, errors caught and fixed this run, open questions (Q1…), assumptions (A1…) with any human overrides, same-English-different-meaning groups with their Context Notes, and how to follow up. Show the Markdown to the user as your final message.",
      inputSchema: {
        rootDir: z.string().optional(),
        format: z.enum(["both", "json", "markdown"]).optional().default("both"),
        since: z.string().optional().describe("ISO time to count 'this run' from (default: start of the latest burst of activity)."),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, format, since }) => {
      const rep = generateReport(safeRoot(rootDir), { since });
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
        : "Use the target locales from .wraith/config.json or ask only if none were specified by the user.";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Localize this project using Wraith. ${targetNote}

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
  const server = createWraithMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
