import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyTranslations } from "../core/apply.js";
import { ensureBootstrapped } from "../core/bootstrap.js";
import { runCheck } from "../core/check.js";
import { exportEscalation, importEscalationCorrections } from "../core/escalate.js";
import { importAsset } from "../core/importers.js";
import {
  lookupMemory,
  recordAssumption,
  recordGlossaryTerm,
  recordMemoryPair,
} from "../core/memory-ops.js";
import { prepareBatch } from "../core/prepare.js";
import { generatePseudoLocale } from "../core/pseudo-locale.js";
import { generateReport } from "../core/report.js";
import { ingestReviewResults, packageReviewJob } from "../core/review.js";
import { scanProject } from "../core/scan.js";
import { getProjectStatus } from "../core/status.js";
import {
  CheckIssueCode,
  CheckSeverity,
  ReviewCategory,
  ReviewSeverity,
} from "../core/types.js";
import { applyDocumentTranslations, prepareDocument } from "../documents/registry.js";
import { mcpTextResult } from "./formatting.js";

export const MCP_SERVER_INSTRUCTIONS = `Polyglot gives you memory, rules, and deterministic proof for localization. You perform all code changes and translations in full codebase context; Polyglot never calls an LLM.

Definition of done:
1. Run \`scan\` to detect framework, i18n library, hardcoded strings, and concatenations.
2. Refactor any hardcoded strings/concatenations in source code into i18n keys (or extract document segments).
3. Use \`prepare\` to get context, glossary terms, fuzzy memory matches, and target locale conventions.
   - IMPORTANT: Treat ALL fuzzy memory matches (even 100% lexical matches) as strong suggestions with prior context, NOT blindly guaranteed translations. Always verify the match fits the current component, element, and surrounding UI.
4. Always write translations through \`apply\` so placeholders, ICU syntax, plural rules, and inline tags are validated and saved to .polyglot/ memory.
5. Run \`pseudo\` and inspect layout/formatting hotspots (and visually QA rendered routes when a dev server/browser is available) to catch text clipping, overflow, wrapping, or RTL visual continuity breaks; fix CSS/layout constraints or overly long copy as needed.
6. Run \`check\` until it passes with zero errors. Localization is NOT done until \`check\` passes.
7. Run \`report\` to surface issues caught, assumptions made, and any strings worth a human look.

Keep defaults zero-question: infer brand names and terminology, record assumptions via \`memory\`, and report them at the end unless config.review is "confirm".`;

export interface McpServerOptions {
  rootDir?: string;
}

