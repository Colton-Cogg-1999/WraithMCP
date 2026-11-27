#!/usr/bin/env node
/**
 * Targeted Simplification & Core-Differentiator Evaluation
 *
 * Compares Wraith pre-simplification (ba7add3, 17 MCP tools, verbose prepare, rigid orchestration)
 * vs. Wraith post-simplification (HEAD, 12 consolidated tools, compact prepare, diagnostic-only QE)
 * vs. Vanilla Codex (A0, no Wraith MCP) across Wraith's core value propositions:
 *   1. Bulk catalog translation (120 real Mastodon keys, es-MX): W-before vs W-after
 *   2. Unprepared React/Next.js app i18n + translation (es-MX, ar): A0 vs W-before vs W-after
 *   3. Messy real-world DOCX (scientific-manuscript.docx, es-MX): A0 vs W-before vs W-after
 *   4. Release-to-release maintenance, human-edit preservation, diagnostic-only QE & TMS round-trip
 *
 * Preserves all historical benchmark artifacts in eval/results/pub-audit/ and eval/results/real-world-v2/.
 * Outputs to eval/results/simplification-eval/results.json.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "eval", "results", "simplification-eval");
const WORK_DIR = path.join(os.tmpdir(), `wraith-simp-eval-${Date.now()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const NODE_BIN = process.execPath;
const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const WRAITH_BEFORE_BIN = "/tmp/wraith-before-ba7add3/dist/bin.js";
const WRAITH_AFTER_BIN = path.join(REPO_ROOT, "dist", "bin.js");

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const fflate = await import("fflate");

function parseCodexJsonl(raw) {
  let modelTurns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let mcpCallsCount = 0;
  const mcpCallsByTool = {};
  let shellCallsCount = 0;
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
  const estApiUsd = +(
    (uncachedInputTokens * 2.5 + cachedInputTokens * 0.25 + outputTokens * 10.0) /
    1_000_000
  ).toFixed(4);

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
    lastMessage: lastMessage.slice(0, 400),
    errors,
  };
}

async function runCodex({ label, cwd, prompt, wraithBin = null, timeoutMs = 360_000 }) {
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
  if (wraithBin) {
    args.push(
      "-c",
      `mcp_servers.wraith.command=${JSON.stringify(NODE_BIN)}`,
      "-c",
      `mcp_servers.wraith.args=${JSON.stringify([wraithBin, "mcp"])}`
    );
  }
  args.push("-");

  console.log(`\n[${label}] starting (mcp=${wraithBin ? path.basename(path.dirname(path.dirname(wraithBin))) : "none"})...`);
  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawn(CODEX_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGTERM");
        resolve({ exitCode: -1, stdout: out, stderr: err, timedOut: true });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout: out, stderr: err, timedOut: false });
      }
    });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });

  const wallS = +((Date.now() - t0) / 1000).toFixed(1);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.jsonl`), stdout, "utf8");
  const telemetry = parseCodexJsonl(stdout);
  console.log(
    `[${label}] done ${wallS}s | exit=${exitCode} turns=${telemetry.modelTurns} in=${telemetry.inputTokens} (uncached=${telemetry.uncachedInputTokens}) out=${telemetry.outputTokens} mcp=${telemetry.mcpCallsCount} sh=${telemetry.shellCallsCount} est=$${telemetry.estApiUsd}`
  );
  if (exitCode !== 0 || telemetry.errors.length > 0) {
    console.warn(`[${label}] warning:`, stderr.slice(0, 300), telemetry.errors.slice(0, 2));
  }
  return { exitCode, timedOut, wallS, telemetry };
}

/* ============================================================================================
 * EXPERIMENT 1: 120 Real Mastodon Keys (es-MX) — W-before vs W-after
 * ========================================================================================== */
