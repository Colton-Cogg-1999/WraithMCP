#!/usr/bin/env node
/**
 * Real-World Document Benchmark (eval/results/real-world-v2/docs/)
 *
 * Tests 3 genuinely sourced, complex public English .docx documents (+ optional 52-page NCI SEER scalability test):
 *   1. sop-lay-down-tubulars.docx   — Oil & Gas Rig Floor SOP (19 tables incl. nested tables, 163 segs)
 *   2. hipaa-privacy-notice.docx    — 5-page HIPAA Notice of Privacy Practices (header + 2 footers, formal usted, 91 segs)
 *   3. scientific-manuscript.docx   — Fragmented scientific manuscript (5.09 runs/para, textbox, header/footer, links, 41 segs)
 *   4. nci-seer-52p-stress.docx     — 52-page NCI SEER Cancer Report (864 segs, 117.8k chars, 30 fields, 296 links — scalability test)
 *
 * Subcommands:
 *   node eval/bench/real-world-docs.mjs wraith [docId]   # Wraith extract -> prepare -> Codex translate -> apply -> doc-verify -> QE -> LibreOffice render
 *   node eval/bench/real-world-docs.mjs deepl  [docId]   # DeepL Document API baseline (uses repo .env ONLY; never LocRAG)
 *   node eval/bench/real-world-docs.mjs stress           # 52-page NCI SEER scalability stress test (Wraith extract/apply/verify + timing + memory + partial translate)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const DOCS_SRC_DIR = path.join(EVAL_ROOT, "corpora", "real-docs");
const RESULTS_DIR = path.join(EVAL_ROOT, "results", "real-world-v2", "docs");
const RENDERS_DIR = path.join(RESULTS_DIR, "renders");
const OUT_DOCS_DIR = path.join(RESULTS_DIR, "translated");

process.env.WRAITH_DEEPL_ENV_PATH = path.join(REPO_ROOT, ".env");

const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const CODEX_MODEL = process.env.WRAITH_CODEX_MODEL ?? "gpt-6.2-astra";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const { translateDocxWithDeepL, getDeepLUsage } = await import(path.join(EVAL_ROOT, "lib", "deepl.mjs"));

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });
fs.mkdirSync(OUT_DOCS_DIR, { recursive: true });

const PROVENANCE = JSON.parse(fs.readFileSync(path.join(DOCS_SRC_DIR, "PROVENANCE.json"), "utf8"));

const DOC_STYLE_NOTES = {
  "sop-lay-down-tubulars":
    "Industrial Oil & Gas Rig Floor Standard Operating Procedure (es-MX): use accurate Mexican petroleum/drilling engineering terminology, concise imperative procedure steps, preserve all document codes (240-DOP-1013A), inline XML tags (<g ...>...</g>, <x .../>), and table labels.",
  "hipaa-privacy-notice":
    "Official US HIPAA Notice of Privacy Practices translated to Mexican Spanish (es-MX): use formal 'usted' register consistently throughout, accurate medical/legal privacy terminology ('información médica protegida', 'entidad cubierta'), and preserve all inline XML tags verbatim.",
  "scientific-manuscript":
    "Peer-reviewed Scientific Journal Manuscript Template translated to Mexican Spanish (es-MX): formal academic register, preserve ALL fragmented inline formatting tags (<g id=\"...\" type=\"format\">...</g>, <x .../>) with exact tag IDs and nesting so Word run formatting stays intact.",
};

function parseCodexJsonl(rawJsonl) {
  let modelTurns = 0, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, finalMessage = "";
  for (const line of rawJsonl.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn.completed" && ev.usage) {
        modelTurns++;
        inputTokens += Number(ev.usage.input_tokens ?? 0);
        cachedInputTokens += Number(ev.usage.cached_input_tokens ?? 0);
        outputTokens += Number(ev.usage.output_tokens ?? 0);
      }
      if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item?.text) {
        finalMessage = ev.item.text;
      }
    } catch {}
  }
  return { modelTurns, inputTokens, cachedInputTokens, outputTokens, finalMessage };
}

function extractJsonFromText(text) {
  const trimmed = (text || "").trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start >= 0) {
    const endChar = trimmed[start] === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(endChar);
    if (end > start) return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error(`Could not parse JSON from Codex output (${trimmed.slice(0, 200)})`);
}

function runCodex(prompt, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(
      CODEX_BIN,
      ["exec", "--ephemeral", "--json", "--model", CODEX_MODEL, "--sandbox", "read-only", "--skip-git-repo-check", "-"],
      { cwd: RESULTS_DIR, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }
    );
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Codex timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseCodexJsonl(stdout);
      if (code !== 0 && !parsed.finalMessage) return reject(new Error(`Codex exit ${code}: ${stderr.slice(-400)}`));
      resolve({ ...parsed, durationMs: Date.now() - t0 });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function renderDocxToPngs(docxPath, prefix) {
  const tmpDir = path.join(RENDERS_DIR, `_tmp_${prefix}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, docxPath], {
    stdio: "pipe",
    timeout: 120_000,
    env: { ...process.env, HOME: "/tmp" },
  });
  const pdfFile = fs.readdirSync(tmpDir).find((f) => f.endsWith(".pdf"));
  if (!pdfFile) throw new Error(`LibreOffice produced no PDF for ${docxPath}`);
  const pdfPath = path.join(tmpDir, pdfFile);
  execFileSync("pdftoppm", ["-png", "-r", "140", pdfPath, path.join(RENDERS_DIR, prefix)], {
    stdio: "pipe",
    timeout: 120_000,
  });
  const pngs = fs
    .readdirSync(RENDERS_DIR)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".png"))
    .sort();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return pngs;
}

function estimateCodexUsd(u) {
  const uncached = Math.max(0, (u.inputTokens || 0) - (u.cachedInputTokens || 0));
  return +((uncached * 2.5 + (u.cachedInputTokens || 0) * 0.25 + (u.outputTokens || 0) * 10.0) / 1_000_000).toFixed(4);
}

async function runWraithDoc(docMeta) {
  const srcPath = path.join(DOCS_SRC_DIR, docMeta.file);
  const outPath = path.join(OUT_DOCS_DIR, `${docMeta.id}.wraith.${docMeta.targetLocale}.docx`);
  const summaryPath = path.join(RESULTS_DIR, `${docMeta.id}.wraith.json`);
  if (fs.existsSync(summaryPath) && fs.existsSync(outPath)) {
    console.log(`[DOC WRAITH ${docMeta.id}] Already complete.`);
    return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  }

  const t0 = Date.now();
  const adapter = wraith.getDocumentAdapter(srcPath);
  const extracted = adapter.extract(srcPath);
  const segs = extracted.segments;
  console.log(`[DOC WRAITH ${docMeta.id}] Extracted ${segs.length} segments (${extracted.stats.wordCount} words, parts=${extracted.stats.parts.join(",")})`);

  // Render original source pages once
  const origPngs = renderDocxToPngs(srcPath, `${docMeta.id}-en`);

  // Translate in batches of 45 segments with full document outline context
  const docOutline = segs.slice(0, 25).map((s) => `[${s.id}] ${s.plainText.slice(0, 100)}`).join("\n");
  const translations = {};
  const usage = { modelTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0 };

  const batchSize = 45;
  for (let i = 0; i < segs.length; i += batchSize) {
    const batch = segs.slice(i, i + batchSize);
    const payload = {};
    for (const s of batch) payload[s.id] = s.text;

    let attempt = 0;
    let errHint = "";
    while (attempt < 3) {
      attempt++;
      const prompt = `Translate the following Microsoft Word (.docx) document segments from English to ${docMeta.targetLocale}.

Document: ${docMeta.title}
Style & Domain Guidance:
${DOC_STYLE_NOTES[docMeta.id]}

CRITICAL INLINE TAG RULES:
- Every <g id="..." type="...">...</g> and <x id="..." type="..."/> tag MUST be preserved with its EXACT id and type attributes and balanced closing tags.
- Do NOT drop, rename, or merge tags. You may reorder <g> tags only if target grammar requires it.
- Keep pure codes/numbers/dates appropriately localized without breaking structure.

Document Opening Context:
${docOutline}
${errHint ? `\nFIX THESE TAG VALIDATION ERRORS FROM PREVIOUS ATTEMPT:\n${errHint}\n` : ""}
Return ONLY a valid JSON object mapping each exact segment id to its translated string:
${JSON.stringify(payload, null, 2)}
`;
      const res = await runCodex(prompt);
      usage.modelTurns += res.modelTurns;
      usage.inputTokens += res.inputTokens;
      usage.cachedInputTokens += res.cachedInputTokens;
      usage.outputTokens += res.outputTokens;
      usage.durationMs += res.durationMs;

      const obj = extractJsonFromText(res.finalMessage);
      // Validate tags against source before accepting
      const bad = [];
      for (const s of batch) {
        const val = obj[s.id];
        if (typeof val !== "string") {
          bad.push(`${s.id}: missing translation`);
          continue;
        }
        const st = wraith.extractInlineTags(s.text);
        const tt = wraith.extractInlineTags(val);
        if (!tt.balanced || JSON.stringify(st.selfClosing) !== JSON.stringify(tt.selfClosing) || JSON.stringify(st.paired) !== JSON.stringify(tt.paired)) {
          bad.push(`${s.id}: inline tag mismatch (source=${s.text.slice(0, 100)})`);
        } else {
          translations[s.id] = val;
        }
      }
      if (bad.length === 0) {
        console.log(`  [DOC WRAITH ${docMeta.id}] batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(segs.length / batchSize)}: ${batch.length}/${batch.length} valid`);
        break;
      }
      errHint = bad.join("\n");
      console.log(`  [DOC WRAITH ${docMeta.id}] batch ${Math.floor(i / batchSize) + 1} had ${bad.length} tag mismatches; retrying (attempt ${attempt})...`);
      if (attempt >= 3) {
        // Fallback to source only for stubbornly broken segments so apply never fails silently
        for (const s of batch) {
          if (!translations[s.id]) translations[s.id] = s.text;
        }
      }
    }
  }

  const updates = segs.map((s) => ({ id: s.id, text: translations[s.id] ?? s.text }));
  const applyRes = adapter.apply(srcPath, outPath, updates);
  if (!applyRes.ok) {
    throw new Error(`DOCX apply failed for ${docMeta.id}: ${JSON.stringify(applyRes.errors.slice(0, 5))}`);
  }

  const verifyRes = wraith.verifyDocumentFormatting({ sourceFile: srcPath, targetFile: outPath });
  const transPngs = renderDocxToPngs(outPath, `${docMeta.id}-wraith-${docMeta.targetLocale}`);

  const summary = {
    id: docMeta.id,
    title: docMeta.title,
    targetLocale: docMeta.targetLocale,
    sourceFile: srcPath,
    outputFile: outPath,
    segmentsTotal: segs.length,
    segmentsUpdated: applyRes.segmentsUpdated,
    wordCount: extracted.stats.wordCount,
    parts: extracted.stats.parts,
    unsupportedParts: extracted.stats.unsupportedParts ?? [],
    verify: verifyRes,
    originalPages: origPngs.length,
    translatedPages: transPngs.length,
    originalPngs: origPngs,
    translatedPngs: transPngs,
    usage: { ...usage, estimatedUsd: estimateCodexUsd(usage), wallMs: Date.now() - t0 },
    segments: segs.map((s) => ({ id: s.id, part: s.part, source: s.text, translated: translations[s.id] ?? s.text })),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[DOC WRAITH ${docMeta.id}] Done: ${origPngs.length}p -> ${transPngs.length}p, verifyPassed=${verifyRes.passed}, est=$${summary.usage.estimatedUsd}`);
  return summary;
}

async function runDeepLDoc(docMeta) {
  const srcPath = path.join(DOCS_SRC_DIR, docMeta.file);
  const outPath = path.join(OUT_DOCS_DIR, `${docMeta.id}.deepl.${docMeta.targetLocale}.docx`);
  const summaryPath = path.join(RESULTS_DIR, `${docMeta.id}.deepl.json`);
  if (fs.existsSync(summaryPath) && fs.existsSync(outPath)) {
    console.log(`[DOC DEEPL ${docMeta.id}] Already complete.`);
    return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  }
  const usageBefore = await getDeepLUsage();
  console.log(`[DOC DEEPL ${docMeta.id}] DeepL remaining=${usageBefore.remaining} chars`);
  if (usageBefore.remaining < 50_000) {
    throw new Error(`Insufficient DeepL quota in repo .env (${usageBefore.remaining} < 50,000 minimum per DOCX).`);
  }
  const t0 = Date.now();
  const res = await translateDocxWithDeepL({
    stageName: `real-doc-${docMeta.id}`,
    inputDocxPath: srcPath,
    outputDocxPath: outPath,
    targetLocale: docMeta.targetLocale,
    stageCap: 150_000,
  });
  const usageAfter = await getDeepLUsage();
  const billedChars = Math.max(0, usageAfter.character_count - usageBefore.character_count);
  const verifyRes = wraith.verifyDocumentFormatting({ sourceFile: srcPath, targetFile: outPath });
  const transPngs = renderDocxToPngs(outPath, `${docMeta.id}-deepl-${docMeta.targetLocale}`);

  // Extract DeepL translated text via Wraith adapter for blinded MQM comparison
  const adapter = wraith.getDocumentAdapter(outPath);
  const deeplExtracted = adapter.extract(outPath);

  const summary = {
    id: docMeta.id,
    title: docMeta.title,
    targetLocale: docMeta.targetLocale,
    outputFile: outPath,
    billedChars,
    estimatedUsd: +((billedChars * 25.0) / 1_000_000).toFixed(4),
    durationMs: Date.now() - t0,
    verify: verifyRes,
    translatedPages: transPngs.length,
    translatedPngs: transPngs,
    segments: deeplExtracted.segments.map((s) => ({ id: s.id, part: s.part, text: s.text })),
    deeplMeta: res,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[DOC DEEPL ${docMeta.id}] Done: ${transPngs.length}p, billed=${billedChars} chars ($${summary.estimatedUsd}), verifyPassed=${verifyRes.passed}`);
  return summary;
}

async function run52PageStressTest() {
  const docMeta = PROVENANCE.documents.find((d) => d.id === "nci-seer-52p-stress");
  const srcPath = path.join(DOCS_SRC_DIR, docMeta.file);
  const outPath = path.join(OUT_DOCS_DIR, `${docMeta.id}.wraith.es-MX.docx`);
  const summaryPath = path.join(RESULTS_DIR, `${docMeta.id}.stress.json`);

  const mem0 = process.memoryUsage().rss;
  const tExtract0 = Date.now();
  const adapter = wraith.getDocumentAdapter(srcPath);
  const extracted = adapter.extract(srcPath);
  const extractMs = Date.now() - tExtract0;

  // Test byte-identical no-op apply + real translation of first 60 segments (covering title, tables, links, fields)
  const noopPath = path.join(OUT_DOCS_DIR, `${docMeta.id}.noop.docx`);
  const tNoop0 = Date.now();
  const noopRes = adapter.apply(srcPath, noopPath, extracted.segments.map((s) => ({ id: s.id, text: s.text })));
  const noopMs = Date.now() - tNoop0;

  // Translate first 50 non-trivial segments with Codex to stress-test live XML splicing at 52-page scale
  const sampleSegs = extracted.segments.filter((s) => s.plainText.trim().length > 12).slice(0, 50);
  const payload = {};
  for (const s of sampleSegs) payload[s.id] = s.text;
  const prompt = `Translate these 50 segments from a 52-page US National Cancer Institute SEER cancer statistics report into Mexican Spanish (es-MX).
Preserve ALL <g id="..." type="...">...</g> and <x id="..." type="..."/> inline tags with exact IDs and types.
Return ONLY a valid JSON object mapping each exact segment id to its translated string:
${JSON.stringify(payload, null, 2)}
`;
  const codexRes = await runCodex(prompt);
  const obj = extractJsonFromText(codexRes.finalMessage);
  const updates = extracted.segments.map((s) => {
    const candidate = obj[s.id];
    if (typeof candidate === "string") {
      const st = wraith.extractInlineTags(s.text);
      const tt = wraith.extractInlineTags(candidate);
      if (tt.balanced && JSON.stringify(st.selfClosing) === JSON.stringify(tt.selfClosing) && JSON.stringify(st.paired) === JSON.stringify(tt.paired)) {
        return { id: s.id, text: candidate };
      }
    }
    return { id: s.id, text: s.text };
  });

  const tApply0 = Date.now();
  const applyRes = adapter.apply(srcPath, outPath, updates);
  const applyMs = Date.now() - tApply0;
  const tVerify0 = Date.now();
  const verifyRes = wraith.verifyDocumentFormatting({ sourceFile: srcPath, targetFile: outPath });
  const verifyMs = Date.now() - tVerify0;
  const memPeak = process.memoryUsage().rss;

  const summary = {
    id: docMeta.id,
    title: docMeta.title,
    segmentsTotal: extracted.segments.length,
    wordCount: extracted.stats.wordCount,
    sampleTranslatedCount: updates.filter((u, idx) => u.text !== extracted.segments[idx].text).length,
    extractMs,
    noopApplyMs: noopMs,
    noopByteIdentical: noopRes.byteIdentical,
    mutatedApplyMs: applyMs,
    mutatedApplyOk: applyRes.ok,
    verifyMs,
    verifyOutcome: verifyRes.outcome,
    verifyFindings: verifyRes.findings,
    rssDeltaMB: +((memPeak - mem0) / (1024 * 1024)).toFixed(1),
    codexUsage: {
      inputTokens: codexRes.inputTokens,
      cachedInputTokens: codexRes.cachedInputTokens,
      outputTokens: codexRes.outputTokens,
      durationMs: codexRes.durationMs,
      estimatedUsd: estimateCodexUsd(codexRes),
    },
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log("[52-PAGE STRESS]", JSON.stringify(summary, null, 2));
  return summary;
}

const [, , cmd, targetId] = process.argv;
const coreDocs = PROVENANCE.documents.filter((d) => !d.scalabilityOnly);
const selected = targetId ? coreDocs.filter((d) => d.id === targetId) : coreDocs;

if (cmd === "wraith") {
  for (const d of selected) await runWraithDoc(d);
} else if (cmd === "deepl") {
  for (const d of selected) await runDeepLDoc(d);
} else if (cmd === "stress") {
  await run52PageStressTest();
} else {
  console.log("Usage: node eval/bench/real-world-docs.mjs <wraith|deepl|stress> [docId]");
}
