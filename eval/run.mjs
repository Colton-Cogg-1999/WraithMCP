#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  CODEX_CONFIG,
  DEEPL_STAGE_CHAR_CAP,
  DOCX_OUT_DIR,
  EVAL_ROOT,
  JUDGE_CONFIG,
  PILOT_LANGUAGES,
  WRAITH_BIN,
  RESULTS_DIR,
  SCREENSHOTS_DIR,
} from "./config.mjs";
import { atomicWriteJson } from "./lib/cache.mjs";
import { materializeCapturedFiles, runCodexWithWraith } from "./lib/codex.mjs";
import { summarizeLedger } from "./lib/cost.mjs";
import {
  assertDeepLStageCap,
  getDeepLUsage,
  translateCatalogWithDeepL,
  translateDocxWithDeepL,
} from "./lib/deepl.mjs";
import {
  inspectDocxStructure,
  measureDocxSourceLeakage,
  renderDocxWithLibreOffice,
} from "./lib/docx-eval.mjs";
import { runDualJudgeEvaluation } from "./lib/judges.mjs";
import { computeCatalogMetrics } from "./lib/metrics.mjs";
import { inspectVisualLayout } from "./lib/visual.mjs";
import { buildPilotDocx, PILOT_DOCX_PATH } from "./docx/build-pilot-docx.mjs";
import {
  buildPilotApp,
  PILOT_APP_DIR,
  PILOT_GLOSSARY,
  PILOT_ITEMS,
  renderPilotAppHtml,
} from "./synthetic/build-pilot-app.mjs";
import {
  extractGlossaryForLocale,
  extractPilotIcuRawDiagnostics,
  flattenJson,
  parseWraithJson,
  runWraithCli,
  seedWraithProject,
  unflattenJson,
} from "./stages/common.mjs";
import { runSyntheticStage } from "./stages/synthetic.mjs";
import { runDocxStage } from "./stages/docx.mjs";
import { runOssStage } from "./stages/oss.mjs";
import { runReplayStage } from "./stages/replay.mjs";
import { runJudgeRemaining } from "./stages/judge-remaining.mjs";
import { generateReports } from "./stages/report.mjs";

async function runSetup() {
  console.log("=== Stage 1: Setup ===");
  const app = buildPilotApp();
  const docxPath = buildPilotDocx();
  const loTest = renderDocxWithLibreOffice(docxPath, path.join(DOCX_OUT_DIR, "source"), "source");
  const usage = await getDeepLUsage();

  const setupSummary = {
    completedAt: new Date().toISOString(),
    wraithBin: WRAITH_BIN,
    codexModel: CODEX_CONFIG.model,
    codexApprovalFlags: CODEX_CONFIG.approvalFlags,
    codexModelCutoff: CODEX_CONFIG.modelCutoffDate,
    judges: JUDGE_CONFIG,
    calComSkipped: true,
    calComSkipReason: "audit3 MISS tests failed (MISS-1, MISS-2, MISS-3: 3 failed / 2 passed).",
    deeplStageCharCap: DEEPL_STAGE_CHAR_CAP,
    deeplUsageBaseline: usage,
    pilotApp: { dir: app.appDir, itemCount: app.itemCount },
    pilotDocx: { path: docxPath, libreOfficeOpened: loTest.openedCleanly, pages: loTest.pngPaths.length },
  };

  atomicWriteJson(path.join(RESULTS_DIR, "setup.json"), setupSummary);
  console.log(JSON.stringify(setupSummary, null, 2));
}

