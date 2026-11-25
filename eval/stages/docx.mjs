import fs from "node:fs";
import path from "node:path";
import {
  DEEPL_STAGE_CHAR_CAP,
  DOCX_OUT_DIR,
  EVAL_ROOT,
  RESULTS_DIR,
} from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import { runCodexWithPolyglot } from "../lib/codex.mjs";
import {
  assertDeepLStageCap,
  getDeepLUsage,
  getGlossaryDeletionLog,
  translateDocxWithDeepL,
} from "../lib/deepl.mjs";
import {
  inspectDocxStructure,
  measureDocxSourceLeakage,
  renderDocxWithLibreOffice,
} from "../lib/docx-eval.mjs";
import { runDualJudgeEvaluation } from "../lib/judges.mjs";
import { buildAllDocxCorpus } from "../docx/build-all-docx.mjs";
import {
  extractGlossaryForLocale,
  normalizeTelemetryPer1k,
  parsePolyglotJson,
  runPolyglotCli,
  seedPolyglotProject,
} from "./common.mjs";

const DOCX_LOW_CONFIDENCE_NOTE =
  "LOW-CONFIDENCE JUDGE VERDICT (Pilot DOCX κ = 0.34, Claude flip rate = 35%): treat DOCX judge preferences as secondary; primary DOCX conclusions rest on deterministic OOXML structure preservation, LibreOffice rendering, source-text leakage, and incremental-update integrity.";

function pickSampleIndices(total, maxCount = 15) {
  if (total <= maxCount) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (let i = 0; i < maxCount; i++) {
    out.push(Math.floor((i * total) / maxCount));
  }
  return [...new Set(out)];
}

/**
 * Mid-batch incremental edit test on `libreoffice-revisions.docx` (-> pl):
 * 1) Translate Batch 1 (limit=5, offset=0) on v1
 * 2) Replace source file with v2 (inserted urgent paragraph at top + edited para 2 from 12h -> 6h)
 * 3) Inspect `prepare` & `check` on v2 to verify Polyglot detects stale & new segments without shifting translations
 * 4) Run Batch 2 on v2 and verify `check` passes with aligned Polish paragraphs
 */
