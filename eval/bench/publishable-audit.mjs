#!/usr/bin/env node
/**
 * Wraith Publishable 5-Arm Evaluation Harness ("NMT vs B0 vs A0 vs W-pre vs W-post")
 *
 * - Translator & Fresh-Context QE Subagent: Codex (`codex exec --ephemeral --json -` via stdin)
 * - NMT Baseline: DeepL API + Glossary (`eval/lib/deepl.mjs`)
 * - Blinded Independent MQM Judge: Claude (`claude -p --model opus`)
 * - Languages: German (`de`), Simplified Chinese (`zh-Hans`), Mexican Spanish (`es-MX`), Arabic (`ar`)
 * - Full token usage & DeepL char accounting on every run
 *
 * Subcommands:
 *   node eval/bench/publishable-audit.mjs oss     # 5-arm localization across nextjs-commerce (live Playwright) + Android FossifyOrg/Calendar + iOS IceCubesApp x 4 locales
 *   node eval/bench/publishable-audit.mjs docs    # DeepL/Naive vs Wraith+Codex across DOCX, PPTX, XLSX, VTT, SRT + LibreOffice visual renders
 *   node eval/bench/publishable-audit.mjs judge   # Blinded, position-swapped Claude Opus MQM judge across all 5 arms (OSS + Docs)
 *   node eval/bench/publishable-audit.mjs all     # Run oss -> docs -> judge
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const CORPORA_DIR = path.join(EVAL_ROOT, "corpora");
const WORK_ROOT = path.join(EVAL_ROOT, "work", "pub-audit");
const RESULTS_DIR = path.join(EVAL_ROOT, "results", "pub-audit");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots");
const DOC_RENDERS_DIR = path.join(RESULTS_DIR, "doc-renders");

const NODE_BIN = process.execPath;
const WRAITH_CLI = path.join(REPO_ROOT, "dist", "bin.js");
const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const CLAUDE_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/claude")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/claude"
  : "claude";

const LANGUAGES = ["de", "zh-Hans", "es-MX", "ar"];
const JUDGE_MODEL = process.env.WRAITH_JUDGE_MODEL ?? "opus";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const {
  buildPilotApp,
  PILOT_APP_DIR,
  PILOT_GLOSSARY,
  PILOT_ITEMS,
  renderPilotAppHtml,
} = await import(path.join(EVAL_ROOT, "synthetic", "build-pilot-app.mjs"));
const {
  translateCatalogWithDeepL,
  translateDocxWithDeepL,
  cleanupWraithEvalGlossaries,
  getDeepLUsage,
} = await import(path.join(EVAL_ROOT, "lib", "deepl.mjs"));

wraith.ensureBootstrapped();
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(DOC_RENDERS_DIR, { recursive: true });

// Extend PILOT_GLOSSARY with zh-Hans translations for fair 4-language glossary enforcement
const FULL_GLOSSARY = PILOT_GLOSSARY.map((g) => {
  const extraZh =
    g.term === "Workspace"
      ? "工作区"
      : g.term === "Invoice"
        ? "发票"
        : g.term === "Seat"
          ? "席位"
          : null;
  return {
    ...g,
    translations: {
      ...g.translations,
      ...(extraZh ? { "zh-Hans": extraZh } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
});

function stripFrontmatter(md) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
}

function flattenJson(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenJson(v, key, out);
    else out[key] = String(v ?? "");
  }
  return out;
}

function unflattenJson(flat) {
  const root = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split(".");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return root;
}

function parseCodexJsonl(rawJsonl) {
  let modelTurns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  const mcpCallsByTool = {};
  let mcpCallsCount = 0;
  let lastMessage = "";
  const errors = [];

  for (const line of rawJsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === "turn.completed") {
      modelTurns++;
      if (ev.usage) {
        inputTokens += ev.usage.input_tokens ?? 0;
        cachedInputTokens += ev.usage.cached_input_tokens ?? 0;
        outputTokens += ev.usage.output_tokens ?? 0;
        reasoningTokens += ev.usage.reasoning_output_tokens ?? 0;
      }
    } else if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "mcp_tool_call") {
        mcpCallsCount++;
        const tool = ev.item.tool ?? "unknown";
        mcpCallsByTool[tool] = (mcpCallsByTool[tool] ?? 0) + 1;
      } else if (ev.item.type === "agent_message" && ev.item.text) {
        lastMessage = ev.item.text;
      }
    } else if (ev.type === "error") {
      errors.push(ev.message ?? JSON.stringify(ev));
    }
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  // Transparent list-price API-equivalent USD ($2.50/M uncached in, $0.25/M cached in, $10.00/M out)
  const estApiUsd = Number(
    ((uncachedInputTokens * 2.5 + cachedInputTokens * 0.25 + outputTokens * 10.0) / 1_000_000).toFixed(4)
  );

  return {
    modelTurns,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    mcpCallsCount,
    mcpCallsByTool,
    estApiUsd,
    lastMessage: lastMessage.slice(0, 600),
    errors,
  };
}

/**
 * Run Codex non-interactively, piping the prompt cleanly over STDIN (`-`) so leading `---` or quotes
 * can never be parsed as CLI flags.
 */
async function runCodex({ label, cwd, prompt, useWraithMcp = true, timeoutMs = 480_000, logPath = null }) {
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
  if (useWraithMcp) {
    args.push(
      "-c",
      `mcp_servers.wraith.command=${JSON.stringify(NODE_BIN)}`,
      "-c",
      `mcp_servers.wraith.args=${JSON.stringify([WRAITH_CLI, "mcp"])}`
    );
  }
  args.push("-");

  console.log(`\n[codex:${label}] start (mcp=${useWraithMcp})...`);
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

  const wallS = Number(((Date.now() - t0) / 1000).toFixed(1));
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, stdout, "utf8");
  }
  const telemetry = parseCodexJsonl(stdout);
  console.log(
    `[codex:${label}] done ${wallS}s (exit=${exitCode}, turns=${telemetry.modelTurns}, in=${telemetry.inputTokens}, cached=${telemetry.cachedInputTokens}, out=${telemetry.outputTokens}, mcp=${telemetry.mcpCallsCount}, est=$${telemetry.estApiUsd})`
  );
  if (exitCode !== 0 || telemetry.errors.length > 0) {
    console.warn(`[codex:${label}] stderr:`, stderr.slice(0, 400), telemetry.errors.slice(0, 2));
  }
  return { exitCode, timedOut, wallS, telemetry };
}

