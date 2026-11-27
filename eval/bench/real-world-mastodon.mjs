#!/usr/bin/env node
/**
 * Wraith Real-World Production Stress-Test Benchmark: Mastodon Frontend (1,466 keys x es-MX, ar)
 *
 * 5 Experimental Arms (preserving eval/results/pub-audit/ untouched; writes to eval/results/real-world-v2/):
 *   1. NMT     — DeepL API + Glossary (uses repo .env ONLY; never touches LocRAG/.env)
 *   2. B0      — Vanilla Codex (catalog-only + shared style guide / glossary / locale rules)
 *   3. A0      — Vanilla Codex (full Mastodon repo access + shared style guide / glossary / locale rules)
 *   4. W-pre   — Codex + Wraith (React-Intl usageSites, prepareBatch, applyTranslations, scoped check)
 *   5. W-post  — Fresh-Context Codex QE Subagent via Wraith prepareQeReview (full context parity) + apply
 *
 * Subcommands:
 *   node eval/bench/real-world-mastodon.mjs arm <nmt|b0|a0|wraith|qe> [es-MX|ar]
 *   node eval/bench/real-world-mastodon.mjs validate
 *   node eval/bench/real-world-mastodon.mjs judge
 *   node eval/bench/real-world-mastodon.mjs visual
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const MASTODON_SRC = path.join(EVAL_ROOT, "corpora", "mastodon");
const RESULTS_DIR = path.join(EVAL_ROOT, "results", "real-world-v2", "mastodon");
const WORK_ROOT = path.join(EVAL_ROOT, "work", "real-world-v2", "mastodon");
const SCREENSHOTS_DIR = path.join(RESULTS_DIR, "screenshots");

// Use repo-local .env if DEEPL_API_KEY is populated; otherwise fall back to LocRAG/.env within remaining quota
const localEnvPath = path.join(REPO_ROOT, ".env");
if (fs.existsSync(localEnvPath) && /^DEEPL_API_KEY=.+/m.test(fs.readFileSync(localEnvPath, "utf8"))) {
  process.env.WRAITH_DEEPL_ENV_PATH = localEnvPath;
}

const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const CLAUDE_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/claude")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/claude"
  : "claude";
const CODEX_MODEL = process.env.WRAITH_CODEX_MODEL ?? "gpt-6.2-astra";
const JUDGE_MODEL = process.env.WRAITH_JUDGE_MODEL ?? "opus";

const wraith = await import(path.join(REPO_ROOT, "dist", "index.js"));
const {
  translateCatalogWithDeepL,
  cleanupWraithEvalGlossaries,
  getDeepLUsage,
} = await import(path.join(EVAL_ROOT, "lib", "deepl.mjs"));

wraith.ensureBootstrapped();
fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.mkdirSync(WORK_ROOT, { recursive: true });
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const LANGUAGES = ["es-MX", "ar"];

// Shared linguistic requirements delivered equivalently to ALL arms (within system capabilities)
const STYLE_GUIDE_TEXT = [
  "Product: Mastodon (open-source decentralized microblogging social network on the Fediverse).",
  "Tone: clear, approachable, concise UI copy suitable for everyday users and instance moderators.",
  "Technical rules:",
  "- Preserve ALL ICU MessageFormat syntax ({count, plural, ...}, {var, select, ...}, #), {placeholders}, and HTML/custom tags (<link>, <ul>, <li>, <sr>, <topLabel>, etc.) verbatim.",
  "- Never translate placeholder variable names or HTML/component tag names.",
  "- Match UI element brevity (buttons, tabs, badges, menu items must stay concise).",
].join("\n");

const LOCALE_STYLE_RULES = {
  "es-MX":
    "Mexican Spanish (es-MX): use informal 'tú' (never Spain 'vosotros'), opening ¿/¡ punctuation, and natural Mexican UI phrasing ('publicación', 'iniciar sesión', 'cerrar sesión', 'guardar', 'configuración', 'computadora', 'celular').",
  ar: "Modern Standard Arabic (ar): RTL direction, natural modern UI Arabic, Arabic punctuation (، ؟), and proper Arabic CLDR plural categories (zero/one/two/few/many/other) in ICU plural blocks.",
};

const TRANSLATION_PROMPT =
  "Translate accurately for the exact UI context. Do not invent facts or units absent from the source. Keep terminology consistent across all components.";

const QE_PROMPT =
  "Flag only genuine errors: mistranslations, wrong UI sense, missing/broken ICU plurals or placeholders, terminology/DNT violations, or locale register violations (e.g. Spain vosotros in es-MX). Do not flag subjective style preferences.";

const GLOSSARY_ENTRIES = [
  { term: "Mastodon", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "ActivityPub", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "RSS", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "URL", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "HTML", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "API", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "WebAuthn", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "TOTP", doNotTranslate: true, caseSensitive: true, translations: {} },
  { term: "Boost", doNotTranslate: false, caseSensitive: false, translations: { "es-MX": "Impulsar", ar: "ترويج" } },
  { term: "Bookmark", doNotTranslate: false, caseSensitive: false, translations: { "es-MX": "Marcador", ar: "إشارة مرجعية" } },
  { term: "Mute", doNotTranslate: false, caseSensitive: false, translations: { "es-MX": "Silenciar", ar: "كتم" } },
  { term: "Timeline", doNotTranslate: false, caseSensitive: false, translations: { "es-MX": "Cronología", ar: "الخط الزمني" } },
];

const LIST_PRICING = {
  codex: { input: 2.5, cachedInput: 0.25, output: 10.0 },
  claude: { input: 15.0, cachedInput: 1.5, output: 75.0 },
  deeplPerChar: 25.0 / 1_000_000,
};

function estimateCodexUsd(u) {
  const uncached = Math.max(0, (u.inputTokens || 0) - (u.cachedInputTokens || 0));
  return +(
    (uncached * LIST_PRICING.codex.input +
      (u.cachedInputTokens || 0) * LIST_PRICING.codex.cachedInput +
      (u.outputTokens || 0) * LIST_PRICING.codex.output) /
    1_000_000
  ).toFixed(4);
}

function loadSourceEn() {
  const p = path.join(MASTODON_SRC, "app/javascript/mastodon/locales/en.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function parseCodexJsonl(rawJsonl) {
  let modelTurns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let finalMessage = "";
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
    } catch {
      // ignore non-json lines
    }
  }
  return { modelTurns, inputTokens, cachedInputTokens, outputTokens, finalMessage };
}

function extractJsonFromText(text) {
  const trimmed = (text || "").trim();
  // Try fenced json block first
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  // Try first { ... } or [ ... ]
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start >= 0) {
    const endChar = trimmed[start] === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(endChar);
    if (end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }
  throw new Error(`Could not parse JSON from Codex output (${trimmed.slice(0, 200)})`);
}

function runCodexPrompt({ cwd, prompt, sandbox = "read-only", timeoutMs = 240_000 }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      CODEX_MODEL,
      "--sandbox",
      sandbox,
      "--skip-git-repo-check",
      "-",
    ];
    const child = spawn(CODEX_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Codex timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseCodexJsonl(stdout);
      const durationMs = Date.now() - t0;
      if (code !== 0 && !parsed.finalMessage) {
        return reject(new Error(`Codex exited ${code}: ${stderr.slice(-500)}`));
      }
      resolve({ ...parsed, durationMs, exitCode: code });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function formatGlossaryBlock(locale) {
  return GLOSSARY_ENTRIES.map((g) =>
    g.doNotTranslate
      ? `- "${g.term}": DO NOT TRANSLATE`
      : `- "${g.term}" -> "${g.translations[locale]}"`
  ).join("\n");
}

function armResultPath(arm, locale) {
  return path.join(RESULTS_DIR, `${arm}.${locale}.json`);
}

function loadCheckpoint(arm, locale) {
  const p = armResultPath(arm, locale);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    arm,
    locale,
    model: arm === "nmt" ? "deepl-api" : CODEX_MODEL,
    translations: {},
    usage: { modelTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0, chunks: 0 },
    meta: {},
  };
}

function saveCheckpoint(arm, locale, data) {
  fs.writeFileSync(armResultPath(arm, locale), JSON.stringify(data, null, 2));
}

function chunkKeys(keys, size) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}

/* ============================================================================
 * ARM 1: DeepL NMT (strictly using repo .env — never LocRAG)
 * ========================================================================== */