async function runDocxIncrementalEditTest(docSpec, { ignoreSpendCap = false } = {}) {
  console.log(`\n--- DOCX Incremental Mid-Batch Edit Test: ${docSpec.id} -> ${docSpec.targetLocale} ---`);
  const locale = docSpec.targetLocale;
  const filename = `${docSpec.id}.docx`;
  const targetName = `${docSpec.id}.${locale}.docx`;

  const workDir = path.join(EVAL_ROOT, "work", `docx-incremental-${docSpec.id}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.copyFileSync(docSpec.path, path.join(workDir, filename));

  // Batch 1 on v1 (only first 5 segments!)
  const batch1Prompt = `Translate ONLY the first batch (limit=5, offset=0) of "${filename}" into Polish ("${locale}") as "${targetName}" using Polyglot MCP tools.
Steps:
1. Call \`prepare\` with document="${filename}", targetLocale="${locale}", limit=5, offset=0.
2. Translate ONLY those 5 segments (preserving <x>/<g> tags and DNT terms Northstar, LedgerVault, SSH) and write them via \`apply\` with document="${filename}", targetFile="${targetName}", targetLocale="${locale}".
3. Stop immediately after Batch 1 (do NOT translate remaining segments yet).
Reply BATCH1_DONE.`;

  const resB1 = await runCodexWithPolyglot({
    stageName: "docx-incremental",
    label: `${docSpec.id}-inc-batch1-${locale}`,
    sourceDir: workDir,
    prompt: batch1Prompt,
    captureRelPaths: [targetName, ".polyglot/documents.json"],
    ignoreSpendCap,
    workspaceSetupFn: (tmpDir) =>
      seedPolyglotProject(tmpDir, [locale], docSpec.glossary, (cfg) => {
        cfg.paths.documents = [filename];
      }),
  });

  // Materialize Batch 1 state + swap source DOCX to v2 (top insertion + para 2 edit!)
  const workV2 = path.join(EVAL_ROOT, "work", `docx-incremental-v2-${docSpec.id}`);
  fs.rmSync(workV2, { recursive: true, force: true });
  fs.mkdirSync(workV2, { recursive: true });
  seedPolyglotProject(workV2, [locale], docSpec.glossary, (cfg) => {
    cfg.paths.documents = [filename];
  });
  // Write captured Batch 1 outputs
  for (const [rel, b64] of Object.entries(resB1.capturedFiles ?? {})) {
    const abs = path.join(workV2, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, "base64"));
  }
  // Now replace source DOCX with v2!
  fs.copyFileSync(docSpec.v2Path, path.join(workV2, filename));

  // Probe deterministic Polyglot check & prepare right after v2 swap (before Batch 2)
  const midCheck = parsePolyglotJson(runPolyglotCli(workV2, ["check", "--locale", locale, "--json"]));

  // Batch 2 on v2: finish remaining + stale segments and verify PASS
  const batch2Prompt = `The source document "${filename}" was edited mid-translation (a new top amendment paragraph was inserted and paragraph 2 changed from twelve hours to six hours).
Using Polyglot MCP tools:
1. Call \`prepare\` with document="${filename}", targetLocale="${locale}", limit=50, offset=0 to see all remaining and stale segments (note how previously translated unchanged segments are preserved).
2. Translate every remaining and stale segment into Polish ("${locale}"), preserving <x>/<g> tags and DNT terms (Northstar, LedgerVault, SSH), and apply them with \`apply\` to targetFile="${targetName}".
3. Run \`check\` until outcome is "PASS".
Reply BATCH2_DONE.`;

  const resB2 = await runCodexWithPolyglot({
    stageName: "docx-incremental",
    label: `${docSpec.id}-inc-batch2-${locale}`,
    sourceDir: workV2,
    prompt: batch2Prompt,
    captureRelPaths: [targetName, ".polyglot/documents.json"],
    ignoreSpendCap,
  });

  const finalDir = path.join(EVAL_ROOT, "work", `docx-incremental-final-${docSpec.id}`);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.cpSync(workV2, finalDir, { recursive: true });
  for (const [rel, b64] of Object.entries(resB2.capturedFiles ?? {})) {
    const abs = path.join(finalDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, "base64"));
  }

  const finalCheck = parsePolyglotJson(runPolyglotCli(finalDir, ["check", "--locale", locale, "--json"]));
  const finalDocxPath = path.join(DOCX_OUT_DIR, `inc-final-${docSpec.id}.${locale}.docx`);
  fs.mkdirSync(DOCX_OUT_DIR, { recursive: true });
  if (fs.existsSync(path.join(finalDir, targetName))) {
    fs.copyFileSync(path.join(finalDir, targetName), finalDocxPath);
  }

  const v2Struct = inspectDocxStructure(docSpec.v2Path);
  const finalStruct = fs.existsSync(finalDocxPath) ? inspectDocxStructure(finalDocxPath) : null;
  const loFinal = fs.existsSync(finalDocxPath)
    ? renderDocxWithLibreOffice(finalDocxPath, path.join(DOCX_OUT_DIR, `${docSpec.id}-inc`), "inc-pl")
    : null;

  // Verify the newly inserted top paragraph is in slot 0 and edited para (6 hours, NOT 12) is aligned
  const topParaPl = finalStruct?.visibleParagraphs?.[0] ?? "";
  const para2Pl = finalStruct?.visibleParagraphs?.[2] ?? "";
  const topLooksAmended = /48|czterdzieści osiem|PILNA|POPRAWKA|awaryjn/i.test(topParaPl);
  const para2HasSixNotTwelve = /sześć|6\s*godz/i.test(para2Pl) && !/dwanaście|12\s*godz/i.test(para2Pl);

  console.log(
    `  [DOCX incremental] midCheck=${midCheck?.outcome} (codes=${JSON.stringify(midCheck?.countsByCode)}) -> finalCheck=${finalCheck?.outcome} (errors=${finalCheck?.errorCount}) topAmended=${topLooksAmended} para2SixHours=${para2HasSixNotTwelve} loOpened=${loFinal?.openedCleanly}`
  );

  return {
    sourceV1Paragraphs: inspectDocxStructure(docSpec.path).visibleParagraphs.length,
    sourceV2Paragraphs: v2Struct.visibleParagraphs.length,
    midBatchCheckAfterV2Swap: {
      outcome: midCheck?.outcome,
      errorCount: midCheck?.errorCount,
      countsByCode: midCheck?.countsByCode,
    },
    finalCheckAfterBatch2: {
      outcome: finalCheck?.outcome,
      errorCount: finalCheck?.errorCount,
      warningCount: finalCheck?.warningCount,
    },
    finalParagraphCount: finalStruct?.visibleParagraphs?.length ?? 0,
    libreOfficeOpened: loFinal?.openedCleanly ?? false,
    topParagraphTranslated: topParaPl,
    editedParagraphTranslated: para2Pl,
    topInsertionAligned: topLooksAmended,
    editedParaUpdatedTo6h: para2HasSixNotTwelve,
    batch1WallMs: resB1.wallMs,
    batch2WallMs: resB2.wallMs,
  };
}

