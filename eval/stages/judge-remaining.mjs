import fs from "node:fs";
import path from "node:path";
import { ALL_LANGUAGES, CORPORA_DIR, DOCX_OUT_DIR, EVAL_ROOT, RESULTS_DIR } from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import { inspectDocxStructure } from "../lib/docx-eval.mjs";
import { runDualJudgeEvaluation } from "../lib/judges.mjs";
import { buildPilotApp, PILOT_GLOSSARY, PILOT_ITEMS } from "../synthetic/build-pilot-app.mjs";
import { buildAllSyntheticApps } from "../synthetic/build-all-synthetic.mjs";
import { buildAllDocxCorpus } from "../docx/build-all-docx.mjs";
import { ensureOssRepoCloned, OSS_REPOS, stratifiedSampleKeys } from "../corpora/fetch-oss.mjs";
import { discoverOssRepoCatalog } from "./oss.mjs";
import {
  extractGlossaryForLocale,
  flattenJson,
  parsePoCatalog,
  parseYamlCatalog,
} from "./common.mjs";

const DOCX_LOW_CONFIDENCE_NOTE =
  "LOW-CONFIDENCE JUDGE VERDICT (Pilot DOCX κ = 0.34, Claude flip rate = 35%): treat DOCX judge preferences as secondary; primary DOCX conclusions rest on deterministic OOXML structure preservation, LibreOffice rendering, source-text leakage, and incremental-update integrity.";

function readCat(format, dir, rel, locale) {
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return {};
  const txt = fs.readFileSync(abs, "utf8");
  if (format === "yaml") return parseYamlCatalog(txt, locale);
  if (format === "po") return parsePoCatalog(txt);
  try {
    return flattenJson(JSON.parse(txt));
  } catch {
    return {};
  }
}

function pickSampleIndices(total, maxCount = 15) {
  if (total <= maxCount) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (let i = 0; i < maxCount; i++) out.push(Math.floor((i * total) / maxCount));
  return [...new Set(out)];
}

/**
 * Saturate all 16 Gemini + 12 Claude workers concurrently across EVERY remaining unjudged
 * (app x locale) / DOCX / OSS / replay pair with zero Playwright or Wraith re-runs.
 */
