#!/usr/bin/env node
/**
 * Real-World Unprepared Localization Engineering Evaluation
 *
 * Compares Vanilla Codex (A0) vs. Codex + Simplified Wraith (W) across the COMPLETE
 * localization engineering workflow on genuinely unprepared content:
 *   Stage 1: Real-world monolingual OSS app (nicbet/toodle — React/Vite/TS/Tailwind, 0 i18n) -> en, es-MX, ar
 *            Evaluates extraction, formatting/RTL prep, build/tsc, Playwright functional & visual QA, tokens/cost.
 *   Stage 2: Real-world complex DOCX (sop-lay-down-tubulars.docx — 19 nested tables, 163 segs) -> es-MX
 *            Evaluates OOXML integrity, nested tables, header/footer, codes, LibreOffice doc-verify, renders, tokens/cost.
 *   Stage 3: Maintenance cycle (v1 -> v2 source changes + human translation corrections) on BOTH app and DOCX.
 *            Evaluates human-edit preservation, targeted incremental updates, structural/build integrity, tokens/cost.
 *   Stage 4: Diagnostic-only QE (scope=risk) + Crowdin XLIFF 1.2 / XLIFF 2.0 round-trip + human-verified protection.
 *
 * Preserves all historical benchmark results untouched.
 * Outputs to eval/results/unprepared-e2e/results.json + screenshots + doc renders.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "eval", "results", "unprepared-e2e");
const SCREENSHOTS_DIR = path.join(OUT_DIR, "screenshots");
const DOC_RENDERS_DIR = path.join(OUT_DIR, "doc-renders");
const WORK_DIR = path.join(os.tmpdir(), `wraith-unprepared-e2e-${Date.now()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(DOC_RENDERS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const NODE_BIN = process.execPath;
const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const WRAITH_BIN = path.join(REPO_ROOT, "dist", "bin.js");
const TOODLE_SRC = "/tmp/unprepared-candidates/toodle";
const SOP_DOC_SRC = path.join(REPO_ROOT, "eval", "corpora", "real-docs", "sop-lay-down-tubulars.docx");
const CHROME_PATH = "/home/colton/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const fflate = await import("fflate");
const PW_PATH = "/home/colton/.local/share/mise/installs/playwright/latest/node_modules/playwright/index.js";
const pwMod = await import(fs.existsSync(PW_PATH) ? PW_PATH : "playwright");
const chromium = pwMod.chromium ?? pwMod.default?.chromium;

function parseCodexJsonl(raw) {
  let modelTurns = 0, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0;
  let mcpCallsCount = 0, shellCallsCount = 0;
  const mcpCallsByTool = {};
  let lastMessage = "";
  const errors = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn.completed" && ev.usage) {
        modelTurns++;
        inputTokens += Number(ev.usage.input_tokens ?? 0);
        cachedInputTokens += Number(ev.usage.cached_input_tokens ?? 0);
        outputTokens += Number(ev.usage.output_tokens ?? 0);
      } else if (ev.type === "item.completed" && ev.item) {
        if (ev.item.type === "mcp_tool_call") {
          mcpCallsCount++;
          const tool = ev.item.tool || ev.item.name || "unknown";
          mcpCallsByTool[tool] = (mcpCallsByTool[tool] || 0) + 1;
        } else if (ev.item.type === "command_execution") {
          shellCallsCount++;
        } else if (ev.item.type === "agent_message" && ev.item.text) {
          lastMessage = ev.item.text;
        }
      } else if (ev.type === "error" || ev.type === "turn.failed") {
        errors.push(ev.message || ev.error?.message || JSON.stringify(ev));
      }
    } catch {}
  }
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const estApiUsd = +((uncachedInputTokens * 2.5 + cachedInputTokens * 0.25 + outputTokens * 10.0) / 1_000_000).toFixed(4);
  return {
    modelTurns,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    mcpCallsCount,
    mcpCallsByTool,
    shellCallsCount,
    estApiUsd,
    lastMessage: lastMessage.slice(0, 500),
    errors,
  };
}

async function runCodex({ label, cwd, prompt, useWraith = false, timeoutMs = 480_000 }) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--trust",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "-C",
    cwd,
  ];
  if (useWraith) {
    args.push(
      "-c",
      `mcp_servers.wraith.command=${JSON.stringify(NODE_BIN)}`,
      "-c",
      `mcp_servers.wraith.args=${JSON.stringify([WRAITH_BIN, "mcp"])}`
    );
  }
  args.push("-");
  console.log(`\n[${label}] starting (wraith=${useWraith})...`);
  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill("SIGTERM"); resolve({ exitCode: -1, stdout: out, stderr: err, timedOut: true }); }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout: out, stderr: err, timedOut: false }); }
    });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
  const wallS = +((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.jsonl`), stdout, "utf8");
  const telemetry = parseCodexJsonl(stdout);
  console.log(
    `[${label}] done ${wallS}s | exit=${exitCode} in=${telemetry.inputTokens} (uncached=${telemetry.uncachedInputTokens}) out=${telemetry.outputTokens} mcp=${telemetry.mcpCallsCount} sh=${telemetry.shellCallsCount} est=$${telemetry.estApiUsd}`
  );
  if (exitCode !== 0 || telemetry.errors.length > 0) {
    console.warn(`[${label}] warn:`, stderr.slice(0, 300), telemetry.errors.slice(0, 2));
  }
  return { exitCode, timedOut, wallS, telemetry };
}

function runShellCheck(cwd, cmd, args) {
  try {
    execFileSync(cmd, args, { cwd, stdio: "pipe", timeout: 120_000 });
    return { ok: true, error: null };
  } catch (err) {
    const msg = (err.stderr?.toString() || err.stdout?.toString() || err.message || "").slice(-500);
    return { ok: false, error: msg };
  }
}

function copyToodle(destDir) {
  fs.cpSync(TOODLE_SRC, destDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) && !src.includes(`${path.sep}dist`),
  });
}

function findLocaleJsonFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".wraith"].includes(ent.name)) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(json)$/i.test(ent.name) && /(?:^|\/)(?:locales|i18n|messages|translations)\b/i.test(path.relative(dir, full))) {
        found.push(path.relative(dir, full));
      }
    }
  };
  walk(dir);
  return found.sort();
}

function flattenJson(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenJson(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
}

async function evaluateToodleInPlaywright(appDir, armTag) {
  const distDir = path.join(appDir, "dist");
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    return { buildAvailable: false, error: "dist/index.html missing" };
  }
  // Serve dist/ on an ephemeral localhost port
  const mimeTypes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const reqPath = (req.url || "/").split("?")[0];
    const rel = reqPath === "/" ? "index.html" : reqPath.replace(/^\/+/, "");
    const abs = path.join(distDir, rel);
    const target = fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : path.join(distDir, "index.html");
    const ext = path.extname(target);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(target).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    headless: true,
  });

  const localeReports = {};
  try {
    for (const loc of ["en", "es-MX", "ar"]) {
      const locRes = { viewports: {}, functional: {} };
      for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "mobile", width: 375, height: 812 }]) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, locale: loc });
        const page = await context.newPage();
        const pageErrors = [];
        const consoleErrors = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

        await page.goto(`${baseUrl}/?locale=${encodeURIComponent(loc)}`, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(400);

        const domMetrics = await page.evaluate(() => {
          const html = document.documentElement;
          const bodyText = (document.body.innerText || "").trim();
          const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
          let clippedCount = 0;
          const clippedSamples = [];
          for (const el of document.querySelectorAll("h1,h2,h3,button,a,span,p,div,label")) {
            const st = getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 2 || rect.height <= 2) continue;
            if (st.clip === "rect(0px, 0px, 0px, 0px)" || st.clipPath?.includes("inset(50%)")) continue;
            if (el.children.length === 0 && (el.textContent || "").trim().length > 0) {
              if ((st.overflowX === "hidden" || st.overflow === "hidden") && el.scrollWidth > el.clientWidth + 2) {
                clippedCount++;
                if (clippedSamples.length < 5) clippedSamples.push((el.textContent || "").trim().slice(0, 40));
              }
            }
          }
          const rawIcuLeak = /\{[\w]+,\s*(?:plural|select)\b/.test(bodyText);
          return {
            dir: html.getAttribute("dir") || getComputedStyle(html).direction,
            lang: html.getAttribute("lang") || "",
            overflowPx,
            clippedCount,
            clippedSamples,
            rawIcuLeak,
            emptyStateText: bodyText.slice(0, 200),
          };
        });

        // Functional check on desktop viewport: add a todo, open shortcuts modal
        if (vp.name === "desktop") {
          let addedTodo = false;
          let modalOpened = false;
          let modalTitle = "";
          try {
            await page.keyboard.press("/");
            await page.waitForTimeout(250);
            const input = page.locator("input[type='text'], textarea").first();
            if (await input.isVisible({ timeout: 2000 })) {
              await input.fill("Review budget tomorrow #work");
              await input.press("Enter");
              await page.waitForTimeout(350);
              const textAfterAdd = await page.evaluate(() => document.body.innerText);
              addedTodo = textAfterAdd.includes("Review budget");
            }
            // Blur input before pressing ?
            await page.keyboard.press("Escape");
            await page.waitForTimeout(150);
            await page.keyboard.press("?");
            await page.waitForTimeout(300);
            const h2 = page.locator("h2").first();
            if (await h2.isVisible({ timeout: 2000 })) {
              modalTitle = (await h2.innerText()).trim();
              modalOpened = modalTitle.length > 0;
            }
            await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${armTag}-${loc}-desktop-modal.png`), fullPage: false });
          } catch (e) {
            locRes.functional.error = e.message;
          }
          locRes.functional = { addedTodo, modalOpened, modalTitle, ...locRes.functional };
        } else {
          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${armTag}-${loc}-mobile.png`), fullPage: false });
        }

        locRes.viewports[vp.name] = { ...domMetrics, pageErrors, consoleErrors };
        await context.close();
      }
      localeReports[loc] = locRes;
    }
  } finally {
    await browser.close();
    server.close();
  }
  return { buildAvailable: true, locales: localeReports };
}

function renderDocxPages(docxPath, prefix) {
  const tmpDir = path.join(DOC_RENDERS_DIR, `_tmp_${prefix}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", tmpDir, docxPath], {
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, HOME: "/tmp" },
    });
    const pdf = fs.readdirSync(tmpDir).find((f) => f.endsWith(".pdf"));
    if (!pdf) return [];
    execFileSync("pdftoppm", ["-png", "-r", "120", path.join(tmpDir, pdf), path.join(DOC_RENDERS_DIR, prefix)], {
      stdio: "pipe",
      timeout: 120_000,
    });
    return fs.readdirSync(DOC_RENDERS_DIR).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".png")).sort();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function inspectDocx(srcPath, tgtPath) {
  if (!fs.existsSync(tgtPath)) return { exists: false, validZip: false };
  try {
    const srcEx = wraith.extractDocument(srcPath);
    const tgtEx = wraith.extractDocument(tgtPath);
    const tgtById = new Map(tgtEx.segments.map((s) => [s.id, s.plainText]));
    let translated = 0, unchangedEnglish = 0, headersTranslated = 0, footersTranslated = 0;
    for (const s of srcEx.segments) {
      const t = tgtById.get(s.id) ?? "";
      const changed = t && t.trim() !== s.plainText.trim();
      if (changed) {
        translated++;
        if (s.part.includes("header")) headersTranslated++;
        if (s.part.includes("footer")) footersTranslated++;
      } else if (/[a-zA-Z]{4,}/.test(s.plainText)) {
        unchangedEnglish++;
      }
    }
    const rawZip = fflate.unzipSync(fs.readFileSync(tgtPath));
    const docXml = fflate.strFromU8(rawZip["word/document.xml"] || new Uint8Array());
    const tableCount = (docXml.match(/<w:tbl\b/g) || []).length;
    const codePreserved = Object.values(rawZip).some((u8) => fflate.strFromU8(u8).includes("240-DOP-1013A"));
    const verify = wraith.verifyDocumentFormatting({ sourceFile: srcPath, targetFile: tgtPath });
    return {
      exists: true,
      validZip: true,
      totalSegments: srcEx.segments.length,
      targetSegments: tgtEx.segments.length,
      translatedSegments: translated,
      unchangedEnglishSegments: unchangedEnglish,
      headersTranslated,
      footersTranslated,
      tableCount,
      codePreserved,
      docVerifyOutcome: verify.outcome,
      sourcePages: verify.sourcePages,
      targetPages: verify.targetPages,
      docVerifyFindings: verify.findings.map((f) => `${f.severity}:${f.code}`),
    };
  } catch (err) {
    return { exists: true, validZip: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ============================================================================================
 * STAGE 1: Real-World Monolingual App (nicbet/toodle) -> en, es-MX, ar
 * ========================================================================================== */
