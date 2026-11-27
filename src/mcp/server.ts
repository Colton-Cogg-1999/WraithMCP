import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyTranslations } from "../core/apply.js";
import { ensureBootstrapped } from "../core/bootstrap.js";
import { runCheck } from "../core/check.js";
import {
  answerQuestion,
  applyAssumptionOverride,
  askQuestion,
  listQuestions,
  overrideAssumption,
  resolveQuestion,
  setContextNoteForKey,
} from "../core/context.js";
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
import { compactPrepareResult, prepareBatch } from "../core/prepare.js";
import { generatePseudoLocale } from "../core/pseudo-locale.js";
import { PseudoMode } from "../core/pseudo.js";
import { prepareQeReview, submitQeVerdicts, summarizeQe } from "../core/qe.js";
import { generateReport } from "../core/report.js";
import { ingestReviewResults, packageReviewJob } from "../core/review.js";
import { scanProject } from "../core/scan.js";
import { resolveConfinedPath, resolveMcpRootDir } from "../core/security.js";
import { getProjectStatus } from "../core/status.js";
import { isXliffPath, runTmsExport, runTmsImport } from "../core/tms.js";
import {
  CheckIssueCode,
  CheckSeverity,
  ReviewCategory,
  ReviewSeverity,
} from "../core/types.js";
import { runVisualQa } from "../core/visual-qa.js";
import { applyDocumentTranslations, prepareDocument } from "../documents/registry.js";
import { mcpTextResult } from "./formatting.js";

