import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ALL_LANGUAGES,
  DEEPL_STAGE_CHAR_CAP,
  EVAL_ROOT,
  REPO_ROOT,
  RESULTS_DIR,
  SCREENSHOTS_DIR,
} from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import {
  materializeCapturedFiles,
  runCodexNoPolyglot,
  runCodexWithPolyglot,
} from "../lib/codex.mjs";
import {
  getDeepLUsage,
  getGlossaryDeletionLog,
  translateCatalogWithDeepL,
} from "../lib/deepl.mjs";
import { runDualJudgeEvaluation } from "../lib/judges.mjs";
import { computeCatalogMetrics } from "../lib/metrics.mjs";
import { inspectVisualLayout } from "../lib/visual.mjs";
import {
  buildPilotApp,
  PILOT_GLOSSARY,
  PILOT_ITEMS,
  renderPilotAppHtml,
} from "../synthetic/build-pilot-app.mjs";
import {
  buildAllSyntheticApps,
  makeDjangoPoSkeleton,
  renderGenericSyntheticHtml,
} from "../synthetic/build-all-synthetic.mjs";
import {
  buildContextMapForApp,
  extractGlossaryForLocale,
  flattenJson,
  normalizeTelemetryPer1k,
  parsePoCatalog,
  parsePolyglotJson,
  parseYamlCatalog,
  runPolyglotCli,
  seedPolyglotProject,
  unflattenJson,
  writePoCatalogFromSkeleton,
  writeYamlCatalog,
} from "./common.mjs";

function readTargetCatalog(appSpec, dir, locale) {
  if (appSpec.format === "json") {
    const p = path.join(dir, appSpec.targetPathFn(locale));
    return fs.existsSync(p) ? flattenJson(JSON.parse(fs.readFileSync(p, "utf8"))) : {};
  }
  if (appSpec.format === "yaml") {
    const p = path.join(dir, appSpec.targetPathFn(locale));
    return fs.existsSync(p) ? parseYamlCatalog(fs.readFileSync(p, "utf8"), locale) : {};
  }
  if (appSpec.format === "po") {
    const p = path.join(dir, appSpec.targetPathFn(locale));
    return fs.existsSync(p) ? parsePoCatalog(fs.readFileSync(p, "utf8")) : {};
  }
  return {};
}

function writeTargetCatalog(appSpec, dir, locale, flatMap) {
  const abs = path.join(dir, appSpec.targetPathFn(locale));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (appSpec.format === "json") {
    fs.writeFileSync(abs, JSON.stringify(unflattenJson(flatMap), null, 2) + "\n");
  } else if (appSpec.format === "yaml") {
    fs.writeFileSync(abs, writeYamlCatalog(locale, flatMap));
  } else if (appSpec.format === "po") {
    const skel = makeDjangoPoSkeleton(locale);
    fs.writeFileSync(abs, writePoCatalogFromSkeleton(skel, flatMap));
  }
}

function buildPromptsForApp(appSpec, locale) {
  const targetRel = appSpec.targetPathFn(locale);
  const promptA = `Localize this ${appSpec.stack} project into "${locale}" using the Polyglot MCP server tools.
Follow the Polyglot /localize workflow strictly:
1. Call \`status\` and \`scan\` first.
2. Call \`prepare\` in batches for targetLocale "${locale}". Inspect usageSites, component files, glossaryHits, and locale conventions so context-ambiguous words (Open, Post, Order, Close, Free, Save, Back, Charge, Sign, Archive) match their exact UI context.
3. Write EVERY translation via Polyglot's \`apply\` tool (preserving all placeholders, ICU/plural syntax, rich-text tags, DNT brands Northstar / Northstar Pay / PulseGrid / LedgerVault, and honoring all glossary terms).
4. Run \`pseudo\` to check layout hotspots for tight-width buttons/tabs/badges and keep tight UI translations concise.
5. Run \`check\` repeatedly and fix any errors until outcome is "PASS".
6. Call \`report\` at the end.
Reply with a brief JSON summary of check outcome.`;

  // Change #1 exact A0 prompt (Codex with NO Polyglot MCP)
  const promptA0 =
    appSpec.id === "nextjs-commerce"
      ? `Translate messages/en.json into ${locale} (writing messages/${locale}.json), reading the components for context; keep placeholders/ICU valid.`
      : `Translate ${appSpec.sourceRel} into ${locale} (writing ${targetRel}), reading the components for context; keep placeholders/ICU valid.`;

  // Change #5 A-compact prompt: prepare (largest page size limit=100) -> apply -> check only
  const promptACompact = `Localize this ${appSpec.stack} project into "${locale}" using ONLY these three Polyglot MCP tools in minimal turns:
1. Call \`prepare\` ONCE with targetLocale="${locale}", limit=100, offset=0 (do NOT call status, scan, pseudo, or report). Read component files only if needed to disambiguate ambiguous words.
2. Call \`apply\` ONCE (or minimal calls) with all translations for "${locale}", preserving placeholders, ICU/plurals, rich-text tags, DNT brands, and glossary terms.
3. Call \`check\` once (and fix only if errors exist until outcome is "PASS").
Reply DONE.`;

  return { promptA, promptA0, promptACompact };
}