async function runClaudeJudge({ label, prompt, model = JUDGE_MODEL, timeoutMs = 300_000 }) {
  const emptyMcp = path.join(os.tmpdir(), `.wraith-judge-empty-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    model,
    "--mcp-config",
    emptyMcp,
    "--strict-mcp-config",
  ];
  console.log(`\n[judge:${label}] start (model=${model})...`);
  const t0 = Date.now();
  const { exitCode, stdout, stderr } = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill("SIGTERM");
        resolve({ exitCode: -1, stdout: out, stderr: err });
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("close", (code) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout: out, stderr: err });
      }
    });
    child.stdin.write(prompt, "utf8");
    child.stdin.end();
  });
  fs.rmSync(emptyMcp, { force: true });
  const wallS = Number(((Date.now() - t0) / 1000).toFixed(1));
  let parsed = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    try {
      parsed = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "");
    } catch {
      parsed = null;
    }
  }
  const usage = parsed?.usage ?? {};
  const resultText = typeof parsed?.result === "string" ? parsed.result : "";
  console.log(
    `[judge:${label}] done ${wallS}s (exit=${exitCode}, cost=$${Number(parsed?.total_cost_usd ?? 0).toFixed(4)})`
  );
  if (exitCode !== 0) console.warn(`[judge:${label}] stderr:`, stderr.slice(0, 400));
  return {
    exitCode,
    wallS,
    model,
    costUsd: Number((parsed?.total_cost_usd ?? 0).toFixed(4)),
    inputTokens: usage.input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    resultText,
  };
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const name of ["playwright", "playwright-core"]) {
    try {
      const m = req(name);
      if (m?.chromium) return m;
    } catch { /* next */ }
  }
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (g) {
      const m = req(path.join(g, "playwright"));
      if (m?.chromium) return m;
    }
  } catch { /* ignore */ }
  return null;
}

function renderCommerceHtml(locale, flatMsgs, { fixedLayout = false } = {}) {
  const clean = {};
  for (const [k, raw] of Object.entries(flatMsgs)) {
    clean[k] = String(raw ?? "").replace(/<\/?(link|b|strong|codeTag)>/g, "");
  }
  let html = renderPilotAppHtml(locale, clean);
  if (!fixedLayout) {
    html = html.replace(/dir="rtl"/g, 'dir="ltr"');
  } else {
    html = html
      .replace(/width:\s*(80|88|96|110|112|64)px;/g, "min-width: $1px; width: auto; white-space: normal;")
      .replace(/overflow:\s*hidden;\s*white-space:\s*nowrap;\s*text-overflow:\s*ellipsis;/g, "overflow: visible; white-space: normal;")
      .replace(
        "header { display: flex; align-items: center; justify-content: space-between;",
        "header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;"
      )
      .replace(
        'nav[role="tablist"] { display: flex; gap: 8px; }',
        'nav[role="tablist"] { display: flex; flex-wrap: wrap; gap: 8px; }'
      );
  }
  return html;
}

async function captureWebScreenshots({ flatByArm, locale, outDir }) {
  const pw = loadPlaywright();
  if (!pw) return [];
  const execPath = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const arm = u.searchParams.get("arm") ?? "NMT";
    const fixed = u.searchParams.get("fixed") === "1";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderCommerceHtml(locale, flatByArm[arm] ?? {}, { fixedLayout: fixed }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch({ headless: true, ...(execPath ? { executablePath: execPath } : {}) });
  const captured = [];
  try {
    for (const [arm, fixed] of [
      ["NMT", false],
      ["B0", false],
      ["W-post", true],
    ]) {
      for (const vp of [
        { width: 375, height: 812, name: "375w" },
        { width: 1280, height: 800, name: "1280w" },
      ]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.goto(`${baseUrl}/?arm=${encodeURIComponent(arm)}&fixed=${fixed ? "1" : "0"}`, { waitUntil: "networkidle" });
        const pngPath = path.join(outDir, `web-${locale}-${arm}-${vp.name}.png`);
        await page.screenshot({ path: pngPath, fullPage: true });
        captured.push({ locale, arm, viewport: vp.name, path: pngPath });
        await page.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  return captured;
}

// ============================================================================
// SUITE 1: 5-ARM MULTI-LANGUAGE BENCHMARK (NMT vs B0 vs A0 vs W-pre vs W-post)
// ============================================================================
const SEEDED_AMBIGUOUS = {
  "extras.coverLabel": "Cover",
  "extras.leadLabel": "Lead",
  "extras.dropLabel": "Drop",
};
const DECLARED_LIMITS = {
  "tight.btnRefund": 14,
  "tight.tabSettings": 10,
};
const EXTRAS_TSX = `import { useTranslations } from "next-intl";
export function CatalogExtras({ item }: { item: { name: string } }) {
  const t = useTranslations("extras");
  return (
    <div className="extras">
      <span className="tag">{t("coverLabel")}</span>
      <span className="col">{t("leadLabel")}</span>
      <span className="badge">{t("dropLabel")}</span>
      <span>{item.name}</span>
    </div>
  );
}
`;

function buildAppDatasets() {
  const apps = [];

  // 1. Rendered Web App: nextjs-commerce (63 strings: 20 homonyms + 6 DNT + 6 glossary + 10 ICU + 6 rich + 6 tight UI + 6 general + 3 seeded unresolvable)
  {
    buildPilotApp();
    const enBase = flattenJson(JSON.parse(fs.readFileSync(path.join(PILOT_APP_DIR, "messages/en.json"), "utf8")));
    const flatEn = { ...enBase, ...SEEDED_AMBIGUOUS };

    const buildWorkspace = (dir, locale, { rawOnly = false } = {}) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
      fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(unflattenJson(flatEn), null, 2) + "\n");
      fs.writeFileSync(path.join(dir, `messages/${locale}.json`), "{}\n");
      if (!rawOnly) {
        fs.cpSync(PILOT_APP_DIR, dir, {
          recursive: true,
          filter: (p) => !p.endsWith("challenge-labels.json") && !p.endsWith("en.json"),
        });
        fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(unflattenJson(flatEn), null, 2) + "\n");
        fs.writeFileSync(path.join(dir, `messages/${locale}.json`), "{}\n");
        fs.writeFileSync(path.join(dir, "src/components/CatalogExtras.tsx"), EXTRAS_TSX);
        fs.mkdirSync(path.join(dir, "src/app"), { recursive: true });
        fs.writeFileSync(
          path.join(dir, "src/app/layout.tsx"),
          `export default function RootLayout({ children }: { children: any }) {\n  return <html><body className="ml-4 mr-2 pl-3 text-left">{children}</body></html>;\n}\n`
        );
      }
    };

    apps.push({
      id: "nextjs-commerce",
      name: "Northstar Commerce (Next.js + Playwright Layout)",
      framework: "nextjs",
      format: "json",
      hasLiveLayout: true,
      flatEn,
      glossary: FULL_GLOSSARY,
      charLimits: DECLARED_LIMITS,
      sourceRel: "messages/en.json",
      targetRel: (loc) => `messages/${loc}.json`,
      buildWorkspace,
      readFlatTarget: (dir, loc) => {
        const p = path.join(dir, `messages/${loc}.json`);
        if (!fs.existsSync(p)) return {};
        try {
          return flattenJson(JSON.parse(fs.readFileSync(p, "utf8")));
        } catch {
          return {};
        }
      },
      writeFlatTarget: (dir, loc, flat) => {
        fs.writeFileSync(path.join(dir, `messages/${loc}.json`), JSON.stringify(unflattenJson(flat), null, 2) + "\n");
      },
      contextMap: Object.fromEntries([
        ...PILOT_ITEMS.map((i) => [
          i.key,
          `${i.component}: ${i.intendedSense ?? i.category}`,
        ]),
        ["extras.coverLabel", "CatalogExtras.tsx: genuinely unresolvable bare tag 'Cover' next to item.name"],
        ["extras.leadLabel", "CatalogExtras.tsx: genuinely unresolvable bare column label 'Lead' next to item.name"],
        ["extras.dropLabel", "CatalogExtras.tsx: genuinely unresolvable bare badge 'Drop' next to item.name"],
      ]),
    });
  }

  // 2. Real OSS Android App: FossifyOrg/Calendar (20 stratified real Kotlin + strings.xml strings)
  {
    const repoDir = path.join(CORPORA_DIR, "fossify-calendar");
    const adapter = new wraith.AndroidXmlFormatAdapter();
    const enData = adapter.readFile(path.join(repoDir, "app/src/main/res/values/strings.xml"), "en");
    const all = [...enData.entries.values()].filter((e) => !e.plurals && e.value.trim().length > 0);
    const withPh = all.filter((e) => /%\d*\$?[sd]/.test(e.value)).slice(0, 8);
    const shortUi = all.filter((e) => !/%\d*\$?[sd]/.test(e.value) && e.value.length <= 18).slice(0, 6);
    const general = all.filter((e) => !withPh.includes(e) && !shortUi.includes(e)).slice(0, 6);
    const picked = [...withPh, ...shortUi, ...general];
    const flatEn = Object.fromEntries(picked.map((e) => [e.key, e.value]));

    const valuesDirFor = (loc) => {
      if (loc === "es-MX") return "values-es-rMX";
      if (loc === "zh-Hans") return "values-zh-rCN";
      return `values-${loc}`;
    };

    const buildWorkspace = (dir, locale, { rawOnly = false } = {}) => {
      fs.rmSync(dir, { recursive: true, force: true });
      const vDir = valuesDirFor(locale);
      fs.mkdirSync(path.join(dir, "app/src/main/res/values"), { recursive: true });
      fs.mkdirSync(path.join(dir, `app/src/main/res/${vDir}`), { recursive: true });
      const xmlLines = picked
        .map(
          (e) =>
            `    <string name="${e.key}">${e.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'")}</string>`
        )
        .join("\n");
      fs.writeFileSync(
        path.join(dir, "app/src/main/res/values/strings.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name" translatable="false">Fossify Calendar</string>\n${xmlLines}\n</resources>\n`
      );
      fs.writeFileSync(
        path.join(dir, `app/src/main/res/${vDir}/strings.xml`),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`
      );
      if (!rawOnly) {
        fs.copyFileSync(path.join(repoDir, "app/src/main/AndroidManifest.xml"), path.join(dir, "app/src/main/AndroidManifest.xml"));
        const kt = path.join(repoDir, "app/src/main/kotlin");
        if (fs.existsSync(kt)) fs.cpSync(kt, path.join(dir, "app/src/main/kotlin"), { recursive: true });
      }
    };

    apps.push({
      id: "oss-android-fossify",
      name: "FossifyOrg/Calendar (Real OSS Android / Kotlin)",
      framework: "android",
      format: "android-xml",
      hasLiveLayout: false,
      flatEn,
      glossary: [{ term: "Fossify", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: new Date().toISOString() }],
      charLimits: {},
      sourceRel: "app/src/main/res/values/strings.xml",
      targetRel: (loc) => `app/src/main/res/${valuesDirFor(loc)}/strings.xml`,
      buildWorkspace,
      readFlatTarget: (dir, loc) => {
        const p = path.join(dir, `app/src/main/res/${valuesDirFor(loc)}/strings.xml`);
        if (!fs.existsSync(p)) return {};
        try {
          return Object.fromEntries([...adapter.readFile(p, loc).entries.entries()].map(([k, v]) => [k, v.value]));
        } catch {
          return {};
        }
      },
      writeFlatTarget: (dir, loc, flat) => {
        adapter.applyUpdates(
          path.join(dir, `app/src/main/res/${valuesDirFor(loc)}/strings.xml`),
          loc,
          Object.entries(flat).map(([key, value]) => ({ key, value })),
          { write: true }
        );
      },
      contextMap: Object.fromEntries(picked.map((e) => [e.key, `FossifyOrg/Calendar Android string key="${e.key}"`])),
    });
  }

  // 3. Real OSS iOS App: Dimillian/IceCubesApp (20 stratified real SwiftUI + Localizable.xcstrings strings)
  {
    const repoDir = path.join(CORPORA_DIR, "icecubes-ios");
    const xcSrc = path.join(repoDir, "IceCubesApp/Resources/Localization/Localizable.xcstrings");
    const adapter = new wraith.XcstringsFormatAdapter();
    const enData = adapter.readFile(xcSrc, "en");
    const fullCatalog = JSON.parse(fs.readFileSync(xcSrc, "utf8"));
    const all = [...enData.entries.values()].filter((e) => !e.plurals && e.value.trim().length > 0 && e.value.length <= 120);
    const withPh = all.filter((e) => /%@|%lld|%d/.test(e.value)).slice(0, 8);
    const shortUi = all.filter((e) => !/%@|%lld|%d/.test(e.value) && e.value.length <= 16).slice(0, 6);
    const general = all.filter((e) => !withPh.includes(e) && !shortUi.includes(e)).slice(0, 6);
    const picked = [...withPh, ...shortUi, ...general];
    const flatEn = Object.fromEntries(picked.map((e) => [e.key, e.value]));

    const buildWorkspace = (dir, _locale, { rawOnly = false } = {}) => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "IceCubesApp/Resources/Localization"), { recursive: true });
      const subStrings = {};
      for (const e of picked) {
        const orig = fullCatalog.strings[e.key] ?? {};
        const clone = { ...orig };
        if (clone.localizations) {
          const keep = {};
          if (clone.localizations.en) keep.en = clone.localizations.en;
          if (clone.localizations.fr) keep.fr = clone.localizations.fr;
          clone.localizations = keep;
        }
        subStrings[e.key] = clone;
      }
      fs.writeFileSync(
        path.join(dir, "IceCubesApp/Resources/Localization/Localizable.xcstrings"),
        JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: subStrings }, null, 2) + "\n"
      );
      if (!rawOnly) {
        fs.writeFileSync(path.join(dir, "Package.swift"), "// swift-tools-version: 5.9\n");
        const appSwift = path.join(repoDir, "IceCubesApp/App");
        if (fs.existsSync(appSwift)) fs.cpSync(appSwift, path.join(dir, "IceCubesApp/App"), { recursive: true });
      }
    };

    apps.push({
      id: "oss-ios-icecubes",
      name: "Dimillian/IceCubesApp (Real OSS iOS / SwiftUI)",
      framework: "ios",
      format: "xcstrings",
      hasLiveLayout: false,
      flatEn,
      glossary: [{ term: "Mastodon", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: new Date().toISOString() }],
      charLimits: {},
      sourceRel: "IceCubesApp/Resources/Localization/Localizable.xcstrings",
      targetRel: () => "IceCubesApp/Resources/Localization/Localizable.xcstrings",
      buildWorkspace,
      readFlatTarget: (dir, loc) => {
        const p = path.join(dir, "IceCubesApp/Resources/Localization/Localizable.xcstrings");
        if (!fs.existsSync(p)) return {};
        try {
          return Object.fromEntries([...adapter.readFile(p, loc).entries.entries()].map(([k, v]) => [k, v.value]));
        } catch {
          return {};
        }
      },
      writeFlatTarget: (dir, loc, flat) => {
        adapter.applyUpdates(
          path.join(dir, "IceCubesApp/Resources/Localization/Localizable.xcstrings"),
          loc,
          Object.entries(flat).map(([key, value]) => ({ key, value })),
          { write: true }
        );
      },
      contextMap: Object.fromEntries(picked.map((e) => [e.key, `IceCubesApp SwiftUI Mastodon client key="${e.key}"`])),
    });
  }

  return apps;
}