async function runPilot({ ignoreSpendCap = false } = {}) {
  console.log("=== Stage 2: Pilot (1 synthetic app x es-MX, de + 1 DOCX) ===");
  const stageName = "pilot";
  const appInfo = buildPilotApp();
  const docxPath = buildPilotDocx();

  const deeplBefore = await getDeepLUsage();
  console.log(`[DeepL before pilot] ${deeplBefore.character_count} / ${deeplBefore.character_limit} (${deeplBefore.tier})`);

  const pilotOut = {
    startedAt: new Date().toISOString(),
    codexApprovalFlags: CODEX_CONFIG.approvalFlags,
    deeplBefore,
    syntheticApp: {},
    docx: {},
    judgeValidationSummary: {},
  };

  const componentsByName = {};
  for (const [rel, code] of Object.entries(appInfo.components)) {
    componentsByName[path.basename(rel)] = code;
  }

  for (const locale of PILOT_LANGUAGES) {
    console.log(`\n--- Pilot synthetic app: ${locale} ---`);
    const localeGlossary = extractGlossaryForLocale(PILOT_GLOSSARY, locale);

    const promptA = `Localize this Next.js (next-intl) project into "${locale}" using the Wraith MCP server tools.
Follow the Wraith /localize workflow strictly:
1. Call \`status\` and \`scan\` first.
2. Call \`prepare\` in batches for targetLocale "${locale}" (pay close attention to usageSites, component names, glossaryHits, and conventions). Read the component files in src/components/ whenever an English word is context-ambiguous (e.g., Open, Post, Order, Close, Free, Save, Back, Charge, Sign, Archive) so your translation matches the exact UI context!
3. Write EVERY translation via Wraith's \`apply\` tool (preserving all ICU syntax, plurals, ordinals, selects, rich-text tags like <link>, <b>, <strong>, <codeTag>, and DNT brands Northstar / Northstar Pay / PulseGrid / LedgerVault, and honoring all glossary terms).
4. Run \`pseudo\` to check layout hotspots for tight-width buttons/tabs/badges, and ensure your translations for tight buttons/tabs stay concise.
5. Run \`check\` repeatedly and fix any errors until outcome is "PASS".
6. Call \`report\` at the end.
Reply with a brief JSON summary of check outcome and any notes.`;

    const codexRes = await runCodexWithWraith({
      stageName,
      label: `pilot-nextjs-${locale}`,
      sourceDir: PILOT_APP_DIR,
      prompt: promptA,
      captureRelPaths: [`messages/${locale}.json`, "messages/en-x-pseudo.json", ".wraith/records.json"],
      ignoreSpendCap,
      workspaceSetupFn: (tmpDir) => seedWraithProject(tmpDir, [locale], PILOT_GLOSSARY),
    });

    const workDirA = path.join(EVAL_ROOT, "work", `pilot-nextjs-A-${locale}`);
    fs.rmSync(workDirA, { recursive: true, force: true });
    fs.cpSync(PILOT_APP_DIR, workDirA, { recursive: true });
    seedWraithProject(workDirA, [locale], PILOT_GLOSSARY);
    materializeCapturedFiles(codexRes, workDirA);

    const aJsonPath = path.join(workDirA, "messages", `${locale}.json`);
    const flatA = fs.existsSync(aJsonPath) ? flattenJson(JSON.parse(fs.readFileSync(aJsonPath, "utf8"))) : {};
    const checkAParsed = parseWraithJson(runWraithCli(workDirA, ["check", "--locale", locale, "--json"]));

    const pseudoPath = path.join(workDirA, "messages", "en-x-pseudo.json");
    if (!fs.existsSync(pseudoPath)) runWraithCli(workDirA, ["pseudo"]);
    const flatPseudo = fs.existsSync(pseudoPath) ? flattenJson(JSON.parse(fs.readFileSync(pseudoPath, "utf8"))) : {};

    const deeplRes = await translateCatalogWithDeepL({
      stageName,
      targetLocale: locale,
      sourceMap: appInfo.flatEn,
      glossaryName: "pilot-commerce",
      glossaryEntries: localeGlossary,
    });
    const flatB = deeplRes.translations;

    const workDirC = path.join(EVAL_ROOT, "work", `pilot-nextjs-C-${locale}`);
    fs.rmSync(workDirC, { recursive: true, force: true });
    fs.cpSync(PILOT_APP_DIR, workDirC, { recursive: true });
    seedWraithProject(workDirC, [locale], PILOT_GLOSSARY);
    fs.writeFileSync(path.join(workDirC, "messages", `${locale}.json`), JSON.stringify(unflattenJson(flatB), null, 2) + "\n");
    const checkCParsed = parseWraithJson(runWraithCli(workDirC, ["check", "--locale", locale, "--json"]));

    const detA = computeCatalogMetrics(appInfo.flatEn, flatA, localeGlossary);
    const detB = computeCatalogMetrics(appInfo.flatEn, flatB, localeGlossary);

    const visualA = await inspectVisualLayout({
      appName: "pilot-nextjs",
      systemLabel: "A",
      screenshotDir: SCREENSHOTS_DIR,
      htmlByLocale: {
        en: renderPilotAppHtml("en", appInfo.flatEn),
        "en-x-pseudo": renderPilotAppHtml("en-x-pseudo", flatPseudo),
        [locale]: renderPilotAppHtml(locale, flatA),
      },
    });
    const visualB = await inspectVisualLayout({
      appName: "pilot-nextjs",
      systemLabel: "B",
      screenshotDir: SCREENSHOTS_DIR,
      htmlByLocale: { [locale]: renderPilotAppHtml(locale, flatB) },
    });

    const judgeItems = PILOT_ITEMS.map((item) => ({
      key: item.key,
      source: item.source,
      category: item.category,
      isChallenge: item.category !== "general",
      componentCode: componentsByName[item.component] ?? "",
      context: `${item.component} (${item.category})`,
      intendedSense: item.intendedSense,
      glossaryHits: localeGlossary.filter((g) =>
        new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(item.source)
      ),
      candidates: { A: flatA[item.key] ?? "", B: flatB[item.key] ?? "" },
    }));

    const judgeRes = await runDualJudgeEvaluation({
      stageName,
      targetLocale: locale,
      items: judgeItems,
      concurrency: 8,
      seed: locale === "es-MX" ? 101 : 202,
      ignoreSpendCap,
    });

    pilotOut.syntheticApp[locale] = {
      systemA: {
        exitCode: codexRes.exitCode,
        wallMs: codexRes.wallMs,
        telemetry: codexRes.telemetry,
        wraithCheck: checkAParsed,
        deterministicMetrics: detA,
        visualDefects: visualA.available ? visualA.locales[locale]?.totalDefects ?? null : null,
      },
      systemB: {
        wallMs: deeplRes.wallMs,
        liveChars: deeplRes.liveChars,
        usedGlossary: deeplRes.usedGlossary,
        deterministicMetrics: detB,
        visualDefects: visualB.available ? visualB.locales[locale]?.totalDefects ?? null : null,
      },
      systemC_checkOnB: checkCParsed,
      judging: judgeRes,
    };
  }

  // Pilot DOCX
  const docxLocale = "de";
  const docxWorkSrc = path.join(EVAL_ROOT, "work", "pilot-docx-src");
  fs.rmSync(docxWorkSrc, { recursive: true, force: true });
  fs.mkdirSync(docxWorkSrc, { recursive: true });
  fs.copyFileSync(docxPath, path.join(docxWorkSrc, "northstar-policy.docx"));

  const docxCodexRes = await runCodexWithWraith({
    stageName,
    label: "pilot-docx-de",
    sourceDir: docxWorkSrc,
    prompt: `Translate the DOCX document "northstar-policy.docx" into German ("de") as "northstar-policy.de.docx" using Wraith MCP tools.`,
    captureRelPaths: ["northstar-policy.de.docx", ".wraith/documents.json"],
    ignoreSpendCap,
    workspaceSetupFn: (tmpDir) =>
      seedWraithProject(tmpDir, [docxLocale], PILOT_GLOSSARY, (cfg) => {
        cfg.paths.documents = ["northstar-policy.docx"];
      }),
  });

  const docxOutA = path.join(DOCX_OUT_DIR, "pilot-A-northstar-policy.de.docx");
  const docxOutB = path.join(DOCX_OUT_DIR, "pilot-B-northstar-policy.de.docx");
  fs.mkdirSync(DOCX_OUT_DIR, { recursive: true });
  if (docxCodexRes.capturedFiles["northstar-policy.de.docx"]) {
    fs.writeFileSync(docxOutA, Buffer.from(docxCodexRes.capturedFiles["northstar-policy.de.docx"], "base64"));
  }
  const deeplMid = await getDeepLUsage();
  const usedSoFar = deeplMid.character_count - deeplBefore.character_count;
  assertDeepLStageCap(stageName, deeplMid, 50_000, DEEPL_STAGE_CHAR_CAP - usedSoFar);
  const docxDeepLRes = await translateDocxWithDeepL({
    stageName,
    sourceDocxPath: docxPath,
    outputDocxPath: docxOutB,
    targetLocale: docxLocale,
    stageCharCap: DEEPL_STAGE_CHAR_CAP - usedSoFar,
  });

  const srcStruct = inspectDocxStructure(docxPath);
  const structA = fs.existsSync(docxOutA) ? inspectDocxStructure(docxOutA) : null;
  const structB = fs.existsSync(docxOutB) ? inspectDocxStructure(docxOutB) : null;
  const loA = fs.existsSync(docxOutA) ? renderDocxWithLibreOffice(docxOutA, path.join(DOCX_OUT_DIR, "render-A"), "A-de") : null;
  const loB = fs.existsSync(docxOutB) ? renderDocxWithLibreOffice(docxOutB, path.join(DOCX_OUT_DIR, "render-B"), "B-de") : null;
  const dntTerms = PILOT_GLOSSARY.filter((g) => g.doNotTranslate).map((g) => g.term);

  pilotOut.docx = {
    sourceFile: "northstar-policy.docx",
    targetLocale: docxLocale,
    systemA: { libreOfficeOpened: loA?.openedCleanly ?? false, sourceLeakage: structA ? measureDocxSourceLeakage(srcStruct.visibleParagraphs, structA.visibleParagraphs, dntTerms) : null },
    systemB: { libreOfficeOpened: loB?.openedCleanly ?? false, billedCharacters: docxDeepLRes.billedCharacters, sourceLeakage: structB ? measureDocxSourceLeakage(srcStruct.visibleParagraphs, structB.visibleParagraphs, dntTerms) : null },
  };
  pilotOut.deeplAfter = await getDeepLUsage();
  pilotOut.finishedAt = new Date().toISOString();
  atomicWriteJson(path.join(RESULTS_DIR, "pilot.json"), pilotOut);
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const stage = args[0] ?? "status";
  const ignoreSpendCap = args.includes("--ignore-spend-cap");
  const onlyApp = getFlagValue(args, "--app");
  const judgeMode = getFlagValue(args, "--judge-mode") ?? "all";

  if (stage === "setup") {
    await runSetup();
  } else if (stage === "pilot") {
    await runPilot({ ignoreSpendCap });
  } else if (stage === "synthetic") {
    await runSyntheticStage({ ignoreSpendCap, onlyApp, judgeMode });
  } else if (stage === "docx-1") {
    await runDocxStage({ part: "1", ignoreSpendCap, judgeMode });
  } else if (stage === "docx-2") {
    await runDocxStage({ part: "2", ignoreSpendCap, judgeMode });
  } else if (stage === "docx") {
    await runDocxStage({ part: "1", ignoreSpendCap, judgeMode });
    await runDocxStage({ part: "2", ignoreSpendCap, judgeMode });
  } else if (stage === "oss") {
    await runOssStage({ ignoreSpendCap, onlyApp, judgeMode });
  } else if (stage === "replay") {
    await runReplayStage({ ignoreSpendCap, judgeMode });
  } else if (stage === "run") {
    // Generic scoped runner (additive). Currently: --scopes tm-ablation [--dry-run]
    const scopes = (getFlagValue(args, "--scopes") ?? "").split(",").filter(Boolean);
    if (scopes.length === 0) {
      console.error("Usage: node eval/run.mjs run --scopes tm-ablation [--dry-run] [--ignore-spend-cap]");
      process.exit(1);
    }
    for (const scope of scopes) {
      if (scope === "tm-ablation") {
        const { runTmAblationStage } = await import("./stages/tm-ablation.mjs");
        await runTmAblationStage({ dryRun: args.includes("--dry-run"), ignoreSpendCap });
      } else {
        console.error(`Unknown scope for \`run\`: ${scope}`);
        process.exit(1);
      }
    }
  } else if (stage === "judge-remaining") {
    const scopeStr = getFlagValue(args, "--scopes") ?? "synthetic,docx,oss,replay";
    const scopeList = scopeStr.split(",");
    if (scopeList.includes("tm-ablation")) {
      const { runTmAblationJudging } = await import("./stages/tm-ablation.mjs");
      await runTmAblationJudging({ ignoreSpendCap, judgeMode });
    }
    const legacyScopes = scopeList.filter((s) => s !== "tm-ablation");
    if (legacyScopes.length > 0) await runJudgeRemaining({ scopes: legacyScopes, ignoreSpendCap, judgeMode });
  } else if (stage === "analyze") {
    await generateReports();
  } else if (stage === "full") {
    await runSyntheticStage({ ignoreSpendCap, onlyApp, judgeMode });
    await runDocxStage({ part: "1", ignoreSpendCap, judgeMode });
    await runDocxStage({ part: "2", ignoreSpendCap, judgeMode });
    await runOssStage({ ignoreSpendCap, onlyApp, judgeMode });
    await runReplayStage({ ignoreSpendCap, judgeMode });
    await generateReports();
  } else if (stage === "icu-diagnostics") {
    console.log(JSON.stringify(extractPilotIcuRawDiagnostics(), null, 2));
  } else if (stage === "status") {
    const ledger = summarizeLedger();
    const usage = await getDeepLUsage().catch((e) => ({ error: e.message }));
    console.log(JSON.stringify({ ledger, deeplUsage: usage }, null, 2));
  } else {
    console.error(
      `Usage: node eval/run.mjs <setup|pilot|synthetic|docx-1|docx-2|oss|replay|analyze|full|icu-diagnostics|status> [--app <id>] [--ignore-spend-cap]\n       node eval/run.mjs run --scopes tm-ablation [--dry-run]`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[eval error]", err);
  process.exit(1);
});