async function runStage1Toodle() {
  const dirA0 = path.join(WORK_DIR, "toodle_A0");
  const dirW = path.join(WORK_DIR, "toodle_W");
  copyToodle(dirA0);
  copyToodle(dirW);

  // Initialize Wraith ONLY in dirW
  wraith.initProject({ rootDir: dirW, sourceLocale: "en", targetLocales: ["es-MX", "ar"], writeAgentRule: false });
  const storeW = new wraith.WraithStore(dirW);
  const cfgW = storeW.readConfig();
  cfgW.styleGuide = {
    instructions: "Keep task-manager UI concise, friendly, and natural. Preserve keyboard shortcut hints cleanly.",
    byLocale: {
      "es-MX": "Use Mexican Spanish informal 'tú' register (avoid Spain-only 'vosotros').",
      ar: "Use clear Modern Standard Arabic with proper Arabic plural forms and RTL layout.",
    },
  };
  storeW.writeConfig(cfgW);
  storeW.upsertGlossaryEntry({ term: "Toodle", doNotTranslate: true, caseSensitive: true, origin: "user" });

  const commonPrompt = `This is a monolingual English React + Vite + TypeScript + Tailwind todo app ("Toodle") with zero existing localization infrastructure.
Internationalize and localize the complete application for English (en), Mexican Spanish (es-MX), and Arabic (ar):
1. Install and configure react-i18next + i18next (standard JSON locale files under src/locales/ or locales/ with en.json, es-MX.json, ar.json).
2. Extract ALL user-facing hardcoded strings, split sentence fragments (e.g. "Press / to add your first todo"), and pluralized counts cleanly into locale JSON catalogs — no leftover hardcoded English UI copy.
3. Fix hardcoded/locale-less date formatting in src/utils/schedule.ts to pass the active locale explicitly to Intl.DateTimeFormat.
4. Support locale selection via URL query parameter \`?locale=en|es-MX|ar\` (defaulting to \`en\`) PLUS a compact language switcher control in the header, and dynamically update \`document.documentElement.lang\` and \`document.documentElement.dir\` (\`"rtl"\` for Arabic, \`"ltr"\` otherwise). Fix physical CSS/directional layout so Arabic RTL renders cleanly on desktop (1280px) and mobile (375px).
5. Keep the brand name "Toodle" untranslated. Use natural Mexican Spanish (tú) and Modern Standard Arabic.
6. Ensure \`npm run lint\` (tsc --noEmit) and \`npm run build\` pass cleanly. Do not leave a dev server running.`;

  const promptA0 = commonPrompt;
  const promptW = `${commonPrompt}\n\nUse the Wraith MCP tools (scan, prepare, apply, check) to discover hardcoded strings/formatting, manage catalogs losslessly, and verify deterministic checks pass.`;

  const runA0 = await runCodex({ label: "stage1_toodle_A0", cwd: dirA0, prompt: promptA0, useWraith: false });
  const runW = await runCodex({ label: "stage1_toodle_W", cwd: dirW, prompt: promptW, useWraith: true });

  const evalArm = async (dir, tag) => {
    const lint = runShellCheck(dir, "npm", ["run", "lint"]);
    const build = runShellCheck(dir, "npm", ["run", "build"]);
    const localeFiles = findLocaleJsonFiles(dir);
    // Independent Wraith scan + check (on A0, run read-only after temporarily detecting or checking)
    const scan = wraith.scanProject({ rootDir: dir, saveUsage: false, limit: 100 });
    // Ensure check sees en, es-MX, ar even on A0 without mutating A0's app source
    let checkSummary;
    try {
      const tmpConfigNeeded = !fs.existsSync(path.join(dir, ".wraith/config.json"));
      if (tmpConfigNeeded) {
        wraith.initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX", "ar"], writeAgentRule: false });
      }
      const chk = wraith.runCheck({ rootDir: dir, limit: 200 });
      checkSummary = {
        outcome: chk.outcome,
        errorCount: chk.errorCount,
        warningCount: chk.warningCount,
        totalSourceKeys: chk.totalSourceKeys,
        countsByCode: chk.countsByCode,
      };
      if (tmpConfigNeeded) fs.rmSync(path.join(dir, ".wraith"), { recursive: true, force: true });
    } catch (e) {
      checkSummary = { error: e.message };
    }
    const playwright = build.ok ? await evaluateToodleInPlaywright(dir, tag) : { buildAvailable: false };
    return { lint, build, localeFiles, scanCounts: scan.counts, i18nLibrary: scan.i18nLibrary, checkSummary, playwright };
  };

  const evalA0 = await evalArm(dirA0, "stage1_A0");
  const evalW = await evalArm(dirW, "stage1_W");

  return {
    dirs: { dirA0, dirW },
    A0_vanilla: { wallS: runA0.wallS, telemetry: runA0.telemetry, evaluation: evalA0 },
    W_simplified: { wallS: runW.wallS, telemetry: runW.telemetry, evaluation: evalW },
  };
}