export const MCP_SERVER_INSTRUCTIONS = `Wraith is deterministic localization infrastructure (0 LLM calls). You translate and refactor code; Wraith provides persistent memory, style/terminology rules, safe lossless file I/O, and independent verification.

Use only the tools needed for the task:
- I18n prep: \`scan\` finds hardcoded strings, concatenations, and locale-unsafe formatting; refactor code and verify with \`check\`.
- Translate apps or documents (.docx/.pptx/.xlsx/.md/.mdx/.vtt/.srt): \`prepare\` fetches pending items, usage sites, glossary, style guide, conventions, and advisory TM (verify matches fit context). Always write deliverables through \`apply\` to enforce placeholders, ICU, plurals, tags, glossary DNT, and post-write key survival.
- Verify: \`check\` runs deterministic gates (\`scope: "translations"\` skips source re-scan). For rendered apps, use \`pseudo\` + \`layout\` (\`check\`|\`visual_qa\`|\`fix\`).
- Memory & decisions: \`memory\` manages glossary, TM, assumptions, Open Questions (ask only when code cannot settle meaning), and optional context notes for ambiguous keys.
- Diagnostic QE & handoff: \`qe_audit\` is diagnostic-only by default (flags defects with evidence, severity, and optional suggestedFix in a fresh context — never auto-edits without authorization). Use \`export\`/\`import\` for TMS/human review and \`report\` for a summary.`;

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
      title: "Project Status",
      description: "Read-only summary of detected framework, locales, coverage, staleness, verification outcome, and pending reviews.",
      inputSchema: {
        rootDir: z.string().optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir }) => mcpTextResult(getProjectStatus(safeRoot(rootDir)))
  );

  server.registerTool(
    "scan",
    {
      title: "Scan Source & Documents",
      description: "Read-only scan for framework/i18n setup, hardcoded strings, concatenations, hardcoded formatting, usage sites, and documents.",
      inputSchema: {
        rootDir: z.string().optional(),
        fileFilter: z.string().optional(),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, fileFilter, offset, limit }) =>
      mcpTextResult(
        scanProject({
          rootDir: safeRoot(rootDir),
          fileFilter,
          saveUsage: false,
          offset,
          limit,
        })
      )
  );

  server.registerTool(
    "prepare",
    {
      title: "Prepare Translation Batch",
      description:
        "Prepare pending software keys or document segments for a target locale with usage context, glossary, style guide, conventions, and advisory TM matches.",
      inputSchema: {
        rootDir: z.string().optional(),
        targetLocale: z.string().describe("Target BCP-47 locale (e.g. 'es-MX', 'ar', 'de')."),
        document: z.string().optional().describe("Optional document path (.docx/.pptx/.xlsx/.md/.mdx/.vtt/.srt)."),
        keys: z.array(z.string()).optional(),
        includeTranslated: z.boolean().optional().default(false),
        detail: z.enum(["compact", "full"]).optional().default("compact"),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(300).optional().default(100),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootDir, targetLocale, document, keys, includeTranslated, detail, offset, limit }) => {
      const root = safeRoot(rootDir);
      if (document) {
        return mcpTextResult(
          prepareDocument(root, {
            documentPath: document,
            targetLocale,
            detail,
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
        detail,
        offset,
        limit,
      });
      return mcpTextResult(detail === "compact" ? compactPrepareResult(result) : result);
    }
  );

  server.registerTool(
    "apply",
    {
      title: "Validate & Apply Translations",
      description:
        "Validate placeholders, ICU, plurals, tags, glossary DNT, and post-write key survival; write losslessly to locale files or documents and update .wraith/ memory.",
      inputSchema: {
        rootDir: z.string().optional(),
        targetLocale: z.string(),
        document: z.string().optional().describe("Source document path when translating a document."),
        targetFile: z.string().optional().describe("Destination document path (must differ from source)."),
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
                .describe("Optional plain-language disambiguation note for ambiguous keys only."),
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
        "Read-only deterministic verification returning PASS, FAIL, or INCONCLUSIVE (catalog parity, placeholders, plurals, tags, glossary, layout/char limits, staleness, source scan).",
      inputSchema: {
        rootDir: z.string().optional(),
        locale: z.string().optional(),
        severity: z.enum(["error", "warning", "info"]).optional(),
        code: z.string().optional(),
        file: z.string().optional(),
        skipScan: z.boolean().optional().default(false),
        scope: z.enum(["all", "translations"]).optional().default("all"),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(25),
      },
      outputSchema: GenericObjectOutputSchema,
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

  server.registerTool(
    "memory",
    {
      title: "Glossary, TM, Decisions & Questions",
      description:
        "Manage persistent localization knowledge: TM/glossary lookup, set_glossary, add_pair, add_assumption / override_assumption / apply_override, add_question / answer_question / resolve_question / list_questions, and optional set_context_note.",
      inputSchema: {
        rootDir: z.string().optional(),
        action: z.enum([
          "lookup",
          "set_glossary",
          "add_assumption",
          "add_question",
          "answer_question",
          "resolve_question",
          "list_questions",
          "override_assumption",
          "apply_override",
          "set_context_note",
          "add_pair",
        ]),
        targetLocale: z.string().optional(),
        query: z.string().optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        term: z.string().optional(),
        doNotTranslate: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        translations: z.record(z.string(), z.string()).optional(),
        abbreviations: z.record(z.string(), z.string()).optional(),
        notes: z.string().optional(),
        origin: z.enum(["inferred", "user", "imported"]).optional(),
        category: z
          .enum(["terminology", "brand", "tone", "disambiguation", "formatting", "scope", "other"])
          .optional(),
        summary: z.string().optional(),
        rationale: z.string().optional(),
        id: z.string().optional(),
        keys: z.array(z.string()).optional(),
        question: z.string().optional(),
        answer: z.string().optional(),
        decision: z.string().optional(),
        status: z.enum(["open", "answered", "resolved", "all"]).optional(),
        key: z.string().optional(),
        note: z.string().optional(),
        source: z.string().optional(),
        target: z.string().optional(),
        context: z.string().optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (args) => {
      const root = safeRoot(args.rootDir);
      const req = (val: string | undefined, name: string): string => {
        if (!val || !val.trim()) throw new Error(`${name} is required for memory action "${args.action}"`);
        return val;
      };
      switch (args.action) {
        case "lookup":
          return mcpTextResult(
            lookupMemory(root, {
              query: req(args.query, "query"),
              targetLocale: args.targetLocale,
              minScore: args.minScore ?? 50,
              limit: args.limit ?? 10,
            })
          );
        case "set_glossary":
          return mcpTextResult(
            recordGlossaryTerm(root, {
              term: req(args.term, "term"),
              doNotTranslate: args.doNotTranslate,
              caseSensitive: args.caseSensitive,
              translations: args.translations,
              abbreviations: args.abbreviations,
              notes: args.notes,
              origin: args.origin,
            })
          );
        case "add_assumption":
          return mcpTextResult(
            recordAssumption(root, {
              category: args.category ?? "other",
              locale: args.targetLocale,
              summary: req(args.summary, "summary"),
              rationale: args.rationale,
            })
          );
        case "add_question":
          if (!args.keys || args.keys.length === 0) {
            return mcpTextResult({ error: "keys is required for add_question" }, true);
          }
          return mcpTextResult(
            askQuestion(root, {
              keys: args.keys,
              locale: args.targetLocale,
              question: req(args.question, "question"),
            })
          );
        case "answer_question":
          return mcpTextResult({
            question: answerQuestion(root, {
              id: req(args.id, "id"),
              answer: req(args.answer, "answer"),
              via: "agent",
            }),
          });
        case "resolve_question":
          return mcpTextResult({ question: resolveQuestion(root, req(args.id, "id")) });
        case "list_questions":
          return mcpTextResult({ questions: listQuestions(root, args.status ?? "open") });
        case "override_assumption":
          return mcpTextResult({
            assumption: overrideAssumption(root, {
              label: req(args.id, "id"),
              decision: req(args.decision, "decision"),
              via: "agent",
            }),
          });
        case "apply_override":
          return mcpTextResult({ assumption: applyAssumptionOverride(root, req(args.id, "id")) });
        case "set_context_note":
          return mcpTextResult({
            ok: true,
            ...setContextNoteForKey(root, req(args.key, "key"), req(args.note, "note")),
          });
        case "add_pair":
          return mcpTextResult(
            recordMemoryPair(root, {
              source: req(args.source, "source"),
              target: req(args.target, "target"),
              targetLocale: req(args.targetLocale, "targetLocale"),
              context: args.context,
            })
          );
      }
    }
  );

  server.registerTool(
    "pseudo",
    {
      title: "Generate Pseudo-Locales",
      description:
        "Generate target-aware pseudo-locales (auto|expand|rtl|cjk|tall|long-word|format) with zero-width key IDs and layout/RTL hotspots.",
      inputSchema: {
        rootDir: z.string().optional(),
        pseudoLocale: z.string().optional(),
        mode: z.enum(["auto", "expand", "rtl", "cjk", "tall", "long-word", "format"]).optional(),
        embedKeyIds: z.boolean().optional().default(true),
        formatOverlay: z.boolean().optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, pseudoLocale, mode, embedKeyIds, formatOverlay }) =>
      mcpTextResult(
        generatePseudoLocale(safeRoot(rootDir), {
          pseudoLocale,
          mode: mode as PseudoMode | "auto" | undefined,
          embedKeyIds,
          formatOverlay,
        })
      )
  );

  server.registerTool(
    "layout",
    {
      title: "Rendered Layout, Visual QA & Codemods",
      description:
        "UI layout & visual QA: mode=check (Playwright overflow/clipping/RTL/width budgets), mode=visual_qa (DOM geometry regression vs baseline, 0 tokens), mode=fix (deterministic Tailwind/RTL mechanical codemods). Returns INCONCLUSIVE without Playwright/baseUrl.",
      inputSchema: {
        rootDir: z.string().optional(),
        mode: z.enum(["check", "visual_qa", "fix"]).optional().default("check"),
        baseUrl: z.string().optional(),
        routes: z.array(z.string()).optional(),
        locales: z.array(z.string()).optional(),
        localeUrlPattern: z.enum(["query", "prefix", "cookie"]).optional(),
        saveBudgets: z.boolean().optional().default(true),
        captureBaseline: z.boolean().optional().default(false),
        basePath: z.string().optional(),
        dryRun: z.boolean().optional().default(false),
        files: z.array(z.string()).optional(),
        flaggedWidthLines: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
        flaggedLongWordLines: z.array(z.object({ file: z.string(), line: z.number().int().positive() })).optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (args) => {
      const root = safeRoot(args.rootDir);
      if (args.mode === "fix") {
        return mcpTextResult(
          runLayoutFix({
            rootDir: root,
            dryRun: args.dryRun,
            files: args.files,
            flaggedWidthLines: args.flaggedWidthLines,
            flaggedLongWordLines: args.flaggedLongWordLines,
          })
        );
      }
      if (args.mode === "visual_qa") {
        const res = await runVisualQa({
          rootDir: root,
          baseUrl: args.baseUrl,
          routes: args.routes,
          locales: args.locales,
          captureBaseline: args.captureBaseline,
          basePath: args.basePath,
          localeUrlPattern: args.localeUrlPattern,
        });
        return mcpTextResult({
          ...res,
          defects: res.defects.slice(0, 25),
          defectsTruncated: res.defects.length > 25,
        });
      }
      return mcpTextResult(
        await runLayoutCheck({
          rootDir: root,
          baseUrl: args.baseUrl,
          routes: args.routes,
          locales: args.locales,
          localeUrlPattern: args.localeUrlPattern,
          saveBudgets: args.saveBudgets,
        })
      );
    }
  );

  server.registerTool(
    "qe_audit",
    {
      title: "Diagnostic Quality Audit",
      description:
        "Diagnostic-only linguistic & visual review in a fresh context (never auto-edits catalogs). mode=prepare builds file-scoped tasks with full style/glossary/locale/visual context (scope=all|risk); mode=submit stores pinned verdicts with severity, category, evidence, and optional suggestedFix; mode=status summarizes findings; mode=package_mqm/ingest_mqm supports cross-model MQM packages.",
      inputSchema: {
        rootDir: z.string().optional(),
        mode: z
          .enum(["status", "prepare", "submit", "package_mqm", "ingest_mqm"])
          .optional()
          .default("status"),
        locales: z.array(z.string()).optional(),
        targetLocale: z.string().optional().describe("Required for package_mqm / ingest_mqm."),
        keys: z.array(z.string()).optional(),
        scope: z.enum(["all", "risk"]).optional().default("all"),
        includeReviewed: z.boolean().optional(),
        verdicts: z
          .array(
            z.object({
              locale: z.string(),
              key: z.string(),
              verdict: z.enum(["ok", "flag"]),
              fingerprint: z.string().optional(),
              target: z.string().optional(),
              severity: z.enum(["critical", "major", "minor"]).optional(),
              category: z
                .enum([
                  "accuracy",
                  "fluency",
                  "terminology",
                  "style",
                  "locale-conventions",
                  "placeholders",
                  "visual",
                  "ambiguity",
                  "other",
                ])
                .optional(),
              reason: z.string().optional(),
              evidence: z.string().optional(),
              visualEvidence: z.string().optional(),
              suggestedFix: z.string().optional(),
              reviewer: z.string().optional(),
            })
          )
          .optional(),
        outputPath: z.string().optional(),
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
      if (args.mode === "prepare") {
        const prep = prepareQeReview({
          rootDir: root,
          locales: args.locales,
          keys: args.keys,
          scope: args.scope,
          includeReviewed: args.includeReviewed,
        });
        return mcpTextResult({
          ...prep,
          tasks: prep.tasks.slice(0, 40),
          tasksTruncated: prep.tasks.length > 40,
        });
      }
      if (args.mode === "submit") {
        return mcpTextResult(submitQeVerdicts({ rootDir: root, verdicts: args.verdicts ?? [] }));
      }
      if (args.mode === "package_mqm") {
        const loc = args.targetLocale ?? args.locales?.[0];
        if (!loc) return mcpTextResult({ error: "targetLocale is required for mode=package_mqm" }, true);
        return mcpTextResult(
          packageReviewJob(root, {
            targetLocale: loc,
            keys: args.keys,
            offset: args.offset,
            limit: args.limit,
            outputPath: args.outputPath,
          })
        );
      }
      if (args.mode === "ingest_mqm") {
        const loc = args.targetLocale ?? args.locales?.[0];
        if (!loc) return mcpTextResult({ error: "targetLocale is required for mode=ingest_mqm" }, true);
        return mcpTextResult(
          ingestReviewResults(root, {
            reviewer: args.reviewer,
            targetLocale: loc,
            findings: (args.findings ?? []).map((f) => ({
              ...f,
              category: f.category as ReviewCategory,
              severity: f.severity as ReviewSeverity,
            })),
          })
        );
      }
      const res = summarizeQe({ rootDir: root, locales: args.locales, keys: args.keys });
      return mcpTextResult({
        ...res,
        flagged: res.flagged.slice(0, 25),
        flaggedTruncated: res.flagged.length > 25,
      });
    }
  );

  server.registerTool(
    "export",
    {
      title: "Export for TMS or Human Review",
      description:
        "Export translations & diagnostic QE context for Crowdin/Phrase (format=xliff2|xliff12 + optional TMX/TBX/screenshots) or standalone human review (format=human -> CSV/XLSX/HTML). Writes only inside outDir.",
      inputSchema: {
        rootDir: z.string().optional(),
        format: z.enum(["xliff2", "xliff12", "human"]).optional().default("xliff2"),
        outDir: z.string().optional(),
        locales: z.array(z.string()).optional(),
        onlyFlagged: z.boolean().optional().default(false),
        includeTm: z.boolean().optional().default(false),
        includeGlossary: z.boolean().optional().default(false),
        bundleScreenshots: z.boolean().optional().default(false),
        humanFormats: z.array(z.enum(["csv", "xlsx", "html"])).optional(),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      const root = safeRoot(args.rootDir);
      if (args.format === "human") {
        const res = exportEscalation(root, {
          outputDir: args.outDir,
          locale: args.locales?.[0],
          formats: args.humanFormats,
        });
        return mcpTextResult({
          format: "human",
          flaggedCount: res.flaggedCount,
          filesWritten: res.filesWritten,
          sample: res.rows.slice(0, 10),
        });
      }
      return mcpTextResult(
        runTmsExport({
          rootDir: root,
          format: args.format,
          outDir: args.outDir,
          locales: args.locales,
          onlyFlagged: args.onlyFlagged,
          includeTm: args.includeTm,
          includeGlossary: args.includeGlossary,
          bundleScreenshots: args.bundleScreenshots,
        })
      );
    }
  );

  server.registerTool(
    "import",
    {
      title: "Import TMS, Human Edits & Assets",
      description:
        "Import reviewed XLIFF 2.0/1.2 from a TMS (validated & recorded as human-verified), human reviewer corrections (CSV/XLSX/JSON), or glossary/TM/locale assets (CSV/TBX/TMX/locales).",
      inputSchema: {
        rootDir: z.string().optional(),
        file: z.string().optional().describe("Workspace-relative file or directory path."),
        format: z
          .enum(["auto", "xliff", "corrections", "csv", "tbx", "tmx", "locales"])
          .optional()
          .default("auto"),
        runVerification: z.boolean().optional().default(true),
      },
      outputSchema: GenericObjectOutputSchema,
      annotations: DESTRUCTIVE_MUTATING_ANNOTATIONS,
    },
    async ({ rootDir, file, format, runVerification }) => {
      const root = safeRoot(rootDir);
      let isXliff = format === "xliff";
      if (!isXliff && format === "auto" && file) {
        if (isXliffPath(file)) {
          isXliff = true;
        } else {
          try {
            const abs = resolveConfinedPath(root, file, { label: "import path" });
            if (
              fs.existsSync(abs) &&
              fs.statSync(abs).isDirectory() &&
              fs.readdirSync(abs).some((f) => isXliffPath(f))
            ) {
              isXliff = true;
            }
          } catch {
            // Let downstream path confinement report the boundary error cleanly
          }
        }
      }

      if (isXliff) {
        if (!file) return mcpTextResult({ error: "file is required when importing XLIFF" }, true);
        const res = await runTmsImport({ rootDir: root, input: file, runVerification });
        return mcpTextResult({ ...res, diff: res.diff.slice(0, 50) }, !res.ok);
      }

      if (format === "corrections" || (format === "auto" && file && /\.(xlsx|json)$/i.test(file))) {
        if (!file) return mcpTextResult({ error: "file is required when importing corrections" }, true);
        const res = importEscalationCorrections(root, file);
        return mcpTextResult(res, res.rejectedCount > 0 && res.appliedCount === 0);
      }

      return mcpTextResult(importAsset(root, { file, format: format as "auto" | "csv" | "tbx" | "tmx" | "locales" }));
    }
  );

  server.registerTool(
    "report",
    {
      title: "Localization Report",
      description:
        "Read-only JSON and Markdown summary: coverage, diagnostic findings, caught-and-fixed issues, open questions (Q1…), assumptions (A1…), and follow-up commands.",
      inputSchema: {
        rootDir: z.string().optional(),
        format: z.enum(["both", "json", "markdown"]).optional().default("both"),
        since: z.string().optional(),
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
    "Task-driven localization workflow using Wraith infrastructure.",
    {
      locales: z.string().optional().describe("Comma-separated target BCP-47 locales (e.g. 'es-MX,ar,de')."),
    },
    async ({ locales }) => {
      const targetNote = locales
        ? `Target locales: ${locales}.`
        : "Use configured targetLocales from .wraith/config.json (ask only if unconfigured).";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Localize this project or document using Wraith. ${targetNote}

Use only the capabilities needed for this repository:
1. Inspect with \`status\` (and \`scan\` if preparing an un-internationalized codebase or discovering documents).
2. If source code has hardcoded strings, concatenations, or hardcoded formatting, extract them into i18n keys and Intl formatters.
3. Translate pending software keys or document segments using \`prepare\` + \`apply\` (never bypass \`apply\` for deliverables). Verify advisory TM matches against context, respect glossary/style guide/character limits, and add optional context notes only for genuinely ambiguous keys.
4. Run \`check\` until PASS. For rendered web apps with a dev server, optionally verify layout/RTL with \`pseudo\` and \`layout\`.
5. Optionally run a fresh-context diagnostic \`qe_audit\` (never auto-edit without authorization) and summarize results with \`report\`.`,
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