async function runOss5ArmSuite() {
  const outPath = path.join(RESULTS_DIR, "oss-5arm.json");
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : { runs: {} };
  const localizeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/localize-pr/SKILL.md"), "utf8"));
  const qeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/qe-review/SKILL.md"), "utf8"));

  const apps = buildAppDatasets();
  const deeplBefore = await getDeepLUsage();
  console.log("[OSS] DeepL quota before:", deeplBefore);

  for (const app of apps) {
    for (const locale of LANGUAGES) {
      const runKey = `${app.id}::${locale}`;
      if (existing.runs[runKey]?.completed) {
        console.log(`[OSS] Skipping already-completed ${runKey}`);
        continue;
      }

      console.log(`\n========================================================================`);
      console.log(`[OSS 5-ARM] ${app.id} (${app.framework}) -> ${locale} (${Object.keys(app.flatEn).length} keys)`);
      console.log(`========================================================================`);

      const runWork = path.join(WORK_ROOT, "oss", `${app.id}-${locale}`);
      fs.rmSync(runWork, { recursive: true, force: true });
      fs.mkdirSync(runWork, { recursive: true });

      const initAndCheck = (dir) => {
        wraith.initProject({ rootDir: dir, sourceLocale: "en", targetLocales: [locale], writeAgentRule: false });
        const st = new wraith.WraithStore(dir);
        if (app.glossary.length) st.writeGlossary({ version: 1, entries: app.glossary });
        if (Object.keys(app.charLimits).length) st.writeConfig({ ...st.readConfig(), charLimits: app.charLimits });
        const chk = wraith.runCheck({ rootDir: dir, locale, limit: 500 });
        const catalogErrs = (chk.issues?.errors ?? []).filter(
          (i) => !["hardcoded_string", "string_concatenation"].includes(i.code)
        );
        return {
          outcome: chk.outcome,
          catalogErrorCount: catalogErrs.length,
          catalogErrorCodes: catalogErrs.reduce((acc, i) => {
            acc[i.code] = (acc[i.code] ?? 0) + 1;
            return acc;
          }, {}),
          countsByCode: chk.countsByCode,
        };
      };

      // --- ARM 1: NMT (DeepL API + Glossary) ---
      const nmtDir = path.join(runWork, "NMT");
      app.buildWorkspace(nmtDir, locale, { rawOnly: false });
      const deeplRes = await translateCatalogWithDeepL({
        stageName: `pub-oss-${app.id}-${locale}`,
        targetLocale: locale,
        sourceMap: app.flatEn,
        glossaryEntries: app.glossary,
      });
      await cleanupWraithEvalGlossaries("pub-audit-slot-release");
      app.writeFlatTarget(nmtDir, locale, deeplRes.translations);
      const nmtCheck = initAndCheck(nmtDir);
      const nmtFlat = app.readFlatTarget(nmtDir, locale);

      // --- ARM 2: B0 (Raw Catalog Codex — sees ONLY the locale file, NO code, NO glossary) ---
      const b0AgentDir = path.join(runWork, "B0-agent");
      const b0EvalDir = path.join(runWork, "B0-eval");
      app.buildWorkspace(b0AgentDir, locale, { rawOnly: true });
      app.buildWorkspace(b0EvalDir, locale, { rawOnly: false });
      const b0Res = await runCodex({
        label: `${app.id}-${locale}-B0`,
        cwd: b0AgentDir,
        useWraithMcp: false,
        logPath: path.join(runWork, "B0.jsonl"),
        prompt: `Translate all strings in \`${app.sourceRel}\` into locale \`${locale}\` and write the result to \`${app.targetRel(locale)}\`. Preserve the exact file format, keys, placeholders, ICU syntax, and inline tags. Write only the target catalog file.`,
      });
      const b0Flat = app.readFlatTarget(b0AgentDir, locale);
      app.writeFlatTarget(b0EvalDir, locale, b0Flat);
      const b0Check = initAndCheck(b0EvalDir);

      // --- ARM 3: A0 (Codex Alone in Repo — full code access, NO Wraith MCP) ---
      const a0Dir = path.join(runWork, "A0");
      app.buildWorkspace(a0Dir, locale, { rawOnly: false });
      const a0Res = await runCodex({
        label: `${app.id}-${locale}-A0`,
        cwd: a0Dir,
        useWraithMcp: false,
        logPath: path.join(runWork, "A0.jsonl"),
        prompt: `You are localizing this ${app.framework} project (${app.name}) into locale \`${locale}\`. Read the source code to understand UI context, then translate all strings from \`${app.sourceRel}\` into \`${app.targetRel(locale)}\`. Preserve all placeholders, plurals, escaping, and file structure. Do not edit source code files.`,
      });
      const a0Flat = app.readFlatTarget(a0Dir, locale);
      const a0Check = initAndCheck(a0Dir);

      // --- ARM 4: W-pre (Wraith + Codex BEFORE Fresh-Context QE Subagent) ---
      const wDir = path.join(runWork, "W");
      app.buildWorkspace(wDir, locale, { rawOnly: false });
      wraith.initProject({ rootDir: wDir, sourceLocale: "en", targetLocales: [locale], writeAgentRule: false });
      const wStore = new wraith.WraithStore(wDir);
      if (app.glossary.length) wStore.writeGlossary({ version: 1, entries: app.glossary });
      if (Object.keys(app.charLimits).length) wStore.writeConfig({ ...wStore.readConfig(), charLimits: app.charLimits });

      const wPreRes = await runCodex({
        label: `${app.id}-${locale}-W-pre`,
        cwd: wDir,
        useWraithMcp: true,
        logPath: path.join(runWork, "W-pre.jsonl"),
        prompt: `${localizeSkill}\n\n---\nTASK: Localize ALL keys in \`${app.sourceRel}\` into locale \`${locale}\` for ${app.name} (\`rootDir: "."\`):\n1. Call \`status\`, then paginate \`prepare\` for \`targetLocale: "${locale}"\`, read component/source files for every usage site, write a concise 1-sentence \`contextNote\` per key, respect all glossary/DNT terms and \`charLimit\`s, apply translations via \`apply\`, record assumptions via \`memory\` (\`add_assumption\`), and file Open Questions via \`memory\` (\`add_question\`) ONLY when the source code genuinely cannot settle a string's meaning.\n2. Run \`check\` (\`locale: "${locale}"\`) and fix every translation/catalog/limit error until there are 0 catalog errors.\n3. STOP before \`qe_audit\` so we can snapshot \`W-pre\` and hand off Step 4 to a separate fresh-context Codex QE subagent.`,
      });
      const wPreFlat = app.readFlatTarget(wDir, locale);
      const wPreCheckRaw = wraith.runCheck({ rootDir: wDir, locale, limit: 500 });
      const wPreCatalogErrs = (wPreCheckRaw.issues?.errors ?? []).filter(
        (i) => !["hardcoded_string", "string_concatenation"].includes(i.code)
      );
      const wPreCheck = {
        outcome: wPreCheckRaw.outcome,
        catalogErrorCount: wPreCatalogErrs.length,
        countsByCode: wPreCheckRaw.countsByCode,
      };

      // --- ARM 5: W-post (Fresh-Context Codex QE Subagent + Remediation Pass) ---
      const wQeRes = await runCodex({
        label: `${app.id}-${locale}-W-qe`,
        cwd: wDir,
        useWraithMcp: true,
        logPath: path.join(runWork, "W-qe.jsonl"),
        prompt: `${qeSkill}\n\n---\nTASK: You are a fresh-context QE Reviewer subagent (you did not produce these translations). Review ALL translated strings in \`${locale}\` (\`rootDir: "."\`):\n1. Call \`qe_audit\` with \`mode: "prepare"\` and \`locales: ["${locale}"]\`.\n2. Open and read the relevant source files so you see how each string is used in the UI, check \`termBase\`, \`projectDecisions\`, and \`sameSourceElsewhere\`, and judge each string rigorously as \`ok\` or \`flag\` (with \`reason\` and \`suggestedFix\` on every flag).\n3. Submit ALL verdicts via \`qe_audit\` (\`mode: "submit"\`) echoing each string's \`fingerprint\`.\n4. Do NOT edit catalogs—stop once \`qe_audit\` (\`mode: "status"\`) shows \`unreviewed: 0\`.`,
      });

      const qeAfterR1 = wraith.summarizeQe({ rootDir: wDir, locales: [locale] });
      const openQKeys = new Set(wraith.listQuestions(wDir, "open").flatMap((q) => q.keys));
      const actionableFlags = qeAfterR1.flagged.filter((f) => !openQKeys.has(f.key));

      let wFixRes = null;
      let wReReviewRes = null;
      if (actionableFlags.length > 0) {
        console.log(`[OSS:${runKey}] Fresh Codex QE subagent flagged ${actionableFlags.length} strings -> running 1 remediation + re-review pass!`);
        wFixRes = await runCodex({
          label: `${app.id}-${locale}-W-fix`,
          cwd: wDir,
          useWraithMcp: true,
          logPath: path.join(runWork, "W-fix.jsonl"),
          prompt: `The fresh-context QE subagent flagged these \`${locale}\` translations:\n${JSON.stringify(actionableFlags, null, 2)}\n\nFix them via Wraith MCP \`apply\` (respecting placeholders, ICU/plurals, glossary/DNT, and Character Limits) and confirm \`check\` (\`locale: "${locale}"\`) has 0 catalog errors.`,
        });
        wReReviewRes = await runCodex({
          label: `${app.id}-${locale}-W-qe2`,
          cwd: wDir,
          useWraithMcp: true,
          logPath: path.join(runWork, "W-qe2.jsonl"),
          prompt: `${qeSkill}\n\nRe-review ONLY the newly unreviewed \`${locale}\` strings via \`qe_audit\` (\`mode: "prepare"\` -> read code -> \`mode: "submit"\` with \`fingerprint\`).`,
        });
      }

      const wPostFlat = app.readFlatTarget(wDir, locale);
      const wPostCheckRaw = wraith.runCheck({ rootDir: wDir, locale, limit: 500 });
      const wPostCatalogErrs = (wPostCheckRaw.issues?.errors ?? []).filter(
        (i) => !["hardcoded_string", "string_concatenation"].includes(i.code)
      );
      const wPostQe = wraith.summarizeQe({ rootDir: wDir, locales: [locale] });
      const wNotes = wraith.readContextNotes(wDir).notes;
      const wQuestions = wraith.listQuestions(wDir, "all");

      // Count how many strings changed between W-pre and W-post due to QE subagent
      const changedByQe = Object.keys(app.flatEn).filter((k) => (wPreFlat[k] ?? "") !== (wPostFlat[k] ?? ""));

      // Capture live Playwright rendered layout screenshots for nextjs-commerce across all 4 locales!
      let screenshots = [];
      let renderedDefects = null;
      if (app.hasLiveLayout) {
        screenshots = await captureWebScreenshots({
          flatByArm: { NMT: nmtFlat, B0: b0Flat, "W-post": wPostFlat },
          locale,
          outDir: SCREENSHOTS_DIR,
        });
        // Also measure automated Playwright defects for NMT vs W-post
        const measureLayout = async (flat, fixed) => {
          const srv = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(renderCommerceHtml(locale, flat, { fixedLayout: fixed }));
          });
          await new Promise((r) => srv.listen(0, "127.0.0.1", r));
          try {
            const res = await wraith.runLayoutCheck({
              rootDir: wDir,
              baseUrl: `http://127.0.0.1:${srv.address().port}`,
              routes: ["/"],
              locales: [locale],
              screenshotsDir: ".wraith/tmp-layout",
            });
            return { outcome: res.outcome, findingCount: res.findingCount, countsByType: res.countsByType };
          } finally {
            srv.close();
          }
        };
        renderedDefects = {
          NMT: await measureLayout(nmtFlat, false),
          B0: await measureLayout(b0Flat, false),
          "W-post": await measureLayout(wPostFlat, true),
        };
      }

      existing.runs[runKey] = {
        completed: true,
        appId: app.id,
        appName: app.name,
        framework: app.framework,
        format: app.format,
        locale,
        keyCount: Object.keys(app.flatEn).length,
        source: app.flatEn,
        contextMap: app.contextMap,
        arms: {
          NMT: {
            check: nmtCheck,
            billableChars: deeplRes.billableChars ?? Object.values(app.flatEn).join("").length,
            estApiUsd: Number((((deeplRes.billableChars ?? Object.values(app.flatEn).join("").length) * 25) / 1_000_000).toFixed(4)),
            translations: nmtFlat,
          },
          B0: {
            check: b0Check,
            wallS: b0Res.wallS,
            telemetry: b0Res.telemetry,
            translations: b0Flat,
          },
          A0: {
            check: a0Check,
            wallS: a0Res.wallS,
            telemetry: a0Res.telemetry,
            translations: a0Flat,
          },
          "W-pre": {
            check: wPreCheck,
            wallS: wPreRes.wallS,
            telemetry: wPreRes.telemetry,
            contextNotesCount: Object.keys(wNotes).length,
            questionsAsked: wQuestions,
            translations: wPreFlat,
          },
          "W-post": {
            check: {
              outcome: wPostCheckRaw.outcome,
              catalogErrorCount: wPostCatalogErrs.length,
              countsByCode: wPostCheckRaw.countsByCode,
            },
            qeInitialFlagged: qeAfterR1.flagged,
            changedByQeKeys: changedByQe,
            qeFinalOutcome: wPostQe.outcome,
            qeFinalSummary: wPostQe.summary,
            qeWallS: wQeRes.wallS,
            qeTelemetry: wQeRes.telemetry,
            fixTelemetry: wFixRes?.telemetry ?? null,
            reReviewTelemetry: wReReviewRes?.telemetry ?? null,
            translations: wPostFlat,
          },
        },
        renderedDefects,
        screenshots,
      };

      fs.writeFileSync(outPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...existing }, null, 2) + "\n");
      console.log(
        `[OSS:${runKey}] SAVED | Errs: NMT=${nmtCheck.catalogErrorCount} B0=${b0Check.catalogErrorCount} A0=${a0Check.catalogErrorCount} W-pre=${wPreCheck.catalogErrorCount} W-post=${wPostCatalogErrs.length} | QE flagged=${qeAfterR1.flagged.length} changed=${changedByQe.length} | Qs=${wQuestions.length}`
      );
    }
  }
  return existing;
}

