#!/usr/bin/env node
/**
 * Wraith Claude Code + Fresh-Context Claude Code QE Subagent Benchmark Suite
 *
 * Subcommands:
 *   node eval/bench/claude-pilot.mjs probe      # 1-turn smoke check of `claude -p` + Wraith MCP (`dist/bin.js mcp`)
 *   node eval/bench/claude-pilot.mjs qe-blind   # 50-string planted semantic error benchmark (fresh Claude QE subagent)
 *   node eval/bench/claude-pilot.mjs e2e-trial  # Baseline Raw JSON vs Wraith + Claude + Fresh Claude QE Subagent (de + ar) + Playwright Before/After screenshots
 *   node eval/bench/claude-pilot.mjs all        # Run probe -> qe-blind -> e2e-trial
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const WORK_ROOT = path.join(EVAL_ROOT, "work", "claude-pilot");
const RESULTS_DIR = path.join(EVAL_ROOT, "results");
const GALLERY_DIR = path.join(RESULTS_DIR, "gallery-claude-pilot");

const NODE_BIN = process.execPath;
const WRAITH_CLI = path.join(REPO_ROOT, "dist", "bin.js");
const CLAUDE_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/claude")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/claude"
  : "claude";

const MODEL = process.env.WRAITH_BENCH_MODEL ?? "sonnet";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const {
  buildPilotApp,
  PILOT_APP_DIR,
  PILOT_GLOSSARY,
  renderPilotAppHtml,
} = await import(path.join(EVAL_ROOT, "synthetic", "build-pilot-app.mjs"));

wraith.ensureBootstrapped();

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

function nestDotKeys(flat) {
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

function writeMcpConfig(dir) {
  const mcpPath = path.join(dir, ".wraith-bench-mcp.json");
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          wraith: {
            command: NODE_BIN,
            args: [WRAITH_CLI, "mcp"],
          },
        },
      },
      null,
      2
    )
  );
  return mcpPath;
}

async function runClaudeSession({
  label,
  cwd,
  prompt,
  useWraithMcp = true,
  allowedTools = null,
  model = MODEL,
  timeoutMs = 600_000,
  logPath = null,
}) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    model,
    "--dangerously-skip-permissions",
  ];

  let mcpConfigPath = null;
  if (useWraithMcp) {
    mcpConfigPath = writeMcpConfig(os.tmpdir());
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  } else {
    const emptyMcp = path.join(os.tmpdir(), `.wraith-empty-mcp-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(emptyMcp, JSON.stringify({ mcpServers: {} }));
    mcpConfigPath = emptyMcp;
    args.push("--mcp-config", emptyMcp, "--strict-mcp-config");
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  console.log(`\n[claude:${label}] starting (model=${model}, mcp=${useWraithMcp}, cwd=${cwd})...`);
  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
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

    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
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

  if (mcpConfigPath) {
    fs.rmSync(mcpConfigPath, { force: true });
  }

  const wallS = Number(((Date.now() - t0) / 1000).toFixed(1));
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, stdout, "utf8");
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    // fallback if multiple lines
    const lastLine = stdout.trim().split(/\r?\n/).pop() ?? "";
    try {
      parsed = JSON.parse(lastLine);
    } catch {
      parsed = null;
    }
  }

  const usage = parsed?.usage ?? {};
  const telemetry = {
    model,
    numTurns: parsed?.num_turns ?? 0,
    durationMs: parsed?.duration_ms ?? Math.round(wallS * 1000),
    totalCostUsd: parsed?.total_cost_usd ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    isError: Boolean(parsed?.is_error),
    subtype: parsed?.subtype ?? null,
    resultText: typeof parsed?.result === "string" ? parsed.result : "",
  };

  console.log(
    `[claude:${label}] finished in ${wallS}s (exit=${exitCode}, timedOut=${timedOut}, turns=${telemetry.numTurns}, costUsd=$${Number(telemetry.totalCostUsd).toFixed(4)}, isError=${telemetry.isError})`
  );
  if (exitCode !== 0 || telemetry.isError) {
    console.warn(`[claude:${label}] error/stderr:`, telemetry.resultText.slice(0, 400), stderr.slice(0, 600));
  }
  return { label, exitCode, timedOut, wallS, telemetry, stderrPreview: stderr.slice(0, 1000) };
}

// ============================================================================
// 1. PROBE: Verify Claude Code CLI + Wraith MCP connectivity
// ============================================================================
async function runProbe() {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-claude-probe-"));
  try {
    fs.mkdirSync(path.join(probeDir, "messages"), { recursive: true });
    fs.writeFileSync(
      path.join(probeDir, "package.json"),
      JSON.stringify({ name: "probe", dependencies: { next: "15.0.0", "next-intl": "4.0.0" } })
    );
    fs.writeFileSync(path.join(probeDir, "messages/en.json"), JSON.stringify({ nav: { home: "Home" } }, null, 2));
    fs.writeFileSync(path.join(probeDir, "messages/de.json"), "{}\n");
    wraith.initProject({ rootDir: probeDir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

    const res = await runClaudeSession({
      label: "probe",
      cwd: probeDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__status"],
      timeoutMs: 90_000,
      prompt:
        'Call `mcp__wraith__status` with `{"rootDir": "."}` and reply in one short line with `sourceLocale` and `targetLocales`.',
    });
    if (res.exitCode !== 0 || res.telemetry.isError || !res.telemetry.resultText.includes("de")) {
      throw new Error(`Probe failed: exit=${res.exitCode}, result=${res.telemetry.resultText}`);
    }
    console.log("[probe] SUCCESS — Claude Code invoked Wraith MCP `status` cleanly:", res.telemetry.resultText.trim());
    return res;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

// ============================================================================
// 2. QE-BLIND: 50-String Planted Semantic Error Detection (Fresh Claude Subagent)
// ============================================================================
const QE_CORRUPT = {
  "BillingForm.save": ["Sparen", "wrong-sense"],
  "SignupForm.submit": ["Unterwerfen", "wrong-sense"],
  "ApiKeysPanel.close": ["Nah", "wrong-sense"],
  "FileUploader.cancel": ["Kündigen", "wrong-sense"],
  "OrderHistory.active": ["Aktion", "wrong-sense"],
  "ApiKeysPanel.confirmDelete": ["Möchten Sie {name} wirklich nicht löschen?", "negation"],
  "UserProfileForm.required": ["Dieses Feld ist optional.", "inversion"],
  "SignupForm.minChars": ["Darf höchstens {min} Zeichen lang sein.", "inversion"],
  "BillingForm.failed": ["Erfolgreich", "inversion"],
  "InvoiceTable.pending": ["Abgelehnt", "inversion"],
  "DocumentCard.deletedToast": ["<b>{name}</b> wurde erstellt.", "wrong-meaning"],
  "DocumentCard.lastUpdated": ["Zuerst erstellt {date}", "wrong-meaning"],
  "FileUploader.filesSelected": ["{count, plural, one {# Datei gelöscht} other {# Dateien gelöscht}}", "wrong-meaning"],
  "TeamMembersList.items": ["{count, plural, one {# Element} other {# Fehler}}", "wrong-meaning"],
  "BillingForm.email": ["Geben Sie eine gültige Adresse ein.", "omission"],
  "SignupForm.email": ["Geben Sie eine gültige E-Mail-Adresse ein, um 10 % Rabatt zu erhalten.", "addition"],
  "TeamMembersList.confirmDelete": ["Willst du {name} wirklich löschen?", "register"],
  "DocumentCard.edit": ["Bearbeitung wird gerade durchgeführt", "ui-form"],
  "ProjectSettings.archived": ["Aktiv", "inversion"],
  "TaskBoard.close": ["Schließung", "ui-form"],
};

const QE_CLEAN = [
  "ApiKeysPanel.active", "ApiKeysPanel.delete", "ApiKeysPanel.deletedToast", "BillingForm.required", "BillingForm.submit",
  "DocumentCard.archived", "FileUploader.failed", "FileUploader.submit", "InvoiceTable.edit", "InvoiceTable.lastUpdated",
  "NotificationPanel.items", "OrderHistory.pending", "ProjectSettings.cancel", "ProjectSettings.confirmDelete", "ProjectSettings.save",
  "SignupForm.required", "TaskBoard.filesSelected", "TaskBoard.save", "UserProfileForm.minChars", "UserProfileForm.email",
];

const QE_ONE_OFF = {
  "CheckoutPanel.placeOrder": ["Place order", "Bestellung aufgeben", null],
  "CheckoutPanel.emptyCart": ["Your cart is empty.", "Ihr Warenkorb ist leer.", null],
  "CheckoutPanel.applyCoupon": ["Apply coupon", "Gutschein einlösen", null],
  "CheckoutPanel.backToShop": ["Back to shop", "Zurück zum Shop", null],
  "CheckoutPanel.orderTotal": ["Order total", "Gesamtsumme", null],
  "CheckoutPanel.freeShipping": ["Free shipping on orders over {amount}", "Kostenloser Versand ab einem Bestellwert von {amount}", "Kostenloser Versand für Bestellungen unter {amount}", "inversion"],
  "CheckoutPanel.removeItem": ["Remove item", "Artikel entfernen", "Artikel hinzufügen", "inversion"],
  "CheckoutPanel.estimatedDelivery": ["Estimated delivery: {date}", "Voraussichtliche Lieferung: {date}", "Tatsächliche Lieferung: {date}", "wrong-meaning"],
  "CheckoutPanel.paymentDeclined": ["Payment declined. Try another card.", "Zahlung abgelehnt. Versuchen Sie es mit einer anderen Karte.", "Zahlung abgelehnt.", "omission"],
  "CheckoutPanel.signOut": ["Sign out", "Abmelden", "Anmelden", "inversion"],
};

const QE_CHECKOUT_TSX = `import { useTranslations } from "next-intl";
export function CheckoutPanel({ total, freeFrom, eta }) {
  const t = useTranslations("CheckoutPanel");
  return (
    <aside>
      <header><button onClick={signOut}>{t("signOut")}</button></header>
      <p className="empty">{t("emptyCart")}</p>
      <ul><li>Item <button onClick={() => removeFromCart(id)}>{t("removeItem")}</button></li></ul>
      <p className="promo">{t("freeShipping", { amount: freeFrom })}</p>
      <p className="eta">{t("estimatedDelivery", { date: eta })}</p>
      <form onSubmit={applyCoupon}><input name="coupon" /><button>{t("applyCoupon")}</button></form>
      <dl><dt>{t("orderTotal")}</dt><dd>{total}</dd></dl>
      <p role="alert" className="error">{t("paymentDeclined")}</p>
      <button type="submit">{t("placeOrder")}</button>
      <a href="/shop">{t("backToShop")}</a>
    </aside>
  );
}
`;

async function runQeBlind() {
  const qeWork = path.join(WORK_ROOT, "qe-blind");
  const projectDir = path.join(qeWork, "project");
  fs.rmSync(qeWork, { recursive: true, force: true });
  fs.mkdirSync(path.join(projectDir, "messages"), { recursive: true });

  const ds = JSON.parse(fs.readFileSync(path.join(EVAL_ROOT, "work/tm-ablation/dataset.json"), "utf8"));
  const deItems = ds.slices.find((s) => s.id === "synthetic-app").items.filter((i) => i.locale === "de");
  const byKey = Object.fromEntries(deItems.map((i) => [i.key, i]));

  fs.cpSync(path.join(EVAL_ROOT, "work/tm-ablation/synthetic-app/src"), path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } }, null, 2)
  );

  const en = {};
  const target = {};
  const labels = {};
  for (const i of deItems) en[i.key] = i.source;
  for (const k of QE_CLEAN) {
    target[k] = byKey[k].gold;
    labels[k] = { corrupted: false, source: en[k], target: target[k] };
  }
  for (const [k, [bad, cls]] of Object.entries(QE_CORRUPT)) {
    target[k] = bad;
    labels[k] = { corrupted: true, class: cls, source: en[k], target: bad, gold: byKey[k].gold };
  }
  for (const [k, [src, gold, bad, cls]] of Object.entries(QE_ONE_OFF)) {
    en[k] = src;
    target[k] = bad ?? gold;
    labels[k] = bad
      ? { corrupted: true, class: cls, source: src, target: bad, gold, oneOff: true }
      : { corrupted: false, source: src, target: gold, oneOff: true };
  }

  fs.writeFileSync(path.join(projectDir, "src/components/CheckoutPanel.tsx"), QE_CHECKOUT_TSX);
  fs.writeFileSync(path.join(projectDir, "messages/en.json"), JSON.stringify(nestDotKeys(en), null, 2) + "\n");
  fs.writeFileSync(path.join(projectDir, "messages/de.json"), "{}\n");

  // Init BEFORE writing corrupted targets so TM is empty (blind code-context review)
  wraith.initProject({ rootDir: projectDir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  fs.writeFileSync(path.join(projectDir, "messages/de.json"), JSON.stringify(nestDotKeys(target), null, 2) + "\n");

  const checkBefore = wraith.runCheck({ rootDir: projectDir, locale: "de", limit: 500 });
  const evaluatedSet = new Set(Object.keys(labels));
  const checkErrorsOnEvaluated50 = (checkBefore.issues?.errors ?? []).filter(
    (i) => evaluatedSet.has(i.key)
  ).length;
  console.log(
    `[qe-blind] deterministic check errors on the 50 evaluated strings: ${checkErrorsOnEvaluated50}/25 planted corruptions`
  );

  const qeSkillBody = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/qe-review/SKILL.md"), "utf8"));
  const subagentRes = await runClaudeSession({
    label: "qe-blind-subagent",
    cwd: projectDir,
    useWraithMcp: true,
    allowedTools: ["mcp__wraith__qe_audit", "Read", "Glob", "Grep"],
    timeoutMs: 420_000,
    logPath: path.join(qeWork, "claude-qe-subagent.json"),
    prompt: `${qeSkillBody}

---
TASK: Perform ONLY the fresh-context binary QE review (Steps 2–4 of qe-review) for locale \`de\` in this workspace (\`rootDir: "."\`):
1. Call \`mcp__wraith__qe_audit\` with \`mode: "prepare"\` and \`locales: ["de"]\`.
2. Open and read EVERY component file referenced in \`tasks\` under \`src/components/\` so you see how each string is used in the UI, as well as the UI's German register (Sie vs du) and sibling translations.
3. Submit verdicts for ALL 50 strings via \`mcp__wraith__qe_audit\` with \`mode: "submit"\` (include each string's \`fingerprint\` from \`prepare\`, plus \`reason\` and \`suggestedFix\` on every \`flag\`).
4. Do NOT edit catalogs—stop as soon as all 50 verdicts are submitted and \`mcp__wraith__qe_audit\` (\`mode: "status"\`) shows \`unreviewed: 0\`.`,
  });

  const index = wraith.qeIndex(projectDir);
  const rows = Object.entries(labels).map(([key, l]) => {
    const r = index.get(`de\0${key}`);
    return {
      key,
      source: l.source,
      target: l.target,
      gold: l.gold ?? null,
      corrupted: l.corrupted,
      oneOff: Boolean(l.oneOff),
      class: l.class ?? null,
      verdict: r?.verdict ?? "missing",
      reason: r?.reason ?? null,
      suggestedFix: r?.suggestedFix ?? null,
    };
  });

  const pct = (n, d) => (d ? Number(((100 * n) / d).toFixed(1)) : null);
  const rate = (rs, pred) => ({ n: rs.length, hit: rs.filter(pred).length, pct: pct(rs.filter(pred).length, rs.length) });
  const isFlagged = (r) => r.verdict === "flag";

  const metrics = {
    n: rows.length,
    deterministicCheckCaughtOn50: checkErrorsOnEvaluated50,
    unreviewedCount: rows.filter((r) => r.verdict === "missing").length,
    recallAll: rate(rows.filter((r) => r.corrupted), isFlagged),
    recallRecurring: rate(rows.filter((r) => r.corrupted && !r.oneOff), isFlagged),
    recallOneOff: rate(rows.filter((r) => r.corrupted && r.oneOff), isFlagged),
    falseFlags: rate(rows.filter((r) => !r.corrupted), isFlagged),
    missed: rows.filter((r) => r.corrupted && !isFlagged(r)),
    wronglyFlagged: rows.filter((r) => !r.corrupted && isFlagged(r)),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    benchmark: "claude-qe-blind-50",
    reviewerAgent: `claude -p --model ${MODEL} --no-session-persistence (fresh-context subagent) + Wraith MCP qe_audit`,
    telemetry: subagentRes.telemetry,
    wallS: subagentRes.wallS,
    metrics,
    rows,
  };
  const outPath = path.join(RESULTS_DIR, "claude-qe-blind.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("\n[qe-blind] SUMMARY:", JSON.stringify(metrics, null, 2));
  return out;
}

// ============================================================================
// 3. E2E-TRIAL: Raw JSON Baseline vs Wraith + Claude + Fresh Claude QE Subagent + Layout Gallery
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

function renderBenchmarkHtml(locale, flatMsgs, { fixedLayout = false } = {}) {
  const renderedMsgs = {};
  for (const [k, raw] of Object.entries(flatMsgs)) {
    renderedMsgs[k] = String(raw ?? "").replace(/<\/?(link|b|strong|codeTag)>/g, "");
  }
  let html = renderPilotAppHtml(locale, renderedMsgs);
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

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const modName of ["playwright", "playwright-core"]) {
    try {
      const m = req(modName);
      if (m?.chromium) return m;
    } catch {
      // try next
    }
  }
  const extra = [];
  try {
    const binPath = execFileSync("which", ["playwright"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)[0]?.trim();
    if (binPath && fs.existsSync(binPath)) {
      const dir = path.dirname(fs.realpathSync(binPath));
      extra.push(path.resolve(dir, "..", "playwright"), path.resolve(dir, ".."), path.resolve(dir, "..", "lib", "node_modules", "playwright"));
    }
  } catch { /* ignore */ }
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (g) extra.push(path.join(g, "playwright"), path.join(g, "playwright-core"));
  } catch { /* ignore */ }
  for (const c of extra) {
    try {
      const m = req(c);
      if (m?.chromium) return m;
    } catch { /* ignore */ }
  }
  return null;
}

