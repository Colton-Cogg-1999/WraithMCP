#!/usr/bin/env node
/**
 * THE BIG ONE — Real-World OSS Multi-Stack + Real-World Multi-Format Document Benchmark
 *
 * Agent: Claude Code (`claude -p --model sonnet --no-session-persistence`) + Fresh-Context Claude QE Subagent
 *
 * Subcommands:
 *   node eval/bench/big-one.mjs oss    # 6 real OSS repos (Android, iOS, Flutter, Astro, Rails, Django): A0 vs Wraith + Fresh QE Subagent
 *   node eval/bench/big-one.mjs docs   # 5 real-world document formats (Clinical DOCX, Policy DOCX, Launch PPTX, Formula XLSX, VTT+SRT) + LibreOffice doc-verify + PDF->PNG visual renders
 *   node eval/bench/big-one.mjs all    # Run oss + docs
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const CORPORA_DIR = path.join(EVAL_ROOT, "corpora");
const WORK_ROOT = path.join(EVAL_ROOT, "work", "big-one");
const RESULTS_DIR = path.join(EVAL_ROOT, "results");
const RENDERS_DIR = path.join(RESULTS_DIR, "big-one-renders");

const NODE_BIN = process.execPath;
const WRAITH_CLI = path.join(REPO_ROOT, "dist", "bin.js");
const CLAUDE_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/claude")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/claude"
  : "claude";
const MODEL = process.env.WRAITH_BENCH_MODEL ?? "sonnet";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const { corpusChrF } = await import(path.join(EVAL_ROOT, "lib", "metrics.mjs"));

wraith.ensureBootstrapped();

function stripFrontmatter(md) {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "");
}

function writeMcpConfig() {
  const p = path.join(os.tmpdir(), `.wraith-bigone-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ mcpServers: { wraith: { command: NODE_BIN, args: [WRAITH_CLI, "mcp"] } } }, null, 2));
  return p;
}

async function runClaude({
  label,
  cwd,
  prompt,
  useWraithMcp = true,
  allowedTools = null,
  timeoutMs = 480_000,
  logPath = null,
}) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    MODEL,
    "--dangerously-skip-permissions",
  ];

  let mcpConfigPath;
  if (useWraithMcp) {
    mcpConfigPath = writeMcpConfig();
  } else {
    mcpConfigPath = path.join(os.tmpdir(), `.wraith-empty-mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
  }
  args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));

  console.log(`\n[claude:${label}] starting (mcp=${useWraithMcp})...`);
  const t0 = Date.now();
  const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
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

  fs.rmSync(mcpConfigPath, { force: true });
  const wallS = Number(((Date.now() - t0) / 1000).toFixed(1));
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, stdout, "utf8");
  }

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
  const telemetry = {
    model: MODEL,
    numTurns: parsed?.num_turns ?? 0,
    wallS,
    totalCostUsd: Number((parsed?.total_cost_usd ?? 0).toFixed(4)),
    inputTokens: usage.input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    isError: Boolean(parsed?.is_error),
    resultPreview: typeof parsed?.result === "string" ? parsed.result.slice(0, 600) : "",
  };
  console.log(`[claude:${label}] done in ${wallS}s (exit=${exitCode}, turns=${telemetry.numTurns}, cost=$${telemetry.totalCostUsd}, err=${telemetry.isError})`);
  if (exitCode !== 0 || telemetry.isError) {
    console.warn(`[claude:${label}] stderr:`, stderr.slice(0, 400));
  }
  return { exitCode, timedOut, wallS, telemetry };
}

function selectStratifiedKeys(srcEntries, humanDeEntries, limit = 30) {
  const shared = [];
  for (const [k, e] of srcEntries.entries()) {
    const h = humanDeEntries.get(k);
    if (!h || !e.value?.trim() || !h.value?.trim()) continue;
    const v = e.value;
    const hasPlaceholder = /\{[^}]+\}|%\d*\$?[sd@f]|%\{[^}]+\}|%\([^)]+\)[sd]/.test(v);
    const isPlural = Boolean(e.plurals && Object.keys(e.plurals).length > 0) || /,\s*plural\s*,/.test(v);
    const isShort = v.length <= 16;
    shared.push({ key: k, entry: e, human: h, hasPlaceholder, isPlural, isShort });
  }
  // Pick a balanced mix: up to 10 placeholder/plural, 10 short UI labels, 10 general copy
  const chosen = [];
  const seen = new Set();
  const take = (arr, n) => {
    for (const item of arr) {
      if (chosen.length >= limit || n <= 0) break;
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      chosen.push(item);
      n--;
    }
  };
  take(shared.filter((x) => x.isPlural), 5);
  take(shared.filter((x) => x.hasPlaceholder && !x.isPlural), 10);
  take(shared.filter((x) => x.isShort && !x.hasPlaceholder && !x.isPlural), 8);
  take(shared, limit - chosen.length);
  return chosen;
}

// ============================================================================
// PILLAR 1: REAL OSS MULTI-STACK BENCHMARK (6 Production Repos -> German `de`)
// ============================================================================
function buildOssSlices() {
  const slices = [];

  // 1. Android: FossifyOrg/Calendar (real Kotlin + res/values/strings.xml)
  {
    const repoDir = path.join(CORPORA_DIR, "fossify-calendar");
    const adapter = new wraith.AndroidXmlFormatAdapter();
    const enData = adapter.readFile(path.join(repoDir, "app/src/main/res/values/strings.xml"), "en");
    const deData = adapter.readFile(path.join(repoDir, "app/src/main/res/values-de/strings.xml"), "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "app/src/main/res/values"), { recursive: true });
      fs.mkdirSync(path.join(targetDir, "app/src/main/res/values-de"), { recursive: true });
      fs.copyFileSync(path.join(repoDir, "app/src/main/AndroidManifest.xml"), path.join(targetDir, "app/src/main/AndroidManifest.xml"));
      // Copy real Kotlin source files referencing these keys so Wraith & Claude have real code context!
      const ktSrc = path.join(repoDir, "app/src/main/kotlin");
      if (fs.existsSync(ktSrc)) fs.cpSync(ktSrc, path.join(targetDir, "app/src/main/kotlin"), { recursive: true });
      const xmlItems = picked
        .map((p) =>
          p.entry.plurals
            ? `    <plurals name="${p.key}">\n${Object.entries(p.entry.plurals)
                .map(([q, v]) => `        <item quantity="${q}">${v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'")}</item>`)
                .join("\n")}\n    </plurals>`
            : `    <string name="${p.key}">${p.entry.value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "\\'")}</string>`
        )
        .join("\n");
      fs.writeFileSync(
        path.join(targetDir, "app/src/main/res/values/strings.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name" translatable="false">Fossify Calendar</string>\n${xmlItems}\n</resources>\n`
      );
      fs.writeFileSync(
        path.join(targetDir, "app/src/main/res/values-de/strings.xml"),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n`
      );
    };

    slices.push({
      id: "android-fossify-calendar",
      repo: "FossifyOrg/Calendar",
      framework: "android",
      format: "android-xml",
      sourceRel: "app/src/main/res/values/strings.xml",
      targetRel: "app/src/main/res/values-de/strings.xml",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "app/src/main/res/values-de/strings.xml"), "de").entries,
    });
  }

  // 2. iOS: Dimillian/IceCubesApp (real SwiftUI + Localizable.xcstrings)
  {
    const repoDir = path.join(CORPORA_DIR, "icecubes-ios");
    const xcPath = path.join(repoDir, "IceCubesApp/Resources/Localization/Localizable.xcstrings");
    const adapter = new wraith.XcstringsFormatAdapter();
    const enData = adapter.readFile(xcPath, "en");
    const deData = adapter.readFile(xcPath, "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);
    const fullCatalog = JSON.parse(fs.readFileSync(xcPath, "utf8"));

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "IceCubesApp/Resources/Localization"), { recursive: true });
      fs.mkdirSync(path.join(targetDir, "IceCubesApp/App"), { recursive: true });
      fs.writeFileSync(path.join(targetDir, "Package.swift"), "// swift-tools-version: 5.9\n");
      // Copy Swift UI files for real code context
      const appSwift = path.join(repoDir, "IceCubesApp/App");
      if (fs.existsSync(appSwift)) fs.cpSync(appSwift, path.join(targetDir, "IceCubesApp/App"), { recursive: true });

      const subStrings = {};
      for (const p of picked) {
        const orig = fullCatalog.strings[p.key] ?? {};
        const clone = { ...orig };
        // Remove German localization so agent must translate it, while keeping English & French to test multi-locale preservation!
        if (clone.localizations) {
          const locs = {};
          if (clone.localizations.en) locs.en = clone.localizations.en;
          if (clone.localizations.fr) locs.fr = clone.localizations.fr;
          clone.localizations = locs;
        }
        subStrings[p.key] = clone;
      }
      fs.writeFileSync(
        path.join(targetDir, "IceCubesApp/Resources/Localization/Localizable.xcstrings"),
        JSON.stringify({ sourceLanguage: "en", version: "1.0", strings: subStrings }, null, 2) + "\n"
      );
    };

    slices.push({
      id: "ios-icecubes",
      repo: "Dimillian/IceCubesApp",
      framework: "ios",
      format: "xcstrings",
      sourceRel: "IceCubesApp/Resources/Localization/Localizable.xcstrings",
      targetRel: "IceCubesApp/Resources/Localization/Localizable.xcstrings",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "IceCubesApp/Resources/Localization/Localizable.xcstrings"), "de").entries,
    });
  }

  // 3. Flutter: gokadzev/Musify (real Dart + lib/localization/app_en.arb)
  {
    const repoDir = path.join(CORPORA_DIR, "musify-flutter");
    const adapter = new wraith.ArbFormatAdapter();
    const enData = adapter.readFile(path.join(repoDir, "lib/localization/app_en.arb"), "en");
    const deData = adapter.readFile(path.join(repoDir, "lib/localization/app_de.arb"), "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);
    const fullEn = JSON.parse(fs.readFileSync(path.join(repoDir, "lib/localization/app_en.arb"), "utf8"));

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "lib/localization"), { recursive: true });
      fs.copyFileSync(path.join(repoDir, "pubspec.yaml"), path.join(targetDir, "pubspec.yaml"));
      for (const sub of ["screens", "widgets", "utilities"]) {
        const s = path.join(repoDir, "lib", sub);
        if (fs.existsSync(s)) fs.cpSync(s, path.join(targetDir, "lib", sub), { recursive: true });
      }
      const subEn = { "@@locale": "en" };
      for (const p of picked) {
        subEn[p.key] = fullEn[p.key];
        if (fullEn[`@${p.key}`]) subEn[`@${p.key}`] = fullEn[`@${p.key}`];
      }
      fs.writeFileSync(path.join(targetDir, "lib/localization/app_en.arb"), JSON.stringify(subEn, null, 2) + "\n");
      fs.writeFileSync(path.join(targetDir, "lib/localization/app_de.arb"), JSON.stringify({ "@@locale": "de" }, null, 2) + "\n");
    };

    slices.push({
      id: "flutter-musify",
      repo: "gokadzev/Musify",
      framework: "flutter",
      format: "arb",
      sourceRel: "lib/localization/app_en.arb",
      targetRel: "lib/localization/app_de.arb",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "lib/localization/app_de.arb"), "de").entries,
    });
  }

  // 4. Astro: withastro/starlight/docs (real .astro + src/content/i18n/en.json)
  {
    const repoDir = path.join(CORPORA_DIR, "astro-starlight/docs");
    const adapter = new wraith.JsonFormatAdapter();
    const enData = adapter.readFile(path.join(repoDir, "src/content/i18n/en.json"), "en");
    const dePath = path.join(repoDir, "src/content/i18n/de.json");
    const deData = adapter.readFile(dePath, "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "src/content/i18n"), { recursive: true });
      fs.copyFileSync(path.join(repoDir, "package.json"), path.join(targetDir, "package.json"));
      const compSrc = path.join(repoDir, "src/components");
      if (fs.existsSync(compSrc)) fs.cpSync(compSrc, path.join(targetDir, "src/components"), { recursive: true });
      const subEn = {};
      for (const p of picked) subEn[p.key] = p.entry.value;
      fs.writeFileSync(path.join(targetDir, "src/content/i18n/en.json"), JSON.stringify(subEn, null, 2) + "\n");
      fs.writeFileSync(path.join(targetDir, "src/content/i18n/de.json"), "{}\n");
    };

    slices.push({
      id: "astro-starlight",
      repo: "withastro/starlight",
      framework: "astro",
      format: "json",
      sourceRel: "src/content/i18n/en.json",
      targetRel: "src/content/i18n/de.json",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "src/content/i18n/de.json"), "de").entries,
    });
  }

  // 5. Rails: mastodon/mastodon (real Ruby/ERB + config/locales/en.yml)
  {
    const repoDir = path.join(CORPORA_DIR, "mastodon");
    const adapter = new wraith.RailsYamlFormatAdapter();
    const enData = adapter.readFile(path.join(repoDir, "config/locales/en.yml"), "en");
    const deData = adapter.readFile(path.join(repoDir, "config/locales/de.yml"), "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "config/locales"), { recursive: true });
      fs.mkdirSync(path.join(targetDir, "app/views/about"), { recursive: true });
      fs.writeFileSync(path.join(targetDir, "Gemfile"), `source "https://rubygems.org"\ngem "rails"\n`);
      const aboutViews = path.join(repoDir, "app/views/about");
      if (fs.existsSync(aboutViews)) fs.cpSync(aboutViews, path.join(targetDir, "app/views/about"), { recursive: true });
      adapter.applyUpdates(
        path.join(targetDir, "config/locales/en.yml"),
        "en",
        picked.map((p) => ({ key: p.key, value: p.entry.value, plurals: p.entry.plurals })),
        { write: true }
      );
      fs.writeFileSync(path.join(targetDir, "config/locales/de.yml"), "de: {}\n");
    };

    slices.push({
      id: "rails-mastodon",
      repo: "mastodon/mastodon",
      framework: "rails",
      format: "yaml",
      sourceRel: "config/locales/en.yml",
      targetRel: "config/locales/de.yml",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "config/locales/de.yml"), "de").entries,
    });
  }

  // 6. Django: wagtail/wagtail (real Python/Django + locale/de/LC_MESSAGES/django.po)
  {
    const repoDir = path.join(CORPORA_DIR, "wagtail");
    const adapter = new wraith.GettextPoFormatAdapter();
    const dePoPath = path.join(repoDir, "wagtail/locale/de/LC_MESSAGES/django.po");
    const enPoPath = path.join(repoDir, "wagtail/locale/en/LC_MESSAGES/django.po");
    const enData = adapter.readFile(enPoPath, "en");
    const deData = adapter.readFile(dePoPath, "de");
    const picked = selectStratifiedKeys(enData.entries, deData.entries, 30);

    const buildSlice = (targetDir) => {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(targetDir, "locale/en/LC_MESSAGES"), { recursive: true });
      fs.mkdirSync(path.join(targetDir, "locale/de/LC_MESSAGES"), { recursive: true });
      fs.mkdirSync(path.join(targetDir, "wagtail/admin"), { recursive: true });
      fs.writeFileSync(path.join(targetDir, "manage.py"), "#!/usr/bin/env python\nimport django\n");
      fs.writeFileSync(path.join(targetDir, "wagtail/admin/views.py"), "from django.utils.translation import gettext as _\n");
      const escPo = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      const header = (loc) =>
        `msgid ""\nmsgstr ""\n"Language: ${loc}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n\n`;
      const enPo =
        header("en") +
        picked.map((p) => `msgid "${escPo(p.key)}"\nmsgstr "${escPo(p.entry.value)}"\n`).join("\n");
      const dePo =
        header("de") +
        picked.map((p) => `msgid "${escPo(p.key)}"\nmsgstr ""\n`).join("\n");
      fs.writeFileSync(path.join(targetDir, "locale/en/LC_MESSAGES/django.po"), enPo);
      fs.writeFileSync(path.join(targetDir, "locale/de/LC_MESSAGES/django.po"), dePo);
    };

    slices.push({
      id: "django-wagtail",
      repo: "wagtail/wagtail",
      framework: "django",
      format: "po",
      sourceRel: "locale/en/LC_MESSAGES/django.po",
      targetRel: "locale/de/LC_MESSAGES/django.po",
      picked,
      buildSlice,
      readTarget: (dir) => adapter.readFile(path.join(dir, "locale/de/LC_MESSAGES/django.po"), "de").entries,
    });
  }

  return slices;
}

async function runOssSuite() {
  const ossWork = path.join(WORK_ROOT, "oss");
  fs.mkdirSync(ossWork, { recursive: true });
  const localizeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/localize-pr/SKILL.md"), "utf8"));
  const qeSkill = stripFrontmatter(fs.readFileSync(path.join(REPO_ROOT, "skills/qe-review/SKILL.md"), "utf8"));

  const slices = buildOssSlices();
  const results = [];

  for (const slice of slices) {
    console.log(`\n====================================================================`);
    console.log(`[OSS] ${slice.id} (${slice.repo} · ${slice.framework}/${slice.format} · ${slice.picked.length} keys -> de)`);
    console.log(`====================================================================`);

    const a0Dir = path.join(ossWork, `${slice.id}-A0`);
    const wDir = path.join(ossWork, `${slice.id}-W`);
    slice.buildSlice(a0Dir);
    slice.buildSlice(wDir);

    // --- Arm A0: Claude alone (NO Wraith MCP) ---
    const a0Res = await runClaude({
      label: `oss-${slice.id}-A0`,
      cwd: a0Dir,
      useWraithMcp: false,
      allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
      timeoutMs: 300_000,
      logPath: path.join(ossWork, `${slice.id}-A0.json`),
      prompt: `Translate all ${slice.picked.length} English strings from \`${slice.sourceRel}\` into German (\`de\`) in \`${slice.targetRel}\` for this real ${slice.framework} project (${slice.repo}). Preserve all placeholders, plurals, escaping, and file structure. Do not modify source code files.`,
    });

    // Evaluate A0 with Wraith check + chrF2 against real human OSS German translations
    wraith.initProject({ rootDir: a0Dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const a0Check = wraith.runCheck({ rootDir: a0Dir, locale: "de", limit: 500 });
    let a0TargetEntries = new Map();
    let a0ParseError = null;
    try {
      a0TargetEntries = slice.readTarget(a0Dir);
    } catch (err) {
      a0ParseError = err instanceof Error ? err.message : String(err);
    }
    const a0Hyps = [];
    const a0Refs = [];
    for (const p of slice.picked) {
      const t = a0TargetEntries.get(p.key)?.value ?? "";
      if (t) {
        a0Hyps.push(t);
        a0Refs.push(p.human.value);
      }
    }
    const a0ChrF = a0Hyps.length > 0 ? Number(corpusChrF(a0Hyps, a0Refs).toFixed(2)) : 0;

    // --- Arm W: Wraith + Claude Translator + Fresh-Context Claude QE Subagent ---
    wraith.initProject({ rootDir: wDir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const wTransRes = await runClaude({
      label: `oss-${slice.id}-W-translate`,
      cwd: wDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__status", "mcp__wraith__prepare", "mcp__wraith__apply", "mcp__wraith__check", "mcp__wraith__memory", "Read", "Glob", "Grep"],
      timeoutMs: 360_000,
      logPath: path.join(ossWork, `${slice.id}-W-translate.json`),
      prompt: `${localizeSkill}\n\n---\nTASK: Localize ALL ${slice.picked.length} English keys in \`${slice.sourceRel}\` into German (\`de\`) for ${slice.repo} (\`rootDir: "."\`). Use Wraith MCP \`prepare\` -> read relevant code files where usage sites exist -> \`apply\` with 1-sentence \`contextNote\`s -> \`check\` (\`locale: "de"\`) until there are 0 translation/catalog errors (ignore pre-existing \`hardcoded_string\` errors in unmodified app source code). Stop before \`qe_audit\`.`,
    });

    const wQeRes = await runClaude({
      label: `oss-${slice.id}-W-qe-subagent`,
      cwd: wDir,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__qe_audit", "Read", "Glob", "Grep"],
      timeoutMs: 300_000,
      logPath: path.join(ossWork, `${slice.id}-W-qe.json`),
      prompt: `${qeSkill}\n\n---\nTASK: Fresh-context QE Subagent for ${slice.repo} (\`de\`, \`rootDir: "."\`). Run \`mcp__wraith__qe_audit\` \`mode: "prepare"\` -> inspect relevant code & context notes -> submit verdicts for all strings via \`mode: "submit"\` echoing \`fingerprint\`s -> verify \`unreviewed: 0\`. Do NOT edit catalogs.`,
    });

    const qeAfterR1 = wraith.summarizeQe({ rootDir: wDir, locales: ["de"] });
    let wFixRes = null;
    if (qeAfterR1.flagged.length > 0) {
      wFixRes = await runClaude({
        label: `oss-${slice.id}-W-fix`,
        cwd: wDir,
        useWraithMcp: true,
        allowedTools: ["mcp__wraith__apply", "mcp__wraith__check", "Read"],
        timeoutMs: 180_000,
        logPath: path.join(ossWork, `${slice.id}-W-fix.json`),
        prompt: `Fix these QE-flagged German translations via \`mcp__wraith__apply\`:\n${JSON.stringify(qeAfterR1.flagged, null, 2)}`,
      });
      await runClaude({
        label: `oss-${slice.id}-W-qe-rereview`,
        cwd: wDir,
        useWraithMcp: true,
        allowedTools: ["mcp__wraith__qe_audit", "Read"],
        timeoutMs: 180_000,
        logPath: path.join(ossWork, `${slice.id}-W-qe-rereview.json`),
        prompt: `${qeSkill}\n\nRe-review ONLY the newly unreviewed German strings via \`mcp__wraith__qe_audit\` (\`prepare\` -> \`submit\` with \`fingerprint\`).`,
      });
    }

    const wCheck = wraith.runCheck({ rootDir: wDir, locale: "de", limit: 500 });
    const wQeFinal = wraith.summarizeQe({ rootDir: wDir, locales: ["de"] });
    const wNotes = wraith.readContextNotes(wDir).notes;
    const wQuestions = wraith.listQuestions(wDir, "all");
    const wTargetEntries = slice.readTarget(wDir);
    const wHyps = [];
    const wRefs = [];
    for (const p of slice.picked) {
      const t = wTargetEntries.get(p.key)?.value ?? "";
      if (t) {
        wHyps.push(t);
        wRefs.push(p.human.value);
      }
    }
    const wChrF = wHyps.length > 0 ? Number(corpusChrF(wHyps, wRefs).toFixed(2)) : 0;

    // Count translation/catalog errors (excluding pre-existing hardcoded_string in real OSS source files!)
    const countCatalogErrors = (chk) =>
      Object.entries(chk.countsByCode ?? {})
        .filter(([code]) => !["hardcoded_string", "string_concatenation", "hardcoded_formatting", "layout_risk", "rtl_layout_risk"].includes(code))
        .reduce((s, [, n]) => s + n, 0);

    const a0CatalogErrs = (a0Check.issues?.errors ?? []).filter(
      (i) => !["hardcoded_string", "string_concatenation"].includes(i.code)
    ).length;
    const wCatalogErrs = (wCheck.issues?.errors ?? []).filter(
      (i) => !["hardcoded_string", "string_concatenation"].includes(i.code)
    ).length;

    const row = {
      id: slice.id,
      repo: slice.repo,
      framework: slice.framework,
      format: slice.format,
      sampledKeys: slice.picked.length,
      a0: {
        translated: a0Hyps.length,
        parseError: a0ParseError,
        catalogErrors: a0CatalogErrs,
        countsByCode: a0Check.countsByCode,
        chrf2VsHuman: a0ChrF,
        wallS: a0Res.wallS,
        costUsd: a0Res.telemetry.totalCostUsd,
      },
      wraith: {
        translated: wHyps.length,
        catalogErrors: wCatalogErrs,
        countsByCode: wCheck.countsByCode,
        chrf2VsHuman: wChrF,
        contextNotesWritten: Object.keys(wNotes).length,
        questionsAsked: wQuestions.length,
        qeInitialFlagged: qeAfterR1.flagged.length,
        qeFinalSummary: wQeFinal.summary,
        qeFinalOutcome: wQeFinal.outcome,
        translateWallS: wTransRes.wallS,
        qeWallS: wQeRes.wallS,
        totalCostUsd: Number((wTransRes.telemetry.totalCostUsd + wQeRes.telemetry.totalCostUsd + (wFixRes?.telemetry.totalCostUsd ?? 0)).toFixed(4)),
      },
    };
    results.push(row);
    // Incremental save after every repo!
    fs.writeFileSync(
      path.join(RESULTS_DIR, "big-one-oss.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, repos: results }, null, 2) + "\n"
    );
    console.log(`[OSS:${slice.id}] A0 catalogErrs=${a0CatalogErrs} chrF2=${a0ChrF} | Wraith catalogErrs=${wCatalogErrs} chrF2=${wChrF} QE=${wQeFinal.outcome} (${JSON.stringify(wQeFinal.summary)})`);
  }

  return results;
}

// ============================================================================
// PILLAR 2: REAL-WORLD MULTI-FORMAT DOCUMENT SUITE (DOCX, PPTX, XLSX, VTT, SRT)
// ============================================================================
function buildRealWorldDocuments(docDir) {
  fs.rmSync(docDir, { recursive: true, force: true });
  fs.mkdirSync(docDir, { recursive: true });

  // 1. Clinical Patient Discharge Letter (DOCX with bold warnings, medication table, header/footer)
  const clinicalDocx = path.join(docDir, "clinical-patient-letter.docx");
  {
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Northstar Medical Center — Patient Discharge Summary</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Dear Patient, thank you for participating in the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>CardioPulse Phase III Study</w:t></w:r><w:r><w:t xml:space="preserve">. Please review your follow-up instructions carefully.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Important Safety Warning: </w:t></w:r><w:r><w:t>Do not stop taking your prescribed blood pressure medication without consulting your attending physician. Seek immediate emergency care if you experience chest pain, shortness of breath, or sudden dizziness.</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Medication</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Dosage &amp; Schedule</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Notes</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Lisinopril 10 mg</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Take one tablet by mouth every morning with water.</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Monitor blood pressure twice weekly.</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Atorvastatin 20 mg</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Take one tablet in the evening with or without food.</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Avoid grapefruit juice during treatment.</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>Your follow-up cardiology appointment is scheduled within 14 days of discharge. Bring your symptom log and current medication list to every clinic visit so the research nurse can update your electronic chart accurately.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Confidentiality Notice: All clinical study records are protected under applicable health privacy regulations and stored in LedgerVault.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
    fs.writeFileSync(
      clinicalDocx,
      zipSync(
        {
          "[Content_Types].xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
          ),
          "_rels/.rels": strToU8(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
          ),
          "word/document.xml": strToU8(docXml),
        },
        { level: 6 }
      )
    );
  }

  // 2. Copy existing complex DOCX (`northstar-policy.docx` with headers, footers, tracked changes, tables)
  const policySrc = path.join(EVAL_ROOT, "docx", "northstar-policy.docx");
  const policyDocx = path.join(docDir, "northstar-policy.docx");
  if (fs.existsSync(policySrc)) fs.copyFileSync(policySrc, policyDocx);

  // 3. Executive Product Launch Deck (PPTX — 3 slides + speaker notes + bold runs, valid for LibreOffice!)
  const launchPptx = path.join(docDir, "product-launch-deck.pptx");
  {
    const makeSlide = (title, bullets) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="900000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2800" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="457200" y="1400000"/><a:ext cx="8229600" cy="4500000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/>${bullets.map((b) => `<a:p>${b}</a:p>`).join("")}</p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

    const entries = {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide3.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
      ),
      "ppt/presentation.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
    <p:sldId id="258" r:id="rId3"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`
      ),
      "ppt/_rels/presentation.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`
      ),
      "ppt/slides/slide1.xml": strToU8(
        makeSlide("Northstar Commerce Q4 Launch", [
          `<a:r><a:rPr sz="1800"/><a:t>Global checkout expansion powered by </a:t></a:r><a:r><a:rPr sz="1800" b="1"/><a:t>Northstar Pay</a:t></a:r>`,
          `<a:r><a:rPr sz="1800"/><a:t>Zero-downtime settlement &amp; real-time fraud scoring.</a:t></a:r>`,
        ])
      ),
      "ppt/slides/slide2.xml": strToU8(
        makeSlide("Enterprise Security &amp; Compliance", [
          `<a:r><a:rPr sz="1800"/><a:t>Immutable audit logs archived in </a:t></a:r><a:r><a:rPr sz="1800" b="1"/><a:t>LedgerVault</a:t></a:r>`,
          `<a:r><a:rPr sz="1800"/><a:t>Automated regional tax reporting across 28 markets.</a:t></a:r>`,
        ])
      ),
      "ppt/slides/slide3.xml": strToU8(
        makeSlide("Next Steps &amp; Rollout Timeline", [
          `<a:r><a:rPr sz="1800"/><a:t>Pilot launch in Germany and Spain starting next Monday.</a:t></a:r>`,
          `<a:r><a:rPr sz="1800"/><a:t>Contact your account manager to enable PulseGrid analytics.</a:t></a:r>`,
        ])
      ),
    };
    fs.writeFileSync(launchPptx, zipSync(entries, { level: 6 }));
  }

  // 4. Q4 Regional Financial Workbook (XLSX with sharedStrings + rich runs + inline notes + 4 real Excel formulas!)
  const financeXlsx = path.join(docDir, "q4-financial-model.xlsx");
  {
    const entries = {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      ),
      "xl/workbook.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Q4 Summary" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
      ),
      "xl/sharedStrings.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="7" uniqueCount="7">
  <si><t>Region</t></si>
  <si><t>Quarterly Revenue</t></si>
  <si><t>Operating Cost</t></si>
  <si><t>Net Margin</t></si>
  <si><t>North America</t></si>
  <si><t>Central Europe</t></si>
  <si><r><t xml:space="preserve">Grand Total </t></r><r><rPr><b/></rPr><t>(USD)</t></r></si>
</sst>`
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2"><v>120000</v></c>
      <c r="C2"><v>78000</v></c>
      <c r="D2"><f>B2-C2</f><v>42000</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>5</v></c>
      <c r="B3"><v>95000</v></c>
      <c r="C3"><v>61000</v></c>
      <c r="D3"><f>B3-C3</f><v>34000</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>6</v></c>
      <c r="B4"><f>SUM(B2:B3)</f><v>215000</v></c>
      <c r="C4"><f>SUM(C2:C3)</f><v>139000</v></c>
      <c r="D4"><f>SUM(D2:D3)</f><v>76000</v></c>
    </row>
    <row r="6">
      <c r="A6" t="inlineStr"><is><t>Audited via LedgerVault automated reconciliation.</t></is></c>
    </row>
  </sheetData>
</worksheet>`
      ),
    };
    fs.writeFileSync(financeXlsx, zipSync(entries, { level: 6 }));
  }

  // 5. Product Demo Video Subtitles (VTT + SRT with tight timing windows & inline cue tags)
  const demoVtt = path.join(docDir, "product-demo.vtt");
  fs.writeFileSync(
    demoVtt,
    `WEBVTT - Northstar Product Demo

NOTE Keep every cue within its reading-speed character limit and max 2 lines.

00:00:00.500 --> 00:00:03.000 align:start position:10%
<v Host>Welcome to <i>Northstar Commerce</i>.</v>

00:00:03.200 --> 00:00:05.500
Today we'll issue a refund in one click.

00:00:05.800 --> 00:00:08.500
Open the <b>Billing</b> tab and select an invoice.

00:00:08.800 --> 00:00:11.200
Every change is logged in LedgerVault automatically.

00:00:11.500 --> 00:00:14.000
Click <b>Save</b> to publish your settings.
`,
    "utf8"
  );

  const webinarSrt = path.join(docDir, "webinar-clip.srt");
  fs.writeFileSync(
    webinarSrt,
    [
      "1",
      "00:00:01,000 --> 00:00:03,200",
      "Good morning everyone.",
      "",
      "2",
      "00:00:03,500 --> 00:00:06,000",
      "<i>PulseGrid</i> tracks conversion without cookies.",
      "",
      "3",
      "00:00:06,400 --> 00:00:09,000",
      "Questions? Drop them in the chat below.",
      "",
    ].join("\r\n"),
    "utf8"
  );

  return [
    { file: "clinical-patient-letter.docx", target: "clinical-patient-letter.de.docx", format: "docx", verify: true },
    ...(fs.existsSync(policyDocx) ? [{ file: "northstar-policy.docx", target: "northstar-policy.de.docx", format: "docx", verify: true }] : []),
    { file: "product-launch-deck.pptx", target: "product-launch-deck.de.pptx", format: "pptx", verify: true },
    { file: "q4-financial-model.xlsx", target: "q4-financial-model.de.xlsx", format: "xlsx", verify: true },
    { file: "product-demo.vtt", target: "product-demo.de.vtt", format: "vtt", verify: false },
    { file: "webinar-clip.srt", target: "webinar-clip.de.srt", format: "srt", verify: false },
  ];
}

function renderPdfAndPngs(inputFile, outPrefix) {
  const soffice = "/usr/bin/soffice";
  if (!fs.existsSync(soffice)) return [];
  fs.mkdirSync(RENDERS_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-render-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-lo-prof-"));
  try {
    execFileSync(
      soffice,
      [`-env:UserInstallation=file://${profileDir}`, "--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir", tmpDir, inputFile],
      { stdio: "ignore", timeout: 60_000 }
    );
    const pdfPath = path.join(tmpDir, path.basename(inputFile, path.extname(inputFile)) + ".pdf");
    if (!fs.existsSync(pdfPath)) return [];
    const pngBase = path.join(RENDERS_DIR, outPrefix);
    execFileSync("/usr/bin/pdftoppm", ["-png", "-r", "120", pdfPath, pngBase], { stdio: "ignore", timeout: 30_000 });
    return fs
      .readdirSync(RENDERS_DIR)
      .filter((f) => f.startsWith(outPrefix + "-") && f.endsWith(".png"))
      .sort()
      .map((f) => path.join(RENDERS_DIR, f));
  } catch {
    return [];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

async function runDocsSuite() {
  const docWork = path.join(WORK_ROOT, "docs-project");
  const docSpecs = buildRealWorldDocuments(path.join(docWork, "docs"));

  wraith.initProject({
    rootDir: docWork,
    sourceLocale: "en",
    targetLocales: ["de"],
    documents: ["docs"],
    writeAgentRule: false,
  });
  const store = new wraith.WraithStore(docWork);
  const now = new Date().toISOString();
  store.writeGlossary({
    version: 1,
    entries: [
      { term: "Northstar", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
      { term: "Northstar Pay", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
      { term: "LedgerVault", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
      { term: "PulseGrid", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
      { term: "CardioPulse", doNotTranslate: true, caseSensitive: true, translations: {}, updatedAt: now },
    ],
  });

  const docResults = [];
  for (const spec of docSpecs) {
    const srcRel = `docs/${spec.file}`;
    const tgtRel = `docs/${spec.target}`;
    console.log(`\n[DOC] Translating ${srcRel} (${spec.format}) -> ${tgtRel}...`);

    const res = await runClaude({
      label: `doc-${spec.file}`,
      cwd: docWork,
      useWraithMcp: true,
      allowedTools: ["mcp__wraith__prepare", "mcp__wraith__apply", "mcp__wraith__check", "Read"],
      timeoutMs: 300_000,
      logPath: path.join(WORK_ROOT, `doc-${spec.file}.json`),
      prompt: `Translate the document \`${srcRel}\` into German (\`de\`) and write it to \`${tgtRel}\` using Wraith MCP tools (\`rootDir: "."\`):
1. Call \`mcp__wraith__prepare\` with \`document: "${srcRel}"\`, \`targetLocale: "de"\`, \`limit: 100\`, \`offset: 0\` (paginate if \`hasMore: true\`).
2. Translate EVERY segment accurately in natural, domain-appropriate German (clinical/formal for medical documents, executive for slides, concise for financial tables, and strictly obeying \`constraints.maxChars\` and max 2 lines for subtitles).
3. Preserve EVERY \`<x id="..."/>\` and \`<g id="...">...</g>\` inline tag verbatim and keep all DNT brand terms (Northstar, Northstar Pay, LedgerVault, PulseGrid, CardioPulse) intact.
4. Call \`mcp__wraith__apply\` with \`document: "${srcRel}"\`, \`targetFile: "${tgtRel}"\`, \`targetLocale: "de"\`, and \`documentUpdates: [{ id, text }, ...]\`. If any segment is rejected, fix it and re-apply until \`ok: true\`.`,
    });

    const absSrc = path.join(docWork, srcRel);
    const absTgt = path.join(docWork, tgtRel);
    const exists = fs.existsSync(absTgt);

    let verifyRes = null;
    let srcPngs = [];
    let tgtPngs = [];
    if (exists && spec.verify) {
      verifyRes = wraith.verifyDocumentFormatting({ sourceFile: absSrc, targetFile: absTgt });
      const slug = spec.file.replace(/[^a-zA-Z0-9]+/g, "-");
      srcPngs = renderPdfAndPngs(absSrc, `${slug}-en`);
      tgtPngs = renderPdfAndPngs(absTgt, `${slug}-de`);
    }

    // Subtitle CPS & timestamp audit
    let subtitleAudit = null;
    if (exists && (spec.format === "vtt" || spec.format === "srt")) {
      const adapter = new wraith.SubtitleDocumentAdapter(spec.format);
      const srcEx = adapter.extract(absSrc);
      const tgtEx = adapter.extract(absTgt);
      const maxCpsObserved = Math.max(
        ...tgtEx.segments.map((s) => Number((s.plainText.length / (s.constraints?.durationSec ?? 1)).toFixed(1)))
      );
      const maxLinesObserved = Math.max(...tgtEx.segments.map((s) => s.plainText.split(/\r?\n/).length));
      subtitleAudit = {
        cuesPreserved: srcEx.segments.length === tgtEx.segments.length,
        cueCount: tgtEx.segments.length,
        maxCpsObserved,
        maxLinesObserved,
        timestampsIdentical: srcEx.segments.every((s, i) => s.constraints?.durationSec === tgtEx.segments[i]?.constraints?.durationSec),
      };
    }

    docResults.push({
      file: spec.file,
      target: spec.target,
      format: spec.format,
      exists,
      wallS: res.wallS,
      costUsd: res.telemetry.totalCostUsd,
      docVerify: verifyRes,
      subtitleAudit,
      renders: { sourcePngs: srcPngs, targetPngs: tgtPngs },
    });

    fs.writeFileSync(
      path.join(RESULTS_DIR, "big-one-docs.json"),
      JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, documents: docResults }, null, 2) + "\n"
    );
    console.log(
      `[DOC:${spec.file}] exists=${exists} verify=${verifyRes?.outcome ?? "n/a"} pages=${verifyRes ? `${verifyRes.sourcePages}->${verifyRes.targetPages}` : "n/a"} subtitleAudit=${subtitleAudit ? JSON.stringify(subtitleAudit) : "n/a"}`
    );
  }

  const finalCheck = wraith.runCheck({ rootDir: docWork, locale: "de", limit: 200 });
  const out = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    finalCheck: { outcome: finalCheck.outcome, errorCount: finalCheck.errorCount, countsByCode: finalCheck.countsByCode },
    documents: docResults,
  };
  fs.writeFileSync(path.join(RESULTS_DIR, "big-one-docs.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

const cmd = process.argv[2] ?? "all";
if (cmd === "oss") {
  await runOssSuite();
} else if (cmd === "docs") {
  await runDocsSuite();
} else if (cmd === "all") {
  await runOssSuite();
  await runDocsSuite();
} else {
  console.error("Usage: node eval/bench/big-one.mjs [oss|docs|all]");
  process.exit(1);
}