export function createPolyglotMcpServer(options: McpServerOptions = {}): McpServer {
  ensureBootstrapped();
  const defaultRoot = options.rootDir ?? process.cwd();

  const server = new McpServer(
    {
      name: "polyglot",
      version: "0.1.0",
    },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    }
  );

  server.tool(
    "status",
    "Report project localization state: detected framework, locales, coverage, untranslated/stale/context-changed/orphaned counts, check pass/fail, and pending reviews.",
    {
      rootDir: z.string().optional().describe("Project root directory (defaults to current working directory)."),
    },
    async ({ rootDir }) => {
      const status = getProjectStatus(rootDir ?? defaultRoot);
      return mcpTextResult(status);
    }
  );

  server.tool(
    "scan",
    "Detect framework & i18n setup; find hardcoded strings, concatenations, sentence fragments, glossary candidates, and documents. Returns compact paginated summary.",
    {
      rootDir: z.string().optional(),
      fileFilter: z.string().optional().describe("Optional substring filter on relative file paths."),
      offset: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ rootDir, fileFilter, offset, limit }) => {
      const result = scanProject({
        rootDir: rootDir ?? defaultRoot,
        fileFilter,
        offset,
        limit,
      });
      return mcpTextResult(result);
    }
  );

  server.tool(
    "prepare",
    "Prepare a batch of keys (or a document with full document-level context) for a target locale with source text, usage context, glossary hits, advisory fuzzy memory matches, and locale conventions.",
    {
      rootDir: z.string().optional(),
      targetLocale: z.string().describe("Target BCP-47 locale (e.g. 'es-MX', 'fr', 'zh-Hans')."),
      document: z.string().optional().describe("Optional path to a .docx, .md, or .mdx document to prepare with whole-document context."),
      keys: z.array(z.string()).optional().describe("Optional specific keys to prepare."),
      includeTranslated: z.boolean().optional().default(false),
      offset: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ rootDir, targetLocale, document, keys, includeTranslated, offset, limit }) => {
      if (document) {
        return mcpTextResult(
          prepareDocument(rootDir ?? defaultRoot, {
            documentPath: document,
            targetLocale,
            offset,
            limit,
          })
        );
      }
      const result = prepareBatch({
        rootDir: rootDir ?? defaultRoot,
        targetLocale,
        keys,
        includeTranslated,
        offset,
        limit,
      });
      return mcpTextResult(result);
    }
  );

  server.tool(
    "apply",
    "Validate and write translations losslessly to target locale files or documents (.docx/.md/.mdx), and record provenance & translation memory in .polyglot/. Rejects invalid placeholders, ICU syntax, plural rules, inline tags, or DNT violations.",
    {
      rootDir: z.string().optional(),
      targetLocale: z.string().describe("Target BCP-47 locale."),
      document: z.string().optional().describe("Optional source document path (.docx/.md/.mdx) when applying document translations."),
      targetFile: z.string().optional().describe("Destination file path when applying document translations."),
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
    async ({ rootDir, targetLocale, document, targetFile, translations, strictGlossary }) => {
      if (document) {
        if (!targetFile) {
          return mcpTextResult({ error: "targetFile is required when applying document translations" }, true);
        }
        const docRes = applyDocumentTranslations(rootDir ?? defaultRoot, {
          sourceFile: document,
          targetFile,
          targetLocale,
          updates: translations.map((t) => ({ id: t.key, text: t.value })),
        });
        return mcpTextResult(docRes, !docRes.ok);
      }
      const result = applyTranslations({
        rootDir: rootDir ?? defaultRoot,
        targetLocale,
        translations,
        strictGlossary,
      });
      return mcpTextResult(result, !result.ok && result.appliedCount === 0);
    }
  );

  server.tool(
    "check",
    "Run full deterministic localization verification: missing/extra/orphaned keys, placeholder/ICU/plural integrity, inline tags, glossary consistency, untranslated strings, hardcoded strings, concatenations, length risk, and staleness (source or context changed).",
    {
      rootDir: z.string().optional(),
      locale: z.string().optional().describe("Filter issues by target locale."),
      severity: z.enum(["error", "warning", "info"]).optional(),
      code: z.string().optional().describe("Filter by issue code (e.g. 'hardcoded_string', 'placeholder_mismatch')."),
      file: z.string().optional().describe("Filter by relative file path substring."),
      skipScan: z.boolean().optional().default(false),
      offset: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
    async ({ rootDir, locale, severity, code, file, skipScan, offset, limit }) => {
      const res = runCheck({
        rootDir: rootDir ?? defaultRoot,
        locale,
        severity: severity as CheckSeverity | undefined,
        code: code as CheckIssueCode | undefined,
        file,
        skipScan,
        offset,
        limit,
      });
      // Strip internal metrics to keep MCP payload compact
      const { metrics: _metrics, ...compact } = res;
      return mcpTextResult(compact);
    }
  );

  server.tool(
    "memory",
    "Look up lexical fuzzy matches and glossary entries, or record a glossary decision (propagating changes to affected keys), translation memory pair, or assumption.",
    {
      rootDir: z.string().optional(),
      action: z
        .enum(["lookup", "set_glossary", "add_assumption", "add_pair"])
        .describe("Action to perform on .polyglot/ memory."),
      query: z.string().optional().describe("Source text or term to look up (for 'lookup')."),
      targetLocale: z.string().optional(),
      minScore: z.number().int().min(0).max(100).optional().default(50),
      limit: z.number().int().min(1).max(50).optional().default(10),
      // set_glossary fields
      term: z.string().optional(),
      doNotTranslate: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      translations: z.record(z.string(), z.string()).optional(),
      notes: z.string().optional(),
      origin: z.enum(["inferred", "user", "imported"]).optional(),
      // add_assumption fields
      category: z
        .enum(["terminology", "brand", "tone", "disambiguation", "formatting", "scope", "other"])
        .optional(),
      summary: z.string().optional(),
      rationale: z.string().optional(),
      // add_pair fields
      source: z.string().optional(),
      target: z.string().optional(),
      context: z.string().optional(),
    },
    async (args) => {
      const root = args.rootDir ?? defaultRoot;
      if (args.action === "lookup") {
        if (!args.query) return mcpTextResult({ error: "query is required for lookup" }, true);
        return mcpTextResult(
          lookupMemory(root, {
            query: args.query,
            targetLocale: args.targetLocale,
            minScore: args.minScore,
            limit: args.limit,
          })
        );
      }
      if (args.action === "set_glossary") {
        if (!args.term) return mcpTextResult({ error: "term is required for set_glossary" }, true);
        return mcpTextResult(
          recordGlossaryTerm(root, {
            term: args.term,
            doNotTranslate: args.doNotTranslate,
            caseSensitive: args.caseSensitive,
            translations: args.translations,
            notes: args.notes,
            origin: args.origin,
          })
        );
      }
      if (args.action === "add_assumption") {
        if (!args.summary) return mcpTextResult({ error: "summary is required for add_assumption" }, true);
        return mcpTextResult(
          recordAssumption(root, {
            category: args.category ?? "other",
            locale: args.targetLocale,
            summary: args.summary,
            rationale: args.rationale,
          })
        );
      }
      if (args.action === "add_pair") {
        if (!args.source || !args.target || !args.targetLocale) {
          return mcpTextResult({ error: "source, target, and targetLocale are required for add_pair" }, true);
        }
        return mcpTextResult(
          recordMemoryPair(root, {
            source: args.source,
            target: args.target,
            targetLocale: args.targetLocale,
            context: args.context,
          })
        );
      }
      return mcpTextResult({ error: "Unknown memory action" }, true);
    }
  );

  server.tool(
    "import",
    "Import optional localization assets into .polyglot/: glossary (CSV, TBX), translation memory (TMX), or existing repository locale files.",
    {
      rootDir: z.string().optional(),
      file: z.string().optional().describe("Path to .csv, .tbx, or .tmx file (omit for existing locale files)."),
      format: z.enum(["auto", "csv", "tbx", "tmx", "locales"]).optional().default("auto"),
    },
    async ({ rootDir, file, format }) => {
      const res = importAsset(rootDir ?? defaultRoot, { file, format });
      return mcpTextResult(res);
    }
  );

  server.tool(
    "pseudo",
    "Generate a pseudo-locale (accented characters, ~30-40% length expansion, bracket markers) preserving placeholders, ICU syntax, and inline tags to reveal hardcoded strings and layout truncation.",
    {
      rootDir: z.string().optional(),
      pseudoLocale: z.string().optional().default("en-x-pseudo"),
    },
    async ({ rootDir, pseudoLocale }) => {
      const res = generatePseudoLocale(rootDir ?? defaultRoot, pseudoLocale);
      return mcpTextResult(res);
    }
  );

  server.tool(
    "review",
    "Package an MQM-style cross-model review job (with two-pass false-positive filtering instructions and output schema) for a different agent/model to run, or ingest review findings into .polyglot/reviews.json.",
    {
      rootDir: z.string().optional(),
      action: z.enum(["package", "ingest"]),
      targetLocale: z.string().describe("Target BCP-47 locale."),
      keys: z.array(z.string()).optional(),
      outputPath: z.string().optional().describe("Optional path to write the review job JSON."),
      offset: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(200).optional().default(40),
      // ingest fields
      reviewer: z.string().optional().describe("Reviewing model/agent name (e.g. 'gemini-cli', 'codex')."),
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
    async (args) => {
      const root = args.rootDir ?? defaultRoot;
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

  server.tool(
    "escalate",
    "Export flagged strings for a human reviewer (CSV, XLSX, and self-contained HTML page showing source, translation, context, and reason flagged), or import reviewer corrections back into locale files and memory.",
    {
      rootDir: z.string().optional(),
      action: z.enum(["export", "import"]),
      locale: z.string().optional().describe("Optional locale filter for export."),
      outputDir: z.string().optional().describe("Directory to write review files (default: .polyglot/escalations)."),
      formats: z.array(z.enum(["csv", "xlsx", "html"])).optional(),
      file: z.string().optional().describe("Path to reviewer corrections file (.csv, .xlsx, or .json) for import."),
    },
    async (args) => {
      const root = args.rootDir ?? defaultRoot;
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

  server.tool(
    "report",
    "Generate the end-of-run localization report (issues caught, assumptions made, strings worth a native speaker's look) as structured JSON and PR-ready Markdown.",
    {
      rootDir: z.string().optional(),
      format: z.enum(["both", "json", "markdown"]).optional().default("both"),
    },
    async ({ rootDir, format }) => {
      const rep = generateReport(rootDir ?? defaultRoot);
      if (format === "markdown") return mcpTextResult(rep.markdown);
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
1. Call \`status\` and \`scan\` to understand the framework, i18n setup, hardcoded strings, concatenations, and documents.
2. If the project has hardcoded strings or no i18n setup yet, set up the framework's standard i18n library and extract strings into source locale files.
3. Infer brand/do-not-translate terms and key UI terminology; record assumptions via \`memory\`. If config.review === "confirm", pause briefly to confirm key glossary terms first; otherwise proceed without interrupting.
4. Use \`prepare\` in batches per target locale. Treat all fuzzy memory matches (even 100% matches) as strong suggestions to verify against component context — never blindly trust them. Write translations exclusively through \`apply\`.
5. Run \`pseudo\` to check layout/formatting hotspots (truncation, fixed widths, overflow, RTL spacing). Where possible, visually QA rendered screens in the pseudo-locale and target locales and fix any CSS/layout or copy overflow issues.
6. Run \`check\`. Fix every error (missing keys, remaining hardcoded strings, broken placeholders/ICU/plurals, glossary inconsistencies, stale/context-changed entries) and re-run \`check\` until clean.
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