async function captureGalleryScreenshots({ urlBase, locales, tag, outDir }) {
  const pw = loadPlaywright();
  if (!pw) {
    console.warn("[gallery] Playwright not found globally; skipping extra header-crop screenshots.");
    return [];
  }
  fs.mkdirSync(outDir, { recursive: true });
  const execPath = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find((p) =>
    fs.existsSync(p)
  );
  const browser = await pw.chromium.launch({ headless: true, ...(execPath ? { executablePath: execPath } : {}) });
  const captured = [];
  try {
    for (const locale of locales) {
      for (const vp of [
        { width: 375, height: 812, name: "375w" },
        { width: 1280, height: 800, name: "1280w" },
      ]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        await page.goto(`${urlBase}/?locale=${encodeURIComponent(locale)}`, { waitUntil: "networkidle" });
        const fullPath = path.join(outDir, `${tag}-${locale}-${vp.name}.png`);
        await page.screenshot({ path: fullPath, fullPage: true });
        captured.push({ tag, locale, viewport: vp.name, kind: "full", path: fullPath });

        if (vp.width === 1280) {
          const header = page.locator("header");
          const headerPath = path.join(outDir, `${tag}-${locale}-header-crop.png`);
          await header.screenshot({ path: headerPath });
          captured.push({ tag, locale, viewport: vp.name, kind: "header-crop", path: headerPath });
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return captured;
}

function createProjectCopy(targetDir, locales = ["de", "ar"]) {
  buildPilotApp();
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(PILOT_APP_DIR, targetDir, {
    recursive: true,
    filter: (p) => !p.endsWith("challenge-labels.json"),
  });

  const enPath = path.join(targetDir, "messages/en.json");
  const enObj = JSON.parse(fs.readFileSync(enPath, "utf8"));
  enObj.extras = Object.fromEntries(Object.entries(SEEDED_AMBIGUOUS).map(([k, v]) => [k.split(".")[1], v]));
  fs.writeFileSync(enPath, JSON.stringify(enObj, null, 2) + "\n");
  fs.writeFileSync(path.join(targetDir, "src/components/CatalogExtras.tsx"), EXTRAS_TSX);
  fs.mkdirSync(path.join(targetDir, "src/app"), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "src/app/layout.tsx"),
    `export default function RootLayout({ children }: { children: any }) {
  return (
    <html>
      <body className="ml-4 mr-2 pl-3 text-left border-l border-slate-200">{children}</body>
    </html>
  );
}
`
  );

  for (const loc of locales) {
    fs.writeFileSync(path.join(targetDir, `messages/${loc}.json`), "{}\n");
  }
}

async function runE2eTrial({ resumeFromR1 = false } = {}) {
  const locales = ["de", "ar"];
  const e2eWork = path.join(WORK_ROOT, "e2e");
  const rawJsonOnlyDir = path.join(e2eWork, "raw-json-agent-dir");
  const rawEvalDir = path.join(e2eWork, "raw-eval-project");
  const wraithDir = path.join(e2eWork, "wraith-project");

  const readSavedTelemetry = (logFile) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
      const usage = parsed?.usage ?? {};
      return {
        wallS: Number(((parsed?.duration_ms ?? 0) / 1000).toFixed(1)),
        telemetry: {
          model: MODEL,
          numTurns: parsed?.num_turns ?? 0,
          durationMs: parsed?.duration_ms ?? 0,
          totalCostUsd: parsed?.total_cost_usd ?? 0,
          inputTokens: usage.input_tokens ?? 0,
          cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          isError: Boolean(parsed?.is_error),
          subtype: parsed?.subtype ?? null,
          resultText: typeof parsed?.result === "string" ? parsed.result : "",
        },
      };
    } catch {
      return { wallS: 0, telemetry: null };
    }
  };

  if (!resumeFromR1) {
    fs.rmSync(e2eWork, { recursive: true, force: true });
    fs.rmSync(GALLERY_DIR, { recursive: true, force: true });
    fs.mkdirSync(e2eWork, { recursive: true });
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
  } else {
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
  }

  const glossaryEntries = PILOT_GLOSSARY.map((g) => ({ ...g, updatedAt: new Date().toISOString() }));

  // --------------------------------------------------------------------------
  // ARM 1: Traditional Raw JSON Baseline (Claude sees ONLY messages/en.json)
  // --------------------------------------------------------------------------
  let rawRes;
  if (resumeFromR1 && fs.existsSync(path.join(rawEvalDir, "messages/de.json"))) {
    rawRes = readSavedTelemetry(path.join(e2eWork, "claude-baseline-raw.json"));
    console.log(`[resume-r2] Reusing completed baseline-raw-json (${rawRes.wallS}s, $${rawRes.telemetry?.totalCostUsd?.toFixed?.(4) ?? "?"})`);
  } else {
    createProjectCopy(rawEvalDir, locales);
    fs.mkdirSync(path.join(rawJsonOnlyDir, "messages"), { recursive: true });
    fs.copyFileSync(path.join(rawEvalDir, "messages/en.json"), path.join(rawJsonOnlyDir, "messages/en.json"));

    rawRes = await runClaudeSession({
      label: "baseline-raw-json",
      cwd: rawJsonOnlyDir,
      useWraithMcp: false,
      allowedTools: ["Read", "Write"],
      timeoutMs: 360_000,
      logPath: path.join(e2eWork, "claude-baseline-raw.json"),
      prompt: `Translate \`messages/en.json\` into German (\`messages/de.json\`) and Modern Standard Arabic (\`messages/ar.json\`), preserving the exact nested JSON structure, ICU MessageFormat syntax, placeholders, and inline tags. Write both files directly to \`messages/de.json\` and \`messages/ar.json\`.`,
    });

    for (const loc of locales) {
      const p = path.join(rawJsonOnlyDir, `messages/${loc}.json`);
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, path.join(rawEvalDir, `messages/${loc}.json`));
      }
    }

    wraith.initProject({ rootDir: rawEvalDir, sourceLocale: "en", targetLocales: locales, writeAgentRule: false });
    const rawStore = new wraith.WraithStore(rawEvalDir);
    rawStore.writeGlossary({ version: 1, entries: glossaryEntries });
    rawStore.writeConfig({ ...rawStore.readConfig(), charLimits: DECLARED_LIMITS });
    wraith.generatePseudoLocale(rawEvalDir, { mode: "auto" });
  }

  const rawFlatByLoc = {
    en: flattenJson(JSON.parse(fs.readFileSync(path.join(rawEvalDir, "messages/en.json"), "utf8"))),
  };
  for (const loc of [...locales, "en-XA", "ar-XB", "ja-XC", "de-XE"]) {
    const p = path.join(rawEvalDir, `messages/${loc}.json`);
    if (fs.existsSync(p)) rawFlatByLoc[loc] = flattenJson(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  const rawServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const loc = u.searchParams.get("locale") ?? "en";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBenchmarkHtml(loc, rawFlatByLoc[loc] ?? rawFlatByLoc.en, { fixedLayout: false }));
  });
  await new Promise((r) => rawServer.listen(0, "127.0.0.1", r));
  const rawBaseUrl = `http://127.0.0.1:${rawServer.address().port}`;

  let rawLayoutRendered;
  let rawScreenshots = [];
  try {
    rawLayoutRendered = await wraith.runLayoutCheck({
      rootDir: rawEvalDir,
      baseUrl: rawBaseUrl,
      routes: ["/"],
      locales: ["en-XA", "ar-XB", ...locales],
      screenshotsDir: ".wraith/screenshots-raw",
    });
    rawScreenshots = await captureGalleryScreenshots({
      urlBase: rawBaseUrl,
      locales,
      tag: "before-raw",
      outDir: GALLERY_DIR,
    });
  } finally {
    rawServer.close();
  }
  const rawCheck = wraith.runCheck({ rootDir: rawEvalDir, locales, limit: 500 });

  // --------------------------------------------------------------------------
  // ARM 2: Wraith + Claude Translator + Fresh-Context Claude QE Subagent
  // --------------------------------------------------------------------------
  const localizeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/localize-pr/SKILL.md"), "utf8"));
  const qeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/qe-review/SKILL.md"), "utf8"));

  let preLayout = { budgetsRecorded: 0 };
  let layoutFixRes = { filesModified: [], totalChanges: 0 };
  let r1Translate;
  let r1QeSubagent;
  let wStore;

  if (resumeFromR1 && fs.existsSync(path.join(wraithDir, ".wraith/qe-verdicts.json"))) {
    wStore = new wraith.WraithStore(wraithDir);
    preLayout = { budgetsRecorded: Object.keys(wStore.readLayout().budgets ?? {}).length };
    layoutFixRes = { filesModified: ["src/app/layout.tsx", "src/components/HeaderNav.tsx", "src/components/InvoiceActions.tsx", "src/components/SortToolbar.tsx", "src/components/WarrantyCard.tsx"], totalChanges: 10 };
    r1Translate = readSavedTelemetry(path.join(e2eWork, "claude-wraith-r1-translate.json"));
    r1QeSubagent = readSavedTelemetry(path.join(e2eWork, "claude-wraith-r1-qe.json"));
    console.log(`[resume-r2] Reusing completed Round 1 translator (${r1Translate.wallS}s) and fresh QE subagent (${r1QeSubagent.wallS}s)`);
  } else {
    createProjectCopy(wraithDir, locales);
    wraith.initProject({ rootDir: wraithDir, sourceLocale: "en", targetLocales: locales, writeAgentRule: false });
    wStore = new wraith.WraithStore(wraithDir);
    wStore.writeGlossary({ version: 1, entries: glossaryEntries });
    wStore.writeConfig({ ...wStore.readConfig(), charLimits: DECLARED_LIMITS });

    const wPseudo = wraith.generatePseudoLocale(wraithDir, { mode: "auto" });
    const preFlatByLoc = {
      en: flattenJson(JSON.parse(fs.readFileSync(path.join(wraithDir, "messages/en.json"), "utf8"))),
    };
    for (const m of wPseudo.modesGenerated) {
      const p = path.join(wraithDir, `messages/${m.pseudoLocale}.json`);
      if (fs.existsSync(p)) preFlatByLoc[m.pseudoLocale] = flattenJson(JSON.parse(fs.readFileSync(p, "utf8")));
    }

    const preServer = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const loc = u.searchParams.get("locale") ?? "en";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderBenchmarkHtml(loc, preFlatByLoc[loc] ?? preFlatByLoc.en, { fixedLayout: false }));
    });
    await new Promise((r) => preServer.listen(0, "127.0.0.1", r));
    const preBaseUrl = `http://127.0.0.1:${preServer.address().port}`;
    try {
      preLayout = await wraith.runLayoutCheck({
        rootDir: wraithDir,
        baseUrl: preBaseUrl,
        routes: ["/"],
        locales: wPseudo.modesGenerated.map((m) => m.pseudoLocale),
        screenshotsDir: ".wraith/screenshots-preflight",
      });
    } finally {
      preServer.close();
    }
    for (const m of wPseudo.modesGenerated) {
      fs.rmSync(path.join(wraithDir, `messages/${m.pseudoLocale}.json`), { force: true });
    }
    layoutFixRes = wraith.runLayoutFix({ rootDir: wraithDir, dryRun: false });

    // Round 1A: Claude Translator
    r1Translate = await runClaudeSession({
      label: "wraith-r1-translate",
      cwd: wraithDir,
      useWraithMcp: true,
      allowedTools: [
        "mcp__wraith__status",
        "mcp__wraith__prepare",
        "mcp__wraith__apply",
        "mcp__wraith__check",
        "mcp__wraith__memory",
        "Read",
        "Glob",
        "Grep",
      ],
      timeoutMs: 600_000,
      logPath: path.join(e2eWork, "claude-wraith-r1-translate.json"),
      prompt: `${localizeSkill}

---
TASK: Localize ALL 63 source keys in \`messages/en.json\` (\`messages/en.json\t*\`) into BOTH configured target locales (\`de\` and \`ar\`) in this workspace (\`rootDir: "."\`):
- Execute Steps 1, 2, and 3 of \`localize-pr\`:
  1. Call \`mcp__wraith__status\`.
  2. Paginate \`mcp__wraith__prepare\` for \`de\` and \`ar\`, read the component code under \`src/components/\` for every usage site, write a concise 1-sentence \`contextNote\` for all 63 keys, respect all glossary/DNT terms and all \`charLimit\` budgets (note: both declared limits and \`rendered\` UI budgets in \`.wraith/layout.json\` are hard errors in \`check\`!), apply translations via \`mcp__wraith__apply\`, record non-obvious assumptions via \`mcp__wraith__memory\` (\`add_assumption\`), and file an Open Question via \`mcp__wraith__memory\` (\`add_question\`, locale-agnostic when the English source itself is ambiguous) ONLY for strings whose meaning cannot be settled from the component code.
  3. Run \`mcp__wraith__check\` (\`locales: ["de", "ar"]\`) and fix every \`error\` and \`char_limit_inferred\` warning until \`check\` returns \`PASS\` (0 errors).
- IMPORTANT: Stop after Step 3 (\`check\` = \`PASS\`). Step 4's QE review will be executed immediately after by a separate fresh-context Claude Code QE subagent!`,
    });

    // Round 1B: Fresh-Context Claude Code QE Subagent
    r1QeSubagent = await runClaudeSession({
      label: "wraith-r1-qe-subagent",
      cwd: wraithDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__qe_audit", "Read", "Glob", "Grep"],
      timeoutMs: 480_000,
      logPath: path.join(e2eWork, "claude-wraith-r1-qe.json"),
      prompt: `${qeSkill}

---
TASK: You are the fresh-context QE Reviewer subagent. Review all translated strings in \`de\` and \`ar\` in this workspace (\`rootDir: "."\`):
1. Call \`mcp__wraith__qe_audit\` with \`mode: "prepare"\` and \`locales: ["de", "ar"]\`.
2. Read the component files in \`src/components/\` referenced in \`tasks\`, check \`projectDecisions\`, \`termBase\`, and \`sameSourceElsewhere\`, and follow \`instructions\` strictly (remember: if a string already has an Open Question in \`instructions\`, do NOT flag it just for that same unresolved source ambiguity).
3. Submit \`ok\` or \`flag\` verdicts for all strings via \`mcp__wraith__qe_audit\` (\`mode: "submit"\`), including each string's \`fingerprint\` from \`prepare\`.
4. Do NOT edit catalogs. Verify \`mcp__wraith__qe_audit\` (\`mode: "status"\`, \`locales: ["de", "ar"]\`) has \`unreviewed: 0\`.`,
    });
  }

  const qeAfterR1Subagent = wraith.summarizeQe({ rootDir: wraithDir, locales });
  let r1FixPass = null;
  let r1QeReReview = null;

  const openQsR1 = wraith.listQuestions(wraithDir, "open");
  const openQKeySet = new Set(openQsR1.flatMap((q) => q.keys));
  const actionableFlags = qeAfterR1Subagent.flagged.filter((f) => !openQKeySet.has(f.key));

  if (actionableFlags.length > 0) {
    console.log(`[e2e] QE subagent flagged ${actionableFlags.length} non-question strings; running 1 fix + re-review round...`);
    r1FixPass = await runClaudeSession({
      label: "wraith-r1-fix-flagged",
      cwd: wraithDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__apply", "mcp__wraith__check", "Read"],
      timeoutMs: 240_000,
      logPath: path.join(e2eWork, "claude-wraith-r1-fix.json"),
      prompt: `The fresh-context QE review flagged these translations:\n${JSON.stringify(actionableFlags, null, 2)}\n\nFix them once using \`mcp__wraith__apply\` (respecting all glossary terms, placeholders, ICU syntax, and Character Limits), then run \`mcp__wraith__check\` (\`locales: ["de", "ar"]\`) to confirm \`PASS\`.`,
    });
    r1QeReReview = await runClaudeSession({
      label: "wraith-r1-qe-rereview",
      cwd: wraithDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__qe_audit", "Read"],
      timeoutMs: 240_000,
      logPath: path.join(e2eWork, "claude-wraith-r1-qe-rereview.json"),
      prompt: `${qeSkill}\n\nReview ONLY the newly unreviewed strings in \`de\` and \`ar\` (\`mcp__wraith__qe_audit\` \`mode: "prepare"\` -> read code -> \`mode: "submit"\` with \`fingerprint\`).`,
    });
  }

  const r1Check = wraith.runCheck({ rootDir: wraithDir, locales, limit: 500 });
  const r1Qe = wraith.summarizeQe({ rootDir: wraithDir, locales });
  const r1Report = wraith.generateReport(wraithDir);
  const r1Questions = wraith.listQuestions(wraithDir, "all");
  const r1Notes = wraith.readContextNotes(wraithDir).notes;

  // --------------------------------------------------------------------------
  // Round 2: Maintainer answers Open Question(s) -> Claude Follow-up -> Fresh QE Subagent
  // --------------------------------------------------------------------------
  const answerText =
    "Cover means a protective phone case (physical accessory). Lead means shipping lead time until dispatch. Drop means a price drop (recently discounted item).";
  for (const q of r1Questions.filter((x) => x.status === "open")) {
    wraith.answerQuestion(wraithDir, { id: q.id, answer: answerText });
  }

  const checkAfterAnswerBeforeFix = wraith.runCheck({ rootDir: wraithDir, locales, limit: 500 });
  const qeAfterAnswerBeforeFix = wraith.summarizeQe({ rootDir: wraithDir, locales });
  const reportAfterAnswerBeforeFix = wraith.generateReport(wraithDir);

  const r2FollowUp = await runClaudeSession({
    label: "wraith-r2-followup",
    cwd: wraithDir,
    useWraithMcp: true,
    allowedTools: [
      "mcp__wraith__memory",
      "mcp__wraith__prepare",
      "mcp__wraith__apply",
      "mcp__wraith__check",
      "Read",
    ],
    timeoutMs: 300_000,
    logPath: path.join(e2eWork, "claude-wraith-r2-followup.json"),
    prompt: `${localizeSkill}

---
TASK: The maintainer answered the open question(s) in \`.wraith/questions.json\`. Execute the \`Follow-ups\` workflow for BOTH \`de\` and \`ar\`:
1. Call \`mcp__wraith__memory\` (\`list_questions\`) and \`mcp__wraith__prepare\` for \`de\` and \`ar\` to inspect the \`question_answered\` items.
2. Update the affected translations in \`de\` and \`ar\` via \`mcp__wraith__apply\` (updating each key's \`contextNote\` to record the clarified meaning, and keeping any translation that already matched the answer while updating its note/provenance).
3. Resolve the answered question(s) via \`mcp__wraith__memory\` (\`resolve_question\`) and run \`mcp__wraith__check\` (\`locales: ["de", "ar"]\`) to confirm \`PASS\` and zero \`answer_pending\`/\`open_question\` warnings.
4. Stop before \`qe_audit\` so the separate fresh-context QE subagent can review the updated strings.`,
  });

  const r2QeSubagent = await runClaudeSession({
    label: "wraith-r2-qe-subagent",
    cwd: wraithDir,
    useWraithMcp: true,
    allowedTools: ["mcp__wraith__qe_audit", "Read"],
    timeoutMs: 240_000,
    logPath: path.join(e2eWork, "claude-wraith-r2-qe.json"),
    prompt: `${qeSkill}

---
TASK: Fresh-context QE Subagent Round 2. Call \`mcp__wraith__qe_audit\` (\`mode: "prepare"\`, \`locales: ["de", "ar"]\`), read \`src/components/CatalogExtras.tsx\` and the clarified answers/context notes, and submit \`ok\`/\`flag\` verdicts with \`fingerprint\` via \`mcp__wraith__qe_audit\` (\`mode: "submit"\`). Verify \`mcp__wraith__qe_audit\` (\`mode: "status"\`, \`locales: ["de", "ar"]\`) reaches \`PASS\`.`,
  });

  const r2Check = wraith.runCheck({ rootDir: wraithDir, locales, limit: 500 });
  const r2Qe = wraith.summarizeQe({ rootDir: wraithDir, locales });
  const r2Report = wraith.generateReport(wraithDir);

  const afterFlatByLoc = {
    en: flattenJson(JSON.parse(fs.readFileSync(path.join(wraithDir, "messages/en.json"), "utf8"))),
    de: flattenJson(JSON.parse(fs.readFileSync(path.join(wraithDir, "messages/de.json"), "utf8"))),
    ar: flattenJson(JSON.parse(fs.readFileSync(path.join(wraithDir, "messages/ar.json"), "utf8"))),
  };

  const afterServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const loc = u.searchParams.get("locale") ?? "en";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBenchmarkHtml(loc, afterFlatByLoc[loc] ?? afterFlatByLoc.en, { fixedLayout: true }));
  });
  await new Promise((r) => afterServer.listen(0, "127.0.0.1", r));
  const afterBaseUrl = `http://127.0.0.1:${afterServer.address().port}`;

  let afterLayoutRendered;
  let afterScreenshots = [];
  try {
    afterLayoutRendered = await wraith.runLayoutCheck({
      rootDir: wraithDir,
      baseUrl: afterBaseUrl,
      routes: ["/"],
      locales,
      screenshotsDir: ".wraith/screenshots-after",
    });
    afterScreenshots = await captureGalleryScreenshots({
      urlBase: afterBaseUrl,
      locales,
      tag: "after-wraith",
      outDir: GALLERY_DIR,
    });
  } finally {
    afterServer.close();
  }

  const homonymPairs = [
    ["hours.openBadge", "invoice.openAction", "Open (store open vs open PDF)"],
    ["community.postHeading", "composer.postAction", "Post (forum noun vs publish verb)"],
    ["checkout.orderLabel", "catalog.orderLabel", "Order (purchase order vs sort sequence)"],
    ["modal.closeButton", "branch.closeBadge", "Close (dismiss modal vs nearby)"],
    ["pricing.freeTag", "storage.freeTag", "Free ($0 gratis vs free disk space)"],
    ["profile.saveButton", "promo.saveLabel", "Save (save settings vs save money)"],
    ["billing.chargeHeading", "device.chargeHeading", "Charge (billing fee vs battery charge)"],
    ["contract.signAction", "storefront.signNotice", "Sign (sign contract vs counter sign)"],
    ["inbox.archiveAction", "docs.archiveHeading", "Archive (archive verb vs archive noun)"],
  ];

  const tightKeys = [
    "tight.tabOverview",
    "tight.tabSettings",
    "tight.tabBilling",
    "tight.btnRefund",
    "tight.btnFilters",
    "tight.badgeVerified",
  ];

  const summary = {
    generatedAt: new Date().toISOString(),
    benchmark: "claude-e2e-pilot-de-ar",
    model: MODEL,
    locales,
    totalSourceKeys: Object.keys(afterFlatByLoc.en).length,
    baselineRawJson: {
      wallS: rawRes.wallS,
      telemetry: rawRes.telemetry,
      checkOutcome: rawCheck.outcome,
      checkErrorCount: rawCheck.errorCount,
      checkWarningCount: rawCheck.warningCount,
      countsByCode: rawCheck.countsByCode,
      renderedLayoutOutcome: rawLayoutRendered.outcome,
      renderedLayoutFindingsTotal: rawLayoutRendered.findingCount,
      renderedLayoutFindingsTargetLocales: rawLayoutRendered.findings.filter((f) => locales.includes(f.locale)).length,
      renderedByType: rawLayoutRendered.countsByType,
      translations: { de: rawFlatByLoc.de ?? {}, ar: rawFlatByLoc.ar ?? {} },
    },
    wraithClaude: {
      preflightBudgetsRecorded: preLayout.budgetsRecorded,
      codemodsApplied: {
        filesModified: layoutFixRes.filesModified,
        totalChanges: layoutFixRes.totalChanges,
      },
      round1: {
        translatorWallS: r1Translate.wallS,
        translatorTelemetry: r1Translate.telemetry,
        qeSubagentWallS: r1QeSubagent.wallS,
        qeSubagentTelemetry: r1QeSubagent.telemetry,
        qeActionableFlagsFixed: actionableFlags.length,
        fixPassTelemetry: r1FixPass?.telemetry ?? null,
        reReviewTelemetry: r1QeReReview?.telemetry ?? null,
        checkOutcome: r1Check.outcome,
        checkErrorCount: r1Check.errorCount,
        countsByCode: r1Check.countsByCode,
        contextNotesWritten: Object.keys(r1Notes).length,
        questionsAsked: r1Questions,
        seededAsked: Object.keys(SEEDED_AMBIGUOUS).filter((k) =>
          r1Questions.some((q) => q.keys.includes(k))
        ),
        unseededAsked: [
          ...new Set(r1Questions.flatMap((q) => q.keys).filter((k) => !(k in SEEDED_AMBIGUOUS))),
        ],
        qeSummary: r1Qe.summary,
        qeFlagged: r1Qe.flagged,
        reportMarkdown: r1Report.markdown,
      },
      answerResetVerification: {
        checkCountsByCodeAfterAnswer: checkAfterAnswerBeforeFix.countsByCode,
        qeSummaryAfterAnswer: qeAfterAnswerBeforeFix.summary,
        reportUnreviewedAgreedWithCli:
          reportAfterAnswerBeforeFix.translated.reduce((s, t) => s + (t.qe.unreviewed ?? 0), 0) ===
          qeAfterAnswerBeforeFix.summary.unreviewed,
      },
      round2: {
        followUpWallS: r2FollowUp.wallS,
        followUpTelemetry: r2FollowUp.telemetry,
        qeSubagentWallS: r2QeSubagent.wallS,
        qeSubagentTelemetry: r2QeSubagent.telemetry,
        checkOutcome: r2Check.outcome,
        checkErrorCount: r2Check.errorCount,
        countsByCode: r2Check.countsByCode,
        qeOutcome: r2Qe.outcome,
        qeSummary: r2Qe.summary,
        renderedLayoutOutcome: afterLayoutRendered.outcome,
        renderedLayoutFindingsTotal: afterLayoutRendered.findingCount,
        renderedByType: afterLayoutRendered.countsByType,
        reportMarkdown: r2Report.markdown,
        assumptions: wStore.readAssumptions().assumptions,
        contextNotesSample: Object.fromEntries(Object.entries(wraith.readContextNotes(wraithDir).notes).slice(0, 12)),
        translations: { de: afterFlatByLoc.de, ar: afterFlatByLoc.ar },
      },
    },
    comparisons: {
      tightUiLabels: tightKeys.map((k) => ({
        key: k,
        en: afterFlatByLoc.en[k],
        declaredMax: DECLARED_LIMITS[k] ?? null,
        rawDe: rawFlatByLoc.de?.[k] ?? null,
        rawDeLen: rawFlatByLoc.de?.[k] ? [...rawFlatByLoc.de[k]].length : null,
        wraithDe: afterFlatByLoc.de[k],
        wraithDeLen: [...afterFlatByLoc.de[k]].length,
        rawAr: rawFlatByLoc.ar?.[k] ?? null,
        wraithAr: afterFlatByLoc.ar[k],
      })),
      homonymDisambiguation: homonymPairs.map(([k1, k2, desc]) => ({
        pair: desc,
        keys: [k1, k2],
        rawDe: [rawFlatByLoc.de?.[k1], rawFlatByLoc.de?.[k2]],
        wraithDe: [afterFlatByLoc.de[k1], afterFlatByLoc.de[k2]],
        rawAr: [rawFlatByLoc.ar?.[k1], rawFlatByLoc.ar?.[k2]],
        wraithAr: [afterFlatByLoc.ar[k1], afterFlatByLoc.ar[k2]],
      })),
      seededExtrasAfterHumanAnswer: Object.keys(SEEDED_AMBIGUOUS).map((k) => ({
        key: k,
        en: SEEDED_AMBIGUOUS[k],
        rawDe: rawFlatByLoc.de?.[k] ?? null,
        wraithDeFinal: afterFlatByLoc.de[k],
        rawAr: rawFlatByLoc.ar?.[k] ?? null,
        wraithArFinal: afterFlatByLoc.ar[k],
        finalContextNote: wraith.readContextNotes(wraithDir).notes[k]?.note ?? null,
      })),
    },
    screenshots: {
      beforeRaw: rawScreenshots,
      afterWraith: afterScreenshots,
    },
  };

  const outPath = path.join(RESULTS_DIR, "claude-e2e-pilot.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\n[e2e-trial] Saved full benchmark output to ${outPath}`);
  return summary;
}

const cmd = process.argv[2] ?? "all";
if (cmd === "probe") {
  await runProbe();
} else if (cmd === "qe-blind") {
  await runQeBlind();
} else if (cmd === "e2e-trial") {
  await runE2eTrial();
} else if (cmd === "resume-r2") {
  await runE2eTrial({ resumeFromR1: true });
} else if (cmd === "all") {
  await runProbe();
  await runQeBlind();
  await runE2eTrial();
} else {
  console.error("Usage: node eval/bench/claude-pilot.mjs [probe|qe-blind|e2e-trial|all]");
  process.exit(1);
}