function findMastodonEn() {
  const candidates = [
    "/tmp/mastodon-storybook-test/app/javascript/mastodon/locales/en.json",
    path.join(REPO_ROOT, "eval/corpora/mastodon/app/javascript/mastodon/locales/en.json"),
    path.join(REPO_ROOT, "eval/results/real-world-v2/mastodon-en.json"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("Mastodon en.json not found");
}

function selectRepresentative120(enObj) {
  const entries = Object.entries(enObj);
  const picked = [];
  const seen = new Set();
  const add = (k, v) => {
    if (!seen.has(k) && picked.length < 120) {
      seen.add(k);
      picked.push([k, v]);
    }
  };
  // 30 ICU plurals/selects
  for (const [k, v] of entries) if (/\{[^}]+,\s*(plural|select)/.test(v) && picked.length < 30) add(k, v);
  // 25 placeholders / HTML tags
  for (const [k, v] of entries) if ((/\{[\w.]+\}/.test(v) || /<[a-z]+/i.test(v)) && picked.length < 55) add(k, v);
  // 25 short ambiguous UI strings (<=18 chars)
  for (const [k, v] of entries) if (v.length <= 18 && picked.length < 80) add(k, v);
  // 40 ordinary production strings evenly spaced
  const step = Math.max(1, Math.floor(entries.length / 45));
  for (let i = 0; i < entries.length && picked.length < 120; i += step) add(entries[i][0], entries[i][1]);
  return Object.fromEntries(picked);
}

function setupMastodon120Workspace(name, subsetObj) {
  const dir = path.join(WORK_DIR, name);
  fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "19.0.0", "react-intl": "7.0.0" } }));
  fs.writeFileSync(path.join(dir, "locales/en.json"), JSON.stringify(subsetObj, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "locales/es-MX.json"), "{}\n");
  // Add a component referencing a few ambiguous keys
  const sampleKeys = Object.keys(subsetObj).slice(0, 10);
  fs.writeFileSync(
    path.join(dir, "src/App.tsx"),
    `import { FormattedMessage } from "react-intl";\nexport function App() {\n  return <div>${sampleKeys.map((k) => `<button><FormattedMessage id="${k}" /></button>`).join("")}</div>;\n}\n`
  );
  wraith.initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], localesPath: "locales", writeAgentRule: false });
  const store = new wraith.WraithStore(dir);
  const cfg = store.readConfig();
  cfg.styleGuide = {
    instructions: "Use natural Mexican Spanish (tú register, avoid Spain-only vosotros/ordenador).",
    byLocale: { "es-MX": "Keep UI buttons concise." },
  };
  store.writeConfig(cfg);
  store.upsertGlossaryEntry({ term: "Mastodon", doNotTranslate: true, caseSensitive: true, origin: "user" });
  store.upsertGlossaryEntry({ term: "Boost", translations: { "es-MX": "Impulsar" }, origin: "user" });
  return dir;
}

async function runExp1Catalog() {
  const fullEn = JSON.parse(fs.readFileSync(findMastodonEn(), "utf8"));
  const subset = selectRepresentative120(fullEn);
  const totalKeys = Object.keys(subset).length;
  const prompt = `Translate all ${totalKeys} keys in locales/en.json into Mexican Spanish (es-MX) using the Wraith MCP tools. Verify your translations pass deterministic checks before finishing. Do not run pseudo or Playwright layout checks since there is no dev server.`;

  const results = {};
  for (const [arm, bin] of [
    ["exp1_W_before", WRAITH_BEFORE_BIN],
    ["exp1_W_after", WRAITH_AFTER_BIN],
  ]) {
    const dir = setupMastodon120Workspace(arm, subset);
    const run = await runCodex({ label: arm, cwd: dir, prompt, wraithBin: bin });
    const chk = wraith.runCheck({ rootDir: dir, locale: "es-MX", scope: "translations", limit: 200 });
    const outJson = JSON.parse(fs.readFileSync(path.join(dir, "locales/es-MX.json"), "utf8"));
    const flatKeys = Object.keys(outJson).filter((k) => typeof outJson[k] === "string" && outJson[k].trim().length > 0);
    const contextNotesCount = Object.keys(wraith.readContextNotes(dir).notes).length;
    results[arm] = {
      wallS: run.wallS,
      telemetry: run.telemetry,
      verification: {
        totalKeys,
        translatedTopLevelFlatKeys: flatKeys.length,
        checkOutcome: chk.outcome,
        checkErrors: chk.errorCount,
        checkWarnings: chk.warningCount,
        countsByCode: chk.countsByCode,
        contextNotesWritten: contextNotesCount,
      },
    };
  }
  return results;
}