/* ============================================================================================
 * STAGE 2: Complex Real-World Word Document (sop-lay-down-tubulars.docx, 19 tables, 163 segs)
 * ========================================================================================== */
async function runStage2Docx() {
  const dirA0 = path.join(WORK_DIR, "docx_A0");
  const dirW = path.join(WORK_DIR, "docx_W");
  for (const d of [dirA0, dirW]) {
    fs.mkdirSync(path.join(d, "docs"), { recursive: true });
    fs.copyFileSync(SOP_DOC_SRC, path.join(d, "docs/sop-lay-down-tubulars.docx"));
  }
  wraith.initProject({ rootDir: dirW, sourceLocale: "en", targetLocales: ["es-MX"], documents: ["docs"], writeAgentRule: false });
  const storeW = new wraith.WraithStore(dirW);
  const cfgW = storeW.readConfig();
  cfgW.styleGuide = {
    instructions: "Industrial Oil & Gas Rig Floor Standard Operating Procedure translated to Mexican Spanish (es-MX): accurate drilling engineering terminology, concise imperative steps, preserve document code 240-DOP-1013A and all inline formatting.",
  };
  storeW.writeConfig(cfgW);

  const commonPrompt = `Translate docs/sop-lay-down-tubulars.docx (an Oil & Gas Rig Floor Standard Operating Procedure with 19 tables including nested tables, headers, footers, and fragmented bold/italic runs) into Mexican Spanish (es-MX).
Save the translated document to docs/sop-lay-down-tubulars.es-MX.docx.
Preserve ALL 19 tables, nested tables, inline formatting, headers, footers, document code "240-DOP-1013A", and OOXML structure. Never overwrite the source file.`;

  const runA0 = await runCodex({ label: "stage2_docx_A0", cwd: dirA0, prompt: commonPrompt, useWraith: false });
  const runW = await runCodex({
    label: "stage2_docx_W",
    cwd: dirW,
    prompt: `${commonPrompt}\n\nUse the Wraith MCP prepare and apply tools for documents.`,
    useWraith: true,
  });

  const srcA0 = path.join(dirA0, "docs/sop-lay-down-tubulars.docx");
  const tgtA0 = path.join(dirA0, "docs/sop-lay-down-tubulars.es-MX.docx");
  const srcW = path.join(dirW, "docs/sop-lay-down-tubulars.docx");
  const tgtW = path.join(dirW, "docs/sop-lay-down-tubulars.es-MX.docx");

  const inspA0 = inspectDocx(srcA0, tgtA0);
  const inspW = inspectDocx(srcW, tgtW);
  const rendersEn = renderDocxPages(SOP_DOC_SRC, "sop-en");
  const rendersA0 = inspA0.validZip ? renderDocxPages(tgtA0, "sop-A0-es-MX") : [];
  const rendersW = inspW.validZip ? renderDocxPages(tgtW, "sop-W-es-MX") : [];

  return {
    dirs: { dirA0, dirW },
    A0_vanilla: { wallS: runA0.wallS, telemetry: runA0.telemetry, evaluation: { ...inspA0, renders: rendersA0 } },
    W_simplified: { wallS: runW.wallS, telemetry: runW.telemetry, evaluation: { ...inspW, renders: rendersW } },
    sourceRenders: rendersEn,
  };
}

