import fs from "node:fs";
import path from "node:path";
import { ESTIMATED_SPEND_CAP_USD, LIST_PRICING_PER_1M, RESULTS_DIR } from "../config.mjs";
import { atomicWriteJson } from "./cache.mjs";

const LEDGER_PATH = path.join(RESULTS_DIR, "cost-ledger.json");

export function readLedger() {
  if (!fs.existsSync(LEDGER_PATH)) {
    return {
      version: 1,
      spendCapUsd: ESTIMATED_SPEND_CAP_USD,
      entries: [],
    };
  }
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return { version: 1, spendCapUsd: ESTIMATED_SPEND_CAP_USD, entries: [] };
  }
}

export function estimateApiUsd(provider, usage = {}) {
  if (typeof usage.reportedCostUsd === "number" && Number.isFinite(usage.reportedCostUsd)) {
    return usage.reportedCostUsd;
  }
  if (provider === "deepl") {
    return (usage.chars ?? 0) * LIST_PRICING_PER_1M.deeplPerCharUsd;
  }
  const rates = LIST_PRICING_PER_1M[provider] ?? LIST_PRICING_PER_1M.codex;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedIn = Math.max(0, (usage.inputTokens ?? 0) - cached);
  const out = usage.outputTokens ?? 0;
  return (
    (uncachedIn / 1_000_000) * rates.input +
    (cached / 1_000_000) * rates.cachedInput +
    (out / 1_000_000) * rates.output
  );
}

export function summarizeLedger(ledger = readLedger()) {
  const byProvider = {};
  const byStage = {};
  let totalEstimatedApiUsd = 0;
  let totalDeepLChars = 0;
  let totalWallMs = 0;
  let cacheHits = 0;
  let liveCalls = 0;

  for (const e of ledger.entries) {
    if (e.cacheHit) cacheHits++;
    else liveCalls++;
    const usd = e.cacheHit ? 0 : (e.estimatedApiUsd ?? 0);
    const chars = e.cacheHit ? 0 : (e.chars ?? 0);
    totalEstimatedApiUsd += usd;
    totalDeepLChars += chars;
    totalWallMs += e.wallMs ?? 0;

    if (!byProvider[e.provider]) {
      byProvider[e.provider] = {
        liveCalls: 0,
        cacheHits: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        chars: 0,
        estimatedApiUsd: 0,
        wallMs: 0,
      };
    }
    const p = byProvider[e.provider];
    if (e.cacheHit) p.cacheHits++;
    else {
      p.liveCalls++;
      p.inputTokens += e.inputTokens ?? 0;
      p.cachedInputTokens += e.cachedInputTokens ?? 0;
      p.outputTokens += e.outputTokens ?? 0;
      p.chars += e.chars ?? 0;
      p.estimatedApiUsd += usd;
      p.wallMs += e.wallMs ?? 0;
    }

    if (!byStage[e.stage]) {
      byStage[e.stage] = { liveCalls: 0, cacheHits: 0, estimatedApiUsd: 0, deeplChars: 0, wallMs: 0 };
    }
    const s = byStage[e.stage];
    if (e.cacheHit) s.cacheHits++;
    else {
      s.liveCalls++;
      s.estimatedApiUsd += usd;
      s.deeplChars += e.provider === "deepl" ? (e.chars ?? 0) : 0;
      s.wallMs += e.wallMs ?? 0;
    }
  }

  return {
    totalEstimatedApiUsd: Number(totalEstimatedApiUsd.toFixed(6)),
    totalDeepLChars,
    totalWallMs,
    liveCalls,
    cacheHits,
    spendCapUsd: ledger.spendCapUsd ?? ESTIMATED_SPEND_CAP_USD,
    byProvider,
    byStage,
  };
}

export function assertWithinSpendCap({ ignoreCap = false } = {}) {
  if (ignoreCap) return;
  const summary = summarizeLedger();
  if (summary.totalEstimatedApiUsd >= summary.spendCapUsd) {
    throw new Error(
      `Estimated API-equivalent spend ($${summary.totalEstimatedApiUsd.toFixed(2)}) reached cap ($${summary.spendCapUsd.toFixed(2)}). Pass --ignore-spend-cap if running on flat-rate CLI subscriptions.`
    );
  }
}

export function recordCost(entry) {
  const ledger = readLedger();
  const estimatedApiUsd = estimateApiUsd(entry.provider, entry);
  ledger.entries.push({
    timestamp: new Date().toISOString(),
    stage: entry.stage ?? "unknown",
    provider: entry.provider,
    model: entry.model ?? null,
    label: entry.label ?? "",
    cacheHit: Boolean(entry.cacheHit),
    inputTokens: entry.inputTokens ?? 0,
    cachedInputTokens: entry.cachedInputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    chars: entry.chars ?? 0,
    estimatedApiUsd: Number(estimatedApiUsd.toFixed(6)),
    wallMs: entry.wallMs ?? 0,
  });
  atomicWriteJson(LEDGER_PATH, ledger);
  return estimatedApiUsd;
}
