import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEEPL_STAGE_CHAR_CAP,
  EVAL_ROOT,
  POLYGLOT_BIN,
  RESULTS_DIR,
} from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import { materializeCapturedFiles, runCodexWithPolyglot } from "../lib/codex.mjs";
import {
  getDeepLUsage,
  getGlossaryDeletionLog,
  translateCatalogWithDeepL,
} from "../lib/deepl.mjs";
import { runDualJudgeEvaluation } from "../lib/judges.mjs";
import { computeCatalogMetrics } from "../lib/metrics.mjs";
import { ensureOssRepoCloned, OSS_REPOS, stratifiedSampleKeys } from "../corpora/fetch-oss.mjs";
import { discoverOssRepoCatalog } from "./oss.mjs";
import {
  extractGlossaryForLocale,
  flattenJson,
  normalizeTelemetryPer1k,
  parsePolyglotJson,
  runPolyglotCli,
  seedPolyglotProject,
  unflattenJson,
} from "./common.mjs";

/**
 * Call Polyglot MCP `prepare` directly over stdio JSON-RPC so we can deterministically inspect
 * `stale_source`, `context_changed`, and fuzzy TM match scores (>=95% and 75-94%) before Codex runs.
 */
async function callPolyglotMcpPrepare(cwd, targetLocale, limit = 100) {
  return new Promise((resolve, reject) => {
    const child = spawn(POLYGLOT_BIN, ["-C", cwd, "mcp"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`MCP prepare timed out: ${stderr.slice(0, 200)}`));
    }, 30_000);

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            send({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "prepare",
                arguments: { targetLocale, limit, offset: 0 },
              },
            });
          } else if (msg.id === 2) {
            clearTimeout(timer);
            child.kill("SIGTERM");
            const txt = msg.result?.content?.[0]?.text ?? "{}";
            try {
              resolve(JSON.parse(txt));
            } catch {
              resolve({ raw: txt });
            }
          }
        } catch {}
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "polyglot-eval", version: "1.0.0" },
      },
    });
  });
}

/**
 * 30-term realistic domain glossary (DNT brands + required German translations) for an OSS app.
 */
function build30TermGlossary(appId) {
  const brandDnt =
    appId === "hoppscotch"
      ? ["Hoppscotch", "GraphQL", "REST", "WebSocket", "OAuth", "JWT", "cURL", "SSE", "MQTT", "JSON"]
      : ["next-intl", "Next.js", "App Router", "Vercel", "React", "TypeScript", "JSON", "ICU", "SSR", "GitHub"];

  const translatedTerms = [
    ["Workspace", "Arbeitsbereich"],
    ["Collection", "Sammlung"],
    ["Environment", "Umgebung"],
    ["Request", "Anfrage"],
    ["Response", "Antwort"],
    ["Header", "Kopfzeile"],
    ["Parameter", "Parameter"],
    ["Settings", "Einstellungen"],
    ["Authentication", "Authentifizierung"],
    ["Token", "Token"],
    ["History", "Verlauf"],
    ["Documentation", "Dokumentation"],
    ["Import", "Importieren"],
    ["Export", "Exportieren"],
    ["Save", "Speichern"],
    ["Delete", "Löschen"],
    ["Share", "Teilen"],
    ["Profile", "Profil"],
    ["Account", "Konto"],
    ["Language", "Sprache"],
  ];

  return [
    ...brandDnt.map((t) => ({ term: t, doNotTranslate: true, caseSensitive: true, translations: {} })),
    ...translatedTerms.map(([term, de]) => ({
      term,
      doNotTranslate: false,
      caseSensitive: false,
      translations: { de },
    })),
  ];
}