export async function runJudgeRemaining({ scopes = ["synthetic", "docx", "oss", "replay"], ignoreSpendCap = false, judgeMode = "all" } = {}) {
  console.log(`=== Fast Parallel Judge Finisher | scopes=[${scopes.join(",")}] judgeMode=${judgeMode} ===`);
  const tasks = [];

  // 1. Synthetic remaining pairs
  let synPath = path.join(RESULTS_DIR, "synthetic.json");
  let synData = scopes.includes("synthetic") && fs.existsSync(synPath) ? JSON.parse(fs.readFileSync(synPath, "utf8")) : null;
  if (synData) {
    const pilotApp = buildPilotApp();
    const others = buildAllSyntheticApps();
    const appSpecs = [
      { id: "nextjs-commerce", format: "json", targetPathFn: (l) => `messages/${l}.json`, items: PILOT_ITEMS, components: pilotApp.components, glossary: PILOT_GLOSSARY },
      { id: "vue-dashboard", format: "json", targetPathFn: (l) => `locales/${l}.json`, items: others.vue.items, components: others.vue.components, glossary: others.vue.glossary },
      { id: "rails-portal", format: "yaml", targetPathFn: (l) => `config/locales/${l}.yml`, items: others.rails.items, components: others.rails.components, glossary: others.rails.glossary },
      { id: "django-clinic", format: "po", targetPathFn: (l) => `locale/${l.replace(/-/g, "_")}/LC_MESSAGES/django.po`, items: others.django.items, components: others.django.components, glossary: others.django.glossary },
    ];

    let seedCounter = 1000;
    for (const appSpec of appSpecs) {
      const compByBase = {};
      for (const [rel, code] of Object.entries(appSpec.components)) compByBase[path.basename(rel)] = code;
      for (const locale of ALL_LANGUAGES) {
        seedCounter += 37;
        const slot = synData.apps?.[appSpec.id]?.locales?.[locale];
        if (!slot || (slot.judging && !slot.judging.partialJudgeMode)) continue;

        const rel = appSpec.targetPathFn(locale);
        const flatA = readCat(appSpec.format, path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-A-${locale}`), rel, locale);
        const flatA0 = readCat(appSpec.format, path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-A0-${locale}`), rel, locale);
        const flatB = readCat(appSpec.format, path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-C-${locale}`), rel, locale);
        const flatBctx = readCat(appSpec.format, path.join(EVAL_ROOT, "work", `syn-${appSpec.id}-Cctx-${locale}`), rel, locale);
        const localeGlossary = extractGlossaryForLocale(appSpec.glossary, locale);

        const judgeItems = appSpec.items.map((item) => ({
          key: item.key,
          source: item.source,
          category: item.category,
          isChallenge: item.category !== "general",
          componentCode: compByBase[item.component] ?? "",
          context: `${item.component} (${item.category})`,
          intendedSense: item.intendedSense,
          glossaryHits: localeGlossary.filter((g) =>
            new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(item.source)
          ),
          candidates: {
            A: flatA[item.key] ?? "",
            A0: flatA0[item.key] ?? "",
            B: flatB[item.key] ?? "",
            Bctx: flatBctx[item.key] ?? "",
          },
        }));

        const mySeed = seedCounter;
        tasks.push(async () => {
          console.log(`[start] synthetic:${appSpec.id}:${locale} (${judgeItems.length} items)`);
          const res = await runDualJudgeEvaluation({
            stageName: `synthetic-${appSpec.id}`,
            targetLocale: locale,
            items: judgeItems,
            concurrency: 28,
            seed: mySeed,
            ignoreSpendCap,
            includeSubtleControls: true,
            judgeMode,
          });
          synData.apps[appSpec.id].locales[locale].judging = res;
          atomicWriteJson(synPath, synData);
          console.log(`[done]  synthetic:${appSpec.id}:${locale} kappa=${res.validation.agreement.kappa} sense=${JSON.stringify(Object.fromEntries(Object.entries(res.senseAccuracy).map(([k, v]) => [k, v.mean])))}`);
        });
      }
    }
  }

  // 2. DOCX remaining docs (15 segments each, marked low-confidence)
  let docxPath = path.join(RESULTS_DIR, "docx.json");
  let docxData = scopes.includes("docx") && fs.existsSync(docxPath) ? JSON.parse(fs.readFileSync(docxPath, "utf8")) : null;
  if (docxData) {
    const allDocs = buildAllDocxCorpus();
    let seed = 4000;
    for (const docSpec of allDocs) {
      seed += 41;
      const slot = docxData.documents?.[docSpec.id];
      if (!slot || (slot.judging && !slot.judging.partialJudgeMode)) continue;
      const locale = docSpec.targetLocale;
      const docxOutA = slot.systemA?.outputPath;
      const docxOutB = slot.systemB?.outputPath;
      if (!docxOutA || !docxOutB || !fs.existsSync(docxOutA) || !fs.existsSync(docxOutB)) continue;

      const srcStruct = inspectDocxStructure(docSpec.path);
      const structA = inspectDocxStructure(docxOutA);
      const structB = inspectDocxStructure(docxOutB);
      const localeGlossary = extractGlossaryForLocale(docSpec.glossary, locale);
      const commonN = Math.min(srcStruct.visibleParagraphs.length, structA.visibleParagraphs.length, structB.visibleParagraphs.length);
      const idxs = pickSampleIndices(commonN, 15);
      const items = idxs.map((i) => ({
        key: `${docSpec.id}-p${i + 1}`,
        source: srcStruct.visibleParagraphs[i],
        category: "docx-segment",
        isChallenge: false,
        context: `${docSpec.id}.docx paragraph ${i + 1}`,
        glossaryHits: localeGlossary.filter((g) =>
          new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(srcStruct.visibleParagraphs[i])
        ),
        intendedSense: null,
        candidates: { A: structA.visibleParagraphs[i], B: structB.visibleParagraphs[i] },
      }));

      const mySeed = seed;
      tasks.push(async () => {
        console.log(`[start] docx:${docSpec.id}:${locale} (${items.length} segments)`);
        const res = await runDualJudgeEvaluation({
          stageName: `docx-${docSpec.id}`,
          targetLocale: locale,
          items,
          concurrency: 28,
          seed: mySeed,
          ignoreSpendCap,
          includeSubtleControls: true,
          lowConfidenceNote: DOCX_LOW_CONFIDENCE_NOTE,
        });
        docxData.documents[docSpec.id].judging = res;
        atomicWriteJson(docxPath, docxData);
        console.log(`[done]  docx:${docSpec.id}:${locale} kappa=${res.validation.agreement.kappa} wins=${JSON.stringify(res.panel.wins)}`);
      });
    }
  }

  // 3. OSS remaining repo x locale pairs (40 stratified strings each, A, A0, B, H)
  let ossPath = path.join(RESULTS_DIR, "oss.json");
  let ossData = scopes.includes("oss") && fs.existsSync(ossPath) ? JSON.parse(fs.readFileSync(ossPath, "utf8")) : null;
  if (ossData) {
    let seed = 7000;
    for (const repo of OSS_REPOS) {
      seed += 101;
      const repoEntry = ossData.repos?.[repo.id];
      if (!repoEntry) continue;
      const cloneDir = path.join(CORPORA_DIR, repo.id);
      if (!fs.existsSync(cloneDir)) continue;
      const discovered = discoverOssRepoCatalog(repo, cloneDir);
      const workSrc = path.join(EVAL_ROOT, "work", `oss-src-${repo.id}`);
      const sourceRel = repo.format === "yaml" ? "config/locales/en.yml" : repo.format === "po" ? "locale/en/LC_MESSAGES/django.po" : "messages/en.json";
      const targetPathFn =
        repo.format === "yaml"
          ? (loc) => `config/locales/${loc}.yml`
          : repo.format === "po"
            ? (loc) => `locale/${loc.replace(/-/g, "_")}/LC_MESSAGES/django.po`
            : (loc) => `messages/${loc}.json`;

      let sampledEnMap = readCat(repo.format, workSrc, sourceRel, "en");
      if (repo.format === "po") {
        // In PO skeleton, msgstr is empty so use msgid as source
        const fixed = {};
        for (const k of Object.keys(sampledEnMap)) fixed[k] = k;
        sampledEnMap = fixed;
      }
      const sampledKeys = Object.keys(sampledEnMap).sort();

      const availLocales = ALL_LANGUAGES.filter((l) => Boolean(repoEntry.locales?.[l]));
      for (const locale of availLocales) {
        seed += 29;
        const slot = repoEntry.locales[locale];
        if (slot.judging && !slot.judging.partialJudgeMode) continue;
        const hInfo = discovered.humanLocales[locale];
        if (!hInfo) continue;
        const rawH = fs.readFileSync(path.join(cloneDir, hInfo.rel), "utf8");
        const humanMap = repo.format === "po" ? parsePoCatalog(rawH) : discovered.parseFn(rawH);

        const targetRel = targetPathFn(locale);
        const flatA = readCat(repo.format, path.join(EVAL_ROOT, "work", `oss-${repo.id}-A-${locale}`), targetRel, locale);
        const flatA0 = readCat(repo.format, path.join(EVAL_ROOT, "work", `oss-${repo.id}-A0-${locale}`), targetRel, locale);
        const flatB = readCat(repo.format, path.join(EVAL_ROOT, "work", `oss-${repo.id}-C-${locale}`), targetRel, locale);

        const keysWithH = sampledKeys.filter((k) => Boolean(humanMap[k]));
        const hPool = Object.fromEntries(keysWithH.map((k) => [k, sampledEnMap[k]]));
        const judgedKeys = stratifiedSampleKeys(hPool, { limit: 40, seed: seed + 13 });
        const judgeItems = judgedKeys.map((k) => ({
          key: k,
          source: sampledEnMap[k],
          category: "oss-catalog",
          isChallenge: false,
          context: `${repo.id} (${repo.stack}) key=${k}`,
          intendedSense: null,
          glossaryHits: [],
          candidates: {
            A: flatA[k] ?? "",
            A0: flatA0[k] ?? "",
            B: flatB[k] ?? "",
            H: humanMap[k] ?? "",
          },
        }));

        const mySeed = seed + 17;
        tasks.push(async () => {
          console.log(`[start] oss:${repo.id}:${locale} (${judgeItems.length} items)`);
          const res = await runDualJudgeEvaluation({
            stageName: `oss-${repo.id}`,
            targetLocale: locale,
            items: judgeItems,
            concurrency: 28,
            seed: mySeed,
            ignoreSpendCap,
            includeSubtleControls: true,
            judgeMode,
          });
          ossData.repos[repo.id].locales[locale].judging = res;
          atomicWriteJson(ossPath, ossData);
          console.log(`[done]  oss:${repo.id}:${locale} kappa=${res.validation.agreement.kappa} wins=${JSON.stringify(res.panel.wins)} humanLast=${JSON.stringify(res.validation.humanAnchorLastRate)}`);
        });
      }
    }
  }

  console.log(`Launching ${tasks.length} unjudged evaluation groups concurrently across shared 16-Gemini / 12-Claude worker pool...`);
  const t0 = Date.now();
  await Promise.all(tasks.map((fn) => fn()));
  console.log(`=== Fast Parallel Judge Finisher COMPLETE (${tasks.length} groups in ${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
}