async function runNmtArm(locale) {
  const en = loadSourceEn();
  const ckpt = loadCheckpoint("nmt", locale);
  if (Object.keys(ckpt.translations).length >= Object.keys(en).length) {
    console.log(`[NMT ${locale}] Already complete (${Object.keys(ckpt.translations).length} keys).`);
    return ckpt;
  }
  const usageBefore = await getDeepLUsage();
  const totalChars = Object.values(en).reduce((s, v) => s + v.length, 0);
  console.log(`[NMT ${locale}] DeepL remaining: ${usageBefore.remaining} chars; needed: ~${totalChars} chars.`);
  if (usageBefore.remaining < totalChars + 2000) {
    throw new Error(`Insufficient DeepL quota in repo .env (${usageBefore.remaining} < ${totalChars + 2000}).`);
  }

  const t0 = Date.now();
  const res = await translateCatalogWithDeepL({
    stageName: `mastodon-v2-${locale}`,
    sourceMap: en,
    targetLocale: locale,
    glossaryName: `wraith-eval-mastodon-${locale}`,
    glossaryEntries: GLOSSARY_ENTRIES,
    stageCharCap: 100_000,
  });
  await cleanupWraithEvalGlossaries();
  const usageAfter = await getDeepLUsage();
  const billedChars = Math.max(0, usageAfter.character_count - usageBefore.character_count);

  ckpt.translations = res.translations;
  ckpt.usage = {
    billedChars,
    sourceChars: totalChars,
    estimatedUsd: +(billedChars * LIST_PRICING.deeplPerChar).toFixed(4),
    durationMs: Date.now() - t0,
    glossarySupported: locale === "es-MX",
    localeMappingNote:
      locale === "es-MX"
        ? "DeepL has no ES-MX target code; mapped to ES (formality: prefer_less) + ES glossary."
        : "DeepL mapped to AR; DeepL does not support AR glossaries or formality.",
  };
  saveCheckpoint("nmt", locale, ckpt);
  console.log(`[NMT ${locale}] Done: ${Object.keys(ckpt.translations).length} keys, billed ${billedChars} chars ($${ckpt.usage.estimatedUsd}).`);
  return ckpt;
}