/* ============================================================================================
 * EXPERIMENT 2: Unprepared React/Next.js App Internationalization — A0 vs W-before vs W-after
 * ========================================================================================== */
function setupUnpreparedApp(name) {
  const dir = path.join(WORK_DIR, name);
  fs.mkdirSync(path.join(dir, "src/components"), { recursive: true });
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "unprepared-app", dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }, null, 2)
  );
  fs.writeFileSync(path.join(dir, "messages/en.json"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "src/components/BillingCard.tsx"),
    `import React from "react";

export function BillingCard({ user, items, total, renewedAt }: { user: string; items: number; total: number; renewedAt: Date }) {
  const greeting = "Welcome back, " + user + "!";
  const summary = "You have " + items + " active subscriptions";
  const price = "$" + total.toFixed(2);
  const dateLabel = renewedAt.toLocaleDateString();
  return (
    <section className="ml-4 pr-6 text-left border-l-2">
      <h2>Billing Overview</h2>
      <p>{greeting}</p>
      <p>{summary}</p>
      <div className="flex justify-between">
        <span>Current Balance</span>
        <strong>{price}</strong>
      </div>
      <p>Renews on {dateLabel}</p>
      <div className="flex gap-2">
        <button>Save</button>
        <button>Open</button>
        <span className="badge">Open</span>
      </div>
    </section>
  );
}
`
  );
  fs.writeFileSync(
    path.join(dir, "src/components/FeedHeader.tsx"),
    `import React from "react";

export function FeedHeader({ unread }: { unread: number }) {
  return (
    <header className="pl-4 text-left">
      <h1>Acme Pulse Feed</h1>
      <p>{"Unread notifications: " + unread}</p>
      <button title="Publish update">Post</button>
      <a href="/archive">View Archive</a>
    </header>
  );
}
`
  );
  wraith.initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX", "ar"], writeAgentRule: false });
  const store = new wraith.WraithStore(dir);
  store.upsertGlossaryEntry({ term: "Acme Pulse", doNotTranslate: true, caseSensitive: true, origin: "user" });
  return dir;
}

async function runExp2UnpreparedApp() {
  const promptBase = `Internationalize this unprepared Next.js (next-intl) application and localize it into Mexican Spanish (es-MX) and Arabic (ar).
- Extract all hardcoded user-facing strings and string concatenations from src/components/*.tsx into messages/en.json using next-intl useTranslations() and proper ICU placeholders/plurals.
- Fix locale-unsafe formatting (.toFixed, currency concatenation, locale-less toLocaleDateString) using Intl formatters with explicit locale.
- Fix physical directional CSS classes (ml-, pr-, pl-, text-left, border-l-) to RTL-safe logical equivalents for Arabic.
- Keep "Acme Pulse" untranslated. Distinguish "Open" (button vs status badge) and "Post" (publish button).
- Translate into messages/es-MX.json and messages/ar.json. Do not start a dev server.`;

  const results = {};
  for (const [arm, bin, extra] of [
    ["exp2_A0_vanilla", null, ""],
    ["exp2_W_before", WRAITH_BEFORE_BIN, "\nUse the Wraith MCP tools to scan, prepare, apply, and verify."],
    ["exp2_W_after", WRAITH_AFTER_BIN, "\nUse the Wraith MCP tools to scan, prepare, apply, and verify."],
  ]) {
    const dir = setupUnpreparedApp(arm);
    const run = await runCodex({ label: arm, cwd: dir, prompt: promptBase + extra, wraithBin: bin });
    const chk = wraith.runCheck({ rootDir: dir, limit: 200 });
    const scan = wraith.scanProject({ rootDir: dir, saveUsage: false, limit: 100 });
    results[arm] = {
      wallS: run.wallS,
      telemetry: run.telemetry,
      verification: {
        sourceKeys: scan.sourceKeys,
        remainingHardcodedStrings: scan.counts.hardcodedStrings,
        remainingConcatenations: scan.counts.concatenations,
        remainingHardcodedFormatting: scan.counts.hardcodedFormatting ?? 0,
        rtlLayoutRisks: chk.countsByCode.rtl_layout_risk ?? 0,
        checkOutcome: chk.outcome,
        checkErrors: chk.errorCount,
        checkWarnings: chk.warningCount,
        countsByCode: chk.countsByCode,
      },
    };
  }
  return results;
}

