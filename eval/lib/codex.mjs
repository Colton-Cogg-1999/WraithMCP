import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_CONFIG, POLYGLOT_BIN } from "../config.mjs";
import { contentHash, getCached, setCached, sha256Buffer } from "./cache.mjs";
import { assertWithinSpendCap, recordCost } from "./cost.mjs";

function snapshotDirFiles(dir, ignoreDirs = new Set(["node_modules", ".next", ".git", ".nuxt", "__pycache__"])) {
  const files = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoreDirs.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files[rel] = sha256Buffer(fs.readFileSync(abs));
    }
  };
  walk(dir);
  return files;
}

function copyDirRecursive(src, dst, ignoreDirs = new Set(["node_modules", ".next", ".git"])) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (ignoreDirs.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d, ignoreDirs);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function collectFilesBase64(dir, relPaths) {
  const out = {};
  for (const rel of relPaths) {
    const abs = path.join(dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      out[rel] = fs.readFileSync(abs).toString("base64");
    }
  }
  return out;
}

/**
 * Parse Codex JSONL events with full Change #5 instrumentation:
 * - model turns (`turn.completed` count)
 * - uncached input tokens (`inputTokens - cachedInputTokens`)
 * - per-call MCP response size (bytes & approx tokens = ceil(bytes/4)) for every Polyglot tool
 */
function parseCodexJsonl(rawJsonl) {
  const events = rawJsonl
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let modelTurns = 0;
  const toolCalls = [];
  const mcpTotalsByTool = {};
  let totalMcpResponseBytes = 0;
  let checkIterations = 0;
  let applyCalls = 0;
  let prepareCalls = 0;
  let lastMessage = "";
  const errors = [];

  for (const ev of events) {
    if (ev.type === "turn.completed") {
      modelTurns++;
      if (ev.usage) {
        inputTokens += ev.usage.input_tokens ?? 0;
        cachedInputTokens += ev.usage.cached_input_tokens ?? 0;
        outputTokens += ev.usage.output_tokens ?? 0;
        reasoningTokens += ev.usage.reasoning_output_tokens ?? 0;
      }
    }
    if (ev.type === "item.completed" && ev.item) {
      if (ev.item.type === "mcp_tool_call") {
        // Compute response payload bytes across content text / structured_content
        let payloadText = "";
        if (Array.isArray(ev.item.result?.content)) {
          payloadText = ev.item.result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
        } else if (ev.item.result) {
          payloadText = JSON.stringify(ev.item.result);
        } else if (ev.item.error) {
          payloadText = JSON.stringify(ev.item.error);
        }
        const responseBytes = Buffer.byteLength(payloadText, "utf8");
        const approxResponseTokens = Math.ceil(responseBytes / 4);
        totalMcpResponseBytes += responseBytes;

        const toolName = ev.item.tool ?? "unknown";
        if (!mcpTotalsByTool[toolName]) {
          mcpTotalsByTool[toolName] = { calls: 0, totalBytes: 0, totalApproxTokens: 0 };
        }
        mcpTotalsByTool[toolName].calls++;
        mcpTotalsByTool[toolName].totalBytes += responseBytes;
        mcpTotalsByTool[toolName].totalApproxTokens += approxResponseTokens;

        toolCalls.push({
          server: ev.item.server,
          tool: toolName,
          status: ev.item.status,
          error: ev.item.error?.message ?? null,
          responseBytes,
          approxResponseTokens,
        });
        if (toolName === "check") checkIterations++;
        if (toolName === "apply") applyCalls++;
        if (toolName === "prepare") prepareCalls++;
      } else if (ev.item.type === "agent_message" && ev.item.text) {
        lastMessage = ev.item.text;
      }
    }
    if (ev.type === "error") {
      errors.push(ev.message ?? JSON.stringify(ev));
    }
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);

  return {
    modelTurns,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalMcpResponseBytes,
    totalMcpApproxTokens: Math.ceil(totalMcpResponseBytes / 4),
    mcpTotalsByTool,
    toolCalls,
    checkIterations,
    applyCalls,
    prepareCalls,
    lastMessage,
    errors,
  };
}

/**
 * Shared runner for System A (Codex + Polyglot MCP) and System A0 (Codex with NO Polyglot MCP).
 */