async function runSingleAppReplay(repo, { ignoreSpendCap = false, judgeMode = "all" } = {}) {
  console.log(`\n=== Release Replay & Glossary Propagation: ${repo.id} (de) ===`);
  const locale = "de";
  const cloneInfo = ensureOssRepoCloned(repo);
  const discovered = discoverOssRepoCatalog(repo, cloneInfo.dir);
  const fullEn = discovered.parseFn(fs.readFileSync(path.join(cloneInfo.dir, discovered.sourceRel), "utf8"));
  const humanInfo = discovered.humanLocales.de;
  if (!humanInfo) throw new Error(`No German human catalog found in ${repo.id}`);
  const fullDe = discovered.parseFn(fs.readFileSync(path.join(cloneInfo.dir, humanInfo.rel), "utf8"));

  // Pick 50 real strings that have German human translations and clean non-trivial text
  const validPool = {};
  for (const [k, v] of Object.entries(fullEn)) {
    if (fullDe[k] && v.length >= 8 && v.length <= 140 && !/\{[^}]*,/.test(v)) {
      validPool[k] = v;
    }
  }
  const baseKeys = stratifiedSampleKeys(validPool, { limit: Math.min(50, Object.keys(validPool).length), seed: repo.id === "hoppscotch" ? 501 : 601 });
  const relNEn = Object.fromEntries(baseKeys.map((k) => [k, fullEn[k]]));
  const relNDe = Object.fromEntries(baseKeys.map((k) => [k, fullDe[k]]));

  // Build Release N workspace with real React/TSX usage sites so context_changed can be tested!
  const workDir = path.join(EVAL_ROOT, "work", `replay-${repo.id}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, "messages"), { recursive: true });
  fs.mkdirSync(path.join(workDir, "src/components"), { recursive: true });

  fs.writeFileSync(
    path.join(workDir, "package.json"),
    JSON.stringify({ name: `replay-${repo.id}`, dependencies: { next: "15.1.0", react: "19.0.0", "next-intl": "4.0.0" } }, null, 2) + "\n"
  );
  fs.writeFileSync(path.join(workDir, "messages/en.json"), JSON.stringify(unflattenJson(relNEn), null, 2) + "\n");
  fs.writeFileSync(path.join(workDir, "messages/de.json"), JSON.stringify(unflattenJson(relNDe), null, 2) + "\n");

  const writeUsageComponent = (fileName, keysSlice) => {
    const body = keysSlice.map((k) => `      <p>{t(${JSON.stringify(k)})}</p>`).join("\n");
    fs.writeFileSync(
      path.join(workDir, "src/components", fileName),
      `import { useTranslations } from "next-intl";\nexport function ${fileName.replace(".tsx", "")}() {\n  const t = useTranslations();\n  return (\n    <div>\n${body}\n    </div>\n  );\n}\n`
    );
  };
  writeUsageComponent("ReleasePanelA.tsx", baseKeys.slice(0, 25));
  writeUsageComponent("ReleasePanelB.tsx", baseKeys.slice(25));

  // Step 1: Seed Release N via `polyglot init` + `polyglot import --format locales`!
  const glossary30 = build30TermGlossary(repo.id);
  seedPolyglotProject(workDir, [locale], glossary30);
  const importRes = runPolyglotCli(workDir, ["import", "--format", "locales", "--json"]);
  const importParsed = parsePolyglotJson(importRes);

  // Step 2: Apply Release N+1 changes:
  // - 10 edited strings (minor wording tweak -> stale_source + high fuzzy TM match)
  // - 6 newly added strings (including 4 near-duplicates of existing strings -> fuzzy TM leverage + 2 brand-new)
  // - 5 moved keys (moved from ReleasePanelA.tsx -> MovedSettingsModal.tsx with unchanged source -> context_changed!)
  const editedKeys = baseKeys.slice(0, Math.min(10, baseKeys.length));
  const movedKeys = baseKeys.slice(10, Math.min(15, baseKeys.length));
  const relN1En = { ...relNEn };
  for (let i = 0; i < editedKeys.length; i++) {
    const k = editedKeys[i];
    const orig = relNEn[k];
    // Minor/moderate realistic Release N+1 copy edit
    relN1En[k] = i < 5 ? `${orig.replace(/\.$/, "")} now.` : `Updated: ${orig}`;
  }

  const addedKeys = [];
  for (let i = 0; i < Math.min(4, baseKeys.length - 16); i++) {
    const baseK = baseKeys[16 + i];
    const newK = `releaseNext.nearDup${i + 1}`;
    relN1En[newK] = `${relNEn[baseK].replace(/\.$/, "")} (beta)`;
    addedKeys.push(newK);
  }
  const brandNew1 = "releaseNext.workspaceAudit";
  const brandNew2 = "releaseNext.exportCollection";
  relN1En[brandNew1] = `Review Workspace Settings and Authentication Token History in ${glossary30[0].term}.`;
  relN1En[brandNew2] = `Export Collection Request and Response Documentation to ${glossary30[1].term}.`;
  addedKeys.push(brandNew1, brandNew2);

  fs.writeFileSync(path.join(workDir, "messages/en.json"), JSON.stringify(unflattenJson(relN1En), null, 2) + "\n");
  // Move the 5 keys to a new component file to test `context_changed`
  writeUsageComponent("ReleasePanelA.tsx", baseKeys.slice(0, 10).concat(baseKeys.slice(15, 25)));
  writeUsageComponent("MovedSettingsModal.tsx", movedKeys.concat(addedKeys));

  // Step 3: Measure deterministic Polyglot `check` & MCP `prepare` BEFORE retranslation!
  const midCheck = parsePolyglotJson(runPolyglotCli(workDir, ["check", "--locale", locale, "--limit", "500", "--json"]));
  const prepResult = await callPolyglotMcpPrepare(workDir, locale, 100);

  const checkIssues = Array.isArray(midCheck?.issues) ? midCheck.issues : (midCheck?.issues?.items ?? []);
  const flaggedStaleKeys = [
    ...new Set(checkIssues.filter((i) => i.code === "stale_source").map((i) => i.key)),
  ];
  const flaggedMissingKeys = [
    ...new Set(checkIssues.filter((i) => i.code === "missing_key" || i.code === "missing_translation").map((i) => i.key)),
  ];
  const flaggedContextChanged = [
    ...new Set(
      checkIssues
        .filter((i) => i.code === "context_changed")
        .map((i) => i.key)
        .concat(
          (prepResult?.items ?? [])
            .filter((it) => it.status === "context_changed" || it.contextChanged)
            .map((it) => it.key)
        )
    ),
  ];

  const staleTP = editedKeys.filter((k) => flaggedStaleKeys.includes(k)).length;
  const stalePrecision = flaggedStaleKeys.length > 0 ? Number((staleTP / flaggedStaleKeys.length).toFixed(4)) : 0;
  const staleRecall = editedKeys.length > 0 ? Number((staleTP / editedKeys.length).toFixed(4)) : 0;

  // Measure fuzzy TM leverage bands (>=95% and 75-94%) from MCP prepare items
  const prepItems = prepResult?.items ?? [];
  let fuzzyHigh95 = 0;
  let fuzzyMed75 = 0;
  const fuzzyExamples = [];
  for (const it of prepItems) {
    const matches = it.tmMatches ?? it.matches ?? it.fuzzyMatches ?? [];
    const topScore = matches.reduce((mx, m) => Math.max(mx, Number(m.score ?? m.similarity ?? 0)), 0);
    const pct = topScore <= 1 ? topScore * 100 : topScore;
    if (pct >= 95) fuzzyHigh95++;
    else if (pct >= 75) fuzzyMed75++;
    if (pct >= 75) {
      fuzzyExamples.push({ key: it.key, source: it.source, topScorePct: Number(pct.toFixed(1)), matchTarget: matches[0]?.target ?? null });
    }
  }

  console.log(
    `  [Replay ${repo.id}] stale_source P=${stalePrecision} R=${staleRecall} (${staleTP}/${editedKeys.length}) | missing=${flaggedMissingKeys.length}/${addedKeys.length} | ctxChanged=${flaggedContextChanged.length}/${movedKeys.length} | fuzzy>=95=${fuzzyHigh95}, 75-94=${fuzzyMed75}`
  );

  // Step 4: Run System A to incrementally update ONLY the stale/added keys via Polyglot MCP
  const changedKeys = [...editedKeys, ...addedKeys];
  const promptReplayA = `Release N+1 updated ${editedKeys.length} existing strings and added ${addedKeys.length} new strings in messages/en.json.
Using Polyglot MCP tools:
1. Call \`prepare\` with targetLocale="${locale}", limit=100, offset=0 to fetch ONLY the stale and untranslated keys (use any TM fuzzyMatches as context hints, adapting them accurately to the new source text rather than copying blindly!).
2. Apply all updated/new German translations via \`apply\`, strictly honoring the 30-term glossary (including DNT terms).
3. Run \`check\` until outcome is "PASS" (0 errors).
Reply DONE.`;

  const resReplayA = await runCodexWithPolyglot({
    stageName: `replay-${repo.id}`,
    label: `replay-${repo.id}-A-${locale}`,
    sourceDir: workDir,
    prompt: promptReplayA,
    captureRelPaths: ["messages/de.json", ".polyglot/records.json"],
    ignoreSpendCap,
  });

  const postAWork = path.join(EVAL_ROOT, "work", `replay-${repo.id}-postA`);
  fs.rmSync(postAWork, { recursive: true, force: true });
  fs.cpSync(workDir, postAWork, { recursive: true });
  materializeCapturedFiles(resReplayA, postAWork);
  const flatReplayA = flattenJson(JSON.parse(fs.readFileSync(path.join(postAWork, "messages/de.json"), "utf8")));
  const checkAfterReplayA = parsePolyglotJson(runPolyglotCli(postAWork, ["check", "--locale", locale, "--json"]));

  // System B: DeepL retranslating the changed + added keys with the 30-term glossary
  const changedSourceMap = Object.fromEntries(changedKeys.map((k) => [k, relN1En[k]]));
  const localeGlossary30 = extractGlossaryForLocale(glossary30, locale);
  const resReplayB = await translateCatalogWithDeepL({
    stageName: `replay-${repo.id}`,
    targetLocale: locale,
    sourceMap: changedSourceMap,
    glossaryName: `replay-${repo.id}-g30`,
    glossaryEntries: localeGlossary30,
    stageCharCap: DEEPL_STAGE_CHAR_CAP,
  });
  const flatReplayB = resReplayB.translations;

  // Judge the updated/added keys (A vs B) to check whether TM-assisted updates stayed accurate
  const replayJudgeItems = changedKeys.map((k) => ({
    key: k,
    source: relN1En[k],
    category: editedKeys.includes(k) ? "stale-updated" : "newly-added",
    isChallenge: true,
    context: `${repo.id} Release N+1 delta (${editedKeys.includes(k) ? "edited" : "added"})`,
    glossaryHits: localeGlossary30.filter((g) =>
      new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(relN1En[k])
    ),
    intendedSense: null,
    candidates: {
      A: flatReplayA[k] ?? "",
      B: flatReplayB[k] ?? "",
    },
  }));

  const replayJudging =
    judgeMode === "none"
      ? null
      : await runDualJudgeEvaluation({
          stageName: `replay-${repo.id}`,
          targetLocale: locale,
          items: replayJudgeItems,
          concurrency: 8,
          seed: repo.id === "hoppscotch" ? 801 : 802,
          ignoreSpendCap,
          includeSubtleControls: false,
          judgeMode,
        });

  // Glossary adherence on the changed keys (30-term termbase): A vs B
  const detChangedA = computeCatalogMetrics(changedSourceMap, flatReplayA, localeGlossary30);
  const detChangedB = computeCatalogMetrics(changedSourceMap, flatReplayB, localeGlossary30);

  // Step 5: Mid-project glossary term change propagation test!
  // Change 1 term ("Workspace": "Arbeitsbereich" -> "Projektbereich") in .polyglot/glossary.json and verify `polyglot check` flags the EXACT affected keys!
  const gPath = path.join(postAWork, ".polyglot/glossary.json");
  const gData = JSON.parse(fs.readFileSync(gPath, "utf8"));
  const mutatedTerm = "Workspace";
  const newRequiredTranslation = "Projektbereich";
  const targetEntry = gData.entries.find((e) => e.term.toLowerCase() === mutatedTerm.toLowerCase());
  if (targetEntry) {
    targetEntry.translations.de = newRequiredTranslation;
  }
  fs.writeFileSync(gPath, JSON.stringify(gData, null, 2) + "\n");

  const expectedAffectedKeys = Object.keys(relN1En).filter((k) => /\bWorkspace\b/i.test(relN1En[k]));
  const afterTermChangeCheck = parsePolyglotJson(runPolyglotCli(postAWork, ["check", "--locale", locale, "--limit", "500", "--json"]));
  const afterTermIssues = Array.isArray(afterTermChangeCheck?.issues)
    ? afterTermChangeCheck.issues
    : (afterTermChangeCheck?.issues?.items ?? []);
  const flaggedGlossaryKeys = [
    ...new Set(
      afterTermIssues
        .filter(
          (i) =>
            (i.code === "glossary_inconsistency" || i.code === "glossary_violation") &&
            String(i.message ?? "").toLowerCase().includes("workspace")
        )
        .map((i) => i.key)
    ),
  ];
  const propTP = expectedAffectedKeys.filter((k) => flaggedGlossaryKeys.includes(k)).length;
  const propPrecision = flaggedGlossaryKeys.length > 0 ? Number((propTP / flaggedGlossaryKeys.length).toFixed(4)) : 0;
  const propRecall = expectedAffectedKeys.length > 0 ? Number((propTP / expectedAffectedKeys.length).toFixed(4)) : 0;

  console.log(
    `  [Glossary propagation ${repo.id}] changed "Workspace" -> "Projektbereich": expected=${expectedAffectedKeys.length} flagged=${flaggedGlossaryKeys.length} P=${propPrecision} R=${propRecall}`
  );

  return {
    repoId: repo.id,
    commitSha: cloneInfo.sha,
    releaseNKeyCount: baseKeys.length,
    importResult: importParsed,
    deltaDesign: "Deterministic Release N -> N+1 corpus delta (10 edited strings, 6 added strings incl. 4 near-duplicates, 5 moved component call sites) built from real OSS strings & German human translations.",
    stalenessAndContext: {
      editedGroundTruth: editedKeys.length,
      flaggedStaleCount: flaggedStaleKeys.length,
      stalePrecision,
      staleRecall,
      addedGroundTruth: addedKeys.length,
      flaggedMissingCount: flaggedMissingKeys.length,
      movedGroundTruth: movedKeys.length,
      flaggedContextChangedCount: flaggedContextChanged.length,
      flaggedContextChangedKeys: flaggedContextChanged,
    },
    fuzzyTmLeverage: {
      preparedItemCount: prepItems.length,
      band95Plus: fuzzyHigh95,
      band75to94: fuzzyMed75,
      examples: fuzzyExamples.slice(0, 8),
    },
    retranslationComparison: {
      changedKeyCount: changedKeys.length,
      systemA: {
        wallMs: resReplayA.wallMs,
        telemetry: normalizeTelemetryPer1k(resReplayA.telemetry, changedKeys.length),
        checkOutcomeAfter: checkAfterReplayA?.outcome,
        checkErrorsAfter: checkAfterReplayA?.errorCount,
        glossaryMetrics: detChangedA,
      },
      systemB: {
        wallMs: resReplayB.wallMs,
        liveChars: resReplayB.liveChars,
        usedGlossary: resReplayB.usedGlossary,
        glossaryMetrics: detChangedB,
      },
      judging: replayJudging,
    },
    glossaryPropagationTest: {
      termbaseSize: glossary30.length,
      mutatedTerm,
      oldTranslation: "Arbeitsbereich",
      newTranslation: newRequiredTranslation,
      expectedAffectedKeys,
      flaggedGlossaryKeys,
      precision: propPrecision,
      recall: propRecall,
    },
  };
}

export async function runReplayStage({ ignoreSpendCap = false, judgeMode = "all" } = {}) {
  console.log("=== Stage 3D: TM, Staleness & Glossary Propagation Replay (2 OSS apps) ===");
  const deeplBefore = await getDeepLUsage();
  const targetRepos = OSS_REPOS.filter((r) => ["hoppscotch", "next-intl"].includes(r.id));

  const out = {
    startedAt: new Date().toISOString(),
    apps: {},
  };

  for (const repo of targetRepos) {
    out.apps[repo.id] = await runSingleAppReplay(repo, { ignoreSpendCap, judgeMode });
  }

  const deeplAfter = await getDeepLUsage();
  out.deeplBefore = deeplBefore;
  out.deeplAfter = deeplAfter;
  out.deeplStageDeltaChars = deeplAfter.character_count - deeplBefore.character_count;
  out.glossaryDeletionLog = getGlossaryDeletionLog();
  out.finishedAt = new Date().toISOString();

  atomicWriteJson(path.join(RESULTS_DIR, "replay-glossary.json"), out);
  console.log(
    `\n=== Stage 3D Replay Complete | DeepL delta=${out.deeplStageDeltaChars} chars ===`
  );
  return out;
}