/* ============================================================================================
 * EXPERIMENT 3: Messy Real-World DOCX (scientific-manuscript.docx, es-MX) — A0 vs W-before vs W-after
 * ========================================================================================== */
function setupDocWorkspace(name) {
  const dir = path.join(WORK_DIR, name);
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  const srcDoc = path.join(REPO_ROOT, "eval/corpora/real-docs/scientific-manuscript.docx");
  fs.copyFileSync(srcDoc, path.join(dir, "docs/scientific-manuscript.docx"));
  wraith.initProject({
    rootDir: dir,
    sourceLocale: "en",
    targetLocales: ["es-MX"],
    documents: ["docs"],
    writeAgentRule: false,
  });
  return dir;
}

function inspectDocxResult(srcPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { exists: false, validZip: false };
  }
  let validZip = false;
  let verify = null;
  let translatedSegments = 0;
  let totalSegments = 0;
  let unchangedEnglishSegments = 0;
  let headerTranslated = false;
  let textboxTranslated = false;
  try {
    const adapter = wraith.getDocumentAdapter(srcPath);
    const srcEx = adapter.extract(srcPath);
    const tgtEx = adapter.extract(targetPath);
    validZip = true;
    totalSegments = srcEx.segments.length;
    const tgtMap = new Map(tgtEx.segments.map((s) => [s.id, s.plainText]));
    for (const s of srcEx.segments) {
      const t = tgtMap.get(s.id) ?? "";
      if (t && t.trim() !== s.plainText.trim()) {
        translatedSegments++;
        if (s.part.includes("header")) headerTranslated = true;
        if (s.id.includes("txbx") || s.part.includes("txbx")) textboxTranslated = true;
      } else if (/[a-zA-Z]{4,}/.test(s.plainText)) {
        unchangedEnglishSegments++;
      }
    }
    // Check raw XML for hyperlink & textbox survival
    const rawEntries = fflate.unzipSync(fs.readFileSync(targetPath));
    const docXml = fflate.strFromU8(rawEntries["word/document.xml"] || new Uint8Array());
    const hasHyperlinks = docXml.includes("<w:hyperlink");
    const hasTextbox = docXml.includes("txbxContent");
    verify = wraith.verifyDocumentFormatting({ sourceFile: srcPath, targetFile: targetPath });
    return {
      exists: true,
      validZip,
      totalSegments,
      translatedSegments,
      unchangedEnglishSegments,
      headerTranslated,
      hasHyperlinks,
      hasTextbox,
      docVerifyOutcome: verify.outcome,
      sourcePages: verify.sourcePages,
      targetPages: verify.targetPages,
      docVerifyFindings: verify.findings.map((f) => `${f.severity}:${f.code}`),
    };
  } catch (err) {
    return { exists: true, validZip, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runExp3Docx() {
  const promptBase = `Translate docs/scientific-manuscript.docx into Mexican Spanish (es-MX) and save the translated Word document to docs/scientific-manuscript.es-MX.docx.
Preserve ALL Word formatting, fragmented runs, headers, footers, text boxes, hyperlinks, and XML structure. Never overwrite docs/scientific-manuscript.docx.`;

  const results = {};
  for (const [arm, bin, extra] of [
    ["exp3_A0_vanilla", null, ""],
    ["exp3_W_before", WRAITH_BEFORE_BIN, "\nUse the Wraith MCP prepare and apply tools for documents."],
    ["exp3_W_after", WRAITH_AFTER_BIN, "\nUse the Wraith MCP prepare and apply tools for documents."],
  ]) {
    const dir = setupDocWorkspace(arm);
    const run = await runCodex({ label: arm, cwd: dir, prompt: promptBase + extra, wraithBin: bin });
    const inspection = inspectDocxResult(
      path.join(dir, "docs/scientific-manuscript.docx"),
      path.join(dir, "docs/scientific-manuscript.es-MX.docx")
    );
    results[arm] = {
      wallS: run.wallS,
      telemetry: run.telemetry,
      verification: inspection,
    };
  }
  return results;
}

/* ============================================================================================
 * EXPERIMENT 4: Release-to-Release Maintenance, Human-Edit Preservation, Diagnostic QE & TMS
 * ========================================================================================== */
async function runExp4Lifecycle() {
  const dir = path.join(WORK_DIR, "exp4_lifecycle");
  fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }));

  // 1. Seed v1 software catalog (10 keys)
  const v1En = {
    "nav.home": "Home",
    "nav.save": "Save",
    "nav.open": "Open",
    "billing.total": "Total due: {amount}",
    "billing.items": "{count, plural, one {# invoice} other {# invoices}}",
    "settings.title": "Account Settings",
    "settings.hint": "Manage your workspace preferences.",
    "alerts.deleted": "Item deleted successfully.",
    "footer.privacy": "Privacy Policy",
    "footer.terms": "Terms of Service",
  };
  fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(v1En, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "messages/es-MX.json"), "{}\n");
  fs.writeFileSync(
    path.join(dir, "src/App.tsx"),
    `import { useTranslations } from "next-intl";
export function App() {
  const t = useTranslations();
  return <div><button>{t("nav.save")}</button><button>{t("nav.open")}</button><p>{t("billing.total", { amount: "$10" })}</p><p>{t("billing.items", { count: 2 })}</p></div>;
}\n`
  );
  // Seed v1 DOCX (real sop-lay-down-tubulars.docx)
  const srcDocPath = path.join(dir, "docs/sop.docx");
  const tgtDocPath = path.join(dir, "docs/sop.es-MX.docx");
  fs.copyFileSync(path.join(REPO_ROOT, "eval/corpora/real-docs/sop-lay-down-tubulars.docx"), srcDocPath);

  wraith.initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], documents: ["docs"], writeAgentRule: false });
  wraith.applyTranslations({
    rootDir: dir,
    targetLocale: "es-MX",
    translations: [
      { key: "nav.home", value: "Inicio" },
      { key: "nav.save", value: "Ahorrar" }, // deliberate wrong sense for diagnostic QE to flag!
      { key: "nav.open", value: "Abrir" },
      { key: "billing.total", value: "Total a pagar: {amount}" },
      { key: "billing.items", value: "{count, plural, one {# factura} other {# facturas}}" },
      { key: "settings.title", value: "Configuración de la cuenta" },
      { key: "settings.hint", value: "Administra las preferencias de tu espacio de trabajo." },
      { key: "alerts.deleted", value: "Elemento eliminado correctamente." },
      { key: "footer.privacy", value: "Política de privacidad" },
      { key: "footer.terms", value: "Términos del servicio" },
    ],
  });

  // 2. Diagnostic-only QE (scope: "risk") flags nav.save with severity + evidence; catalog untouched
  const catBeforeQe = fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8");
  const qePrep = wraith.prepareQeReview({ rootDir: dir, locales: ["es-MX"], scope: "risk", write: false });
  const saveTask = qePrep.tasks.flatMap((t) => t.strings).find((s) => s.key === "nav.save");
  const qeSub = wraith.submitQeVerdicts({
    rootDir: dir,
    verdicts: [
      {
        locale: "es-MX",
        key: "nav.save",
        fingerprint: saveTask.fingerprint,
        verdict: "flag",
        severity: "critical",
        category: "accuracy",
        reason: "Wrong word sense: Ahorrar means saving money",
        evidence: "src/App.tsx:4 <button>{t('nav.save')}</button>",
        suggestedFix: "Guardar",
      },
    ],
  });
  const catalogUntouchedByQe = fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8") === catBeforeQe;

  // 3. Crowdin XLIFF 1.2 + XLIFF 2.0 round-trip: human approves nav.save -> Guardar
  const exp12 = wraith.runTmsExport({ rootDir: dir, format: "xliff12", outDir: "tms12", onlyFlagged: true, includeTm: true, includeGlossary: true });
  const xlf12Path = path.join(dir, "tms12/es-MX.xlf");
  const approved12 = fs
    .readFileSync(xlf12Path, "utf8")
    .replace('state="needs-review-translation">Ahorrar', 'state="final">Guardar');
  fs.writeFileSync(xlf12Path, approved12);
  const imp12 = await wraith.runTmsImport({ rootDir: dir, input: "tms12/es-MX.xlf", runVerification: false });

  // Attempt agent overwrite of human-verified nav.save -> must reject with human_verified
  const overwriteAttempt = wraith.submitQeVerdicts({
    rootDir: dir,
    verdicts: [{ locale: "es-MX", key: "nav.save", target: "Guardar", verdict: "flag", reason: "agent overwrite" }],
  });

  // 4. Simulate manual edit in catalog (footer.privacy) + v2 release (edit 2 source keys, add 2 new keys)
  const esNow = JSON.parse(fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8"));
  esNow["footer.privacy"] = "Aviso de privacidad (editado manualmente)";
  fs.writeFileSync(path.join(dir, "messages/es-MX.json"), JSON.stringify(esNow, null, 2) + "\n");

  const v2En = {
    ...v1En,
    "settings.hint": "Manage your team workspace preferences and billing alerts.", // edited
    "alerts.deleted": "Record permanently removed.", // edited
    "new.export": "Export CSV", // added
    "new.import": "Import Data", // added
  };
  fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(v2En, null, 2) + "\n");

  const v2Prep = wraith.prepareBatch({ rootDir: dir, targetLocale: "es-MX" });
  const v2Reasons = Object.fromEntries(v2Prep.items.map((i) => [i.key, i.reason]));

  // 5. DOCX release-to-release maintenance + manual reviewer edit preservation
  const docV1 = wraith.extractDocument(srcDocPath);
  const v1DocApply = wraith.applyDocumentTranslations(dir, {
    sourceFile: "docs/sop.docx",
    targetFile: "docs/sop.es-MX.docx",
    targetLocale: "es-MX",
    updates: docV1.segments.map((s) => ({ id: s.id, text: `[ES] ${s.text}` })),
  });
  // Simulate a human reviewer editing segment #10 directly inside sop.es-MX.docx
  const targetSeg10 = docV1.segments[10];
  const humanEditedSeg10 = `[REVISADO POR HUMANO] ${targetSeg10.text}`;
  const rawTgtZip = fflate.unzipSync(fs.readFileSync(tgtDocPath));
  const patchedTgtXml = fflate
    .strFromU8(rawTgtZip["word/document.xml"])
    .replace(`[ES] ${targetSeg10.plainText}`, `[REVISADO POR HUMANO] ${targetSeg10.plainText}`);
  rawTgtZip["word/document.xml"] = fflate.strToU8(patchedTgtXml);
  fs.writeFileSync(tgtDocPath, fflate.zipSync(rawTgtZip));

  // Now simulate v2 source DOCX: prepend a brand-new paragraph at the top of word/document.xml (shifting ALL positional indices!)
  const rawSrcZip = fflate.unzipSync(fs.readFileSync(srcDocPath));
  const v2SrcXml = fflate
    .strFromU8(rawSrcZip["word/document.xml"])
    .replace("<w:body>", "<w:body><w:p><w:r><w:t>Revision 2.0 Safety Addendum</w:t></w:r></w:p>");
  rawSrcZip["word/document.xml"] = fflate.strToU8(v2SrcXml);
  fs.writeFileSync(srcDocPath, fflate.zipSync(rawSrcZip));

  const docV2Prep = wraith.prepareDocument(dir, { documentPath: "docs/sop.docx", targetLocale: "es-MX", limit: 300 });
  const newOnlySegs = docV2Prep.segments.filter((s) => s.status !== "translated");
  const v2DocApply = wraith.applyDocumentTranslations(dir, {
    sourceFile: "docs/sop.docx",
    targetFile: "docs/sop.es-MX.docx",
    targetLocale: "es-MX",
    updates: newOnlySegs.map((s) => ({ id: s.id, text: "Anexo de seguridad Revisión 2.0" })),
  });
  const docV2Tgt = wraith.extractDocument(tgtDocPath);
  const humanEditPreservedInDoc = docV2Tgt.segments.some((s) => s.plainText.includes("[REVISADO POR HUMANO]"));
  const docV2Verify = wraith.verifyDocumentFormatting({ sourceFile: srcDocPath, targetFile: tgtDocPath });

  return {
    diagnosticQe: {
      scopeRiskCount: qePrep.toReview,
      skippedLowRisk: qePrep.skippedLowRisk,
      verdictsAccepted: qeSub.accepted,
      catalogUntouchedByQe,
      humanVerifiedProtected: overwriteAttempt.rejected.some((r) => r.code === "human_verified"),
    },
    tmsRoundTrip: {
      exportedFiles: exp12.files,
      exportedFlaggedUnits: exp12.unitsByLocale["es-MX"],
      importedApplied: imp12.applied,
      importedHumanVerified: imp12.qeHumanVerified,
      importedTmUpserted: imp12.tmUpserted,
      navSaveAfterImport: JSON.parse(fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8"))["nav.save"],
    },
    catalogMaintenanceV2: {
      totalSourceKeysV2: Object.keys(v2En).length,
      pendingCountV2: v2Prep.totalPending,
      pendingReasons: v2Reasons,
      manualEditNotOverwritten: JSON.parse(fs.readFileSync(path.join(dir, "messages/es-MX.json"), "utf8"))["footer.privacy"].includes("editado manualmente"),
    },
    docxMaintenanceV2: {
      v1Segments: docV1.segments.length,
      v1ApplyOk: v1DocApply.ok,
      v2TotalSegments: docV2Prep.totalSegments,
      v2TranslatedCarriedByContentIdentity: docV2Prep.translatedSegments,
      v2PendingCount: docV2Prep.pendingSegments,
      v2ApplyOk: v2DocApply.ok,
      humanEditPreservedDespiteParagraphShift: humanEditPreservedInDoc,
      docVerifyOutcome: docV2Verify.outcome,
    },
  };
}

console.log("=== Running Wraith Simplification & Core-Differentiator Evaluation ===");
const summary = {
  generatedAt: new Date().toISOString(),
  exp1_catalog120: await runExp1Catalog(),
  exp2_unpreparedApp: await runExp2UnpreparedApp(),
  exp3_messyDocx: await runExp3Docx(),
  exp4_lifecycle: await runExp4Lifecycle(),
};

const outPath = path.join(OUT_DIR, "results.json");
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\nSaved evaluation results -> ${outPath}`);
console.log(JSON.stringify(summary, null, 2));