async function runCodexBase({
  mode, // "A" | "A0" | "A-compact"
  stageName,
  label,
  sourceDir,
  prompt,
  captureRelPaths = [],
  approvalFlags = CODEX_CONFIG.approvalFlags,
  timeoutMs = 600_000,
  ignoreSpendCap = false,
  workspaceSetupFn = null,
}) {
  const usePolyglotMcp = mode !== "A0";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pg-eval-${mode.toLowerCase()}-`));
  try {
    copyDirRecursive(sourceDir, tmpDir);
    if (workspaceSetupFn) {
      await workspaceSetupFn(tmpDir);
    }

    const inputSnapshot = snapshotDirFiles(tmpDir);
    const cacheKey = {
      op: `codex-${mode}-v2`,
      model: CODEX_CONFIG.model,
      reasoningEffort: CODEX_CONFIG.reasoningEffort,
      approvalFlags,
      usePolyglotMcp,
      polyglotBinHash: usePolyglotMcp ? sha256Buffer(fs.readFileSync(POLYGLOT_BIN)) : null,
      inputSnapshot,
      prompt,
      captureRelPaths: [...captureRelPaths].sort(),
    };

    const cached = getCached("codex", cacheKey);
    if (cached.hit) {
      recordCost({
        stage: stageName,
        provider: "codex",
        model: CODEX_CONFIG.model,
        label: `${mode}:${label}`,
        cacheHit: true,
        inputTokens: cached.value.telemetry.inputTokens,
        cachedInputTokens: cached.value.telemetry.cachedInputTokens,
        outputTokens: cached.value.telemetry.outputTokens,
        wallMs: 0,
      });
      return { ...cached.value, cacheHit: true };
    }

    assertWithinSpendCap({ ignoreCap: ignoreSpendCap });

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      "-C",
      tmpDir,
      ...approvalFlags,
    ];
    if (usePolyglotMcp) {
      args.push(
        "-c",
        `mcp_servers.polyglot.command="${POLYGLOT_BIN}"`,
        "-c",
        'mcp_servers.polyglot.args=["mcp"]'
      );
    }
    args.push(prompt);

    const t0 = Date.now();
    const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
      const child = spawn("codex", args, {
        cwd: tmpDir,
        stdio: ["ignore", "pipe", "pipe"],
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

      child.stdout.on("data", (d) => (out += d.toString("utf8")));
      child.stderr.on("data", (d) => (err += d.toString("utf8")));
      child.on("close", (code) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout: out, stderr: err, timedOut: false });
        }
      });
    });
    const wallMs = Date.now() - t0;

    const telemetry = parseCodexJsonl(stdout);
    const capturedFiles = collectFilesBase64(tmpDir, captureRelPaths);

    const afterSnapshot = snapshotDirFiles(tmpDir);
    const changedRelPaths = Object.keys(afterSnapshot).filter(
      (k) => afterSnapshot[k] !== inputSnapshot[k]
    );
    for (const rel of changedRelPaths) {
      if (capturedFiles[rel] === undefined && !rel.endsWith(".png") && !rel.endsWith(".pdf")) {
        const abs = path.join(tmpDir, rel);
        if (fs.statSync(abs).size <= 5 * 1024 * 1024) {
          capturedFiles[rel] = fs.readFileSync(abs).toString("base64");
        }
      }
    }

    const estimatedApiUsd = recordCost({
      stage: stageName,
      provider: "codex",
      model: CODEX_CONFIG.model,
      label: `${mode}:${label}`,
      cacheHit: false,
      inputTokens: telemetry.inputTokens,
      cachedInputTokens: telemetry.cachedInputTokens,
      outputTokens: telemetry.outputTokens,
      wallMs,
    });

    const result = {
      mode,
      label,
      exitCode,
      timedOut,
      wallMs,
      approvalFlags,
      model: CODEX_CONFIG.model,
      estimatedApiUsd,
      telemetry,
      changedRelPaths,
      capturedFiles,
      stderrPreview: stderr.slice(0, 1500),
      hash: contentHash(cacheKey),
    };

    if (!timedOut && exitCode === 0) {
      setCached("codex", cacheKey, result, { mode, label, stageName });
    }
    return { ...result, cacheHit: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function runCodexWithPolyglot(opts) {
  return runCodexBase({ ...opts, mode: opts.mode ?? "A" });
}

export async function runCodexNoPolyglot(opts) {
  return runCodexBase({ ...opts, mode: "A0" });
}

export function materializeCapturedFiles(result, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const [rel, b64] of Object.entries(result.capturedFiles ?? {})) {
    const abs = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, "base64"));
  }
}