/**
 * Run DOCX evaluation for part 1 (`northstar-policy` [cached de] + `gov-grant-form` [ja] + `open-sustainability-report` [ar])
 * or part 2 (`libreoffice-revisions` [pl] + incremental edit test).
 * Splitting ensures each stage stays <= 100,000 DeepL characters (50k min per DOCX).
 */
export async function runDocxStage({ part = "all", ignoreSpendCap = false, judgeMode = "all" } = {}) {
  const allDocs = buildAllDocxCorpus();
  const selected =
    part === "1"
      ? allDocs.filter((d) => ["northstar-policy", "gov-grant-form"].includes(d.id))
      : part === "2"
        ? allDocs.filter((d) => ["open-sustainability-report", "libreoffice-revisions"].includes(d.id))
        : allDocs;

  console.log(`=== Stage 3B: DOCX Evaluation (part=${part}: ${selected.map((d) => `${d.id}->${d.targetLocale}`).join(", ")}) ===`);

  const outPath = path.join(RESULTS_DIR, "docx.json");
  const out = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : { startedAt: new Date().toISOString(), lowConfidenceNote: DOCX_LOW_CONFIDENCE_NOTE, documents: {}, incrementalEditTest: null };

  const deeplBefore = await getDeepLUsage();
  console.log(`[DeepL before docx-${part}] ${deeplBefore.character_count} / ${deeplBefore.character_limit} (remaining ${deeplBefore.remaining})`);

  let seed = 4000;
  for (const docSpec of selected) {
    seed += 41;
    const locale = docSpec.targetLocale;
    const filename = `${docSpec.id}.docx`;
    const targetName = `${docSpec.id}.${locale}.docx`;
    console.log(`\n--- DOCX [${docSpec.id}] -> ${locale} ---`);

    const docWorkSrc = path.join(EVAL_ROOT, "work", `docx-src-${docSpec.id}`);
    fs.rmSync(docWorkSrc, { recursive: true, force: true });
    fs.mkdirSync(docWorkSrc, { recursive: true });
    fs.copyFileSync(docSpec.path, path.join(docWorkSrc, filename));

    // Reuse exact Pilot prompt for northstar-policy so Codex cache hits 100% if available
    const promptA =
      docSpec.id === "northstar-policy"
        ? `Translate the DOCX document "northstar-policy.docx" into German ("de") as "northstar-policy.de.docx" using Polyglot MCP tools.
Steps:
1. Call \`prepare\` with document="northstar-policy.docx", targetLocale="de", limit=12, offset=0 (and paginate with offset=12 if hasMore is true) to translate in batches.
2. Preserve EVERY <x id="..."/> and <g id="...">...</g> inline tag verbatim, keep DNT brand names (Northstar, Northstar Pay, PulseGrid, LedgerVault) untranslated, and apply the glossary terms (Workspace -> Arbeitsbereich, Invoice -> Rechnung).
3. Write each batch using \`apply\` with document="northstar-policy.docx", targetFile="northstar-policy.de.docx", targetLocale="de".
4. Run \`check\` to verify the configured document passes with 0 errors.
Reply DONE when complete.`
        : `Translate the DOCX document "${filename}" into "${locale}" as "${targetName}" using Polyglot MCP tools.
Steps:
1. Call \`prepare\` with document="${filename}", targetLocale="${locale}", limit=15, offset=0 (paginate if hasMore is true).
2. Preserve EVERY <x id="..."/> and <g id="...">...</g> inline tag verbatim, keep DNT terms (${docSpec.dntTerms.join(", ")}) untranslated, and follow ${locale} locale conventions.
3. Write each batch via \`apply\` with document="${filename}", targetFile="${targetName}", targetLocale="${locale}".
4. Run \`check\` to verify the document passes with 0 errors.
Reply DONE when complete.`;

    const codexRes = await runCodexWithPolyglot({
      stageName: `docx-part${part}`,
      label: docSpec.id === "northstar-policy" ? "pilot-docx-de" : `docx-${docSpec.id}-${locale}`,
      sourceDir: docWorkSrc,
      prompt: promptA,
      captureRelPaths: [targetName, ".polyglot/documents.json"],
      ignoreSpendCap,
      workspaceSetupFn: (tmpDir) =>
        seedPolyglotProject(tmpDir, [locale], docSpec.glossary, (cfg) => {
          cfg.paths.documents = [filename];
        }),
    });

    const docOutDir = path.join(DOCX_OUT_DIR, docSpec.id);
    fs.mkdirSync(docOutDir, { recursive: true });
    const docxOutA = path.join(docOutDir, `A-${targetName}`);
    const docxOutB = path.join(docOutDir, `B-${targetName}`);

    if (codexRes.capturedFiles[targetName]) {
      fs.writeFileSync(docxOutA, Buffer.from(codexRes.capturedFiles[targetName], "base64"));
    }

    // Verify Polyglot check on A
    const verifyA = path.join(EVAL_ROOT, "work", `docx-verifyA-${docSpec.id}`);
    fs.rmSync(verifyA, { recursive: true, force: true });
    fs.cpSync(docWorkSrc, verifyA, { recursive: true });
    seedPolyglotProject(verifyA, [locale], docSpec.glossary, (cfg) => {
      cfg.paths.documents = [filename];
    });
    for (const [rel, b64] of Object.entries(codexRes.capturedFiles ?? {})) {
      const abs = path.join(verifyA, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(b64, "base64"));
    }
    const checkA = parsePolyglotJson(runPolyglotCli(verifyA, ["check", "--locale", locale, "--json"]));

    // System B: DeepL Document API (checking stage budget before live call)
    const deeplMid = await getDeepLUsage();
    const usedSoFar = deeplMid.character_count - deeplBefore.character_count;
    const localeGlossary = extractGlossaryForLocale(docSpec.glossary, locale);
    const deeplRes = await translateDocxWithDeepL({
      stageName: `docx-part${part}`,
      sourceDocxPath: docSpec.path,
      outputDocxPath: docxOutB,
      targetLocale: locale,
      // Keep northstar-policy cache key identical to pilot (no glossary arg passed in pilot)
      glossaryName: docSpec.id === "northstar-policy" ? null : `docx-${docSpec.id}`,
      glossaryEntries: docSpec.id === "northstar-policy" ? [] : localeGlossary,
      stageCharCap: Math.max(0, DEEPL_STAGE_CHAR_CAP - usedSoFar),
    });

    const srcStruct = inspectDocxStructure(docSpec.path);
    const structA = fs.existsSync(docxOutA) ? inspectDocxStructure(docxOutA) : null;
    const structB = fs.existsSync(docxOutB) ? inspectDocxStructure(docxOutB) : null;

    const loSrc = renderDocxWithLibreOffice(docSpec.path, path.join(docOutDir, "render-src"), "src");
    const loA = fs.existsSync(docxOutA)
      ? renderDocxWithLibreOffice(docxOutA, path.join(docOutDir, "render-A"), `A-${locale}`)
      : null;
    const loB = fs.existsSync(docxOutB)
      ? renderDocxWithLibreOffice(docxOutB, path.join(docOutDir, "render-B"), `B-${locale}`)
      : null;

    const leakA = structA ? measureDocxSourceLeakage(srcStruct.visibleParagraphs, structA.visibleParagraphs, docSpec.dntTerms) : null;
    const leakB = structB ? measureDocxSourceLeakage(srcStruct.visibleParagraphs, structB.visibleParagraphs, docSpec.dntTerms) : null;

    // Judge 15 segments per DOCX (Change #8), explicitly marked low-confidence (Change #6)
    const existingDocxJudge = out.documents[docSpec.id]?.judging ?? null;
    let judging = existingDocxJudge;
    if (structA && structB && judgeMode !== "none" && (!existingDocxJudge || existingDocxJudge.partialJudgeMode)) {
      const commonN = Math.min(
        srcStruct.visibleParagraphs.length,
        structA.visibleParagraphs.length,
        structB.visibleParagraphs.length
      );
      const idxs = pickSampleIndices(commonN, 15);
      const items = idxs.map((i) => ({
        key: `${docSpec.id}-p${i + 1}`,
        source: srcStruct.visibleParagraphs[i],
        category: "docx-segment",
        isChallenge: false,
        context: `${docSpec.id}.docx paragraph ${i + 1}`,
        glossaryHits: localeGlossary.filter((g) =>
          new RegExp(`\\b${g.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, g.caseSensitive ? "" : "i").test(
            srcStruct.visibleParagraphs[i]
          )
        ),
        intendedSense: null,
        candidates: {
          A: structA.visibleParagraphs[i],
          B: structB.visibleParagraphs[i],
        },
      }));
      judging = await runDualJudgeEvaluation({
        stageName: `docx-${docSpec.id}`,
        targetLocale: locale,
        items,
        concurrency: 8,
        seed,
        ignoreSpendCap,
        includeSubtleControls: true,
        lowConfidenceNote: DOCX_LOW_CONFIDENCE_NOTE,
        judgeMode,
      });
    }

    const stripParas = (s) =>
      s ? { ...s, visibleParagraphs: undefined, paragraphCountVisible: s.visibleParagraphs.length } : null;

    out.documents[docSpec.id] = {
      id: docSpec.id,
      targetLocale: locale,
      sourceStructure: stripParas(srcStruct),
      sourcePngPages: loSrc.pngPaths,
      systemA: {
        exitCode: codexRes.exitCode,
        wallMs: codexRes.wallMs,
        cacheHit: codexRes.cacheHit,
        telemetry: normalizeTelemetryPer1k(codexRes.telemetry, srcStruct.visibleParagraphs.length),
        polyglotCheck: {
          outcome: checkA?.outcome,
          errorCount: checkA?.errorCount,
          warningCount: checkA?.warningCount,
        },
        outputPath: docxOutA,
        structure: stripParas(structA),
        libreOfficeOpened: loA?.openedCleanly ?? false,
        pngPages: loA?.pngPaths ?? [],
        sourceLeakage: leakA,
      },
      systemB: {
        wallMs: deeplRes.wallMs,
        cacheHit: deeplRes.cacheHit,
        billedCharacters: deeplRes.billedCharacters,
        usedGlossary: deeplRes.usedGlossary,
        outputPath: docxOutB,
        structure: stripParas(structB),
        libreOfficeOpened: loB?.openedCleanly ?? false,
        pngPages: loB?.pngPaths ?? [],
        sourceLeakage: leakB,
      },
      judging,
    };

    console.log(
      `  [DOCX ${docSpec.id}:${locale}] A(lo=${loA?.openedCleanly},leak=${leakA?.leakedCount},rPr=${structA?.uniqueFormattingRuns}/${srcStruct.uniqueFormattingRuns},check=${checkA?.outcome}) B(lo=${loB?.openedCleanly},leak=${leakB?.leakedCount},rPr=${structB?.uniqueFormattingRuns}/${srcStruct.uniqueFormattingRuns},billed=${deeplRes.billedCharacters})`
    );

    if (docSpec.v2Path) {
      out.incrementalEditTest = await runDocxIncrementalEditTest(docSpec, { ignoreSpendCap });
    }

    atomicWriteJson(outPath, out);
  }

  const deeplAfter = await getDeepLUsage();
  out[`deeplPart${part}`] = {
    before: deeplBefore,
    after: deeplAfter,
    deltaChars: deeplAfter.character_count - deeplBefore.character_count,
  };
  out.glossaryDeletionLog = getGlossaryDeletionLog();
  out.finishedAt = new Date().toISOString();
  atomicWriteJson(outPath, out);

  console.log(
    `\n=== Stage 3B DOCX (part=${part}) Complete | DeepL delta=${deeplAfter.character_count - deeplBefore.character_count} chars ===`
  );
  return out;
}