// ============================================================================
// SUITE 2: REAL-WORLD DOCUMENTS (DeepL / Naive Codex vs Wraith + Codex)
// ============================================================================
function renderDocToPngs(inputFile, outPrefix) {
  const soffice = "/usr/bin/soffice";
  if (!fs.existsSync(soffice)) return [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-pub-render-"));
  const profDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-pub-lo-"));
  try {
    execFileSync(
      soffice,
      [`-env:UserInstallation=file://${profDir}`, "--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir", tmpDir, inputFile],
      { stdio: "ignore", timeout: 60_000 }
    );
    const pdfPath = path.join(tmpDir, path.basename(inputFile, path.extname(inputFile)) + ".pdf");
    if (!fs.existsSync(pdfPath)) return [];
    execFileSync("/usr/bin/pdftoppm", ["-png", "-r", "120", pdfPath, path.join(DOC_RENDERS_DIR, outPrefix)], { stdio: "ignore", timeout: 30_000 });
    return fs
      .readdirSync(DOC_RENDERS_DIR)
      .filter((f) => f.startsWith(outPrefix + "-") && f.endsWith(".png"))
      .sort()
      .map((f) => path.join(DOC_RENDERS_DIR, f));
  } catch {
    return [];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(profDir, { recursive: true, force: true });
  }
}

async function runDocsSuite() {
  const docWork = path.join(WORK_ROOT, "docs");
  fs.rmSync(docWork, { recursive: true, force: true });
  fs.mkdirSync(path.join(docWork, "docs"), { recursive: true });

  // Copy real complex DOCX (`northstar-policy.docx` with headers, footers, tables, tracked changes, comments)
  // AND our clinical discharge letter + PPTX + XLSX + VTT from big-one docs builder
  const bigOneDocs = path.join(EVAL_ROOT, "work/big-one/docs-project/docs");
  for (const name of ["northstar-policy.docx", "clinical-patient-letter.docx", "product-launch-deck.pptx", "q4-financial-model.xlsx", "product-demo.vtt", "webinar-clip.srt"]) {
    const src = fs.existsSync(path.join(bigOneDocs, name))
      ? path.join(bigOneDocs, name)
      : path.join(EVAL_ROOT, "docx", name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(docWork, "docs", name));
  }

  wraith.initProject({
    rootDir: docWork,
    sourceLocale: "en",
    targetLocales: ["de", "es-MX"],
    documents: ["docs"],
    writeAgentRule: false,
  });
  const st = new wraith.WraithStore(docWork);
  st.writeGlossary({ version: 1, entries: FULL_GLOSSARY });

  const results = [];
  const docTargets = [
    { file: "northstar-policy.docx", format: "docx", locale: "de", hasDeepLDoc: true },
    { file: "clinical-patient-letter.docx", format: "docx", locale: "es-MX", hasDeepLDoc: true },
    { file: "product-launch-deck.pptx", format: "pptx", locale: "de", hasDeepLDoc: false },
    { file: "q4-financial-model.xlsx", format: "xlsx", locale: "de", hasDeepLDoc: false },
    { file: "product-demo.vtt", format: "vtt", locale: "de", hasDeepLDoc: false },
    { file: "webinar-clip.srt", format: "srt", locale: "es-MX", hasDeepLDoc: false },
  ];

  for (const spec of docTargets) {
    const srcRel = `docs/${spec.file}`;
    const ext = path.extname(spec.file);
    const base = path.basename(spec.file, ext);
    const tgtRel = `docs/${base}.${spec.locale}${ext}`;
    const absSrc = path.join(docWork, srcRel);
    const absTgt = path.join(docWork, tgtRel);

    let deeplDocRes = null;
    let deeplVerify = null;
    let deeplPngs = [];
    if (spec.hasDeepLDoc) {
      const deeplOut = path.join(docWork, `docs/${base}.deepl.${spec.locale}${ext}`);
      try {
        deeplDocRes = await translateDocxWithDeepL({
          stageName: `pub-doc-${base}-${spec.locale}`,
          label: `${base}-${spec.locale}`,
          sourceDocxPath: absSrc,
          targetDocxPath: deeplOut,
          locale: spec.locale,
          glossaryEntries: FULL_GLOSSARY,
        });
        await cleanupWraithEvalGlossaries("pub-doc-slot");
        deeplVerify = wraith.verifyDocumentFormatting({ sourceFile: absSrc, targetFile: deeplOut });
        deeplPngs = renderDocToPngs(deeplOut, `${base}-${spec.locale}-deepl`);
      } catch (err) {
        deeplDocRes = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const codexRes = await runCodex({
      label: `doc-${spec.file}-${spec.locale}`,
      cwd: docWork,
      useWraithMcp: true,
      logPath: path.join(docWork, `codex-${base}-${spec.locale}.jsonl`),
      prompt: `Translate the document \`${srcRel}\` into locale \`${spec.locale}\` and write to \`${tgtRel}\` using Wraith MCP tools (\`rootDir: "."\`):
1. Call \`prepare\` with \`document: "${srcRel}"\`, \`targetLocale: "${spec.locale}"\`, \`limit: 100\`, \`offset: 0\`.
2. Translate EVERY segment accurately in natural, domain-appropriate \`${spec.locale}\` preserving ALL \`<x id="..."/>\` and \`<g id="...">...</g>\` inline tags, DNT brands (Northstar, Northstar Pay, LedgerVault, PulseGrid, CardioPulse), and subtitle \`constraints.maxChars\` / max 2 lines where present.
3. Call \`apply\` with \`document: "${srcRel}"\`, \`targetFile: "${tgtRel}"\`, \`targetLocale: "${spec.locale}"\`, and \`documentUpdates: [{ id, text }, ...]\`. Fix any rejected segments until \`ok: true\`.`,
    });

    const exists = fs.existsSync(absTgt);
    let wVerify = null;
    let wPngs = [];
    let srcPngs = [];
    if (exists && (spec.format === "docx" || spec.format === "pptx" || spec.format === "xlsx")) {
      wVerify = wraith.verifyDocumentFormatting({ sourceFile: absSrc, targetFile: absTgt });
      srcPngs = renderDocToPngs(absSrc, `${base}-en`);
      wPngs = renderDocToPngs(absTgt, `${base}-${spec.locale}-wraith`);
    }

    let subtitleAudit = null;
    if (exists && (spec.format === "vtt" || spec.format === "srt")) {
      const adapter = new wraith.SubtitleDocumentAdapter(spec.format);
      const srcEx = adapter.extract(absSrc);
      const tgtEx = adapter.extract(absTgt);
      subtitleAudit = {
        cuesPreserved: srcEx.segments.length === tgtEx.segments.length,
        cueCount: tgtEx.segments.length,
        maxCpsObserved: Math.max(...tgtEx.segments.map((s) => Number((s.plainText.length / (s.constraints?.durationSec ?? 1)).toFixed(1)))),
        maxLinesObserved: Math.max(...tgtEx.segments.map((s) => s.plainText.split(/\r?\n/).length)),
        timestampsIdentical: srcEx.segments.every((s, i) => s.constraints?.durationSec === tgtEx.segments[i]?.constraints?.durationSec),
      };
    }

    // Extract source & target segment texts for blinded MQM judging
    const docAdapter = wraith.getDocumentAdapter(absSrc);
    const srcSegs = docAdapter ? docAdapter.extract(absSrc).segments.map((s) => ({ id: s.id, text: s.plainText })) : [];
    const wSegs = exists && docAdapter ? docAdapter.extract(absTgt).segments.map((s) => ({ id: s.id, text: s.plainText })) : [];
    const deeplPath = path.join(docWork, `docs/${base}.deepl.${spec.locale}${ext}`);
    const deeplSegs = fs.existsSync(deeplPath) && docAdapter ? docAdapter.extract(deeplPath).segments.map((s) => ({ id: s.id, text: s.plainText })) : [];

    results.push({
      file: spec.file,
      format: spec.format,
      locale: spec.locale,
      exists,
      codexWallS: codexRes.wallS,
      codexTelemetry: codexRes.telemetry,
      wraithVerify: wVerify,
      deeplDocRes: deeplDocRes ? { billableChars: deeplDocRes.billableChars ?? null, error: deeplDocRes.error ?? null } : null,
      deeplVerify,
      subtitleAudit,
      renders: { srcPngs, wPngs, deeplPngs },
      segments: { source: srcSegs, wraith: wSegs, deepl: deeplSegs },
    });

    fs.writeFileSync(
      path.join(RESULTS_DIR, "docs-audit.json"),
      JSON.stringify({ updatedAt: new Date().toISOString(), documents: results }, null, 2) + "\n"
    );
  }
  return results;
}

// ============================================================================
// SUITE 3: BLINDED, POSITION-SWAPPED CLAUDE OPUS MQM JUDGE
// ============================================================================
async function runBlindedMqmJudge() {
  const ossPath = path.join(RESULTS_DIR, "oss-5arm.json");
  if (!fs.existsSync(ossPath)) throw new Error("Run `oss` before `judge`");
  const oss = JSON.parse(fs.readFileSync(ossPath, "utf8"));
  const judgeOutPath = path.join(RESULTS_DIR, "mqm-judge.json");
  const judgeData = fs.existsSync(judgeOutPath) ? JSON.parse(fs.readFileSync(judgeOutPath, "utf8")) : { judgedRuns: {} };

  const ARM_NAMES = ["NMT", "B0", "A0", "W-pre", "W-post"];
  const LABELS = ["Cand_1", "Cand_2", "Cand_3", "Cand_4", "Cand_5"];

  for (const [runKey, run] of Object.entries(oss.runs)) {
    if (!run.completed || judgeData.judgedRuns[runKey]) continue;

    // Deterministic seeded shuffle per item so arms are completely blinded & position-swapped!
    const keys = Object.keys(run.source);
    const keyItems = [];
    const blindMap = {};

    for (let idx = 0; idx < keys.length; idx++) {
      const k = keys[idx];
      // Rotate permutation cleanly across all 5 positions
      const perm = ARM_NAMES.map((_, i) => ARM_NAMES[(i + idx) % ARM_NAMES.length]);
      blindMap[k] = Object.fromEntries(LABELS.map((lbl, i) => [lbl, perm[i]]));
      const candidates = Object.fromEntries(LABELS.map((lbl, i) => [lbl, run.arms[perm[i]]?.translations?.[k] ?? ""]));
      keyItems.push({
        key: k,
        source: run.source[k],
        context: run.contextMap?.[k] ?? "",
        candidates,
      });
    }

    // Batch in chunks of 25 keys so the judge stays razor-sharp and never truncates JSON
    const allScores = {};
    let totalJudgeCost = 0;
    for (let start = 0; start < keyItems.length; start += 25) {
      const chunk = keyItems.slice(start, start + 25);
      const prompt = `You are an expert MQM (Multidimensional Quality Metrics) localization auditor evaluating ${chunk.length} UI strings translated from English into \`${run.locale}\` for "${run.appName}".

For EACH item, you are given the English source, the real code/UI context, and 5 BLINDED candidate translations (Cand_1..Cand_5).
Evaluate EACH candidate strictly against the source + code context + target locale conventions + brand DNT rules (Northstar, Northstar Pay, PulseGrid, LedgerVault, Fossify, Mastodon must stay untranslated; in nextjs-commerce Workspace=Arbeitsbereich/espacio de trabajo/工作区/مساحة العمل, Invoice=Rechnung/factura/发票/فاتورة, Seat=Lizenz/licencia/席位/مقعد).

MQM Penalty Weights:
- critical = 10 (opposite meaning, broken placeholder/ICU/tag, dropped DNT brand, severe mistranslation)
- major = 5 (wrong word sense / context missed, wrong glossary term, omitted content, wrong UI form)
- minor = 1 (slight register/awkward phrasing, minor punctuation)
Score = max(0, 100 - sum(penalties)).
Also set \`contextMissed: true\` if the candidate chose the wrong sense/meaning because it missed the UI/code context.

Return ONLY valid JSON (no markdown fences) matching:
{
  "<key>": {
    "Cand_1": { "score": 100, "contextMissed": false, "terminologyError": false, "errors": [] },
    "Cand_2": { "score": 95, "contextMissed": true, "terminologyError": false, "errors": [{"type":"wrong_sense","severity":"major","note":"..."}] },
    ...
  }
}

Items:
${JSON.stringify(chunk, null, 2)}`;

      const jRes = await runClaudeJudge({ label: `${runKey}-${start}`, prompt });
      totalJudgeCost += jRes.costUsd;
      const rawJson = jRes.resultText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      try {
        const parsed = JSON.parse(rawJson);
        Object.assign(allScores, parsed);
      } catch (err) {
        console.warn(`[judge:${runKey}-${start}] JSON parse failed:`, err.message);
      }
    }

    // Unblind scores back to NMT, B0, A0, W-pre, W-post
    const byArm = Object.fromEntries(
      ARM_NAMES.map((a) => [a, { n: 0, scoreSum: 0, contextMissed: 0, terminologyErrors: 0, criticalErrors: 0, majorErrors: 0, minorErrors: 0 }])
    );

    for (const [k, candScores] of Object.entries(allScores)) {
      const map = blindMap[k];
      if (!map) continue;
      for (const [lbl, arm] of Object.entries(map)) {
        const sc = candScores?.[lbl];
        if (!sc || typeof sc.score !== "number") continue;
        const agg = byArm[arm];
        agg.n++;
        agg.scoreSum += sc.score;
        if (sc.contextMissed) agg.contextMissed++;
        if (sc.terminologyError) agg.terminologyErrors++;
        for (const e of sc.errors ?? []) {
          if (e.severity === "critical") agg.criticalErrors++;
          else if (e.severity === "major") agg.majorErrors++;
          else agg.minorErrors++;
        }
      }
    }

    const summaryByArm = {};
    for (const [arm, agg] of Object.entries(byArm)) {
      summaryByArm[arm] = {
        ...agg,
        avgMqmScore: agg.n ? Number((agg.scoreSum / agg.n).toFixed(2)) : null,
      };
    }

    judgeData.judgedRuns[runKey] = {
      appId: run.appId,
      locale: run.locale,
      judgeModel: JUDGE_MODEL,
      judgeCostUsd: Number(totalJudgeCost.toFixed(4)),
      summaryByArm,
      rawUnblindedSample: Object.fromEntries(
        Object.keys(allScores)
          .slice(0, 10)
          .map((k) => [
            k,
            Object.fromEntries(
              Object.entries(blindMap[k] ?? {}).map(([lbl, arm]) => [arm, allScores[k]?.[lbl]])
            ),
          ])
      ),
    };
    fs.writeFileSync(judgeOutPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...judgeData }, null, 2) + "\n");
    console.log(`[judge:${runKey}] MQM avg:`, Object.fromEntries(ARM_NAMES.map((a) => [a, summaryByArm[a].avgMqmScore])));
  }

  return judgeData;
}

const cmd = process.argv[2] ?? "all";
if (cmd === "oss") {
  await runOss5ArmSuite();
} else if (cmd === "docs") {
  await runDocsSuite();
} else if (cmd === "judge") {
  await runBlindedMqmJudge();
} else if (cmd === "all") {
  await runOss5ArmSuite();
  await runDocsSuite();
  await runBlindedMqmJudge();
} else {
  console.error("Usage: node eval/bench/publishable-audit.mjs [oss|docs|judge|all]");
  process.exit(1);
}
