import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ensureBootstrapped } from "./core/bootstrap.js";
import { runCheck } from "./core/check.js";
import { exportEscalation, importEscalationCorrections } from "./core/escalate.js";
import { importAsset } from "./core/importers.js";
import { initProject } from "./core/init.js";
import { generatePseudoLocale } from "./core/pseudo-locale.js";
import { generateReport } from "./core/report.js";
import { ingestReviewResults, packageReviewJob } from "./core/review.js";
import { scanProject } from "./core/scan.js";
import { getProjectStatus } from "./core/status.js";
import { CheckIssueCode, CheckSeverity, FrameworkName, ReviewMode } from "./core/types.js";
import { startMcpServer } from "./mcp/server.js";

function parseCsvList(val?: string): string[] | undefined {
  if (!val) return undefined;
  return val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createCli(): Command {
  ensureBootstrapped();
  const program = new Command();

  program
    .name("polyglot")
    .description(
      "Model-free, deterministic localization CLI and MCP server for coding agents."
    )
    .version("0.1.0")
    .option("-C, --cwd <dir>", "Project root directory", process.cwd());

  program
    .command("init")
    .description("Initialize .polyglot/ config, agent rules, and optional git pre-commit hook")
    .option("-s, --source <locale>", "Source locale (BCP-47)", "en")
    .option("-t, --targets <locales>", "Comma-separated target locales (e.g. es-MX,fr,zh-Hans)")
    .option("-r, --review <mode>", "Review mode: auto or confirm", "auto")
    .option("-f, --framework <name>", "Framework override (default: auto)", "auto")
    .option("--locales-dir <path>", "Locales directory override")
    .option("--no-agent-rule", "Skip adding the localization rule to AGENTS.md / CLAUDE.md")
    .option("--hook", "Install a git pre-commit hook running polyglot check", false)
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const result = initProject({
        rootDir,
        sourceLocale: opts.source,
        targetLocales: parseCsvList(opts.targets),
        review: opts.review as ReviewMode,
        framework: opts.framework as FrameworkName,
        localesPath: opts.localesDir,
        writeAgentRule: opts.agentRule,
        installHook: opts.hook,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(
        `${result.created ? "Initialized" : "Updated"} ${result.configPath} (source: ${result.config.sourceLocale}, targets: ${result.config.targetLocales.join(", ") || "none yet"})`
      );
      if (result.agentFilesUpdated.length > 0) {
        console.log(`Added check rule to: ${result.agentFilesUpdated.join(", ")}`);
      }
      if (result.hookInstalled) {
        console.log(`Installed pre-commit hook: ${result.hookInstalled}`);
      }
      console.log("\nAdd to your coding agent MCP config:");
      console.log("  claude mcp add polyglot -- npx -y polyglot-mcp mcp");
    });

  program
    .command("status")
    .description("Show localization status, coverage, staleness, and check state")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const st = getProjectStatus(rootDir);

      if (opts.json) {
        console.log(JSON.stringify(st, null, 2));
        return;
      }

      console.log(
        `Polyglot status (${st.framework}${st.i18nLibrary ? ` / ${st.i18nLibrary}` : ""})`
      );
      console.log(
        `Source: ${st.sourceLocale} (${st.totalSourceKeys} keys) · Check: ${st.checkPassed ? "PASS" : `FAIL (${st.errorCount} errors, ${st.warningCount} warnings)`}`
      );
      if (st.locales.length === 0) {
        console.log("Target locales: none configured yet.");
      } else {
        for (const loc of st.locales) {
          console.log(
            `  ${loc.locale}: ${loc.coveragePct}% (${loc.translatedKeys}/${loc.totalKeys}) · missing ${loc.missingKeys} · stale ${loc.staleSource} · context-changed ${loc.contextChanged} · reviews ${loc.openReviews}`
          );
        }
      }
      if (st.orphanedKeys > 0) {
        console.log(`Orphaned keys: ${st.orphanedKeys}`);
      }
      console.log(
        `Memory: ${st.glossaryCount} glossary · ${st.memoryCount} pairs · ${st.assumptionsCount} assumptions · ${st.pendingReviews} open reviews`
      );
    });

  program
    .command("scan")
    .description("Detect framework & i18n setup; find hardcoded strings and concatenations")
    .option("--file <pattern>", "Filter by relative file substring")
    .option("--limit <n>", "Max findings to show", "25")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const res = scanProject({
        rootDir,
        fileFilter: opts.file,
        limit: Number.parseInt(opts.limit, 10) || 25,
      });

      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }

      console.log(
        `${res.framework}, ${res.i18nLibrary ?? "no i18n"} · ${res.counts.hardcodedStrings} hardcoded strings · ${res.counts.concatenations} concatenations · ${res.counts.trackedKeys} tracked keys (${res.filesScanned} files scanned)`
      );
      if (res.hardcodedStrings.items.length > 0) {
        console.log("\nHardcoded strings:");
        for (const h of res.hardcodedStrings.items) {
          console.log(
            `  ${h.file}:${h.line} [${h.kind}${h.attribute ? `:${h.attribute}` : ""}] "${h.text}"`
          );
        }
        if (res.hardcodedStrings.hasMore) {
          console.log(`  ... and ${res.hardcodedStrings.total - res.hardcodedStrings.items.length} more`);
        }
      }
      if (res.concatenations.items.length > 0) {
        console.log("\nConcatenations / fragments:");
        for (const c of res.concatenations.items) {
          console.log(`  ${c.file}:${c.line} ${c.expression}`);
        }
      }
    });

  program
    .command("check")
    .description("Run all deterministic localization checks (exits non-zero on errors)")
    .option("-l, --locale <locale>", "Filter by target locale")
    .option("--severity <level>", "Filter by severity (error|warning|info)")
    .option("--code <code>", "Filter by check issue code")
    .option("--skip-scan", "Skip source hardcoded-string scanning", false)
    .option("--limit <n>", "Max issues to display", "25")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const res = runCheck({
        rootDir,
        locale: opts.locale,
        severity: opts.severity as CheckSeverity | undefined,
        code: opts.code as CheckIssueCode | undefined,
        skipScan: opts.skipScan,
        limit: Number.parseInt(opts.limit, 10) || 25,
      });

      if (opts.json) {
        const { metrics: _m, ...out } = res;
        console.log(JSON.stringify(out, null, 2));
      } else if (res.passed) {
        console.log(
          `✓ clean · 0 errors · ${res.warningCount} warning(s) (${res.totalSourceKeys} keys across ${res.targetLocales.length} target locale(s))`
        );
        for (const iss of res.issues.items) {
          console.log(`  [${iss.severity}] ${iss.code}: ${iss.message}`);
        }
      } else {
        console.log(
          `✗ ${res.errorCount} error(s) · ${res.warningCount} warning(s)`
        );
        for (const iss of res.issues.items) {
          const loc = iss.file ? `${iss.file}:${iss.line ?? 1} ` : "";
          console.log(`  [${iss.severity}] ${iss.code}: ${loc}${iss.message}`);
        }
        if (res.issues.hasMore) {
          console.log(`  ... and ${res.issues.total - res.issues.items.length} more`);
        }
      }

      if (!res.passed) {
        process.exitCode = 1;
      }
    });

  program
    .command("pseudo")
    .description("Generate a pseudo-locale to catch hardcoded strings and layout truncation")
    .option("-l, --locale <tag>", "Pseudo-locale tag", "en-x-pseudo")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const res = generatePseudoLocale(rootDir, opts.locale);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Generated pseudo-locale ${res.pseudoLocale} (${res.keysGenerated} keys -> ${res.filesWritten.join(", ")})`
      );
      for (const s of res.sample) {
        console.log(`  ${s.key}: "${s.source}" -> "${s.pseudo}"`);
      }
      if (res.layoutHotspots.total > 0) {
        console.log(`\nLayout QA hotspots (${res.layoutHotspots.total}):`);
        for (const h of res.layoutHotspots.items.slice(0, 8)) {
          console.log(`  ${h.file}:${h.line} [${h.constraint}] ${h.suggestion}`);
        }
      }
    });

  program
    .command("review")
    .description("Package an MQM cross-model review job or ingest review results")
    .option("-l, --locale <locale>", "Target locale for packaging or ingesting")
    .option("-o, --output <path>", "Write packaged review job JSON to file")
    .option("--ingest <file>", "Ingest review findings JSON file from another agent/model")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      if (opts.ingest) {
        const abs = path.resolve(rootDir, opts.ingest);
        const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
        const res = ingestReviewResults(rootDir, {
          reviewer: parsed.reviewer,
          targetLocale: opts.locale ?? parsed.targetLocale,
          findings: parsed.findings ?? [],
        });
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(
          `Ingested review (${res.reviewer}) for ${res.targetLocale}: ${res.verifiedOpen} verified finding(s), ${res.filteredFalsePositives} false positive(s) filtered`
        );
        return;
      }

      if (!opts.locale) {
        console.error("Error: --locale <locale> is required when packaging a review job.");
        process.exitCode = 1;
        return;
      }
      const pkg = packageReviewJob(rootDir, {
        targetLocale: opts.locale,
        outputPath: opts.output,
      });
      if (opts.json || !opts.output) {
        console.log(JSON.stringify(pkg, null, 2));
        return;
      }
      console.log(
        `Packaged MQM review job (${pkg.items.length} strings for ${pkg.targetLocale}) -> ${pkg.outputPath}`
      );
    });

  program
    .command("escalate")
    .description("Export flagged strings for human review (CSV, XLSX, HTML) or import corrections")
    .option("-l, --locale <locale>", "Filter export by target locale")
    .option("-o, --output-dir <dir>", "Output directory", ".polyglot/escalations")
    .option("--import <file>", "Import reviewer corrections (.csv, .xlsx, or .json)")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      if (opts.import) {
        const res = importEscalationCorrections(rootDir, opts.import);
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        console.log(
          `Imported corrections from ${res.file}: ${res.appliedCount} applied, ${res.rejectedCount} rejected, ${res.resolvedReviews} review(s) resolved`
        );
        return;
      }

      const res = exportEscalation(rootDir, {
        outputDir: opts.outputDir,
        locale: opts.locale,
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Exported ${res.flaggedCount} flagged string(s): ${res.filesWritten.join(", ")}`
      );
    });

  program
    .command("import [file]")
    .description("Import optional assets: glossary (CSV, TBX), translation memory (TMX), or existing locale files")
    .option("-f, --format <fmt>", "Asset format: auto|csv|tbx|tmx|locales", "auto")
    .option("--json", "Output JSON", false)
    .action((file, opts) => {
      const rootDir = program.opts().cwd;
      const res = importAsset(rootDir, { file, format: opts.format });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Imported (${res.format}) from ${res.file}: ${res.glossaryImported} glossary · ${res.memoryImported} memory pairs · ${res.recordsImported} records`
      );
    });

  program
    .command("report")
    .description("Generate end-of-run localization report (Markdown or JSON)")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const rep = generateReport(rootDir);
      if (opts.json) {
        console.log(JSON.stringify(rep, null, 2));
        return;
      }
      console.log(rep.markdown);
    });

  program
    .command("mcp")
    .description("Start the Polyglot MCP server over stdio")
    .action(async () => {
      const rootDir = program.opts().cwd;
      await startMcpServer({ rootDir });
    });

  return program;
}
