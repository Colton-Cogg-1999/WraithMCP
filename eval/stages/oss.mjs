import fs from "node:fs";
import path from "node:path";
import {
  ALL_LANGUAGES,
  DEEPL_STAGE_CHAR_CAP,
  EVAL_ROOT,
  RESULTS_DIR,
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
import { computeCatalogMetrics, corpusChrF } from "../lib/metrics.mjs";
import {
  ensureOssRepoCloned,
  findPostCutoffKeys,
  flattenObject,
  OSS_REPOS,
  saveCorporaManifest,
  stratifiedSampleKeys,
} from "../corpora/fetch-oss.mjs";
import {
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

const LOCALE_CANDIDATES = {
  "es-MX": ["es-MX", "es_MX", "es-419", "es", "es-ES", "es_ES"],
  de: ["de", "de-DE", "de_DE"],
  ja: ["ja", "ja-JP", "ja_JP"],
  ar: ["ar", "ar-SA", "ar_SA"],
  pl: ["pl", "pl-PL", "pl_PL"],
};

function findFilesMatching(rootDir, predicate, maxDepth = 5, maxResults = 300) {
  const results = [];
  const skipDirs = new Set([".git", "node_modules", "dist", "build", ".next", "vendor", "test", "tests", "__tests__"]);
  const walk = (dir, depth) => {
    if (depth > maxDepth || results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
        if (predicate(rel, e.name)) results.push(rel);
      }
    }
  };
  walk(rootDir, 0);
  return results;
}

/**
 * Inspect each cloned OSS repo to locate its English source catalog, available human target catalogs,
 * and source code roots, plus probe Polyglot's out-of-the-box monorepo DX (`init` + `status`).
 */
export function discoverOssRepoCatalog(repo, repoDir) {
  let sourceRel = null;
  let format = repo.format;
  let parseFn = (txt) => flattenObject(JSON.parse(txt));
  const humanLocales = {};
  let codeRoots = [];

  if (repo.id === "next-intl") {
    const candidates = [
      "examples/example-app-router/messages/en.json",
      "examples/example-app-router-playground/messages/en.json",
      ...findFilesMatching(repoDir, (rel, name) => name === "en.json" && rel.includes("messages"), 5),
    ];
    let best = null;
    for (const rel of candidates) {
      const abs = path.join(repoDir, rel);
      if (!fs.existsSync(abs)) continue;
      try {
        const flat = flattenObject(JSON.parse(fs.readFileSync(abs, "utf8")));
        const count = Object.keys(flat).length;
        if (!best || count > best.count) best = { rel, count };
      } catch {}
    }
    if (best) {
      sourceRel = best.rel;
      const msgDir = path.dirname(sourceRel);
      codeRoots = [path.join(path.dirname(msgDir), "src")];
      for (const loc of ALL_LANGUAGES) {
        for (const cand of LOCALE_CANDIDATES[loc]) {
          const p = path.join(msgDir, `${cand}.json`);
          if (fs.existsSync(path.join(repoDir, p))) {
            humanLocales[loc] = { rel: p, repoCode: cand };
            break;
          }
        }
      }
    }
  } else if (repo.id === "hoppscotch") {
    const candidates = [
      "packages/hoppscotch-common/locales/en.json",
      ...findFilesMatching(repoDir, (rel, name) => name === "en.json" && rel.includes("locales"), 4),
    ];
    sourceRel = candidates.find((c) => fs.existsSync(path.join(repoDir, c))) ?? null;
    if (sourceRel) {
      const locDir = path.dirname(sourceRel);
      codeRoots = [path.join(path.dirname(locDir), "src")];
      for (const loc of ALL_LANGUAGES) {
        for (const cand of LOCALE_CANDIDATES[loc]) {
          const p = path.join(locDir, `${cand}.json`);
          if (fs.existsSync(path.join(repoDir, p))) {
            humanLocales[loc] = { rel: p, repoCode: cand };
            break;
          }
        }
      }
    }
  } else if (repo.id === "immich") {
    const candidates = [
      "i18n/en.json",
      "web/src/lib/assets/i18n/en.json",
      ...findFilesMatching(repoDir, (rel, name) => name === "en.json" && rel.includes("i18n"), 5),
    ];
    sourceRel = candidates.find((c) => fs.existsSync(path.join(repoDir, c))) ?? null;
    if (sourceRel) {
      const locDir = path.dirname(sourceRel);
      codeRoots = ["web/src"];
      for (const loc of ALL_LANGUAGES) {
        for (const cand of LOCALE_CANDIDATES[loc]) {
          const p = path.join(locDir, `${cand}.json`);
          if (fs.existsSync(path.join(repoDir, p))) {
            humanLocales[loc] = { rel: p, repoCode: cand };
            break;
          }
        }
      }
    }
  } else if (repo.id === "mastodon") {
    const candidates = ["config/locales/en.yml", "config/locales/simple_form.en.yml"];
    sourceRel = candidates.find((c) => fs.existsSync(path.join(repoDir, c))) ?? null;
    format = "yaml";
    parseFn = (txt) => parseYamlCatalog(txt);
    if (sourceRel) {
      const locDir = path.dirname(sourceRel);
      codeRoots = ["app/views", "app/controllers", "app/models"];
      for (const loc of ALL_LANGUAGES) {
        for (const cand of LOCALE_CANDIDATES[loc]) {
          const p = path.join(locDir, `${cand}.yml`);
          if (fs.existsSync(path.join(repoDir, p))) {
            humanLocales[loc] = { rel: p, repoCode: cand };
            break;
          }
        }
      }
    }
  } else if (repo.id === "wagtail") {
    const candidates = [
      "wagtail/locale/en/LC_MESSAGES/django.po",
      "wagtail/admin/locale/en/LC_MESSAGES/django.po",
      ...findFilesMatching(repoDir, (rel, name) => name === "django.po" && rel.includes("/en/LC_MESSAGES/"), 5),
    ];
    let best = null;
    for (const rel of candidates) {
      const abs = path.join(repoDir, rel);
      if (!fs.existsSync(abs)) continue;
      const flat = parsePoCatalog(fs.readFileSync(abs, "utf8"));
      const count = Object.keys(flat).length;
      if (!best || count > best.count) best = { rel, count };
    }
    if (best) {
      sourceRel = best.rel;
      format = "po";
      parseFn = (txt) => {
        const m = parsePoCatalog(txt);
        // For English .po, msgstr may be empty -> fall back to msgid itself!
        const out = {};
        for (const [k, v] of Object.entries(m)) out[k] = v || k;
        return out;
      };
      const baseLocaleDir = sourceRel.replace(/\/en\/LC_MESSAGES\/django\.po$/, "");
      codeRoots = [path.dirname(baseLocaleDir)];
      for (const loc of ALL_LANGUAGES) {
        for (const cand of LOCALE_CANDIDATES[loc]) {
          const p = `${baseLocaleDir}/${cand}/LC_MESSAGES/django.po`;
          if (fs.existsSync(path.join(repoDir, p))) {
            humanLocales[loc] = { rel: p, repoCode: cand };
            break;
          }
        }
      }
    }
  }

  return { sourceRel, format, parseFn, humanLocales, codeRoots };
}

/**
 * Probe Polyglot's out-of-the-box setup DX on the real repo directory (without leaving .polyglot behind).
 */
function probeMonorepoSetupDx(repoDir, discovered) {
  const pgDir = path.join(repoDir, ".polyglot");
  const hadPg = fs.existsSync(pgDir);
  if (hadPg) return { skipped: true };
  try {
    const initRes = runPolyglotCli(repoDir, ["init", "-s", "en", "-t", "de", "--no-agent-rule"]);
    let configSnapshot = null;
    const cfgPath = path.join(pgDir, "config.json");
    if (fs.existsSync(cfgPath)) {
      configSnapshot = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    }
    const statusRes = runPolyglotCli(repoDir, ["status", "--json"]);
    const statusParsed = parsePolyglotJson(statusRes);
    const detectedFormat = configSnapshot?.format ?? null;
    const detectedLocalesDir = configSnapshot?.paths?.locales ?? null;
    const autoDetectedCorrectly =
      Boolean(discovered.sourceRel) &&
      Boolean(detectedLocalesDir) &&
      discovered.sourceRel.startsWith(String(detectedLocalesDir).replace(/^\.\//, ""));

    return {
      initExitCode: initRes.exitCode,
      detectedFramework: configSnapshot?.framework ?? null,
      detectedFormat,
      detectedSourcePaths: configSnapshot?.paths?.source ?? [],
      detectedLocalesPath: detectedLocalesDir,
      actualSourceCatalog: discovered.sourceRel,
      autoDetectedCorrectly,
      neededManualConfigPatch: !autoDetectedCorrectly,
      statusKeyCount: statusParsed?.sourceKeys ?? statusParsed?.totalKeys ?? null,
    };
  } finally {
    fs.rmSync(pgDir, { recursive: true, force: true });
  }
}

/**
 * Collect up to `maxFiles` real source files from the repo that reference sampled keys
 * so Codex + Polyglot can read genuine surrounding code context in a fast, isolated copy!
 */
function collectRelevantCodeFiles(repoDir, codeRoots, sampledKeys, maxFiles = 20) {
  const leafTokens = [...new Set(sampledKeys.map((k) => k.split(".").pop()).filter((t) => t && t.length >= 5))].slice(0, 80);
  const exts = new Set([".ts", ".tsx", ".vue", ".svelte", ".erb", ".rb", ".py", ".html", ".js", ".jsx"]);
  const matched = {};
  let count = 0;

  for (const rootRel of codeRoots) {
    const absRoot = path.join(repoDir, rootRel);
    if (!fs.existsSync(absRoot)) continue;
    const files = findFilesMatching(
      absRoot,
      (_rel, name) => exts.has(path.extname(name)),
      5,
      400
    );
    for (const rel of files) {
      if (count >= maxFiles) break;
      const abs = path.join(absRoot, rel);
      try {
        const stat = fs.statSync(abs);
        if (stat.size > 40_000) continue;
        const txt = fs.readFileSync(abs, "utf8");
        if (leafTokens.some((tok) => txt.includes(tok))) {
          const outRel = path.join("src_context", path.basename(rootRel), rel).replace(/\\/g, "/");
          matched[outRel] = txt;
          count++;
        }
      } catch {}
    }
  }
  return matched;
}

function makePoSkeletonFromMap(locale, sourceMap) {
  const esc = (s) =>
    String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  let out = `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"MIME-Version: 1.0\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Content-Transfer-Encoding: 8bit\\n"\n\n`;
  for (const [k, v] of Object.entries(sourceMap)) {
    out += `msgid "${esc(v)}"\nmsgstr ""\n\n`;
  }
  return out;
}

/**
 * Materialize an isolated, clean, Polyglot-compatible catalog workspace for a sampled OSS app.
 */
function buildIsolatedOssWorkspace(repo, sampledEnMap, contextCodeFiles, targetLocales) {
  const workSrc = path.join(EVAL_ROOT, "work", `oss-src-${repo.id}`);
  fs.rmSync(workSrc, { recursive: true, force: true });
  fs.mkdirSync(workSrc, { recursive: true });

  // Write context source files
  for (const [rel, content] of Object.entries(contextCodeFiles)) {
    const abs = path.join(workSrc, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  let sourceRel, targetPathFn, format;
  if (repo.format === "yaml") {
    format = "yaml";
    sourceRel = "config/locales/en.yml";
    targetPathFn = (loc) => `config/locales/${loc}.yml`;
    fs.mkdirSync(path.join(workSrc, "config/locales"), { recursive: true });
    fs.writeFileSync(path.join(workSrc, "Gemfile"), 'gem "rails"\n');
    fs.writeFileSync(path.join(workSrc, sourceRel), writeYamlCatalog("en", sampledEnMap));
  } else if (repo.format === "po") {
    format = "po";
    sourceRel = "locale/en/LC_MESSAGES/django.po";
    targetPathFn = (loc) => `locale/${loc.replace(/-/g, "_")}/LC_MESSAGES/django.po`;
    fs.writeFileSync(path.join(workSrc, "manage.py"), "#!/usr/bin/env python\n");
    for (const loc of ["en", ...targetLocales]) {
      const p = path.join(workSrc, targetPathFn(loc));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, makePoSkeletonFromMap(loc, sampledEnMap));
    }
  } else {
    format = "json";
    sourceRel = "messages/en.json";
    targetPathFn = (loc) => `messages/${loc}.json`;
    fs.mkdirSync(path.join(workSrc, "messages"), { recursive: true });
    fs.writeFileSync(
      path.join(workSrc, "package.json"),
      JSON.stringify({ name: `oss-sample-${repo.id}`, dependencies: { "next-intl": "4.0.0" } }, null, 2) + "\n"
    );
    fs.writeFileSync(path.join(workSrc, sourceRel), JSON.stringify(unflattenJson(sampledEnMap), null, 2) + "\n");
  }

  return { workSrc, sourceRel, targetPathFn, format };
}

function readIsolatedCatalog(format, dir, rel, locale) {
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

function writeIsolatedCatalog(format, dir, rel, locale, flatMap, sourceMap) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (format === "yaml") {
    fs.writeFileSync(abs, writeYamlCatalog(locale, flatMap));
  } else if (format === "po") {
    const skel = makePoSkeletonFromMap(locale, sourceMap);
    fs.writeFileSync(abs, writePoCatalogFromSkeleton(skel, flatMap));
  } else {
    fs.writeFileSync(abs, JSON.stringify(unflattenJson(flatMap), null, 2) + "\n");
  }
}

export async function runOssStage({ ignoreSpendCap = false, onlyApp = null, maxSample = 200, judgeSample = 40, judgeMode = "all" } = {}) {
  console.log("=== Stage 3C: Open-Source Apps Evaluation (5 repos, 200 stratified strings/app, 40 judged/app/lang + H) ===");
  const selectedRepos = OSS_REPOS.filter((r) => !onlyApp || r.id === onlyApp);

  const outPath = path.join(RESULTS_DIR, "oss.json");
  const out = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : { startedAt: new Date().toISOString(), repos: {} };

  const manifest = {};
  let seed = 7000;

  for (const repo of selectedRepos) {
    seed += 101;
    const deeplBeforeApp = await getDeepLUsage();
    console.log(
      `\n================ OSS App: ${repo.id} (${repo.stack}) | DeepL ${deeplBeforeApp.character_count}/${deeplBeforeApp.character_limit} ================`
    );

    const cloneInfo = ensureOssRepoCloned(repo);
    const discovered = discoverOssRepoCatalog(repo, cloneInfo.dir);
    if (!discovered.sourceRel) {
      console.warn(`[OSS ${repo.id}] Could not locate English source catalog; skipping.`);
      continue;
    }

    const dxProbe = probeMonorepoSetupDx(cloneInfo.dir, discovered);
    const fullEnMap = discovered.parseFn(
      fs.readFileSync(path.join(cloneInfo.dir, discovered.sourceRel), "utf8")
    );

    // Load available human catalogs H
    const humanMaps = {};
    for (const [loc, info] of Object.entries(discovered.humanLocales)) {
      try {
        const raw = fs.readFileSync(path.join(cloneInfo.dir, info.rel), "utf8");
        const parsed = repo.format === "po" ? parsePoCatalog(raw) : discovered.parseFn(raw);
        // Keep only non-empty entries
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && v.trim()) clean[k] = v;
        }
        if (Object.keys(clean).length >= 20) {
          humanMaps[loc] = { repoCode: info.repoCode, rel: info.rel, map: clean };
        }
      } catch (err) {
        console.warn(`[OSS ${repo.id}] Failed parsing human locale ${loc}: ${err.message}`);
      }
    }

    const availableLocales = ALL_LANGUAGES.filter((l) => Boolean(humanMaps[l]));
    // Prefer keys that exist in at least half of available human locales so H comparisons are fair
    const candidateEnMap = {};
    const minLocaleCoverage = Math.max(1, Math.ceil(availableLocales.length * 0.6));
    for (const [k, v] of Object.entries(fullEnMap)) {
      if (typeof v !== "string" || !v.trim() || v.length > 400) continue;
      const cov = availableLocales.filter((l) => Boolean(humanMaps[l]?.map?.[k])).length;
      if (cov >= minLocaleCoverage) candidateEnMap[k] = v;
    }
    const basePool = Object.keys(candidateEnMap).length >= 25 ? candidateEnMap : fullEnMap;

    // Contamination control: find keys added/modified after CODEX_CONFIG.modelCutoffDate
    const postCutoffInfo = findPostCutoffKeys(cloneInfo.dir, discovered.sourceRel, discovered.parseFn);
    const postCutoffValid = postCutoffInfo.postCutoffKeys.filter((k) => Boolean(basePool[k])).slice(0, 40);

    // Stratified sample of up to `maxSample` (200) keys, ALWAYS including post-cutoff keys!
    const sampledKeysSet = new Set(postCutoffValid);
    const extraSample = stratifiedSampleKeys(basePool, { limit: maxSample, seed });
    for (const k of extraSample) {
      if (sampledKeysSet.size >= maxSample) break;
      sampledKeysSet.add(k);
    }
    const sampledKeys = [...sampledKeysSet].sort();
    const sampledEnMap = Object.fromEntries(sampledKeys.map((k) => [k, fullEnMap[k]]));

    const contextCodeFiles = collectRelevantCodeFiles(cloneInfo.dir, discovered.codeRoots, sampledKeys, 18);
    const iso = buildIsolatedOssWorkspace(repo, sampledEnMap, contextCodeFiles, availableLocales);

    manifest[repo.id] = {
      url: repo.url,
      sha: cloneInfo.sha,
      commitDate: cloneInfo.commitDate,
      sourceRel: discovered.sourceRel,
      totalSourceKeys: Object.keys(fullEnMap).length,
      sampledKeyCount: sampledKeys.length,
      postCutoffCount: postCutoffValid.length,
      availableLocales: Object.fromEntries(availableLocales.map((l) => [l, humanMaps[l].repoCode])),
      dxProbe,
    };

    out.repos[repo.id] = out.repos[repo.id] ?? {
      ...manifest[repo.id],
      contextCodeFileCount: Object.keys(contextCodeFiles).length,
      locales: {},
    };

    console.log(
      `[OSS ${repo.id}] sha=${cloneInfo.sha.slice(0, 8)} totalKeys=${Object.keys(fullEnMap).length} sampled=${sampledKeys.length} postCutoff=${postCutoffValid.length} locales=[${availableLocales.join(",")}] ctxFiles=${Object.keys(contextCodeFiles).length}`
    );

    let appDeepLDelta = 0;

    for (const locale of availableLocales) {
      seed += 29;
      console.log(`\n--- OSS [${repo.id}] -> ${locale} (H=${humanMaps[locale].repoCode}) ---`);
      const targetRel = iso.targetPathFn(locale);
      const humanMap = humanMaps[locale].map;

      // 1. System A: Codex + Polyglot MCP
      const promptA = `Localize this ${repo.id} (${repo.stack}) catalog into "${locale}" using Polyglot MCP server tools.
Steps:
1. Call \`status\` and \`prepare\` (using limit=100, paginating with offset if hasMore=true) for targetLocale="${locale}".
2. Read relevant files under src_context/ whenever a short UI string needs context disambiguation.
3. Write EVERY translation via Polyglot's \`apply\` tool, preserving all placeholders, ICU/plural syntax, printf tokens, HTML/rich-text tags, and product names.
4. Run \`check\` and fix any errors until outcome is "PASS".
Reply DONE.`;

      const resA = await runCodexWithPolyglot({
        stageName: `oss-${repo.id}`,
        label: `oss-${repo.id}-A-${locale}`,
        sourceDir: iso.workSrc,
        prompt: promptA,
        captureRelPaths: [targetRel, ".polyglot/records.json"],
        ignoreSpendCap,
        workspaceSetupFn: (tmpDir) => seedPolyglotProject(tmpDir, [locale], []),
      });
      const workA = path.join(EVAL_ROOT, "work", `oss-${repo.id}-A-${locale}`);
      fs.rmSync(workA, { recursive: true, force: true });
      fs.cpSync(iso.workSrc, workA, { recursive: true });
      seedPolyglotProject(workA, [locale], []);
      materializeCapturedFiles(resA, workA);
      const flatA = readIsolatedCatalog(iso.format, workA, targetRel, locale);
      const checkA = parsePolyglotJson(runPolyglotCli(workA, ["check", "--locale", locale, "--json"]));

      // 2. System A0: Codex CLI with NO Polyglot MCP (Change #1)
      const promptA0 = `Translate ${iso.sourceRel} into ${locale} (writing ${targetRel}), reading the components in src_context/ for context; keep placeholders/ICU valid.`;
      const resA0 = await runCodexNoPolyglot({
        stageName: `oss-${repo.id}`,
        label: `oss-${repo.id}-A0-${locale}`,
        sourceDir: iso.workSrc,
        prompt: promptA0,
        captureRelPaths: [targetRel],
        ignoreSpendCap,
      });
      const workA0 = path.join(EVAL_ROOT, "work", `oss-${repo.id}-A0-${locale}`);
      fs.rmSync(workA0, { recursive: true, force: true });
      fs.cpSync(iso.workSrc, workA0, { recursive: true });
      materializeCapturedFiles(resA0, workA0);
      const flatA0 = readIsolatedCatalog(iso.format, workA0, targetRel, locale);

      // Run Polyglot check on A0 as well
      const workCheckA0 = path.join(EVAL_ROOT, "work", `oss-${repo.id}-checkA0-${locale}`);
      fs.rmSync(workCheckA0, { recursive: true, force: true });
      fs.cpSync(iso.workSrc, workCheckA0, { recursive: true });
      seedPolyglotProject(workCheckA0, [locale], []);
      writeIsolatedCatalog(iso.format, workCheckA0, targetRel, locale, flatA0, sampledEnMap);
      const checkA0 = parsePolyglotJson(runPolyglotCli(workCheckA0, ["check", "--locale", locale, "--json"]));

      // 3. System B: DeepL (staying strictly inside per-app stage cap)
      const remainingAppCap = Math.max(0, DEEPL_STAGE_CHAR_CAP - appDeepLDelta);
      const resB = await translateCatalogWithDeepL({
        stageName: `oss-${repo.id}`,
        targetLocale: locale,
        sourceMap: sampledEnMap,
        stageCharCap: remainingAppCap,
      });
      appDeepLDelta += resB.liveChars;
      const flatB = resB.translations;

      // 4. System C: Polyglot check on B (no fixing)
      const workC = path.join(EVAL_ROOT, "work", `oss-${repo.id}-C-${locale}`);
      fs.rmSync(workC, { recursive: true, force: true });
      fs.cpSync(iso.workSrc, workC, { recursive: true });
      seedPolyglotProject(workC, [locale], []);
      writeIsolatedCatalog(iso.format, workC, targetRel, locale, flatB, sampledEnMap);
      const checkC = parsePolyglotJson(runPolyglotCli(workC, ["check", "--locale", locale, "--json"]));

      // 5. Deterministic metrics + chrF2 against human H on 100% of sampled strings (and post-cutoff subset!)
      const detA = computeCatalogMetrics(sampledEnMap, flatA);
      const detA0 = computeCatalogMetrics(sampledEnMap, flatA0);
      const detB = computeCatalogMetrics(sampledEnMap, flatB);

      const keysWithH = sampledKeys.filter((k) => Boolean(humanMap[k]));
      const chrfAll = {
        n: keysWithH.length,
        A: corpusChrF(keysWithH.map((k) => ({ hyp: flatA[k] ?? "", ref: humanMap[k] }))),
        A0: corpusChrF(keysWithH.map((k) => ({ hyp: flatA0[k] ?? "", ref: humanMap[k] }))),
        B: corpusChrF(keysWithH.map((k) => ({ hyp: flatB[k] ?? "", ref: humanMap[k] }))),
      };
      const postKeysWithH = postCutoffValid.filter((k) => Boolean(humanMap[k]));
      const chrfPostCutoff =
        postKeysWithH.length > 0
          ? {
              n: postKeysWithH.length,
              A: corpusChrF(postKeysWithH.map((k) => ({ hyp: flatA[k] ?? "", ref: humanMap[k] }))),
              A0: corpusChrF(postKeysWithH.map((k) => ({ hyp: flatA0[k] ?? "", ref: humanMap[k] }))),
              B: corpusChrF(postKeysWithH.map((k) => ({ hyp: flatB[k] ?? "", ref: humanMap[k] }))),
            }
          : null;

      // 6. Stratified judge sample: 40 strings per (OSS app x lang) comparing blinded A, A0, B, H (Change #8)
      const hPool = Object.fromEntries(keysWithH.map((k) => [k, sampledEnMap[k]]));
      const judgedKeys = stratifiedSampleKeys(hPool, { limit: judgeSample, seed: seed + 13 });
      const judgeItems = judgedKeys.map((k) => ({
        key: k,
        source: sampledEnMap[k],
        category: postCutoffValid.includes(k) ? "post-cutoff" : "oss-catalog",
        isChallenge: postCutoffValid.includes(k),
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

      console.log(
        `  [${repo.id}:${locale}] chrF2(A=${chrfAll.A}, A0=${chrfAll.A0}, B=${chrfAll.B}) errs(A=${checkA?.errorCount}, A0=${checkA0?.errorCount}, B=${checkC?.errorCount}) -> judging ${judgeItems.length} items (A,A0,B,H)...`
      );

      const existingOssJudge = out.repos[repo.id]?.locales?.[locale]?.judging ?? null;
      let judging = existingOssJudge;
      if (judgeMode !== "none" && (!existingOssJudge || existingOssJudge.partialJudgeMode)) {
        judging = await runDualJudgeEvaluation({
          stageName: `oss-${repo.id}`,
          targetLocale: locale,
          items: judgeItems,
          concurrency: 8,
          seed: seed + 17,
          ignoreSpendCap,
          includeSubtleControls: true,
          judgeMode,
        });
      }

      if (judging) {
        console.log(
          `  [judged ${repo.id}:${locale}] kappa=${judging.validation.agreement.kappa} wins=${JSON.stringify(judging.panel.wins)} humanLast=${JSON.stringify(judging.validation.humanAnchorLastRate)} reliable=${judging.validation.humanAnchorReliable}`
        );
      }

      out.repos[repo.id].locales[locale] = {
        repoHumanLocale: humanMaps[locale].repoCode,
        chrfAll,
        chrfPostCutoff,
        systemA: {
          exitCode: resA.exitCode,
          wallMs: resA.wallMs,
          cacheHit: resA.cacheHit,
          estimatedApiUsd: resA.estimatedApiUsd,
          telemetry: normalizeTelemetryPer1k(resA.telemetry, sampledKeys.length),
          polyglotCheck: {
            outcome: checkA?.outcome,
            errorCount: checkA?.errorCount,
            warningCount: checkA?.warningCount,
            countsByCode: checkA?.countsByCode,
          },
          deterministicMetrics: detA,
        },
        systemA0: {
          exitCode: resA0.exitCode,
          wallMs: resA0.wallMs,
          cacheHit: resA0.cacheHit,
          estimatedApiUsd: resA0.estimatedApiUsd,
          telemetry: normalizeTelemetryPer1k(resA0.telemetry, sampledKeys.length),
          polyglotCheck: {
            outcome: checkA0?.outcome,
            errorCount: checkA0?.errorCount,
            warningCount: checkA0?.warningCount,
            countsByCode: checkA0?.countsByCode,
          },
          deterministicMetrics: detA0,
        },
        systemB: {
          wallMs: resB.wallMs,
          liveChars: resB.liveChars,
          cacheHits: resB.cacheHits,
          formality: resB.formality,
          deterministicMetrics: detB,
          polyglotCheck: {
            outcome: checkC?.outcome,
            errorCount: checkC?.errorCount,
            warningCount: checkC?.warningCount,
            countsByCode: checkC?.countsByCode,
          },
        },
        judging,
      };

      atomicWriteJson(outPath, out);
    }

    const deeplAfterApp = await getDeepLUsage();
    out.repos[repo.id].deeplDeltaChars = deeplAfterApp.character_count - deeplBeforeApp.character_count;
    atomicWriteJson(outPath, out);
  }

  saveCorporaManifest(manifest);
  out.glossaryDeletionLog = getGlossaryDeletionLog();
  out.finishedAt = new Date().toISOString();
  atomicWriteJson(outPath, out);
  console.log("\n=== Stage 3C OSS Evaluation Complete ===");
  return out;
}