function runCheckOnFlat(appSpec, locale, flatMap, workSubdir) {
  const workDir = path.join(EVAL_ROOT, "work", workSubdir);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.cpSync(appSpec.dir, workDir, { recursive: true });
  seedPolyglotProject(workDir, [locale], appSpec.glossary);
  writeTargetCatalog(appSpec, workDir, locale, flatMap);
  const res = runPolyglotCli(workDir, ["check", "--locale", locale, "--json"]);
  return parsePolyglotJson(res);
}

/**
 * Extraction test on never-internationalized Next.js app (`nextjs-unlocalized`).
 */
async function runExtractionBenchmark(extractionApp, { ignoreSpendCap = false } = {}) {
  console.log("\n=== Synthetic Extraction Test: nextjs-unlocalized ===");
  const scanDir = path.join(EVAL_ROOT, "work", "extract-scan-only");
  fs.rmSync(scanDir, { recursive: true, force: true });
  fs.cpSync(extractionApp.appDir, scanDir, { recursive: true });
  seedPolyglotProject(scanDir, ["de", "es-MX"], PILOT_GLOSSARY);

  const scanRes = runPolyglotCli(scanDir, ["scan", "--json"]);
  const scanParsed = parsePolyglotJson(scanRes);
  const candidates =
    scanParsed.hardcodedStrings?.items ??
    scanParsed.hardcodedCandidates ??
    scanParsed.hardcoded ??
    scanParsed.candidates ??
    [];
  const candidateTexts = candidates.map((c) => String(c.text ?? c.value ?? c.source ?? ""));

  // Recall: how many of the 24 expected user-visible strings appear in scanner findings
  let expectedFound = 0;
  const missedExpected = [];
  for (const exp of extractionApp.expected) {
    const hit = candidateTexts.some((t) => t.includes(exp) || exp.includes(t.trim()) && t.trim().length >= 4);
    if (hit) expectedFound++;
    else missedExpected.push(exp);
  }

  // False positives against the 10 must-not-flag technical strings
  let mustNotFlagged = 0;
  const flaggedTechnical = [];
  for (const bad of extractionApp.mustNotFlag) {
    const hit = candidateTexts.some((t) => t.includes(bad));
    if (hit) {
      mustNotFlagged++;
      flaggedTechnical.push(bad);
    }
  }

  const recall = Number((expectedFound / extractionApp.expected.length).toFixed(4));
  const truePositives = expectedFound;
  const precision =
    candidateTexts.length > 0 ? Number((truePositives / Math.max(truePositives, candidateTexts.length)).toFixed(4)) : 0;

  console.log(
    `[Extraction scanner] candidates=${candidateTexts.length} recall=${expectedFound}/${extractionApp.expected.length} (${(recall * 100).toFixed(1)}%) techFalsePositives=${mustNotFlagged}/${extractionApp.mustNotFlag.length}`
  );

  // Now run Codex + Polyglot MCP to actually extract strings, wire next-intl, and translate into de & es-MX
  const extractPrompt = `This Next.js app (src/components/StudioDashboard.tsx) has hardcoded English UI strings and an empty messages/en.json.
Do NOT touch src/lib/runnerApi.ts (those are API/SQL/header/log technical strings).
Using Polyglot MCP tools:
1. Call \`scan\` to find hardcoded user-visible strings in src/components/StudioDashboard.tsx.
2. Refactor src/components/StudioDashboard.tsx to use \`useTranslations\` from "next-intl" and populate messages/en.json with clean structured keys for every user-visible string (keep Northstar as brand name).
3. Call \`prepare\` and \`apply\` to translate all extracted strings into "de" and "es-MX" (messages/de.json and messages/es-MX.json).
4. Call \`check\` repeatedly until outcome is "PASS" with 0 errors.
Reply DONE.`;

  const codexRes = await runCodexWithPolyglot({
    stageName: "synthetic-extraction",
    label: "nextjs-unlocalized-extract",
    sourceDir: extractionApp.appDir,
    prompt: extractPrompt,
    captureRelPaths: [
      "src/components/StudioDashboard.tsx",
      "messages/en.json",
      "messages/de.json",
      "messages/es-MX.json",
    ],
    ignoreSpendCap,
    workspaceSetupFn: (tmpDir) => seedPolyglotProject(tmpDir, ["de", "es-MX"], PILOT_GLOSSARY),
  });

  const verifyDir = path.join(EVAL_ROOT, "work", "extract-verify");
  fs.rmSync(verifyDir, { recursive: true, force: true });
  fs.cpSync(extractionApp.appDir, verifyDir, { recursive: true });
  seedPolyglotProject(verifyDir, ["de", "es-MX"], PILOT_GLOSSARY);
  materializeCapturedFiles(codexRes, verifyDir);

  const checkDe = parsePolyglotJson(runPolyglotCli(verifyDir, ["check", "--locale", "de", "--json"]));
  const checkEs = parsePolyglotJson(runPolyglotCli(verifyDir, ["check", "--locale", "es-MX", "--json"]));

  // Check TypeScript compilation using repo's tsc with minimal ambient declarations for react & next-intl
  fs.writeFileSync(
    path.join(verifyDir, "src", "eval-shims.d.ts"),
    `declare module "react" {
  export function useState<T>(init: T): [T, (v: T) => void];
}
declare module "react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}
declare module "next-intl" {
  export function useTranslations(ns?: string): (key: string, values?: Record<string, unknown>) => string;
}
declare namespace JSX {
  interface IntrinsicElements { [elemName: string]: any; }
}
`
  );

  let tscPassed = false;
  let tscOutput = "";
  try {
    const tscBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
    execFileSync(tscBin, ["--noEmit", "-p", path.join(verifyDir, "tsconfig.json")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    tscPassed = true;
  } catch (err) {
    tscPassed = false;
    tscOutput = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().slice(0, 800);
  }

  const enPath = path.join(verifyDir, "messages", "en.json");
  const extractedEn = fs.existsSync(enPath) ? flattenJson(JSON.parse(fs.readFileSync(enPath, "utf8"))) : {};
  const runnerApiUnchanged =
    fs.readFileSync(path.join(verifyDir, "src/lib/runnerApi.ts"), "utf8") ===
    fs.readFileSync(path.join(extractionApp.appDir, "src/lib/runnerApi.ts"), "utf8");

  console.log(
    `[Extraction agent] exit=${codexRes.exitCode} extractedKeys=${Object.keys(extractedEn).length} tscPassed=${tscPassed} checkDe=${checkDe?.outcome} checkEs=${checkEs?.outcome} runnerApiUnchanged=${runnerApiUnchanged}`
  );

  return {
    scanner: {
      totalCandidatesFound: candidateTexts.length,
      expectedCount: extractionApp.expected.length,
      expectedFound,
      recall,
      approxPrecision: precision,
      missedExpected,
      mustNotFlagCount: extractionApp.mustNotFlag.length,
      technicalFalsePositives: mustNotFlagged,
      flaggedTechnical,
    },
    agentWorkflow: {
      exitCode: codexRes.exitCode,
      wallMs: codexRes.wallMs,
      telemetry: normalizeTelemetryPer1k(codexRes.telemetry, Math.max(1, Object.keys(extractedEn).length)),
      extractedKeyCount: Object.keys(extractedEn).length,
      runnerApiUnchanged,
      tscPassed,
      tscOutput,
      polyglotCheck: {
        de: { outcome: checkDe?.outcome, errorCount: checkDe?.errorCount, warningCount: checkDe?.warningCount },
        "es-MX": { outcome: checkEs?.outcome, errorCount: checkEs?.errorCount, warningCount: checkEs?.warningCount },
      },
    },
  };
}

export async function runSyntheticStage({ ignoreSpendCap = false, onlyApp = null, judgeMode = "all" } = {}) {
  console.log("=== Stage 3A: Synthetic Apps Benchmark (4 stacks x 5 langs + A0 + B+ctx + A-compact + Extraction) ===");
  const pilotApp = buildPilotApp();
  const others = buildAllSyntheticApps();

  const apps = [
    {
      id: "nextjs-commerce",
      stack: "next-intl",
      format: "json",
      dir: pilotApp.appDir,
      sourceRel: "messages/en.json",
      targetPathFn: (loc) => `messages/${loc}.json`,
      pseudoRel: "messages/en-x-pseudo.json",
      items: PILOT_ITEMS,
      flatEn: pilotApp.flatEn,
      components: pilotApp.components,
      glossary: PILOT_GLOSSARY,
      renderHtml: (loc, flat) => renderPilotAppHtml(loc, flat),
      runCompactOnLocales: ["es-MX", "de"],
    },
    {
      id: "vue-dashboard",
      stack: "vue-i18n",
      format: "json",
      dir: others.vue.appDir,
      sourceRel: "locales/en.json",
      targetPathFn: (loc) => `locales/${loc}.json`,
      pseudoRel: "locales/en-x-pseudo.json",
      items: others.vue.items,
      flatEn: others.vue.flatEn,
      components: others.vue.components,
      glossary: others.vue.glossary,
      renderHtml: (loc, flat) => renderGenericSyntheticHtml("PulseGrid Vue Dashboard", loc, others.vue.items, flat),
      runCompactOnLocales: [],
    },
    {
      id: "rails-portal",
      stack: "rails",
      format: "yaml",
      dir: others.rails.appDir,
      sourceRel: "config/locales/en.yml",
      targetPathFn: (loc) => `config/locales/${loc}.yml`,
      pseudoRel: "config/locales/en-x-pseudo.yml",
      items: others.rails.items,
      flatEn: others.rails.flatEn,
      components: others.rails.components,
      glossary: others.rails.glossary,
      renderHtml: (loc, flat) => renderGenericSyntheticHtml("Northstar Rails Portal", loc, others.rails.items, flat),
      runCompactOnLocales: [],
    },
    {
      id: "django-clinic",
      stack: "django",
      format: "po",
      dir: others.django.appDir,
      sourceRel: "locale/en/LC_MESSAGES/django.po",
      targetPathFn: (loc) => `locale/${loc.replace(/-/g, "_")}/LC_MESSAGES/django.po`,
      pseudoRel: null,
      items: others.django.items,
      flatEn: others.django.flatEn,
      components: others.django.components,
      glossary: others.django.glossary,
      renderHtml: (loc, flat) => renderGenericSyntheticHtml("Northstar Django Clinic", loc, others.django.items, flat),
      runCompactOnLocales: [],
    },
  ].filter((a) => !onlyApp || a.id === onlyApp);

  const outPath = path.join(RESULTS_DIR, "synthetic.json");
  const out = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : { startedAt: new Date().toISOString(), apps: {}, aCompactComparison: {}, extraction: null };

  const deeplBefore = await getDeepLUsage();
  console.log(`[DeepL before synthetic] ${deeplBefore.character_count} / ${deeplBefore.character_limit} (remaining ${deeplBefore.remaining})`);

  let seedCounter = 1000;

  for (const appSpec of apps) {
    out.apps[appSpec.id] = out.apps[appSpec.id] ?? { stack: appSpec.stack, format: appSpec.format, itemCount: appSpec.items.length, locales: {} };
    const compByBase = {};
    for (const [rel, code] of Object.entries(appSpec.components)) {
      compByBase[path.basename(rel)] = code;
    }
    const contextByKey = buildContextMapForApp(appSpec.items, compByBase);

    for (const locale of ALL_LANGUAGES) {
      seedCounter += 37;
      console.log(`\n--- Synthetic [${appSpec.id} / ${appSpec.stack}] -> ${locale} ---`);
      const localeGlossary = extractGlossaryForLocale(appSpec.glossary, locale);
      const { promptA, promptA0, promptACompact } = buildPromptsForApp(appSpec, locale);
      const targetRel = appSpec.targetPathFn(locale);
      const capturePaths = [targetRel, ".polyglot/records.json"];
      if (appSpec.pseudoRel) capturePaths.push(appSpec.pseudoRel);

      // 1. System A: Codex + Polyglot MCP
      const resA = await runCodexWithPolyglot({
        stageName: `synthetic-${appSpec.id}`,
        label: `${appSpec.id}-A-${locale}`,
        sourceDir: appSpec.dir,
        prompt: promptA,
        captureRelPaths: capturePaths,
        ignoreSpendCap,
        workspaceSetupFn: (tmpDir) => seedPolyglotProject(tmpDir, [locale], appSpec.glossary),
      });
      const workA = path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-A-${locale}`);
      fs.rmSync(workA, { recursive: true, force: true });
      fs.cpSync(appSpec.dir, workA, { recursive: true });
      seedPolyglotProject(workA, [locale], appSpec.glossary);
      materializeCapturedFiles(resA, workA);
      const flatA = readTargetCatalog(appSpec, workA, locale);
      const checkA = parsePolyglotJson(runPolyglotCli(workA, ["check", "--locale", locale, "--json"]));

      // Pseudo-locale for visual QA
      let flatPseudo = {};
      if (appSpec.pseudoRel) {
        const pseudoAbs = path.join(workA, appSpec.pseudoRel);
        if (!fs.existsSync(pseudoAbs)) runPolyglotCli(workA, ["pseudo"]);
        if (fs.existsSync(pseudoAbs)) {
          flatPseudo =
            appSpec.format === "yaml"
              ? parseYamlCatalog(fs.readFileSync(pseudoAbs, "utf8"), "en-x-pseudo")
              : flattenJson(JSON.parse(fs.readFileSync(pseudoAbs, "utf8")));
        }
      }

      // 2. System A0: Codex CLI with NO Polyglot MCP (Change #1)
      const resA0 = await runCodexNoPolyglot({
        stageName: `synthetic-${appSpec.id}`,
        label: `${appSpec.id}-A0-${locale}`,
        sourceDir: appSpec.dir,
        prompt: promptA0,
        captureRelPaths: [targetRel],
        ignoreSpendCap,
      });
      const workA0 = path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-A0-${locale}`);
      fs.rmSync(workA0, { recursive: true, force: true });
      fs.cpSync(appSpec.dir, workA0, { recursive: true });
      materializeCapturedFiles(resA0, workA0);
      const flatA0 = readTargetCatalog(appSpec, workA0, locale);
      const checkA0 = runCheckOnFlat(appSpec, locale, flatA0, `syn-${appSpec.id}-checkA0-${locale}`);

      // 3. System B: DeepL (with fixed recursive ICU + paired <rt> + cleaned glossaries)
      const resB = await translateCatalogWithDeepL({
        stageName: `synthetic-${appSpec.id}`,
        targetLocale: locale,
        sourceMap: appSpec.flatEn,
        glossaryName: `syn-${appSpec.id}`,
        glossaryEntries: localeGlossary,
        stageCharCap: DEEPL_STAGE_CHAR_CAP,
      });
      const flatB = resB.translations;
      const checkC_onB = runCheckOnFlat(appSpec, locale, flatB, `syn-${appSpec.id}-C-${locale}`);

      // 4. System B+ctx: DeepL with `context` parameter (~300 chars, Change #2)
      const resBctx = await translateCatalogWithDeepL({
        stageName: `synthetic-${appSpec.id}`,
        targetLocale: locale,
        sourceMap: appSpec.flatEn,
        glossaryName: `syn-${appSpec.id}`,
        glossaryEntries: localeGlossary,
        contextByKey,
        stageCharCap: DEEPL_STAGE_CHAR_CAP,
      });
      const flatBctx = resBctx.translations;
      const checkC_onBctx = runCheckOnFlat(appSpec, locale, flatBctx, `syn-${appSpec.id}-Cctx-${locale}`);

      // 5. Deterministic metrics
      const detA = computeCatalogMetrics(appSpec.flatEn, flatA, localeGlossary);
      const detA0 = computeCatalogMetrics(appSpec.flatEn, flatA0, localeGlossary);
      const detB = computeCatalogMetrics(appSpec.flatEn, flatB, localeGlossary);
      const detBctx = computeCatalogMetrics(appSpec.flatEn, flatBctx, localeGlossary);

      // 6. Playwright Visual QA
      const htmlMap = {
        en: appSpec.renderHtml("en", appSpec.flatEn),
        [locale]: appSpec.renderHtml(locale, flatA),
      };
      if (Object.keys(flatPseudo).length > 0) {
        htmlMap["en-x-pseudo"] = appSpec.renderHtml("en-x-pseudo", flatPseudo);
      }
      const visA = await inspectVisualLayout({
        appName: `syn-${appSpec.id}`,
        systemLabel: "A",
        screenshotDir: SCREENSHOTS_DIR,
        htmlByLocale: htmlMap,
      });
      const visA0 = await inspectVisualLayout({
        appName: `syn-${appSpec.id}`,
        systemLabel: "A0",
        screenshotDir: SCREENSHOTS_DIR,
        htmlByLocale: { [locale]: appSpec.renderHtml(locale, flatA0) },
      });
      const visB = await inspectVisualLayout({
        appName: `syn-${appSpec.id}`,
        systemLabel: "B",
        screenshotDir: SCREENSHOTS_DIR,
        htmlByLocale: { [locale]: appSpec.renderHtml(locale, flatB) },
      });
      const visBctx = await inspectVisualLayout({
        appName: `syn-${appSpec.id}`,
        systemLabel: "Bctx",
        screenshotDir: SCREENSHOTS_DIR,
        htmlByLocale: { [locale]: appSpec.renderHtml(locale, flatBctx) },
      });

      // 7. Blinded 4-way Dual-Judge Panel (A, A0, B, Bctx) on 100% of items + 9 planted controls
      const judgeItems = appSpec.items.map((item) => ({
        key: item.key,
        source: item.source,
        category: item.category,
        isChallenge: item.category !== "general",
        componentCode: compByBase[item.component] ?? "",
        context: `${item.component} (${item.category})`,
        intendedSense: item.intendedSense,
        glossaryHits: localeGlossary.filter((g) =>
          new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(
            item.source
          )
        ),
        candidates: {
          A: flatA[item.key] ?? "",
          A0: flatA0[item.key] ?? "",
          B: flatB[item.key] ?? "",
          Bctx: flatBctx[item.key] ?? "",
        },
      }));

      console.log(
        `  [${appSpec.id}:${locale}] A(err=${checkA?.errorCount},wall=${(resA.wallMs / 1000).toFixed(1)}s) A0(err=${checkA0?.errorCount},wall=${(resA0.wallMs / 1000).toFixed(1)}s) B(err=${checkC_onB?.errorCount},glos=${resB.usedGlossary}) B+ctx(err=${checkC_onBctx?.errorCount}) -> judging ${judgeItems.length} items (4-way)...`
      );

      const existingJudging = out.apps[appSpec.id]?.locales?.[locale]?.judging ?? null;
      let judging = existingJudging;
      if (judgeMode !== "none" && (!existingJudging || existingJudging.partialJudgeMode)) {
        judging = await runDualJudgeEvaluation({
          stageName: `synthetic-${appSpec.id}`,
          targetLocale: locale,
          items: judgeItems,
          concurrency: 8,
          seed: seedCounter,
          ignoreSpendCap,
          includeSubtleControls: true,
          judgeMode,
        });
      }

      if (judging) {
        console.log(
          `  [judged ${appSpec.id}:${locale}] kappa=${judging.validation.agreement.kappa} wins=${JSON.stringify(judging.panel.wins)} sense=${JSON.stringify(Object.fromEntries(Object.entries(judging.senseAccuracy).map(([k, v]) => [k, v.mean])))}`
        );
      }

      out.apps[appSpec.id].locales[locale] = {
        systemA: {
          exitCode: resA.exitCode,
          wallMs: resA.wallMs,
          cacheHit: resA.cacheHit,
          estimatedApiUsd: resA.estimatedApiUsd,
          telemetry: normalizeTelemetryPer1k(resA.telemetry, appSpec.items.length),
          polyglotCheck: {
            outcome: checkA?.outcome,
            errorCount: checkA?.errorCount,
            warningCount: checkA?.warningCount,
            countsByCode: checkA?.countsByCode,
          },
          deterministicMetrics: detA,
          visualDefects: visA.available ? visA.locales[locale]?.totalDefects ?? null : null,
          visualPseudoDefects: visA.available ? visA.locales["en-x-pseudo"]?.totalDefects ?? null : null,
          screenshotPath: visA.available ? visA.locales[locale]?.screenshotPath ?? null : null,
          pseudoScreenshotPath: visA.available ? visA.locales["en-x-pseudo"]?.screenshotPath ?? null : null,
        },
        systemA0: {
          exitCode: resA0.exitCode,
          wallMs: resA0.wallMs,
          cacheHit: resA0.cacheHit,
          estimatedApiUsd: resA0.estimatedApiUsd,
          telemetry: normalizeTelemetryPer1k(resA0.telemetry, appSpec.items.length),
          polyglotCheck: {
            outcome: checkA0?.outcome,
            errorCount: checkA0?.errorCount,
            warningCount: checkA0?.warningCount,
            countsByCode: checkA0?.countsByCode,
          },
          deterministicMetrics: detA0,
          visualDefects: visA0.available ? visA0.locales[locale]?.totalDefects ?? null : null,
          screenshotPath: visA0.available ? visA0.locales[locale]?.screenshotPath ?? null : null,
        },
        systemB: {
          wallMs: resB.wallMs,
          liveChars: resB.liveChars,
          cacheHits: resB.cacheHits,
          usedGlossary: resB.usedGlossary,
          formality: resB.formality,
          deterministicMetrics: detB,
          polyglotCheck: {
            outcome: checkC_onB?.outcome,
            errorCount: checkC_onB?.errorCount,
            warningCount: checkC_onB?.warningCount,
            countsByCode: checkC_onB?.countsByCode,
          },
          visualDefects: visB.available ? visB.locales[locale]?.totalDefects ?? null : null,
          screenshotPath: visB.available ? visB.locales[locale]?.screenshotPath ?? null : null,
        },
        systemBctx: {
          wallMs: resBctx.wallMs,
          liveChars: resBctx.liveChars,
          cacheHits: resBctx.cacheHits,
          usedGlossary: resBctx.usedGlossary,
          formality: resBctx.formality,
          deterministicMetrics: detBctx,
          polyglotCheck: {
            outcome: checkC_onBctx?.outcome,
            errorCount: checkC_onBctx?.errorCount,
            warningCount: checkC_onBctx?.warningCount,
            countsByCode: checkC_onBctx?.countsByCode,
          },
          visualDefects: visBctx.available ? visBctx.locales[locale]?.totalDefects ?? null : null,
          screenshotPath: visBctx.available ? visBctx.locales[locale]?.screenshotPath ?? null : null,
        },
        judging,
      };

      // 8. System A-compact variant (Change #5) on nextjs-commerce es-MX & de
      if (appSpec.runCompactOnLocales.includes(locale)) {
        console.log(`  --- Running A-compact (prepare limit=100 -> apply -> check) for ${appSpec.id}:${locale} ---`);
        const resCompact = await runCodexWithPolyglot({
          mode: "A-compact",
          stageName: `synthetic-${appSpec.id}-compact`,
          label: `${appSpec.id}-Acompact-${locale}`,
          sourceDir: appSpec.dir,
          prompt: promptACompact,
          captureRelPaths: [targetRel, ".polyglot/records.json"],
          ignoreSpendCap,
          workspaceSetupFn: (tmpDir) => seedPolyglotProject(tmpDir, [locale], appSpec.glossary),
        });
        const workC = path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-Acompact-${locale}`);
        fs.rmSync(workC, { recursive: true, force: true });
        fs.cpSync(appSpec.dir, workC, { recursive: true });
        seedPolyglotProject(workC, [locale], appSpec.glossary);
        materializeCapturedFiles(resCompact, workC);
        const flatCompact = readTargetCatalog(appSpec, workC, locale);
        const checkCompact = parsePolyglotJson(runPolyglotCli(workC, ["check", "--locale", locale, "--json"]));
        const detCompact = computeCatalogMetrics(appSpec.flatEn, flatCompact, localeGlossary);

        const compactJudgeItems = appSpec.items.map((item) => ({
          key: item.key,
          source: item.source,
          category: item.category,
          isChallenge: item.category !== "general",
          componentCode: compByBase[item.component] ?? "",
          context: `${item.component} (${item.category})`,
          intendedSense: item.intendedSense,
          glossaryHits: localeGlossary.filter((g) =>
            new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(
              item.source
            )
          ),
          candidates: {
            A: flatA[item.key] ?? "",
            Acompact: flatCompact[item.key] ?? "",
          },
        }));

        const existingCompactJudging = out.aCompactComparison?.[`${appSpec.id}:${locale}`]?.judging ?? null;
        let compactJudging = existingCompactJudging;
        if (judgeMode !== "none" && (!existingCompactJudging || existingCompactJudging.partialJudgeMode)) {
          compactJudging = await runDualJudgeEvaluation({
            stageName: `synthetic-${appSpec.id}-compact`,
            targetLocale: locale,
            items: compactJudgeItems,
            concurrency: 8,
            seed: seedCounter + 9,
            ignoreSpendCap,
            includeSubtleControls: false,
            judgeMode,
          });
        }

        out.aCompactComparison[`${appSpec.id}:${locale}`] = {
          fullA: {
            wallMs: resA.wallMs,
            telemetry: normalizeTelemetryPer1k(resA.telemetry, appSpec.items.length),
            polyglotCheckOutcome: checkA?.outcome,
          },
          compactA: {
            exitCode: resCompact.exitCode,
            wallMs: resCompact.wallMs,
            telemetry: normalizeTelemetryPer1k(resCompact.telemetry, appSpec.items.length),
            polyglotCheck: {
              outcome: checkCompact?.outcome,
              errorCount: checkCompact?.errorCount,
              warningCount: checkCompact?.warningCount,
            },
            deterministicMetrics: detCompact,
          },
          judging: compactJudging,
        };
      }

      // Persist incrementally after every app+locale
      atomicWriteJson(outPath, out);
    }
  }

  // Run Extraction Test if running full synthetic stage (or explicitly requested)
  if (!onlyApp || onlyApp === "nextjs-unlocalized") {
    out.extraction = await runExtractionBenchmark(others.extraction, { ignoreSpendCap });
  }

  const deeplAfter = await getDeepLUsage();
  out.deeplBefore = deeplBefore;
  out.deeplAfter = deeplAfter;
  out.deeplStageDeltaChars = deeplAfter.character_count - deeplBefore.character_count;
  out.glossaryDeletionLog = getGlossaryDeletionLog();
  out.finishedAt = new Date().toISOString();
  atomicWriteJson(outPath, out);

  console.log(
    `\n=== Stage 3A Synthetic Complete | DeepL delta=${out.deeplStageDeltaChars} chars (${deeplAfter.character_count}/${deeplAfter.character_limit}) ===`
  );
  return out;
}