/* ============================================================================================
 * STAGE 3: Maintenance Cycle (v1 -> v2 Source Changes + Human Corrections) on App & DOCX
 * ========================================================================================== */
function patchJsonKey(filePath, targetKey, newValue) {
  const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (targetKey in obj && typeof obj[targetKey] === "string") {
    obj[targetKey] = newValue;
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
    return true;
  }
  const parts = targetKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur || typeof cur[parts[i]] !== "object") return false;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur[parts[parts.length - 1]] === "string") {
    cur[parts[parts.length - 1]] = newValue;
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
    return true;
  }
  return false;
}

function getJsonKey(filePath, targetKey) {
  const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (targetKey in obj && typeof obj[targetKey] === "string") return obj[targetKey];
  let cur = obj;
  for (const p of targetKey.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return typeof cur === "string" ? cur : undefined;
}

async function runStage3Maintenance(stage1Dirs, stage2Dirs) {
  /* --- 3A: App Maintenance (Toodle v1 -> v2) --- */
  const appMaint = {};
  for (const [arm, dir, useWraith] of [
    ["A0_vanilla", stage1Dirs.dirA0, false],
    ["W_simplified", stage1Dirs.dirW, true],
  ]) {
    const locFiles = findLocaleJsonFiles(dir);
    const enRel = locFiles.find((f) => /(?:^|\/)en\.json$/i.test(f));
    const esRel = locFiles.find((f) => /(?:^|\/)es-MX\.json$/i.test(f));
    const arRel = locFiles.find((f) => /(?:^|\/)ar\.json$/i.test(f));
    if (!enRel || !esRel || !arRel) {
      appMaint[arm] = { skipped: true, reason: `Missing standard locale JSON files (${locFiles.join(", ")})` };
      continue;
    }
    const enAbs = path.join(dir, enRel);
    const esAbs = path.join(dir, esRel);
    const arAbs = path.join(dir, arRel);
    const flatEn = flattenJson(JSON.parse(fs.readFileSync(enAbs, "utf8")));
    const allKeys = Object.keys(flatEn);
    // Pick 2 human-edited keys (keep source unchanged) and 2 keys whose English source will change in v2
    const humanKey1 = allKeys[0];
    const humanKey2 = allKeys[Math.min(1, allKeys.length - 1)];
    const sourceEditKey1 = allKeys[Math.min(2, allKeys.length - 1)];
    const sourceEditKey2 = allKeys[Math.min(3, allKeys.length - 1)];

    const humanEs1 = `${getJsonKey(esAbs, humanKey1) || "Editado"} [Revisado por equipo MX]`;
    const humanAr2 = `${getJsonKey(arAbs, humanKey2) || "معدل"} [مراجعة بشرية]`;
    patchJsonKey(esAbs, humanKey1, humanEs1);
    patchJsonKey(arAbs, humanKey2, humanAr2);

    // Source v2 changes: revise 2 existing English keys + add a new hardcoded badge in AppHeader.tsx!
    patchJsonKey(enAbs, sourceEditKey1, `${flatEn[sourceEditKey1]} (v2 updated)`);
    patchJsonKey(enAbs, sourceEditKey2, `${flatEn[sourceEditKey2]} — revised for release 2`);
    const headerPath = path.join(dir, "src/components/AppHeader.tsx");
    const hdr = fs.readFileSync(headerPath, "utf8");
    const v2Hdr = hdr.replace("</h1>", `</h1>\n      <p className="text-xs opacity-80">Release 2.0: Synced locally</p>`);
    fs.writeFileSync(headerPath, v2Hdr);

    const maintPrompt = `A v2 release was just merged into this localized Toodle app:
- Two English strings in ${enRel} were revised ("${sourceEditKey1}" and "${sourceEditKey2}").
- A new hardcoded subtitle "Release 2.0: Synced locally" was added to src/components/AppHeader.tsx.
- Human linguists also made manual corrections directly inside ${esRel} and ${arRel}.

Tasks:
1. Extract the new subtitle in src/components/AppHeader.tsx into the i18n catalog.
2. Update es-MX and ar translations ONLY for the newly added and source-revised strings.
3. CRITICAL: Preserve ALL existing human linguist edits in ${esRel} and ${arRel} — do NOT overwrite untouched keys.
4. Ensure \`npm run lint\` and \`npm run build\` pass cleanly.${useWraith ? "\n\nUse Wraith MCP (scan, prepare, apply, check) to detect only stale/new keys and verify." : ""}`;

    const run = await runCodex({ label: `stage3a_app_maint_${arm}`, cwd: dir, prompt: maintPrompt, useWraith });
    const lint = runShellCheck(dir, "npm", ["run", "lint"]);
    const build = runShellCheck(dir, "npm", ["run", "build"]);
    const scanAfter = wraith.scanProject({ rootDir: dir, saveUsage: false, limit: 100 });
    const esHumanPreserved = getJsonKey(esAbs, humanKey1) === humanEs1;
    const arHumanPreserved = getJsonKey(arAbs, humanKey2) === humanAr2;
    const flatEsAfter = flattenJson(JSON.parse(fs.readFileSync(esAbs, "utf8")));
    const flatArAfter = flattenJson(JSON.parse(fs.readFileSync(arAbs, "utf8")));
    const v2Edit1EsChanged = flatEsAfter[sourceEditKey1] && /v2|actualizad|revisad|versión/i.test(flatEsAfter[sourceEditKey1]);
    const v2Edit2EsChanged = flatEsAfter[sourceEditKey2] && /2|revisad|edición|versión/i.test(flatEsAfter[sourceEditKey2]);
    const v2NewSubtitleExtracted = !fs.readFileSync(headerPath, "utf8").includes("Release 2.0: Synced locally");

    appMaint[arm] = {
      wallS: run.wallS,
      telemetry: run.telemetry,
      evaluation: {
        lintOk: lint.ok,
        buildOk: build.ok,
        esHumanEditPreserved: esHumanPreserved,
        arHumanEditPreserved: arHumanPreserved,
        v2NewSubtitleExtracted,
        v2Edit1EsUpdated: Boolean(v2Edit1EsChanged),
        v2Edit2EsUpdated: Boolean(v2Edit2EsChanged),
        remainingHardcodedStrings: scanAfter.counts.hardcodedStrings,
        esKeyCount: Object.keys(flatEsAfter).length,
        arKeyCount: Object.keys(flatArAfter).length,
      },
    };
  }

  /* --- 3B: DOCX Maintenance (sop-lay-down-tubulars.docx v1 -> v2 + Human Edits) --- */
  const docMaint = {};
  for (const [arm, dir, useWraith] of [
    ["A0_vanilla", stage2Dirs.dirA0, false],
    ["W_simplified", stage2Dirs.dirW, true],
  ]) {
    const srcPath = path.join(dir, "docs/sop-lay-down-tubulars.docx");
    const tgtPath = path.join(dir, "docs/sop-lay-down-tubulars.es-MX.docx");
    if (!fs.existsSync(tgtPath)) {
      docMaint[arm] = { skipped: true, reason: "Missing v1 target docx" };
      continue;
    }

    // 1. Inject 2 human linguist corrections directly into v1 target DOCX (find 2 translated plain segments)
    const v1TgtEx = wraith.extractDocument(tgtPath);
    const plainSegs = v1TgtEx.segments.filter((s) => s.part === "word/document.xml" && s.tags.length === 0 && s.plainText.length >= 12 && s.plainText.length <= 60);
    const hSeg1 = plainSegs[2];
    const hSeg2 = plainSegs[Math.min(8, plainSegs.length - 1)];
    const humanMarker1 = `${hSeg1.plainText} (Aprobado HSE MX)`;
    const humanMarker2 = `${hSeg2.plainText} (Revisión Planta)`;
    const tgtZip = fflate.unzipSync(fs.readFileSync(tgtPath));
    let tgtXml = fflate.strFromU8(tgtZip["word/document.xml"]);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    tgtXml = tgtXml.replace(esc(hSeg1.plainText), esc(humanMarker1)).replace(esc(hSeg2.plainText), esc(humanMarker2));
    tgtZip["word/document.xml"] = fflate.strToU8(tgtXml);
    fs.writeFileSync(tgtPath, fflate.zipSync(tgtZip));

    // 2. Revise source DOCX to v2: prepend a new paragraph at top of <w:body> (shifts ALL indices!) + edit 1 paragraph
    const srcZip = fflate.unzipSync(fs.readFileSync(srcPath));
    let srcXml = fflate.strFromU8(srcZip["word/document.xml"]);
    srcXml = srcXml
      .replace("<w:body>", "<w:body><w:p><w:r><w:t>Revision 2.0 Addendum: Confirm rig-floor exclusion zone before lifting tubulars.</w:t></w:r></w:p>")
      .replace("Hot Work", "Hot Work and Spark Control");
    srcZip["word/document.xml"] = fflate.strToU8(srcXml);
    fs.writeFileSync(srcPath, fflate.zipSync(srcZip));

    const docMaintPrompt = `docs/sop-lay-down-tubulars.docx was updated to Revision 2.0 (a new safety addendum paragraph was inserted at the top of the document, shifting paragraph indices, and one existing term was revised to "Hot Work and Spark Control").
Meanwhile, a Mexican Spanish HSE reviewer edited two paragraphs directly inside docs/sop-lay-down-tubulars.es-MX.docx.

Update docs/sop-lay-down-tubulars.es-MX.docx for Revision 2.0:
1. Translate the new addendum and revised source paragraph into Mexican Spanish.
2. CRITICAL: Preserve ALL existing translated segments and BOTH human reviewer edits inside docs/sop-lay-down-tubulars.es-MX.docx without overwriting them or corrupting Word formatting/tables.
3. Never overwrite docs/sop-lay-down-tubulars.docx.${useWraith ? "\n\nUse the Wraith MCP prepare and apply tools for documents (content-identity tracking automatically carries untouched & human-edited segments)." : ""}`;

    const run = await runCodex({ label: `stage3b_doc_maint_${arm}`, cwd: dir, prompt: docMaintPrompt, useWraith });
    const insp = inspectDocx(srcPath, tgtPath);
    let human1Preserved = false, human2Preserved = false, addendumTranslated = false, revisedTermTranslated = false;
    if (insp.validZip) {
      const finalEx = wraith.extractDocument(tgtPath);
      const allPlain = finalEx.segments.map((s) => s.plainText).join("\n");
      human1Preserved = allPlain.includes("(Aprobado HSE MX)");
      human2Preserved = allPlain.includes("(Revisión Planta)");
      addendumTranslated = /revisi[oó]n 2\.0|anexo|adenda|exclusi[oó]n/i.test(finalEx.segments[0]?.plainText || allPlain.slice(0, 300));
      revisedTermTranslated = /chispas|trabajo en caliente/i.test(allPlain);
    }
    docMaint[arm] = {
      wallS: run.wallS,
      telemetry: run.telemetry,
      evaluation: {
        ...insp,
        human1Preserved,
        human2Preserved,
        addendumTranslated,
        revisedTermTranslated,
      },
    };
  }

  return { appMaintenance: appMaint, docxMaintenance: docMaint };
}

/* ============================================================================================
 * STAGE 4: Diagnostic-Only QE + Crowdin XLIFF 1.2 / XLIFF 2.0 TMS Round-Trip (Wraith Arm)
 * ========================================================================================== */
async function runStage4DiagnosticQeAndTms(dirW) {
  const prepAll = wraith.prepareQeReview({ rootDir: dirW, locales: ["es-MX", "ar"], scope: "all", write: false });
  const prepRisk = wraith.prepareQeReview({ rootDir: dirW, locales: ["es-MX", "ar"], scope: "risk", write: false });
  const firstEsTask = prepRisk.tasks.find((t) => t.locale === "es-MX")?.strings[0];
  const locFiles = findLocaleJsonFiles(dirW);
  const esRel = locFiles.find((f) => /(?:^|\/)es-MX\.json$/i.test(f));
  const esBefore = esRel ? fs.readFileSync(path.join(dirW, esRel), "utf8") : "";

  let qeSubmit = null;
  let catalogUntouchedByQe = false;
  let tmsRoundTrip = null;
  if (firstEsTask && esRel) {
    qeSubmit = wraith.submitQeVerdicts({
      rootDir: dirW,
      verdicts: [
        {
          locale: "es-MX",
          key: firstEsTask.key,
          fingerprint: firstEsTask.fingerprint,
          verdict: "flag",
          severity: "minor",
          category: "terminology",
          reason: "Diagnostic check: verify UI label phrasing with native speaker",
          evidence: `Flagged via risk-prioritized audit (${(firstEsTask.riskSignals || []).join(",")})`,
          suggestedFix: `${firstEsTask.target} (verificado)`,
          reviewer: "diagnostic-audit",
        },
      ],
    });
    catalogUntouchedByQe = fs.readFileSync(path.join(dirW, esRel), "utf8") === esBefore;

    const exp12 = wraith.runTmsExport({ rootDir: dirW, format: "xliff12", outDir: ".wraith/crowdin-eval", locales: ["es-MX"], onlyFlagged: true, includeTm: true, includeGlossary: true });
    const xlf12 = path.join(dirW, ".wraith/crowdin-eval/es-MX.xlf");
    const approvedXml = fs
      .readFileSync(xlf12, "utf8")
      .replace(/state="needs-review-translation"/, 'state="final"')
      .replace(`>${firstEsTask.target}<`, `>${firstEsTask.target} (aprobado Crowdin)<`);
    fs.writeFileSync(xlf12, approvedXml);
    const imp12 = await wraith.runTmsImport({ rootDir: dirW, input: ".wraith/crowdin-eval/es-MX.xlf", runVerification: false });
    const overwriteAttempt = wraith.submitQeVerdicts({
      rootDir: dirW,
      verdicts: [
        {
          locale: "es-MX",
          key: firstEsTask.key,
          target: `${firstEsTask.target} (aprobado Crowdin)`,
          verdict: "flag",
          reason: "unauthorized overwrite",
        },
      ],
    });
    tmsRoundTrip = {
      exportedFiles: exp12.files,
      flaggedExported: exp12.unitsByLocale["es-MX"],
      importedApplied: imp12.applied,
      importedHumanVerified: imp12.qeHumanVerified,
      importedRejected: imp12.rejected.length,
      humanVerifiedProtected: overwriteAttempt.rejected.some((r) => r.code === "human_verified"),
    };
  }
  return {
    diagnosticOnly: prepRisk.diagnosticOnly,
    allStrings: prepAll.toReview,
    riskFilteredStrings: prepRisk.toReview,
    skippedLowRisk: prepRisk.skippedLowRisk,
    qeAccepted: qeSubmit?.accepted ?? 0,
    catalogUntouchedByQe,
    tmsRoundTrip,
  };
}

console.log("=== Real-World Unprepared Localization Engineering Evaluation ===");
const stage1 = await runStage1Toodle();
const stage2 = await runStage2Docx();
const stage3 = await runStage3Maintenance(stage1.dirs, stage2.dirs);
const stage4 = await runStage4DiagnosticQeAndTms(stage1.dirs.dirW);

const finalReport = {
  generatedAt: new Date().toISOString(),
  workDir: WORK_DIR,
  stage1_unpreparedApp_toodle: {
    A0_vanilla: stage1.A0_vanilla,
    W_simplified: stage1.W_simplified,
  },
  stage2_complexDocx_sop: {
    A0_vanilla: stage2.A0_vanilla,
    W_simplified: stage2.W_simplified,
    sourceRenders: stage2.sourceRenders,
  },
  stage3_maintenance: stage3,
  stage4_diagnosticQeAndTms: stage4,
};

const outPath = path.join(OUT_DIR, "results.json");
fs.writeFileSync(outPath, JSON.stringify(finalReport, null, 2) + "\n", "utf8");
console.log(`\nDone! Saved full evaluation -> ${outPath}`);