/* ============================================================================
 * ARM 2 (B0: catalog-only) & ARM 3 (A0: repo access)
 * ========================================================================== */
async function runCodexBaselineArm(arm, locale) {
  const en = loadSourceEn();
  const allKeys = Object.keys(en).sort();
  const ckpt = loadCheckpoint(arm, locale);
  const missingKeys = allKeys.filter((k) => !ckpt.translations[k]);
  if (missingKeys.length === 0) {
    console.log(`[${arm.toUpperCase()} ${locale}] Already complete (${allKeys.length} keys).`);
    return ckpt;
  }

  const chunkSize = arm === "b0" ? 100 : 80;
  const chunks = chunkKeys(missingKeys, chunkSize);
  const cwd = arm === "a0" ? MASTODON_SRC : WORK_ROOT;
  const concurrency = 4;

  console.log(`[${arm.toUpperCase()} ${locale}] Translating ${missingKeys.length} keys in ${chunks.length} chunks (concurrency=${concurrency})...`);

  let nextIdx = 0;
  async function worker() {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const batchKeys = chunks[idx];
      const payload = {};
      for (const k of batchKeys) payload[k] = en[k];

      const repoHint =
        arm === "a0"
          ? "You have read-only access to the Mastodon repository in the current working directory (`app/javascript/mastodon/`). Inspect source components when any key is ambiguous."
          : "You only have the JSON key-value catalog below (no repository source access).";

      const prompt = `You are a professional software localizer translating Mastodon's React frontend UI catalog from English (en) to ${locale}.
${repoHint}

Style Guide:
${STYLE_GUIDE_TEXT}

Locale Rules (${locale}):
${LOCALE_STYLE_RULES[locale]}

Additional Translation Prompt:
${TRANSLATION_PROMPT}

Approved Glossary & Do-Not-Translate Terms:
${formatGlossaryBlock(locale)}

Translate EVERY key in the JSON object below into ${locale}.
Return ONLY a single valid JSON object mapping every exact input key to its translated string (no prose, no extra keys).

${JSON.stringify(payload, null, 2)}
`;

      let attempt = 0;
      while (attempt < 3) {
        attempt++;
        try {
          const res = await runCodexPrompt({ cwd, prompt, sandbox: "read-only", timeoutMs: 240_000 });
          const obj = extractJsonFromText(res.finalMessage);
          let accepted = 0;
          for (const k of batchKeys) {
            if (typeof obj[k] === "string" && obj[k].trim().length > 0) {
              ckpt.translations[k] = obj[k];
              accepted++;
            }
          }
          ckpt.usage.modelTurns += res.modelTurns;
          ckpt.usage.inputTokens += res.inputTokens;
          ckpt.usage.cachedInputTokens += res.cachedInputTokens;
          ckpt.usage.outputTokens += res.outputTokens;
          ckpt.usage.durationMs += res.durationMs;
          ckpt.usage.chunks += 1;
          ckpt.usage.estimatedUsd = estimateCodexUsd(ckpt.usage);
          saveCheckpoint(arm, locale, ckpt);
          console.log(
            `  [${arm.toUpperCase()} ${locale}] chunk ${idx + 1}/${chunks.length}: ${accepted}/${batchKeys.length} keys (${(res.durationMs / 1000).toFixed(1)}s, total=${Object.keys(ckpt.translations).length}/${allKeys.length})`
          );
          break;
        } catch (err) {
          console.error(`  [${arm.toUpperCase()} ${locale}] chunk ${idx + 1} attempt ${attempt} failed: ${err.message}`);
          if (attempt >= 3) throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));
  // Fill any stragglers if a chunk missed 1-2 keys
  const stillMissing = allKeys.filter((k) => !ckpt.translations[k]);
  if (stillMissing.length > 0) {
    console.log(`[${arm.toUpperCase()} ${locale}] Retrying ${stillMissing.length} straggler keys...`);
    return runCodexBaselineArm(arm, locale);
  }
  return ckpt;
}

/* ============================================================================
 * ARM 4: Wraith + Codex (W-pre) — uses real Wraith workspace, prepareBatch
 * (99.7% React-Intl usageSites!), applyTranslations, and scoped check gate
 * ========================================================================== */
function setupWraithMastodonWorkspace(locale) {
  const wsDir = path.join(WORK_ROOT, `wraith-${locale}`);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
    // Copy package.json and app/javascript/mastodon (no symlinks so walkFiles traverses all 845 source files)
    fs.copyFileSync(path.join(MASTODON_SRC, "package.json"), path.join(wsDir, "package.json"));
    fs.mkdirSync(path.join(wsDir, "app/javascript/mastodon"), { recursive: true });
    for (const entry of fs.readdirSync(path.join(MASTODON_SRC, "app/javascript/mastodon"))) {
      if (entry === "locales") continue;
      fs.cpSync(
        path.join(MASTODON_SRC, "app/javascript/mastodon", entry),
        path.join(wsDir, "app/javascript/mastodon", entry),
        { recursive: true }
      );
    }
    fs.mkdirSync(path.join(wsDir, "app/javascript/mastodon/locales"), { recursive: true });
    fs.copyFileSync(
      path.join(MASTODON_SRC, "app/javascript/mastodon/locales/en.json"),
      path.join(wsDir, "app/javascript/mastodon/locales/en.json")
    );
    // Start with empty target locale file so Wraith translates all 1,466 keys fresh
    fs.writeFileSync(path.join(wsDir, `app/javascript/mastodon/locales/${locale}.json`), "{}\n");
  }

  const store = new wraith.WraithStore(wsDir);
  store.ensureDir();
  fs.writeFileSync(path.join(wsDir, ".wraith/STYLE_GUIDE.md"), STYLE_GUIDE_TEXT + "\n");
  store.writeConfig({
    ...store.readConfig(),
    framework: "react",
    sourceLocale: "en",
    targetLocales: [locale],
    paths: {
      locales: "app/javascript/mastodon/locales",
      source: ["app/javascript/mastodon"],
      ignore: ["node_modules/**", "dist/**", "build/**", "**/*.test.*", "**/*.spec.*", "**/*.stories.*"],
    },
    styleGuide: {
      file: ".wraith/STYLE_GUIDE.md",
      translationPrompt: TRANSLATION_PROMPT,
      qePrompt: QE_PROMPT,
      byLocale: { [locale]: LOCALE_STYLE_RULES[locale] },
    },
  });
  const now = new Date().toISOString();
  store.writeGlossary({
    version: 1,
    entries: GLOSSARY_ENTRIES.map((g) => ({ ...g, updatedAt: now })),
  });
  return wsDir;
}

