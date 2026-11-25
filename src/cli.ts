import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ensureBootstrapped } from "./core/bootstrap.js";
import { runCheck } from "./core/check.js";
import { exportEscalation, importEscalationCorrections } from "./core/escalate.js";
import { importAsset } from "./core/importers.js";
import { initProject } from "./core/init.js";
import { runLayoutFix } from "./core/layout-codemods.js";
import { runLayoutCheck } from "./core/layout.js";
import { generatePseudoLocale } from "./core/pseudo-locale.js";
import { PseudoMode } from "./core/pseudo.js";
import { runQe } from "./core/qe.js";
import { isXliffPath, runTmsExport, runTmsImport } from "./core/tms.js";
import { runVisualQa } from "./core/visual-qa.js";
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
      console.log("\nAdd to your coding agent MCP config (from a local checkout or installed binary):");
      console.log("  claude mcp add polyglot -- node /absolute/path/to/polyglot/dist/bin.js mcp");
      console.log("  # or if 'polyglot' is on PATH: claude mcp add polyglot -- polyglot mcp");
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
      } else if (res.outcome === "PASS") {
        console.log(
          `PASS · 0 errors · ${res.warningCount} warning(s) (${res.totalSourceKeys} keys across ${res.targetLocales.length} target locale(s), ${res.coverage.filesScanned} source file(s) scanned)`
        );
        for (const iss of res.issues.items) {
          console.log(`  [${iss.severity}] ${iss.code}: ${iss.message}`);
        }
      } else if (res.outcome === "INCONCLUSIVE") {
        console.log(`INCONCLUSIVE · insufficient coverage to pass verification`);
        for (const r of res.inconclusiveReasons) {
          console.log(`  - ${r}`);
        }
      } else {
        console.log(
          `FAIL · ${res.errorCount} error(s) · ${res.warningCount} warning(s)`
        );
        for (const iss of res.issues.items) {
          const loc = iss.file ? `${iss.file}:${iss.line ?? 1} ` : "";
          console.log(`  [${iss.severity}] ${iss.code}: ${loc}${iss.message}`);
        }
        if (res.issues.hasMore) {
          console.log(`  ... and ${res.issues.total - res.issues.items.length} more`);
        }
      }

      if (res.outcome === "FAIL") {
        process.exitCode = 1;
      } else if (res.outcome === "INCONCLUSIVE") {
        process.exitCode = 2;
      }
    });

  program
    .command("pseudo")
    .description("Generate pseudo-locale(s) (expand, rtl, cjk, tall, long-word, format, or auto) with zero-width key tracing")
    .option("-l, --locale <tag>", "Pseudo-locale tag (defaults to en-x-pseudo or mode tag)")
    .option("-m, --mode <mode>", "Pseudo mode: auto|expand|rtl|cjk|tall|long-word|format")
    .option("--no-key-ids", "Disable invisible zero-width key ID embedding")
    .option("--format-overlay", "Overlay format pseudo-transforms (Arabic-Indic digits, comma decimals, D/M/Y dates, ¤ currency)")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const res = generatePseudoLocale(rootDir, {
        pseudoLocale: opts.locale,
        mode: opts.mode as PseudoMode | "auto" | undefined,
        embedKeyIds: opts.keyIds,
        formatOverlay: opts.formatOverlay,
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Generated pseudo-locale(s): ${res.modesGenerated.map((m) => `${m.pseudoLocale} [${m.mode}]`).join(", ")} (${res.keysGenerated} keys -> ${res.filesWritten.join(", ")})`
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
    .command("layout")
    .description("Render routes with Playwright to detect overflow, clipping, overlap, tofu, RTL, and hardcoded formats — or run deterministic codemods with --fix")
    .option("--url <baseUrl>", "Running dev server base URL (e.g. http://localhost:3000)")
    .option("--routes <list>", "Comma-separated routes to render (e.g. /,/settings)")
    .option("-l, --locales <list>", "Comma-separated locales to check (defaults to pseudo + targetLocales)")
    .option("--locale-pattern <pattern>", "How locale is passed: query|prefix|cookie", "query")
    .option("--fix", "Apply deterministic mechanical codemods (Tailwind physical->logical, w-*->min-w-*, root html dir/lang)", false)
    .option("--dry-run", "Preview mechanical codemod diffs without writing files (use with --fix)", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const rootDir = program.opts().cwd;
      if (opts.fix) {
        const fixRes = runLayoutFix({
          rootDir,
          dryRun: Boolean(opts.dryRun),
        });
        if (opts.json) {
          console.log(JSON.stringify(fixRes, null, 2));
          return;
        }
        console.log(
          `${fixRes.dryRun ? "[dry-run] " : ""}Layout codemods: ${fixRes.totalChanges} change(s) across ${fixRes.previews.length} file(s)`
        );
        for (const p of fixRes.previews) {
          console.log(`\n${p.unifiedDiff}`);
        }
        return;
      }

      const res = await runLayoutCheck({
        rootDir,
        baseUrl: opts.url,
        routes: parseCsvList(opts.routes),
        locales: parseCsvList(opts.locales),
        localeUrlPattern: opts.localePattern as "query" | "prefix" | "cookie",
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.outcome === "INCONCLUSIVE") {
        console.log(`INCONCLUSIVE · ${res.inconclusiveReason}`);
        for (const s of res.nextSteps) console.log(`  - ${s}`);
      } else if (res.outcome === "PASS") {
        console.log(
          `PASS · 0 layout defects across ${res.routesChecked.length} route(s) × ${res.localesChecked.length} locale(s) × ${res.viewportsChecked.length} viewport(s)`
        );
      } else {
        console.log(`FAIL · ${res.findingCount} layout defect(s) (${JSON.stringify(res.countsByType)})`);
        for (const f of res.findings.slice(0, 20)) {
          const locStr = f.file ? `${f.file}:${f.line ?? 1}` : f.route;
          console.log(
            `  [${f.type}] (${f.locale} @ ${f.viewport.width}px) ${f.key ?? f.element} @ ${locStr}: ${f.prescription}`
          );
        }
        if (res.budgetsRecorded > 0) {
          console.log(`\nRecorded ${res.budgetsRecorded} width budget(s) in .polyglot/layout.json.`);
        }
      }
      if (res.outcome === "FAIL") process.exitCode = 1;
      else if (res.outcome === "INCONCLUSIVE") process.exitCode = 2;
    });

  program
    .command("extract")
    .description("Deterministic extraction gate: list hardcoded strings, concatenations, and hardcoded formatting still in source (the agent performs the refactor)")
    .option("--fail-on-unextracted", "Exit 1 when any hardcoded strings or concatenations remain", false)
    .option("--limit <n>", "Max findings to show", "50")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      const res = scanProject({ rootDir, saveUsage: false, limit: Number.parseInt(opts.limit, 10) || 50 });
      const unextracted = res.counts.hardcodedStrings + res.counts.concatenations;
      const out = {
        outcome: unextracted === 0 ? "PASS" : "FAIL",
        framework: res.framework,
        i18nLibrary: res.i18nLibrary,
        filesScanned: res.filesScanned,
        counts: res.counts,
        hardcodedStrings: res.hardcodedStrings.items,
        concatenations: res.concatenations.items,
      };
      if (opts.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(
          `${out.outcome} · ${res.counts.hardcodedStrings} hardcoded string(s) · ${res.counts.concatenations} concatenation(s) · ${res.counts.hardcodedFormatting ?? 0} hardcoded formatting (${res.filesScanned} files scanned)`
        );
        for (const h of res.hardcodedStrings.items) console.log(`  ${h.file}:${h.line} [${h.kind}] "${h.text}"`);
        for (const c of res.concatenations.items) console.log(`  ${c.file}:${c.line} ${c.expression}`);
      }
      if (opts.failOnUnextracted && unextracted > 0) process.exitCode = 1;
    });

  program
    .command("visual-qa")
    .description("Token-free DOM geometry regression check (line wraps, blowouts, truncation, occlusion, tofu, contrast) against .polyglot/visual-baseline.json")
    .option("--capture-baseline", "Capture/overwrite the geometry baseline instead of diffing", false)
    .option("--base <path>", "Baseline file path", ".polyglot/visual-baseline.json")
    .option("--routes <csv>", "Comma-separated routes")
    .option("--locales <csv>", "Comma-separated locales")
    .option("--url <baseUrl>", "Running preview/dev server base URL")
    .option("--locale-pattern <pattern>", "How locale is passed: query|prefix|cookie")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const rootDir = program.opts().cwd;
      const res = await runVisualQa({
        rootDir,
        baseUrl: opts.url,
        routes: parseCsvList(opts.routes),
        locales: parseCsvList(opts.locales),
        captureBaseline: Boolean(opts.captureBaseline),
        basePath: opts.base,
        localeUrlPattern: opts.localePattern as "query" | "prefix" | "cookie" | undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.outcome === "INCONCLUSIVE") {
        console.log(`INCONCLUSIVE · ${res.inconclusiveReason}`);
        for (const s of res.nextSteps) console.log(`  - ${s}`);
      } else if (res.mode === "capture") {
        console.log(`Captured baseline: ${res.elementsMeasured} traced element(s) -> ${res.baselinePath}`);
      } else if (res.outcome === "PASS") {
        console.log(`PASS · 0 visual regressions across ${res.elementsMeasured} traced element(s)`);
      } else {
        console.log(`FAIL · ${res.defectCount} visual regression(s) ${JSON.stringify(res.countsByType)}`);
        for (const d of res.defects.slice(0, 25)) {
          console.log(`  [${d.type}] ${d.locale} @ ${d.viewport} ${d.key}${d.file ? ` (${d.file}:${d.line ?? 1})` : ""}: ${d.message}${d.screenshot ? ` -> ${d.screenshot}` : ""}`);
        }
        if (res.manifestPath) console.log(`Artifacts manifest: ${res.manifestPath}`);
      }
      if (res.outcome === "FAIL") process.exitCode = 1;
      else if (res.outcome === "INCONCLUSIVE") process.exitCode = 2;
    });

  program
    .command("qe")
    .description("Tiered quality estimation: deterministic Tier 1 gate, 3-critic LLM swarm (Tier 2, needs ANTHROPIC_API_KEY or GEMINI_API_KEY), composite risk + optional auto-repair")
    .option("--locales <csv>", "Comma-separated target locales (default: config targetLocales)")
    .option("--auto-repair", "Run one targeted repair pass for 25 <= risk <= 60 (writes through validated apply)", false)
    .option("--fail-above <number>", "Exit 1 if any segment risk exceeds this score")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      const rootDir = program.opts().cwd;
      const res = await runQe({
        rootDir,
        locales: parseCsvList(opts.locales),
        autoRepair: Boolean(opts.autoRepair),
        failAbove: opts.failAbove !== undefined ? Number(opts.failAbove) : undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const s = res.summary;
        console.log(
          `${res.outcome} · ${s.total} segment(s): ${s.verified} verified · ${s.needsReview} needs_review · ${s.unscored} unscored · ${s.tier1Escalations} Tier-1 escalations · mean risk ${s.meanRisk} · max ${s.maxRisk} · ${s.llmCalls} LLM call(s) (${res.model ?? "Tier 2 unavailable"})`
        );
        for (const f of res.flagged.slice(0, 20)) {
          console.log(`  [${f.status}] ${f.locale} ${f.key} risk=${f.riskScore}${f.topIssue ? `: ${f.topIssue}` : ""}`);
        }
        for (const n of res.nextSteps) console.log(`  - ${n}`);
        console.log(`Report: ${res.reportPath}`);
      }
      if (res.outcome === "FAIL") process.exitCode = 1;
      else if (res.outcome === "INCONCLUSIVE") process.exitCode = 2;
    });

  program
    .command("export")
    .description("Export segments for human post-editing in a TMS: XLIFF 2.0 with metadata/notes, optional TMX 1.4b, TBX-Basic, and failure screenshots")
    .option("--format <fmt>", "Export format (xliff2)", "xliff2")
    .option("-o, --out <dir>", "Output directory", ".polyglot/exports/tms")
    .option("--locales <csv>", "Comma-separated target locales")
    .option("--only-flagged", "Only export segments with status needs_review in .polyglot/qe-report.json", false)
    .option("--include-tm", "Write tm.tmx (TMX 1.4b)", false)
    .option("--include-glossary", "Write glossary.tbx (TBX-Basic)", false)
    .option("--bundle-screenshots", "Copy matching visual-qa failure crops into <out>/screenshots/", false)
    .option("--json", "Output JSON", false)
    .action((opts) => {
      const rootDir = program.opts().cwd;
      if (opts.format !== "xliff2") {
        console.error(`Error: unsupported format "${opts.format}" (supported: xliff2)`);
        process.exitCode = 1;
        return;
      }
      const res = runTmsExport({
        rootDir,
        format: "xliff2",
        outDir: opts.out,
        locales: parseCsvList(opts.locales),
        onlyFlagged: Boolean(opts.onlyFlagged),
        includeTm: Boolean(opts.includeTm),
        includeGlossary: Boolean(opts.includeGlossary),
        bundleScreenshots: Boolean(opts.bundleScreenshots),
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(
        `Exported ${Object.entries(res.unitsByLocale).map(([l, n]) => `${l}: ${n} unit(s)`).join(", ") || "no locales"} -> ${res.outDir}`
      );
      for (const f of res.files) console.log(`  ${f}`);
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
    .description("Import assets: glossary (CSV, TBX), translation memory (TMX), existing locale files, or reviewed XLIFF 2.0 from a TMS (file or directory)")
    .option("-f, --format <fmt>", "Asset format: auto|csv|tbx|tmx|locales|xliff", "auto")
    .option("--json", "Output JSON", false)
    .action(async (file, opts) => {
      const rootDir = program.opts().cwd;
      const looksXliff =
        opts.format === "xliff" ||
        (file &&
          (isXliffPath(file) ||
            (fs.existsSync(path.resolve(rootDir, file)) &&
              fs.statSync(path.resolve(rootDir, file)).isDirectory() &&
              fs.readdirSync(path.resolve(rootDir, file)).some((f) => isXliffPath(f)))));
      if (looksXliff) {
        if (!file) {
          console.error("Error: an XLIFF file or directory is required.");
          process.exitCode = 1;
          return;
        }
        const res = await runTmsImport({ rootDir, input: file });
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            `TMS import (${res.files.length} file(s), ${res.locales.join(", ")}): ${res.applied} applied · ${res.unchanged} unchanged (verified) · ${res.rejected.length} rejected · ${res.tmUpserted} TM entries (human-reviewed) · ${res.qeHumanVerified} QE segments human-verified`
          );
          for (const d of res.diff.slice(0, 30)) {
            console.log(`  ${d.locale} ${d.key}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)} [${d.state}]`);
          }
          for (const r of res.rejected.slice(0, 20)) console.log(`  [rejected] ${r.locale} ${r.key}: ${r.code} ${r.message}`);
          if (res.check) console.log(`check: ${res.check.outcome} (${res.check.errorCount} errors, ${res.check.warningCount} warnings)`);
          if (res.visualQa) console.log(`visual-qa: ${res.visualQa.outcome} (${res.visualQa.defectCount} defects)${res.visualQa.inconclusiveReason ? ` — ${res.visualQa.inconclusiveReason}` : ""}`);
        }
        if (!res.ok || res.check?.outcome === "FAIL") process.exitCode = 1;
        return;
      }
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
