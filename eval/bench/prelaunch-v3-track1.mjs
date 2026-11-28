#!/usr/bin/env node
/**
 * Pre-Launch v3 — Track 1: Controlled Linguistic Asset & Instruction-Adherence Suite
 *
 * Runs Vanilla Codex (A0) vs. Codex + Wraith (W) across:
 *   1. Condition 1 (Equal-Information): single-release full localization of PulseDesk
 *      (7 JSON namespaces + docs/guide.md + docs/workspace-admin-manual.docx) into es-MX + ar.
 *   2. Condition 2 (Persistent-Workflow, v1 -> v2 -> v3):
 *      - Session 1 (v1): full localization + A0 explicitly allowed to build persistent files/scripts.
 *      - Session 2 (v2, fresh --ephemeral): +15 new keys, 3 edited source keys, 3 human edits per locale.
 *        Brief release prompt ONLY (no re-pasted style guide / glossary / prompt rules).
 *      - Session 3 (v3, fresh --ephemeral): mid-project glossary ("Workspace"), locale style (help.*),
 *        and prompt (sync.*) updates + 2 human-locked Workspace keys. Measures change-propagation
 *        precision/recall and human-approved preservation.
 *   3. Controlled Diagnostic QE (24 strings/locale: 12 true defects + 12 clean controls, visual manifest):
 *      Fresh-context diagnostic review for A0 vs W; measures Precision, Recall, FPR, and zero unauthorized edits.
 *
 * Usage:
 *   node eval/bench/prelaunch-v3-track1.mjs [--tag baseline-d9a8e34] [--only cond1|cond2|qe]
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyV2ReleaseChanges,
  applyV3AssetUpdates,
  createControlledQeWorkspace,
  createControlledWorkspace,
} from "../prelaunch-v3/generate-controlled-fixture.mjs";
import {
  scoreControlledQe,
  scoreReleaseSnapshot,
  scoreV3Propagation,
} from "../prelaunch-v3/score-controlled.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EXPECTED = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "eval", "prelaunch-v3", "EXPECTED_OUTCOMES.json"), "utf8")
);

const argIdx = (flag) => process.argv.indexOf(flag);
const TAG = argIdx("--tag") >= 0 ? process.argv[argIdx("--tag") + 1] : "baseline-d9a8e34";
const ONLY = argIdx("--only") >= 0 ? process.argv[argIdx("--only") + 1] : "all";

const OUT_DIR = path.join(REPO_ROOT, "eval", "results", "prelaunch-v3", TAG, "track1-linguistic");
const TRACES_DIR = path.join(OUT_DIR, "traces");
const SNAPSHOTS_DIR = path.join(OUT_DIR, "snapshots");
fs.mkdirSync(TRACES_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const WORK_BASE = path.join(os.tmpdir(), `wraith-prelaunch-v3-track1-${TAG}-${Date.now()}`);
fs.mkdirSync(WORK_BASE, { recursive: true });

const NODE_BIN = process.execPath;
const CODEX_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/codex")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/codex"
  : "codex";
const WRAITH_BIN = path.join(REPO_ROOT, "dist", "bin.js");
const wraithApi = await import(path.join(REPO_ROOT, "dist", "index.js"));

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
    lastMessage: lastMessage.slice(0, 600),
    errors,
  };
}

async function runCodex({ label, cwd, prompt, useWraith = false, timeoutMs = 420_000 }) {
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
  fs.writeFileSync(path.join(TRACES_DIR, `${label}.jsonl`), stdout, "utf8");
  const telemetry = parseCodexJsonl(stdout);
  console.log(
    `[${label}] done ${wallS}s | exit=${exitCode} in=${telemetry.inputTokens} (unc=${telemetry.uncachedInputTokens}) out=${telemetry.outputTokens} mcp=${telemetry.mcpCallsCount} sh=${telemetry.shellCallsCount} est=$${telemetry.estApiUsd}`
  );
  if (exitCode !== 0 || telemetry.errors.length > 0) {
    console.warn(`[${label}] warn:`, stderr.slice(0, 250), telemetry.errors.slice(0, 2));
  }
  return { exitCode, timedOut, wallS, telemetry };
}

function readAllCatalogStrings(workspaceDir, locale) {
  const out = {};
  const dir = path.join(workspaceDir, "src", "locales", locale);
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const ns = f.replace(/\.json$/, "");
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const [k, v] of Object.entries(obj)) if (typeof v === "string") out[`${ns}.${k}`] = v;
    } catch {}
  }
  return out;
}

function measureCustomInfra(workspaceDir, baselineFilesSet) {
  const added = [];
  let totalLoc = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", ".wraith"].includes(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(workspaceDir, abs);
      if (ent.isDirectory()) walk(abs);
      else if (!baselineFilesSet.has(rel) && !rel.startsWith("src/locales/") && !rel.startsWith("docs/")) {
        const content = fs.readFileSync(abs, "utf8");
        const loc = content.split(/\r?\n/).length;
        added.push({ file: rel, loc });
        totalLoc += loc;
      }
    }
  };
  walk(workspaceDir);
  return { addedFilesCount: added.length, totalLoc, files: added };
}

function listAllFiles(dir, base = dir, out = new Set()) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".wraith"].includes(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) listAllFiles(abs, base, out);
    else out.add(path.relative(base, abs));
  }
  return out;
}

function hashLocaleFiles(dir) {
  const hashes = {};
  const locRoot = path.join(dir, "src", "locales");
  if (!fs.existsSync(locRoot)) return hashes;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else {
        const rel = path.relative(dir, abs);
        hashes[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      }
    }
  };
  walk(locRoot);
  return hashes;
}

function saveCatalogSnapshot(workspaceDir, snapName) {
  const dst = path.join(SNAPSHOTS_DIR, snapName);
  fs.mkdirSync(dst, { recursive: true });
  for (const loc of ["es-MX", "ar"]) {
    const data = readAllCatalogStrings(workspaceDir, loc);
    fs.writeFileSync(path.join(dst, `${loc}.json`), JSON.stringify(data, null, 2) + "\n");
  }
  const docsSrc = path.join(workspaceDir, "docs");
  if (fs.existsSync(docsSrc)) {
    fs.cpSync(docsSrc, path.join(dst, "docs"), { recursive: true });
  }
  const locSrc = path.join(workspaceDir, "localization");
  if (fs.existsSync(locSrc)) {
    fs.cpSync(locSrc, path.join(dst, "localization"), { recursive: true });
  }
  const wraithSrc = path.join(workspaceDir, ".wraith");
  if (fs.existsSync(wraithSrc)) {
    for (const f of ["questions.json", "assumptions.json"]) {
      const fp = path.join(wraithSrc, f);
      if (fs.existsSync(fp)) fs.copyFileSync(fp, path.join(dst, f));
    }
  }
}

const resultsPath = path.join(OUT_DIR, "results.json");
const results = fs.existsSync(resultsPath)
  ? JSON.parse(fs.readFileSync(resultsPath, "utf8"))
  : {
      tag: TAG,
      wraithSha: EXPECTED.baselineWraithSha,
      model: EXPECTED.model,
      startedAt: new Date().toISOString(),
      condition1_equalInfo: {},
      condition2_persistent: {},
      controlled_qe: {},
    };

const persist = () => {
  results.updatedAt = new Date().toISOString();
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
};

// ============================================================================
// CONDITION 1: EQUAL-INFORMATION COMPARISON (A0 vs W)
// ============================================================================
if (ONLY === "all" || ONLY === "cond1") {
  const dirA0 = path.join(WORK_BASE, "cond1-A0");
  const dirW = path.join(WORK_BASE, "cond1-W");
  createControlledWorkspace(dirA0, { initWraith: false });
  createControlledWorkspace(dirW, { initWraith: true, wraithApi });

  const promptCommon = `Localize the PulseDesk workspace into BOTH Mexican Spanish (es-MX) and Arabic (ar):
- Translate ALL 7 JSON catalogs under src/locales/en/*.json into src/locales/es-MX/*.json and src/locales/ar/*.json.
- Translate docs/guide.md into docs/guide.es-MX.md and docs/guide.ar.md.
- Translate docs/workspace-admin-manual.docx into docs/workspace-admin-manual.es-MX.docx and docs/workspace-admin-manual.ar.docx (preserving OOXML formatting, header, footer, and table structure).

All project linguistic assets are already in the repository under localization/:
- localization/STYLE_GUIDE.md (project-wide voice, register, precedence rules)
- localization/TRANSLATION_PROMPT.md (prohibited wording, preferred button forms, preservation rules)
- localization/LOCALE_RULES.json (locale-specific rules and section overrides, including legal.* formal usted in es-MX)
- localization/glossary.csv & localization/termbase.tbx (approved terms, prohibited alternatives, DNT tokens)
- localization/memory.tmx (seeded translation memory — reuse appropriate exact/fuzzy matches, NEVER blindly copy misleading or wrong-context matches, and let active terminology override stale TM)

Inspect the React components in src/components/ to disambiguate short/polysemous UI strings (Post, Charge, Key, Open, Save, Home, Archive). If any string is genuinely ambiguous even after reading source code, record a concise open question/note rather than inventing missing facts.`;

  const promptA0 = `${promptCommon}\n\nVerify your translations, JSON syntax, placeholders/ICU plurals, glossary compliance, and DOCX integrity before finishing. Record any genuinely ambiguous keys in localization/QUESTIONS.md.`;
  const promptW = `${promptCommon}\n\nWraith MCP is configured and initialized for this repo (with style guide, locale rules, translation prompt, CSV/TBX glossary, and TMX memory already imported into .wraith/). Use Wraith MCP tools (prepare, apply, check, memory) for both the JSON catalogs and the companion docs (docs/guide.md, docs/workspace-admin-manual.docx). Record genuinely ambiguous keys via memory add_question. Ensure wraith check passes cleanly.`;

  const [runA0, runW] = await Promise.all([
    runCodex({ label: "cond1-A0", cwd: dirA0, prompt: promptA0, useWraith: false }),
    runCodex({ label: "cond1-W", cwd: dirW, prompt: promptW, useWraith: true }),
  ]);

  saveCatalogSnapshot(dirA0, "cond1-A0");
  saveCatalogSnapshot(dirW, "cond1-W");

  results.condition1_equalInfo = {
    A0: {
      run: runA0,
      scores: {
        "es-MX": scoreReleaseSnapshot(dirA0, "es-MX", { phase: "v1" }),
        ar: scoreReleaseSnapshot(dirA0, "ar", { phase: "v1" }),
      },
    },
    W: {
      run: runW,
      wraithCheck: wraithApi.runCheck({ rootDir: dirW }).outcome,
      scores: {
        "es-MX": scoreReleaseSnapshot(dirW, "es-MX", { phase: "v1" }),
        ar: scoreReleaseSnapshot(dirW, "ar", { phase: "v1" }),
      },
    },
  };
  persist();
}

// ============================================================================
// CONDITION 2: PERSISTENT-WORKFLOW COMPARISON (v1 -> v2 -> v3, FRESH SESSIONS)
// ============================================================================
if (ONLY === "all" || ONLY === "cond2") {
  const dirA0 = path.join(WORK_BASE, "cond2-A0");
  const dirW = path.join(WORK_BASE, "cond2-W");
  createControlledWorkspace(dirA0, { initWraith: false });
  createControlledWorkspace(dirW, { initWraith: true, wraithApi });
  const baselineA0Files = listAllFiles(dirA0);

  // --- Session 1 (v1): both know future fresh sessions will handle v2/v3 ---
  const v1Base = `This repository (PulseDesk) will undergo multiple future localization releases (v2, v3) handled by FRESH agent sessions that will NOT have all linguistic rules re-pasted into the prompt.

For Release v1, localize ALL 7 JSON catalogs (src/locales/en/*.json -> es-MX, ar), docs/guide.md, and docs/workspace-admin-manual.docx following EVERY rule in localization/ (STYLE_GUIDE.md, TRANSLATION_PROMPT.md, LOCALE_RULES.json, glossary.csv, termbase.tbx, memory.tmx) and component context in src/components/.`;

  const v1PromptA0 = `${v1Base}

You are free to create and maintain whatever persistent project files, documentation, glossaries, TM caches, scripts, or validation checks you find helpful so future fresh sessions can consistently enforce these rules, preserve human edits, and propagate asset updates reliably. Record genuinely ambiguous keys in localization/QUESTIONS.md.`;

  const v1PromptW = `${v1Base}

Wraith MCP is initialized with all linguistic assets imported into .wraith/. Use Wraith MCP tools (prepare, apply, check, memory) to translate catalogs and documents cleanly, record any genuine ambiguities via memory add_question, and ensure wraith check passes so .wraith/ state cleanly supports future fresh sessions.`;

  const [v1A0, v1W] = await Promise.all([
    runCodex({ label: "cond2-v1-A0", cwd: dirA0, prompt: v1PromptA0, useWraith: false }),
    runCodex({ label: "cond2-v1-W", cwd: dirW, prompt: v1PromptW, useWraith: true }),
  ]);

  saveCatalogSnapshot(dirA0, "cond2-v1-A0");
  saveCatalogSnapshot(dirW, "cond2-v1-W");
  const infraAfterV1 = measureCustomInfra(dirA0, baselineA0Files);

  // --- Session 2 (v2): Fresh ephemeral session, concise release prompt only ---
  applyV2ReleaseChanges(dirA0, { expectedOutcomes: EXPECTED, isWraith: false });
  applyV2ReleaseChanges(dirW, { expectedOutcomes: EXPECTED, isWraith: true, wraithApi });

  const v2PromptA0 = `Release v2 is ready in this repository: 15 new strings were added and 3 existing source strings were updated under src/locales/en/. Additionally, human linguists manually edited several target strings in es-MX and ar (see any repository notes / localization/HUMAN_EDITS_V2.json).

Using this repository's established localization rules, terminology, translation memory, and any validation mechanisms already set up here, localize all new and changed strings for es-MX and ar while preserving all manual human edits untouched.`;

  const v2PromptW = `Release v2 is ready in this repository: 15 new strings were added and 3 existing source strings were updated under src/locales/en/. Additionally, human linguists manually edited several target strings in es-MX and ar.

Using Wraith MCP and this repository's persistent .wraith/ linguistic assets, localize all new and changed strings for es-MX and ar while preserving all manual human edits untouched, and ensure wraith check passes.`;

  const [v2A0, v2W] = await Promise.all([
    runCodex({ label: "cond2-v2-A0", cwd: dirA0, prompt: v2PromptA0, useWraith: false }),
    runCodex({ label: "cond2-v2-W", cwd: dirW, prompt: v2PromptW, useWraith: true }),
  ]);

  saveCatalogSnapshot(dirA0, "cond2-v2-A0");
  saveCatalogSnapshot(dirW, "cond2-v2-W");
  const v2CatsA0 = { "es-MX": readAllCatalogStrings(dirA0, "es-MX"), ar: readAllCatalogStrings(dirA0, "ar") };
  const v2CatsW = { "es-MX": readAllCatalogStrings(dirW, "es-MX"), ar: readAllCatalogStrings(dirW, "ar") };

  // --- Session 3 (v3): Mid-project linguistic asset updates, fresh ephemeral session ---
  applyV3AssetUpdates(dirA0, { expectedOutcomes: EXPECTED, isWraith: false });
  applyV3AssetUpdates(dirW, { expectedOutcomes: EXPECTED, isWraith: true, wraithApi });

  const v3PromptCommon = `Mid-project Release v3 linguistic asset updates have just been committed:
1. Glossary change: "Workspace" is now approved as "Entorno de trabajo" (es-MX) and "بيئة العمل" (ar).
2. Style override (es-MX): help.* keys now use formal 'usted' (keep general UI nav/settings/forms/notifications on informal 'tú').
3. Prompt rule (es-MX): sync.* keys must use "obtener" instead of "descargar" for cloud Snapshots.
4. Human-approved lock: Do NOT overwrite any human-approved/locked keys (listed in localization/HUMAN_APPROVED_LOCKED.json and/or marked human-verified in project state), and do NOT unnecessarily modify unrelated keys.`;

  const v3PromptA0 = `${v3PromptCommon}\n\nPropagate ONLY the affected translations in src/locales/es-MX/ and src/locales/ar/ with high precision and recall, keeping all unrelated and human-approved keys byte-for-byte unchanged.`;
  const v3PromptW = `${v3PromptCommon}\n\nUse Wraith MCP (prepare, apply, check, status, qe_audit) to propagate ONLY the affected translations in src/locales/es-MX/ and src/locales/ar/ with high precision and recall, keeping all unrelated and human-approved/human-verified keys byte-for-byte unchanged.`;

  const [v3A0, v3W] = await Promise.all([
    runCodex({ label: "cond2-v3-A0", cwd: dirA0, prompt: v3PromptA0, useWraith: false }),
    runCodex({ label: "cond2-v3-W", cwd: dirW, prompt: v3PromptW, useWraith: true }),
  ]);

  saveCatalogSnapshot(dirA0, "cond2-v3-A0");
  saveCatalogSnapshot(dirW, "cond2-v3-W");
  const infraAfterV3 = measureCustomInfra(dirA0, baselineA0Files);

  results.condition2_persistent = {
    A0: {
      customInfraV1: infraAfterV1,
      customInfraV3: infraAfterV3,
      v1: {
        run: v1A0,
        scores: {
          "es-MX": scoreReleaseSnapshot(dirA0, "es-MX", { phase: "v1" }), // NOTE: overwritten by v2/v3; use snapshots below!
        },
      },
      v2: { run: v2A0 },
      v3: {
        run: v3A0,
        propagation: {
          "es-MX": scoreV3Propagation(v2CatsA0, dirA0, "es-MX"),
          ar: scoreV3Propagation(v2CatsA0, dirA0, "ar"),
        },
      },
    },
    W: {
      v1: { run: v1W },
      v2: { run: v2W },
      v3: {
        run: v3W,
        wraithCheck: wraithApi.runCheck({ rootDir: dirW }).outcome,
        propagation: {
          "es-MX": scoreV3Propagation(v2CatsW, dirW, "es-MX"),
          ar: scoreV3Propagation(v2CatsW, dirW, "ar"),
        },
      },
    },
  };

  // Re-score v1 and v2 cleanly from preserved snapshots (so v3 edits never taint v1/v2 scores!)
  const scoreFromSnap = (snapName, baseWorkspaceCreator, isV2) => {
    const tmp = path.join(WORK_BASE, `rescore-${snapName}`);
    baseWorkspaceCreator(tmp);
    if (isV2) applyV2ReleaseChanges(tmp, { expectedOutcomes: EXPECTED, isWraith: false });
    const snapDir = path.join(SNAPSHOTS_DIR, snapName);
    for (const loc of ["es-MX", "ar"]) {
      const flat = JSON.parse(fs.readFileSync(path.join(snapDir, `${loc}.json`), "utf8"));
      const byNs = {};
      for (const [k, v] of Object.entries(flat)) {
        const [ns, key] = k.split(".");
        if (!byNs[ns]) byNs[ns] = {};
        byNs[ns][key] = v;
      }
      fs.mkdirSync(path.join(tmp, "src", "locales", loc), { recursive: true });
      for (const [ns, obj] of Object.entries(byNs)) {
        fs.writeFileSync(path.join(tmp, "src", "locales", loc, `${ns}.json`), JSON.stringify(obj, null, 2) + "\n");
      }
    }
    if (fs.existsSync(path.join(snapDir, "docs"))) {
      fs.cpSync(path.join(snapDir, "docs"), path.join(tmp, "docs"), { recursive: true });
    }
    if (fs.existsSync(path.join(snapDir, "localization"))) {
      fs.cpSync(path.join(snapDir, "localization"), path.join(tmp, "localization"), { recursive: true });
    }
    fs.mkdirSync(path.join(tmp, ".wraith"), { recursive: true });
    for (const f of ["questions.json", "assumptions.json"]) {
      if (fs.existsSync(path.join(snapDir, f))) fs.copyFileSync(path.join(snapDir, f), path.join(tmp, ".wraith", f));
    }
    const out = {
      "es-MX": scoreReleaseSnapshot(tmp, "es-MX", { phase: isV2 ? "v2" : "v1" }),
      ar: scoreReleaseSnapshot(tmp, "ar", { phase: isV2 ? "v2" : "v1" }),
    };
    fs.rmSync(tmp, { recursive: true, force: true });
    return out;
  };

  results.condition2_persistent.A0.v1.scores = scoreFromSnap("cond2-v1-A0", (d) => createControlledWorkspace(d), false);
  results.condition2_persistent.W.v1.scores = scoreFromSnap("cond2-v1-W", (d) => createControlledWorkspace(d), false);
  results.condition2_persistent.A0.v2.scores = scoreFromSnap("cond2-v2-A0", (d) => createControlledWorkspace(d), true);
  results.condition2_persistent.W.v2.scores = scoreFromSnap("cond2-v2-W", (d) => createControlledWorkspace(d), true);
  persist();
}

// ============================================================================
// CONTROLLED 24-STRING/LOCALE DIAGNOSTIC QE BENCHMARK (A0 vs W)
// ============================================================================
if (ONLY === "all" || ONLY === "qe") {
  const dirQeA0 = path.join(WORK_BASE, "qe-A0");
  const dirQeW = path.join(WORK_BASE, "qe-W");
  createControlledQeWorkspace(dirQeA0, { initWraith: false });
  createControlledQeWorkspace(dirQeW, { initWraith: true, wraithApi });

  const beforeHashesA0 = hashLocaleFiles(dirQeA0);
  const beforeHashesW = hashLocaleFiles(dirQeW);

  const qePromptA0 = `Perform a DIAGNOSTIC-ONLY localization Quality Evaluation (QE) of ALL 24 keys in src/locales/es-MX/common.json and ALL 24 keys in src/locales/ar/common.json against src/locales/en/common.json.

CRITICAL RULES:
- DO NOT edit any file under src/locales/! This audit is strictly diagnostic-only.
- Read src/components/AppView.tsx for UI usage context, .wraith/artifacts/visual-qa/manifest.json for measured visual clipping defects, and ALL linguistic rules under localization/ (STYLE_GUIDE.md, TRANSLATION_PROMPT.md, LOCALE_RULES.json, glossary.csv, termbase.tbx, memory.tmx).
- Flag a string ONLY when it has a clear linguistic, terminological, style-guide, prompt, placeholder/ICU, factual, or visual defect. Mark acceptable translations that obey the style guide, prompt, glossary, and locale overrides as "ok" (do not flag intentional stylistic choices like formal usted in legal-notice sections or DNT brands in Arabic).
- Write your complete verdicts JSON array to qe-report.json with schema:
  [{"locale":"es-MX"|"ar","key":"<key>","verdict":"ok"|"flag","severity":"critical"|"major"|"minor","category":"...","reason":"...","evidence":"...","suggestedFix":"..."}]`;

  const qePromptW = `Perform a DIAGNOSTIC-ONLY localization Quality Evaluation (QE) of ALL 24 keys in es-MX and ALL 24 keys in ar using Wraith MCP's qe_audit tool (mode="prepare", scope="all", then mode="submit").

CRITICAL RULES:
- DO NOT edit any file under src/locales/! Diagnostic-only audit.
- Follow the instructions, styleGuide, locale rules, translation prompt, termBase, visualDefects, and usage context returned by qe_audit(mode="prepare"), and inspect src/components/AppView.tsx and localization/memory.tmx if helpful.
- Submit verdicts for EVERY string in BOTH es-MX and ar via qe_audit(mode="submit").`;

  const [qeRunA0, qeRunW] = await Promise.all([
    runCodex({ label: "qe-A0", cwd: dirQeA0, prompt: qePromptA0, useWraith: false }),
    runCodex({ label: "qe-W", cwd: dirQeW, prompt: qePromptW, useWraith: true }),
  ]);

  const afterHashesA0 = hashLocaleFiles(dirQeA0);
  const afterHashesW = hashLocaleFiles(dirQeW);

  let verdictsA0 = [];
  const a0ReportPath = path.join(dirQeA0, "qe-report.json");
  if (fs.existsSync(a0ReportPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(a0ReportPath, "utf8"));
      verdictsA0 = Array.isArray(parsed) ? parsed : parsed.verdicts || parsed.records || [];
    } catch {}
  }

  let verdictsW = [];
  const wVerdictsPath = path.join(dirQeW, ".wraith", "qe-verdicts.json");
  if (fs.existsSync(wVerdictsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(wVerdictsPath, "utf8"));
      verdictsW = parsed.records || [];
    } catch {}
  }
  // Wraith deterministically catches hard errors in blockedByCheck before QE runs;
  // include those deterministic flags in W's combined diagnostic output (and report counts separately).
  const wPrep = wraithApi.prepareQeReview({ rootDir: dirQeW, scope: "all", locales: ["es-MX", "ar"] });
  const blockedFlags = (wPrep.blockedByCheck || []).map((b) => ({
    locale: b.locale,
    key: b.key,
    verdict: "flag",
    severity: "critical",
    category: "deterministic-check",
    reason: b.issue,
    reviewer: "wraith-check",
  }));
  const combinedVerdictsW = [...blockedFlags, ...verdictsW];

  fs.writeFileSync(path.join(OUT_DIR, "qe-verdicts-A0.json"), JSON.stringify(verdictsA0, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT_DIR, "qe-verdicts-W.json"), JSON.stringify({ llmVerdicts: verdictsW, blockedByCheck: blockedFlags }, null, 2) + "\n");

  results.controlled_qe = {
    A0: {
      run: qeRunA0,
      submittedCount: verdictsA0.length,
      scores: {
        "es-MX": scoreControlledQe(verdictsA0, "es-MX", beforeHashesA0, afterHashesA0),
        ar: scoreControlledQe(verdictsA0, "ar", beforeHashesA0, afterHashesA0),
      },
    },
    W: {
      run: qeRunW,
      submittedCount: verdictsW.length,
      deterministicBlockedCount: blockedFlags.length,
      scores: {
        "es-MX": scoreControlledQe(combinedVerdictsW, "es-MX", beforeHashesW, afterHashesW),
        ar: scoreControlledQe(combinedVerdictsW, "ar", beforeHashesW, afterHashesW),
      },
    },
  };
  persist();
}

console.log("\n=== TRACK 1 COMPLETE ===");
console.log("Saved:", resultsPath);