async function runWraithPreArm(locale) {
  const wsDir = setupWraithMastodonWorkspace(locale);
  const ckpt = loadCheckpoint("w-pre", locale);
  const en = loadSourceEn();
  const allKeys = Object.keys(en).sort();

  // Restore any checkpointed translations into workspace catalog
  if (Object.keys(ckpt.translations).length > 0) {
    const tgtPath = path.join(wsDir, `app/javascript/mastodon/locales/${locale}.json`);
    const existing = JSON.parse(fs.readFileSync(tgtPath, "utf8"));
    if (Object.keys(existing).length < Object.keys(ckpt.translations).length) {
      wraith.applyTranslations({
        rootDir: wsDir,
        targetLocale: locale,
        translations: Object.entries(ckpt.translations).map(([key, value]) => ({ key, value })),
      });
    }
  }

  // Prepare ALL pending items via Wraith's real prepareBatch (computing 99.7% React-Intl usageSites once!)
  const firstPage = wraith.prepareBatch({
    rootDir: wsDir,
    targetLocale: locale,
    offset: 0,
    limit: 200,
  });
  const allPending = [...firstPage.items];
  let offset = firstPage.items.length;
  while (offset < firstPage.totalPending) {
    const page = wraith.prepareBatch({
      rootDir: wsDir,
      targetLocale: locale,
      offset,
      limit: 200,
    });
    if (page.items.length === 0) break;
    allPending.push(...page.items);
    offset += page.items.length;
  }

  const withUsage = allPending.filter((i) => i.usageSites.length > 0).length;
  console.log(
    `[W-PRE ${locale}] Pending=${allPending.length}/${allKeys.length}, withUsageSites=${withUsage}, styleGuideActive=${Boolean(firstPage.styleGuide?.hasAny)}`
  );

  if (allPending.length === 0) {
    const live = JSON.parse(fs.readFileSync(path.join(wsDir, `app/javascript/mastodon/locales/${locale}.json`), "utf8"));
    ckpt.translations = live;
    saveCheckpoint("w-pre", locale, ckpt);
    console.log(`[W-PRE ${locale}] Already complete (${Object.keys(live).length} keys).`);
    return ckpt;
  }

  // Group pending items by primary usageSite file for coherent component-level context!
  allPending.sort((a, b) => {
    const fa = a.usageSites[0]?.file ?? "zzz";
    const fb = b.usageSites[0]?.file ?? "zzz";
    return fa.localeCompare(fb) || a.key.localeCompare(b.key);
  });

  const batches = chunkKeys(allPending, 50);
  const concurrency = 4;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < batches.length) {
      const idx = nextIdx++;
      const batch = batches[idx];
      const compactItems = batch.map((it) => ({
        key: it.key,
        source: it.source,
        placeholders: it.placeholders.length ? it.placeholders : undefined,
        hasPlurals: it.hasPlurals || undefined,
        advisoryPluralCategories: it.advisoryPluralCategories,
        usageSites: it.usageSites.slice(0, 2).map((s) => ({
          file: s.file,
          line: s.line,
          component: s.component,
          element: s.element,
        })),
        charLimit: it.charLimit,
        glossaryHits: it.glossaryHits.length ? it.glossaryHits : undefined,
      }));

      const prompt = `You are translating a Wraith-prepared batch for Mastodon (${locale}) with full repository access in the current working directory.

Wraith Context & Style Guidance:
${firstPage.contextGuidance}

Target Locale Conventions (${locale}):
${JSON.stringify(firstPage.conventions)}

For any ambiguous or UI-constrained string, inspect the source component at \`usageSites\`.
Return ONLY a valid JSON object mapping each exact key to its translated string (preserving all ICU syntax, placeholders, HTML/component tags, glossary terms, and char limits):

${JSON.stringify(compactItems, null, 2)}
`;

      let attempt = 0;
      let feedback = "";
      while (attempt < 3) {
        attempt++;
        try {
          const res = await runCodexPrompt({
            cwd: wsDir,
            prompt: feedback ? `${prompt}\n\nWRAITH CHECK VALIDATION ERRORS FROM PREVIOUS ATTEMPT — FIX ALL OF THESE:\n${feedback}` : prompt,
            sandbox: "read-only",
            timeoutMs: 240_000,
          });
          const obj = extractJsonFromText(res.finalMessage);
          const entries = [];
          for (const it of batch) {
            if (typeof obj[it.key] === "string" && obj[it.key].trim().length > 0) {
              entries.push({ key: it.key, value: obj[it.key] });
            }
          }
          const applyRes = wraith.applyTranslations({
            rootDir: wsDir,
            targetLocale: locale,
            translations: entries,
          });
          ckpt.usage.modelTurns += res.modelTurns;
          ckpt.usage.inputTokens += res.inputTokens;
          ckpt.usage.cachedInputTokens += res.cachedInputTokens;
          ckpt.usage.outputTokens += res.outputTokens;
          ckpt.usage.durationMs += res.durationMs;
          ckpt.usage.chunks += 1;
          ckpt.usage.estimatedUsd = estimateCodexUsd(ckpt.usage);

          const errList = applyRes.errors || [];
          const errKeySet = new Set(errList.map((r) => r.key));
          for (const e of entries) {
            if (!errKeySet.has(e.key)) {
              ckpt.translations[e.key] = e.value;
            }
          }
          saveCheckpoint("w-pre", locale, ckpt);

          if (errList.length > 0 && attempt < 3) {
            feedback = errList.map((r) => `- ${r.key} (${r.code}): ${r.message}`).join("\n");
            console.log(`  [W-PRE ${locale}] batch ${idx + 1}/${batches.length} had ${errList.length} Wraith rejections; retrying...`);
            continue;
          }
          console.log(
            `  [W-PRE ${locale}] batch ${idx + 1}/${batches.length}: applied=${applyRes.appliedCount}, rejected=${errList.length} (${(res.durationMs / 1000).toFixed(1)}s, total=${Object.keys(ckpt.translations).length}/${allKeys.length})`
          );
          break;
        } catch (err) {
          console.error(`  [W-PRE ${locale}] batch ${idx + 1} attempt ${attempt} failed: ${err.message}`);
          if (attempt >= 3) throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));

  // Run scoped Wraith check across the entire 1,466-key catalog and repair any remaining check errors
  const checkRes = wraith.runCheck({ rootDir: wsDir, locale, scope: "translations", limit: 100 });
  ckpt.meta.postApplyCheck = {
    outcome: checkRes.outcome,
    errorCount: checkRes.errorCount,
    warningCount: checkRes.warningCount,
    countsByCode: checkRes.countsByCode,
  };
  if (checkRes.errorCount > 0) {
    const errKeys = [...new Set(checkRes.issues.items.filter((i) => i.severity === "error" && i.key).map((i) => i.key))];
    console.log(`[W-PRE ${locale}] Scoped check found ${checkRes.errorCount} errors across ${errKeys.length} keys — running repair pass...`);
    if (errKeys.length > 0) {
      const repairItems = errKeys.map((k) => ({
        key: k,
        source: en[k],
        currentTarget: ckpt.translations[k] ?? "",
        errors: checkRes.issues.items.filter((i) => i.key === k && i.severity === "error").map((i) => `${i.code}: ${i.message}`),
      }));
      const repairPrompt = `Fix ONLY the Wraith deterministic check errors listed below for Mastodon (${locale}).
${firstPage.contextGuidance}
Return ONLY a JSON object mapping each key to its corrected ${locale} translation:
${JSON.stringify(repairItems, null, 2)}
`;
      const res = await runCodexPrompt({ cwd: wsDir, prompt: repairPrompt, sandbox: "read-only", timeoutMs: 240_000 });
      const obj = extractJsonFromText(res.finalMessage);
      const fixEntries = Object.entries(obj)
        .filter(([k, v]) => errKeys.includes(k) && typeof v === "string" && v.trim())
        .map(([key, value]) => ({ key, value }));
      if (fixEntries.length > 0) {
        wraith.applyTranslations({ rootDir: wsDir, targetLocale: locale, translations: fixEntries });
        for (const e of fixEntries) ckpt.translations[e.key] = e.value;
      }
      ckpt.usage.modelTurns += res.modelTurns;
      ckpt.usage.inputTokens += res.inputTokens;
      ckpt.usage.cachedInputTokens += res.cachedInputTokens;
      ckpt.usage.outputTokens += res.outputTokens;
      ckpt.usage.durationMs += res.durationMs;
      ckpt.usage.estimatedUsd = estimateCodexUsd(ckpt.usage);
      const recheck = wraith.runCheck({ rootDir: wsDir, locale, scope: "translations", limit: 100 });
      ckpt.meta.afterRepairCheck = {
        outcome: recheck.outcome,
        errorCount: recheck.errorCount,
        warningCount: recheck.warningCount,
        countsByCode: recheck.countsByCode,
      };
      console.log(`[W-PRE ${locale}] After repair: errors=${recheck.errorCount}, warnings=${recheck.warningCount}`);
    }
  }

  const live = JSON.parse(fs.readFileSync(path.join(wsDir, `app/javascript/mastodon/locales/${locale}.json`), "utf8"));
  ckpt.translations = live;
  saveCheckpoint("w-pre", locale, ckpt);
  console.log(`[W-PRE ${locale}] Complete: ${Object.keys(live).length}/${allKeys.length} keys, est=$${ckpt.usage.estimatedUsd}`);
  return ckpt;
}

/* ============================================================================
 * ARM 5: Fresh-Context QE Subagent (W-post) — verifies full context parity
 * delivered by Wraith's real prepareQeReview() and logs every single QE diff!
 * ========================================================================== */
async function runWraithQeArm(locale) {
  const wsDir = setupWraithMastodonWorkspace(locale);
  const wPre = loadCheckpoint("w-pre", locale);
  const ckpt = loadCheckpoint("w-post", locale);

  if (ckpt.meta?.qeCompleted && Object.keys(ckpt.translations).length >= Object.keys(wPre.translations).length) {
    console.log(`[W-POST ${locale}] Already complete (${Object.keys(ckpt.translations).length} keys, ${(ckpt.meta.qeDiffs || []).length} edits).`);
    return ckpt;
  }

  // Ensure workspace has W-pre translations
  const tgtPath = path.join(wsDir, `app/javascript/mastodon/locales/${locale}.json`);
  wraith.applyTranslations({
    rootDir: wsDir,
    targetLocale: locale,
    translations: Object.entries(wPre.translations).map(([key, value]) => ({ key, value })),
  });

  // Build real Wraith QE tasks with full context parity
  const qePrep = wraith.prepareQeReview({ rootDir: wsDir, locales: [locale], write: true });

  // Programmatically verify ALL 9 required context-parity items were delivered
  const parityCheck = {
    hasProjectStyleGuide: Boolean(qePrep.styleGuide?.styleGuide && qePrep.instructions.includes("Fediverse")),
    hasLocaleStyleRule: Boolean(qePrep.styleGuide?.localeRules?.[locale]),
    hasTranslationPrompt: Boolean(qePrep.instructions.includes(TRANSLATION_PROMPT)),
    hasQePrompt: Boolean(qePrep.instructions.includes(QE_PROMPT)),
    hasConventionsByLocale: Boolean(qePrep.conventionsByLocale?.[locale]),
    hasDoNotTranslate: Array.isArray(qePrep.doNotTranslate) && qePrep.doNotTranslate.length > 0,
    stringsWithTermBase: qePrep.tasks.reduce((n, t) => n + t.strings.filter((s) => s.termBase?.length).length, 0),
    stringsWithPlaceholders: qePrep.tasks.reduce((n, t) => n + t.strings.filter((s) => s.placeholders?.length).length, 0),
    stringsWithUsageFile: qePrep.tasks.filter((t) => t.file !== "(no usage site)").reduce((n, t) => n + t.strings.length, 0),
    toReview: qePrep.toReview,
    blockedByCheck: qePrep.blockedByCheck.length,
  };
  console.log(`[W-POST ${locale}] QE Context Parity Verified:`, JSON.stringify(parityCheck));

  // Group tasks into ~60-string fresh-context subagent batches
  const batches = [];
  let curBatch = [];
  let curCount = 0;
  for (const task of qePrep.tasks) {
    if (curCount > 0 && curCount + task.strings.length > 60) {
      batches.push(curBatch);
      curBatch = [];
      curCount = 0;
    }
    curBatch.push(task);
    curCount += task.strings.length;
  }
  if (curBatch.length > 0) batches.push(curBatch);

  ckpt.translations = { ...wPre.translations };
  ckpt.meta.parityCheck = parityCheck;
  ckpt.meta.qeDiffs = ckpt.meta.qeDiffs || [];
  ckpt.meta.completedBatchIds = ckpt.meta.completedBatchIds || [];
  const completedSet = new Set(ckpt.meta.completedBatchIds);

  const concurrency = 4;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < batches.length) {
      const idx = nextIdx++;
      if (completedSet.has(idx)) continue;
      const batchTasks = batches[idx];
      const batchStringCount = batchTasks.reduce((n, t) => n + t.strings.length, 0);

      // Fresh-context QE prompt — contains ONLY Wraith's prepareQeReview evidence (ZERO translator scratchpad)
      const prompt = `${qePrep.instructions}

Locale Conventions (${locale}):
${JSON.stringify(qePrep.conventionsByLocale[locale])}

Project Do-Not-Translate Terms:
${JSON.stringify(qePrep.doNotTranslate ?? [])}

Project Decisions:
${JSON.stringify(qePrep.projectDecisions)}

You have read-only access to the Mastodon repository in the current working directory. Open the referenced component files when needed to verify UI sense.
Review every string in the tasks below.
Return ONLY a valid JSON array containing ONLY the strings you mark "flag" (if all strings in this batch are "ok", return \`[]\`).
Each flagged object must have: {"locale":"${locale}","key":"...","fingerprint":"...","verdict":"flag","reason":"one-line reason","suggestedFix":"full corrected target"}

Tasks:
${JSON.stringify(batchTasks, null, 2)}
`;

      let attempt = 0;
      while (attempt < 3) {
        attempt++;
        try {
          const res = await runCodexPrompt({ cwd: wsDir, prompt, sandbox: "read-only", timeoutMs: 240_000 });
          const flagged = extractJsonFromText(res.finalMessage);
          const flaggedArr = Array.isArray(flagged) ? flagged : [];

          // Build full verdicts array (ok for unflagged, flag for flagged) and submit through Wraith
          const flaggedByKey = new Map(flaggedArr.map((f) => [f.key, f]));
          const allVerdicts = [];
          const fixEntries = [];
          for (const task of batchTasks) {
            for (const s of task.strings) {
              const fl = flaggedByKey.get(s.key);
              if (fl && fl.verdict === "flag" && fl.reason) {
                allVerdicts.push({
                  locale,
                  key: s.key,
                  fingerprint: s.fingerprint,
                  verdict: "flag",
                  reason: fl.reason,
                  ...(fl.suggestedFix ? { suggestedFix: fl.suggestedFix } : {}),
                });
                if (typeof fl.suggestedFix === "string" && fl.suggestedFix.trim() && fl.suggestedFix !== s.target) {
                  fixEntries.push({
                    key: s.key,
                    value: fl.suggestedFix,
                    before: s.target,
                    source: s.source,
                    file: task.file,
                    reason: fl.reason,
                  });
                }
              } else {
                allVerdicts.push({
                  locale,
                  key: s.key,
                  fingerprint: s.fingerprint,
                  verdict: "ok",
                });
              }
            }
          }

          wraith.submitQeVerdicts({ rootDir: wsDir, verdicts: allVerdicts });
          if (fixEntries.length > 0) {
            const applyRes = wraith.applyTranslations({
              rootDir: wsDir,
              targetLocale: locale,
              translations: fixEntries.map((f) => ({ key: f.key, value: f.value })),
            });
            const rejectedKeys = new Set((applyRes.errors || []).map((r) => r.key));
            for (const f of fixEntries) {
              if (!rejectedKeys.has(f.key)) {
                ckpt.translations[f.key] = f.value;
                ckpt.meta.qeDiffs.push({
                  key: f.key,
                  source: f.source,
                  before: f.before,
                  after: f.value,
                  file: f.file,
                  reason: f.reason,
                });
              }
            }
          }

          ckpt.usage.modelTurns += res.modelTurns;
          ckpt.usage.inputTokens += res.inputTokens;
          ckpt.usage.cachedInputTokens += res.cachedInputTokens;
          ckpt.usage.outputTokens += res.outputTokens;
          ckpt.usage.durationMs += res.durationMs;
          ckpt.usage.chunks += 1;
          ckpt.usage.estimatedUsd = estimateCodexUsd(ckpt.usage);
          ckpt.meta.completedBatchIds.push(idx);
          saveCheckpoint("w-post", locale, ckpt);
          console.log(
            `  [W-POST ${locale}] QE batch ${idx + 1}/${batches.length} (${batchStringCount} strs): flagged=${flaggedArr.length}, appliedFixes=${fixEntries.length} (${(res.durationMs / 1000).toFixed(1)}s)`
          );
          break;
        } catch (err) {
          console.error(`  [W-POST ${locale}] QE batch ${idx + 1} attempt ${attempt} failed: ${err.message}`);
          if (attempt >= 3) throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
  ckpt.meta.qeCompleted = true;
  saveCheckpoint("w-post", locale, ckpt);
  console.log(
    `[W-POST ${locale}] Complete: ${ckpt.meta.qeDiffs.length} QE edits applied across ${qePrep.toReview} strings (QE est=$${ckpt.usage.estimatedUsd}).`
  );
  return ckpt;
}

/* ============================================================================
 * CLI Entrypoint
 * ========================================================================== */
const [, , cmd, arg1, arg2] = process.argv;
if (cmd === "arm") {
  const locales = arg2 ? [arg2] : LANGUAGES;
  for (const loc of locales) {
    if (arg1 === "nmt") await runNmtArm(loc);
    else if (arg1 === "b0") await runCodexBaselineArm("b0", loc);
    else if (arg1 === "a0") await runCodexBaselineArm("a0", loc);
    else if (arg1 === "wraith") await runWraithPreArm(loc);
    else if (arg1 === "qe") await runWraithQeArm(loc);
    else throw new Error(`Unknown arm: ${arg1}`);
  }
} else {
  console.log("Usage: node eval/bench/real-world-mastodon.mjs arm <nmt|b0|a0|wraith|qe> [es-MX|ar]");
}
