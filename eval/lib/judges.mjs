import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EVAL_ROOT, JUDGE_CONFIG, LOCALE_CONVENTIONS_TEXT } from "../config.mjs";
import { getCached, setCached } from "./cache.mjs";
import { assertWithinSpendCap, recordCost } from "./cost.mjs";
import { cohensKappa, makePrng, proportionCI } from "./metrics.mjs";

const SCHEMA_PATH = path.join(EVAL_ROOT, "schemas", "judge-output.schema.json");
const JUDGE_SCHEMA_STR = fs.readFileSync(SCHEMA_PATH, "utf8");
const BATCH_SCHEMA_PATH = path.join(EVAL_ROOT, "schemas", "judge-batch-output.schema.json");
const JUDGE_BATCH_SCHEMA_STR = fs.readFileSync(BATCH_SCHEMA_PATH, "utf8");

function validateJudgeOutput(obj, expectedLabels) {
  if (!obj || typeof obj !== "object") return false;
  if (!Array.isArray(obj.candidates) || obj.candidates.length !== expectedLabels.length) return false;
  const seen = new Set();
  for (const c of obj.candidates) {
    if (!expectedLabels.includes(c.label) || seen.has(c.label)) return false;
    seen.add(c.label);
    if (!Array.isArray(c.errors)) return false;
    for (const e of c.errors) {
      if (!e || typeof e.category !== "string" || typeof e.severity !== "string") return false;
    }
  }
  if (![...expectedLabels, "tie"].includes(obj.preference)) return false;
  return true;
}

function buildJudgePrompt({ targetLocale, item, blindedCandidates }) {
  const conventions = LOCALE_CONVENTIONS_TEXT[targetLocale] ?? `Target locale: ${targetLocale}`;
  const glossarySection =
    item.glossaryHits && item.glossaryHits.length > 0
      ? item.glossaryHits
          .map((g) =>
            g.doNotTranslate
              ? `- "${g.term}": DO NOT TRANSLATE (brand/proper name)`
              : `- "${g.term}" -> "${g.expectedTranslation}"`
          )
          .join("\n")
      : "(none applicable)";

  const senseLine = item.intendedSense
    ? `Intended sense in this component: ${item.intendedSense}\nEvaluate conveysIntendedSense (true/false) for each candidate.`
    : `No special disambiguation sense label; set conveysIntendedSense to null for each candidate.`;

  const codeSnippet = item.componentCode
    ? `Component code / context:\n\`\`\`\n${item.componentCode.slice(0, 1400)}\n\`\`\``
    : `Context: ${item.context ?? "(catalog item)"}`;

  const candidateLines = blindedCandidates
    .map((c) => `Candidate ${c.label}: ${JSON.stringify(c.text)}`)
    .join("\n");

  return `You are an independent professional localization quality evaluator assessing translations from English (en) into ${targetLocale}.
Do NOT assume any candidate came from a particular system; judge strictly on quality, accuracy, context fit, placeholder/ICU/tag integrity, glossary adherence, formality register, numeric/unit accuracy, negation fidelity, and target locale conventions.

Target locale conventions:
${conventions}

Applicable glossary rules:
${glossarySection}

Key: ${item.key}
Source (en): ${JSON.stringify(item.source)}
${codeSnippet}
${senseLine}

Candidates (blinded, randomized order):
${candidateLines}

Scoring instructions:
- For each candidate, list every MQM-style error using categories: accuracy, terminology, fluency, style, locale-conventions, placeholders; severities: minor, major, critical.
- Missing/corrupted placeholders, broken ICU/plural syntax, untranslated source leakage, wrong target language, DNT/glossary violations, wrong contextual sense, missing negation, or wrong numbers/units are major or critical errors. Wrong formality register or small meaning shifts are at least minor/major errors.
- Set "preference" to the clearly best candidate label (${blindedCandidates.map((c) => c.label).join(" / ")}), or "tie" if top candidates are equivalent in quality.
- Set "worstCandidate" to the clearly weakest candidate label (or null if tied).
- Return ONLY valid JSON matching the required schema.`;
}

function runCliCommand(bin, args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill("SIGTERM");
        resolve({ exitCode: -1, stdout, stderr, wallMs: Date.now() - t0, timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, wallMs: Date.now() - t0, timedOut: false });
      }
    });
  });
}

function createSemaphore(max) {
  let active = 0;
  const queue = [];
  return async function withLimit(fn) {
    if (active >= max) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length > 0) queue.shift()();
    }
  };
}

const geminiSemaphore = createSemaphore(16);
const claudeSemaphore = createSemaphore(12);

function buildBatchJudgePrompt({ targetLocale, units }) {
  const conventions = LOCALE_CONVENTIONS_TEXT[targetLocale] ?? `Target locale: ${targetLocale}`;
  const blocks = units.map((u, i) => {
    const id = `item_${i}`;
    const item = u.item;
    const glossaryStr =
      item.glossaryHits && item.glossaryHits.length > 0
        ? item.glossaryHits
            .map((g) => (g.doNotTranslate ? `"${g.term}"=DNT` : `"${g.term}"->"${g.expectedTranslation}"`))
            .join("; ")
        : "none";
    const senseStr = item.intendedSense
      ? `Intended sense: ${item.intendedSense} (set conveysIntendedSense boolean)`
      : `conveysIntendedSense: null`;
    const ctxStr = item.componentCode
      ? `Code: ${item.componentCode.replace(/\s+/g, " ").slice(0, 320)}`
      : `Context: ${item.context ?? "(catalog)"}`;
    const cands = u.blinded.map((c) => `  ${c.label}: ${JSON.stringify(c.text)}`).join("\n");
    return `### ${id} | Key: ${item.key}
Source (en): ${JSON.stringify(item.source)}
${ctxStr}
Glossary: ${glossaryStr} | ${senseStr}
Candidates (${u.labels.join("/")}):
${cands}`;
  });

  return `You are an independent professional localization quality evaluator assessing ${units.length} translations from English (en) into ${targetLocale}.
Do NOT assume any candidate came from a particular system; judge each item independently on accuracy, context fit, placeholder/ICU/tag integrity, glossary adherence, formality register, numeric/unit accuracy, negation fidelity, and locale conventions.

Target locale conventions:
${conventions}

Scoring instructions for EACH item (return one object per item id in "results" array):
- List MQM-style errors per candidate using categories [accuracy, terminology, fluency, style, locale-conventions, placeholders] and severities [minor, major, critical].
- Missing/corrupted placeholders, broken ICU/plural syntax, untranslated leakage, wrong target language, DNT/glossary violations, wrong contextual sense, missing negation, or wrong numbers/units are major/critical errors. Wrong formality register or small meaning shifts are at least minor/major errors.
- Set "preference" to the best candidate label or "tie"; set "worstCandidate" to the weakest label or null.
- Keep "rationale" concise (1 sentence).
- Return ONLY valid JSON matching the required schema with ALL ${units.length} items (ids item_0..item_${units.length - 1}).

${blocks.join("\n\n")}`;
}

async function callBatchJudge({ judgeName, stageName, targetLocale, units, ignoreSpendCap = false }) {
  const model = judgeName === "claude" ? JUDGE_CONFIG.claude.model : JUDGE_CONFIG.gemini.model;
  const namespace = `judge-${judgeName}`;
  const resultsByIdx = new Array(units.length).fill(null);
  const uncachedPositions = [];

  // 1. Check per-item cache first so partial runs reuse 100% of cached single-item results
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const itemCacheKey = { judgeName, model, prompt: u.prompt, expectedLabels: u.labels };
    const cached = getCached(namespace, itemCacheKey);
    if (cached.hit) {
      recordCost({
        stage: stageName,
        provider: judgeName,
        model,
        label: `cache-hit`,
        cacheHit: true,
        inputTokens: cached.value.usage?.inputTokens ?? 0,
        outputTokens: cached.value.usage?.outputTokens ?? 0,
        reportedCostUsd: 0,
      });
      resultsByIdx[i] = { ...cached.value, cacheHit: true };
    } else {
      uncachedPositions.push(i);
    }
  }

  if (uncachedPositions.length === 0) return resultsByIdx;

  // 2. Run batched CLI call for uncached units
  const batchUnits = uncachedPositions.map((pos) => units[pos]);
  const batchPrompt = buildBatchJudgePrompt({ targetLocale, units: batchUnits });
  assertWithinSpendCap({ ignoreCap: ignoreSpendCap });

  const withSem = judgeName === "gemini" ? geminiSemaphore : claudeSemaphore;
  let parsedResults = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await withSem(() =>
      judgeName === "claude"
        ? runCliCommand(
            "claude",
            [
              "-p",
              "--output-format",
              "json",
              "--json-schema",
              JUDGE_BATCH_SCHEMA_STR,
              "--no-session-persistence",
              "--tools",
              "",
              "--model",
              JUDGE_CONFIG.claude.model,
              "--effort",
              JUDGE_CONFIG.claude.effort,
              batchPrompt,
            ],
            240_000
          )
        : runCliCommand(
            "agy",
            [
              "--output-format",
              "json",
              "--json-schema",
              BATCH_SCHEMA_PATH,
              "--disable-slash-commands",
              "--model",
              JUDGE_CONFIG.gemini.model,
              "-p",
              batchPrompt,
            ],
            240_000
          )
    );

    if (res.exitCode !== 0) {
      if (judgeName === "claude" && res.stdout.includes("usage_limit_reached")) {
        let msg = "Claude usage_limit_reached";
        try {
          const env = JSON.parse(res.stdout);
          if (env.result) msg = `Claude rate limit: ${env.result}`;
        } catch {}
        throw new Error(msg);
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }

    let envelope;
    try {
      envelope = JSON.parse(res.stdout);
    } catch {
      continue;
    }
    let parsed = envelope.structured_output ?? null;
    if (!parsed) {
      const rawText = envelope.result ?? envelope.response ?? "";
      try {
        parsed = JSON.parse(rawText);
      } catch {
        const m = /\{[\s\S]*\}/.exec(rawText);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {}
        }
      }
    }

    if (Array.isArray(parsed?.results)) {
      const usage =
        judgeName === "claude"
          ? {
              inputTokens:
                (envelope.usage?.input_tokens ?? 0) +
                (envelope.usage?.cache_creation_input_tokens ?? 0) +
                (envelope.usage?.cache_read_input_tokens ?? 0),
              cachedInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
              outputTokens: envelope.usage?.output_tokens ?? 0,
              reportedCostUsd: envelope.total_cost_usd,
            }
          : {
              inputTokens: envelope.usage?.input_tokens ?? 0,
              cachedInputTokens: envelope.usage?.cache_read_tokens ?? 0,
              outputTokens: envelope.usage?.output_tokens ?? 0,
            };

      const estimatedApiUsd = recordCost({
        stage: stageName,
        provider: judgeName,
        model,
        label: `judge-batch-${judgeName}(${batchUnits.length})`,
        cacheHit: false,
        ...usage,
        wallMs: res.wallMs,
      });

      parsedResults = { results: parsed.results, usage, estimatedApiUsd, wallMs: res.wallMs };
      break;
    }
  }

  // 3. Map validated batch items back & cache each individually
  if (parsedResults) {
    const byId = new Map();
    for (const r of parsedResults.results) {
      if (r && typeof r.id === "string") byId.set(r.id, r);
    }
    const perItemUsage = {
      inputTokens: Math.round((parsedResults.usage.inputTokens ?? 0) / Math.max(1, batchUnits.length)),
      cachedInputTokens: Math.round((parsedResults.usage.cachedInputTokens ?? 0) / Math.max(1, batchUnits.length)),
      outputTokens: Math.round((parsedResults.usage.outputTokens ?? 0) / Math.max(1, batchUnits.length)),
    };
    for (let bi = 0; bi < batchUnits.length; bi++) {
      const r = byId.get(`item_${bi}`);
      const origPos = uncachedPositions[bi];
      const u = units[origPos];
      if (r && validateJudgeOutput(r, u.labels)) {
        const cleanOutput = {
          candidates: r.candidates,
          preference: r.preference,
          worstCandidate: r.worstCandidate,
          rationale: r.rationale,
        };
        const value = {
          judgeName,
          model,
          output: cleanOutput,
          usage: perItemUsage,
          estimatedApiUsd: parsedResults.estimatedApiUsd / Math.max(1, batchUnits.length),
          wallMs: Math.round(parsedResults.wallMs / Math.max(1, batchUnits.length)),
          batched: true,
        };
        setCached(namespace, { judgeName, model, prompt: u.prompt, expectedLabels: u.labels }, value);
        resultsByIdx[origPos] = { ...value, cacheHit: false };
      }
    }
  }

  // 4. Fallback in parallel ONLY for any missed/invalid item
  const missingIdxs = [];
  for (let i = 0; i < units.length; i++) {
    if (!resultsByIdx[i]) missingIdxs.push(i);
  }
  if (missingIdxs.length > 0) {
    await Promise.all(
      missingIdxs.map(async (i) => {
        const u = units[i];
        resultsByIdx[i] = await callSingleJudge({
          judgeName,
          stageName,
          prompt: u.prompt,
          expectedLabels: u.labels,
          ignoreSpendCap,
        });
      })
    );
  }

  return resultsByIdx;
}

async function callSingleJudge({ judgeName, stageName, prompt, expectedLabels, ignoreSpendCap = false }) {
  const model = judgeName === "claude" ? JUDGE_CONFIG.claude.model : JUDGE_CONFIG.gemini.model;
  const cacheKey = { judgeName, model, prompt, expectedLabels };
  const namespace = `judge-${judgeName}`;

  const cached = getCached(namespace, cacheKey);
  if (cached.hit) {
    recordCost({
      stage: stageName,
      provider: judgeName,
      model,
      label: `cache-hit`,
      cacheHit: true,
      inputTokens: cached.value.usage?.inputTokens ?? 0,
      outputTokens: cached.value.usage?.outputTokens ?? 0,
      reportedCostUsd: 0,
    });
    return { ...cached.value, cacheHit: true };
  }

  assertWithinSpendCap({ ignoreCap: ignoreSpendCap });

  const withSem = judgeName === "gemini" ? geminiSemaphore : claudeSemaphore;
  let lastErr = "";
  let schemaRetries = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const effectivePrompt =
      schemaRetries === 0
        ? prompt
        : `${prompt}\n\nIMPORTANT: Your previous response did not validate against the JSON schema (${lastErr}). Return strictly valid JSON with candidate labels ${expectedLabels.join(", ")}.`;

    const res = await withSem(() =>
      judgeName === "claude"
        ? runCliCommand("claude", [
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            JUDGE_SCHEMA_STR,
            "--no-session-persistence",
            "--tools",
            "",
            "--model",
            JUDGE_CONFIG.claude.model,
            "--effort",
            JUDGE_CONFIG.claude.effort,
            effectivePrompt,
          ])
        : runCliCommand("agy", [
            "--output-format",
            "json",
            "--json-schema",
            SCHEMA_PATH,
            "--disable-slash-commands",
            "--model",
            JUDGE_CONFIG.gemini.model,
            "-p",
            effectivePrompt,
          ])
    );

    if (res.exitCode !== 0) {
      if (judgeName === "claude" && res.stdout.includes("usage_limit_reached")) {
        let msg = "Claude usage_limit_reached";
        try {
          const env = JSON.parse(res.stdout);
          if (env.result) msg = `Claude rate limit: ${env.result}`;
        } catch {}
        throw new Error(msg);
      }
      lastErr = `exit=${res.exitCode} timedOut=${res.timedOut} ${res.stderr.slice(0, 180)}`;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }

    let envelope;
    try {
      envelope = JSON.parse(res.stdout);
    } catch (e) {
      lastErr = `invalid envelope JSON: ${e.message}`;
      if (++schemaRetries > 1) break;
      continue;
    }

    let parsed = envelope.structured_output ?? null;
    if (!parsed) {
      const rawText = envelope.result ?? envelope.response ?? "";
      try {
        parsed = JSON.parse(rawText);
      } catch {
        const m = /\{[\s\S]*\}/.exec(rawText);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            parsed = null;
          }
        }
      }
    }

    if (!validateJudgeOutput(parsed, expectedLabels)) {
      lastErr = "failed judge output schema validation";
      if (++schemaRetries > 1) break;
      continue;
    }

    const usage =
      judgeName === "claude"
        ? {
            inputTokens:
              (envelope.usage?.input_tokens ?? 0) +
              (envelope.usage?.cache_creation_input_tokens ?? 0) +
              (envelope.usage?.cache_read_input_tokens ?? 0),
            cachedInputTokens: envelope.usage?.cache_read_input_tokens ?? 0,
            outputTokens: envelope.usage?.output_tokens ?? 0,
            reportedCostUsd: envelope.total_cost_usd,
          }
        : {
            inputTokens: envelope.usage?.input_tokens ?? 0,
            cachedInputTokens: envelope.usage?.cache_read_tokens ?? 0,
            outputTokens: envelope.usage?.output_tokens ?? 0,
          };

    const estimatedApiUsd = recordCost({
      stage: stageName,
      provider: judgeName,
      model,
      label: `judge-${judgeName}`,
      cacheHit: false,
      ...usage,
      wallMs: res.wallMs,
    });

    const value = {
      judgeName,
      model,
      output: parsed,
      usage,
      estimatedApiUsd,
      wallMs: res.wallMs,
      retries: attempt,
    };
    setCached(namespace, cacheKey, value);
    return { ...value, cacheHit: false };
  }

  throw new Error(`Judge "${judgeName}" failed after retry: ${lastErr}`);
}

/**
 * 9 planted corruption types (5 obvious + 4 subtle per Change #6):
 * Obvious: dropped_placeholder, wrong_sense, glossary_dnt_violation, wrong_language, truncated_meaning
 * Subtle:  wrong_formality, small_meaning_shift, wrong_number_or_unit, missing_negation
 */
export const OBVIOUS_CORRUPTIONS = [
  "dropped_placeholder",
  "wrong_sense",
  "glossary_dnt_violation",
  "wrong_language",
  "truncated_meaning",
];

export const SUBTLE_CORRUPTIONS = [
  "wrong_formality",
  "small_meaning_shift",
  "wrong_number_or_unit",
  "missing_negation",
];

export const ALL_CORRUPTIONS = [...OBVIOUS_CORRUPTIONS, ...SUBTLE_CORRUPTIONS];

export function generatePlantedCorruption(item, cleanTranslation, targetLocale, corruptionType) {
  const clean = String(cleanTranslation ?? "");
  switch (corruptionType) {
    case "dropped_placeholder": {
      const phMatch = /(\{[^}]+\}|%\{[^}]+\}|%\([^)]+\)[a-zA-Z]|#)/.exec(clean);
      if (phMatch) {
        return {
          type: "dropped_placeholder",
          corrupted: clean.replace(phMatch[0], "").replace(/\s+/g, " ").trim(),
        };
      }
      return { type: "dropped_placeholder", corrupted: `${clean} {missingVar` };
    }
    case "wrong_sense": {
      const wrongMap = {
        de: "Geschlossener Briefumschlag",
        "es-MX": "Sobre cerrado de papel",
        ja: "閉じた封筒",
        ar: "مظروف ورقي مغلق",
        pl: "Zamknięta koperta",
      };
      return { type: "wrong_sense", corrupted: wrongMap[targetLocale] ?? "Unrelated literal sense" };
    }
    case "glossary_dnt_violation": {
      const dnt = (item.glossaryHits ?? []).find((g) => g.doNotTranslate);
      if (dnt && clean.includes(dnt.term)) {
        const bad = targetLocale === "de" ? "NordStern" : targetLocale === "es-MX" ? "EstrellaNorte" : "BrandX";
        return { type: "glossary_dnt_violation", corrupted: clean.replaceAll(dnt.term, bad) };
      }
      const term = (item.glossaryHits ?? []).find((g) => g.expectedTranslation);
      if (term) {
        return {
          type: "glossary_dnt_violation",
          corrupted: clean.replace(new RegExp(term.expectedTranslation, "i"), "Widget-Box"),
        };
      }
      return { type: "glossary_dnt_violation", corrupted: `${clean} (WrongBrandName)` };
    }
    case "wrong_language": {
      return {
        type: "wrong_language",
        corrupted: targetLocale.startsWith("fr")
          ? "Benvenuto nel nostro negozio online."
          : "Bienvenue dans notre boutique en ligne aujourd'hui.",
      };
    }
    case "truncated_meaning": {
      const words = clean.split(/\s+/);
      const half = Math.max(1, Math.floor(words.length / 2));
      const cut = words.slice(0, half).join(" ");
      return {
        type: "truncated_meaning",
        corrupted: cut.length < clean.length ? `${cut}...` : clean.slice(0, Math.max(2, Math.floor(clean.length / 2))),
      };
    }
    // === 4 Subtle Corruptions (Change #6) ===
    case "wrong_formality": {
      // Deliberately flip register (polite <-> casual / Spain vosotros in es-MX)
      if (targetLocale === "de") {
        let c = clean
          .replace(/\bSie\b/g, "du")
          .replace(/\bIhnen\b/g, "dir")
          .replace(/\bIhr(e|en|er|es|em)?\b/g, "dein$1")
          .replace(/\bBitte überprüfen Sie\b/gi, "Bitte prüf");
        if (c === clean) c = `Hey, schau dir das mal an: ${clean}`;
        return { type: "wrong_formality", corrupted: c };
      }
      if (targetLocale === "es-MX") {
        let c = clean
          .replace(/\btu\b/gi, "vuestro")
          .replace(/\btus\b/gi, "vuestros")
          .replace(/\bpuedes\b/gi, "podéis")
          .replace(/\bestás\b/gi, "estáis");
        if (c === clean) c = `Vosotros podéis revisar esto: ${clean}`;
        return { type: "wrong_formality", corrupted: c };
      }
      if (targetLocale === "ja") {
        let c = clean.replace(/ます。?$/, "る。").replace(/ください。?$/, "くれ。").replace(/です。?$/, "だ。");
        if (c === clean) c = `${clean}ぞ`;
        return { type: "wrong_formality", corrupted: c };
      }
      if (targetLocale === "pl") {
        let c = clean.replace(/\bProszę\b/gi, "Ej, weź").replace(/\bPaństwa\b/gi, "twoje");
        if (c === clean) c = `Ej, sprawdź to: ${clean}`;
        return { type: "wrong_formality", corrupted: c };
      }
      return { type: "wrong_formality", corrupted: `يا صاحبي، ${clean}` };
    }
    case "small_meaning_shift": {
      // Subtly shift temporal/modal meaning (before->after, same day->next week, monthly->weekly, all->some)
      const shifts = [
        [/\bvor\b/i, "nach"],
        [/\bantes\b/i, "después"],
        [/\bmonatlich/i, "wöchentlich"],
        [/\bmensual/i, "semanal"],
        [/\balle\b/i, "einige"],
        [/\btodos\b/i, "algunos"],
        [/\bam selben Tag\b/i, "nächste Woche"],
        [/\bel mismo día\b/i, "la próxima semana"],
        [/\b当日\b/, "翌週"],
        [/\b毎月\b/, "毎週"],
        [/\btego samego dnia\b/i, "w przyszłym tygodniu"],
        [/\bmiesięczn/i, "tygodniow"],
        [/\bشهري/, "أسبوعي"],
      ];
      for (const [re, rep] of shifts) {
        if (re.test(clean)) return { type: "small_meaning_shift", corrupted: clean.replace(re, rep) };
      }
      const suffix = {
        de: " (nur optional am Wochenende)",
        "es-MX": " (solo opcional los fines de semana)",
        ja: "（週末のみ任意）",
        ar: " (اختياري في عطلة نهاية الأسبوع فقط)",
        pl: " (opcjonalnie tylko w weekendy)",
      };
      return { type: "small_meaning_shift", corrupted: clean + (suffix[targetLocale] ?? " (optional only on weekends)") };
    }
    case "wrong_number_or_unit": {
      // Shift an explicit digit or time/duration unit
      if (/\b24\s*(h|Std|Stunden|horas|godz|ساعة|時間)/i.test(clean)) {
        return { type: "wrong_number_or_unit", corrupted: clean.replace(/\b24\b/, "12") };
      }
      if (/\b20\s*%/.test(clean)) {
        return { type: "wrong_number_or_unit", corrupted: clean.replace(/\b20\b/, "10") };
      }
      if (/\b(15:00|3:00)\b/.test(clean)) {
        return { type: "wrong_number_or_unit", corrupted: clean.replace(/\b(15:00|3:00)\b/, "17:00") };
      }
      const numMatch = /\b(\d+)\b/.exec(clean);
      if (numMatch) {
        const shifted = String(Number(numMatch[1]) + 3);
        return { type: "wrong_number_or_unit", corrupted: clean.replace(numMatch[0], shifted) };
      }
      const wordNums = [
        [/\bzwei Jahre\b/i, "fünf Jahre"],
        [/\bdos años\b/i, "cinco años"],
        [/\bvierzehn\b/i, "dreißig"],
        [/\b2年間\b/, "5年間"],
        [/\bdwa lata\b/i, "pięć lat"],
        [/\bعامين\b/, "خمس سنوات"],
      ];
      for (const [re, rep] of wordNums) {
        if (re.test(clean)) return { type: "wrong_number_or_unit", corrupted: clean.replace(re, rep) };
      }
      const fallback = {
        de: `${clean} (gültig für 7 Monate)`,
        "es-MX": `${clean} (válido por 7 meses)`,
        ja: `${clean}（7か月間有効）`,
        ar: `${clean} (صالح لمدة 7 أشهر)`,
        pl: `${clean} (ważne przez 7 miesięcy)`,
      };
      return { type: "wrong_number_or_unit", corrupted: fallback[targetLocale] ?? `${clean} (7 months)` };
    }
    case "missing_negation": {
      // Remove negation word so the sentence asserts the opposite
      const negPatterns = [
        [/\bnicht\s+/i, ""],
        [/\bohne\s+/i, "mit "],
        [/\bkeine?\s+/i, "alle "],
        [/\bno\s+(se\s+puede|pudimos|hay)\b/i, "$1"],
        [/\bsin\s+/i, "con "],
        [/\bno\s+/i, ""],
        [/\bnie\s+/i, ""],
        [/\bbez\s+/i, "z "],
        [/できません/, "できます"],
        [/なしで/, "付きで"],
        [/ません/, "ます"],
        [/لا\s+يمكن/, "يمكن"],
        [/بدون\s+/, "مع "],
      ];
      for (const [re, rep] of negPatterns) {
        if (re.test(clean)) return { type: "missing_negation", corrupted: clean.replace(re, rep) };
      }
      const flip = {
        de: `Nicht: ${clean}`,
        "es-MX": `No: ${clean}`,
        ja: `不要：${clean}`,
        ar: `لا: ${clean}`,
        pl: `Nie: ${clean}`,
      };
      return { type: "missing_negation", corrupted: flip[targetLocale] ?? `Not: ${clean}` };
    }
    default:
      return { type: "truncated_meaning", corrupted: clean.slice(0, 3) };
  }
}

async function runPool(items, concurrency, workerFn, onProgress = null) {
  const results = new Array(items.length);
  let nextIdx = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await workerFn(items[idx], idx);
      completed++;
      if (onProgress && (completed % 25 === 0 || completed === items.length)) {
        onProgress(completed, items.length);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function summarizeSubset(rows, sysList, judges) {
  const n = rows.length;
  const panelWins = { tie: 0 };
  for (const s of sysList) panelWins[s] = 0;
  const indicators = Object.fromEntries(sysList.map((s) => [s, []]));
  const mqm = Object.fromEntries(
    sysList.map((s) => [s, { minor: 0, major: 0, critical: 0, total: 0, byCategory: {} }])
  );
  const sense = Object.fromEntries(sysList.map((s) => [s, []]));

  for (const row of rows) {
    const pv = row.panelVerdict ?? "tie";
    panelWins[pv] = (panelWins[pv] ?? 0) + 1;
    for (const s of sysList) {
      indicators[s].push(pv === s ? 1 : 0);
      for (const j of judges) {
        const o1 = row.judges[j]?.order1;
        const o2 = row.judges[j]?.order2;
        if (!o1 || !o2) continue;
        for (const e of [...(o1.bySys[s]?.errors ?? []), ...(o2.bySys[s]?.errors ?? [])]) {
          mqm[s][e.severity] = (mqm[s][e.severity] ?? 0) + 0.25;
          mqm[s].total += 0.25;
          mqm[s].byCategory[e.category] = (mqm[s].byCategory[e.category] ?? 0) + 0.25;
        }
        if (row.intendedSense) {
          const s1 = o1.bySys[s]?.conveysIntendedSense;
          const s2 = o2.bySys[s]?.conveysIntendedSense;
          if (typeof s1 === "boolean" && typeof s2 === "boolean") {
            sense[s].push(s1 && s2 ? 1 : 0);
          }
        }
      }
    }
  }

  const denom = Math.max(1, n);
  const mqmPer100 = {};
  const winRateCI = {};
  const senseAccuracy = {};
  for (const s of sysList) {
    winRateCI[s] = proportionCI(indicators[s]);
    mqmPer100[s] = {
      totalPer100: Number(((mqm[s].total / denom) * 100).toFixed(2)),
      minorPer100: Number(((mqm[s].minor / denom) * 100).toFixed(2)),
      majorPer100: Number(((mqm[s].major / denom) * 100).toFixed(2)),
      criticalPer100: Number(((mqm[s].critical / denom) * 100).toFixed(2)),
      byCategoryPer100: Object.fromEntries(
        Object.entries(mqm[s].byCategory).map(([cat, v]) => [cat, Number(((v / denom) * 100).toFixed(2))])
      ),
    };
    if (sense[s].length > 0) {
      senseAccuracy[s] = proportionCI(sense[s]);
    }
  }
  return { count: n, panelWins, winRateCI, mqmPer100, senseAccuracy };
}

/**
 * Dual blinded, position-swapped judge evaluation supporting 2-4 systems (e.g. A, A0, B, Bctx or A, A0, B, H),
 * 9 planted corruption controls (5 obvious + 4 subtle), Wilson 95% CIs, and challenge vs non-challenge split.
 */
export async function runDualJudgeEvaluation({
  stageName,
  targetLocale,
  items, // [{ key, source, isChallenge?, category?, componentCode?, context?, glossaryHits?, intendedSense?, candidates: { A, A0?, B, Bctx?, H? } }]
  concurrency = 8,
  seed = 2026,
  ignoreSpendCap = false,
  includeSubtleControls = true,
  lowConfidenceNote = null,
  judgeMode = "all", // "all" | "gemini" | "none"
}) {
  if (judgeMode === "none") return null;
  const rng = makePrng(seed);
  const judges = judgeMode === "gemini" ? ["gemini"] : ["claude", "gemini"];
  const allSysIds = [
    ...new Set(items.flatMap((it) => Object.keys(it.candidates).filter((k) => it.candidates[k] !== undefined))),
  ];

  const LABELS_BY_N = {
    2: ["X", "Y"],
    3: ["X", "Y", "Z"],
    4: ["X", "Y", "Z", "W"],
  };

  const compareTasks = items.map((item) => {
    const sysIds = Object.keys(item.candidates).filter((k) => item.candidates[k] !== undefined);
    const order1Sys = [...sysIds];
    for (let i = order1Sys.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order1Sys[i], order1Sys[j]] = [order1Sys[j], order1Sys[i]];
    }
    const order2Sys = [...order1Sys].reverse();
    const labels = LABELS_BY_N[order1Sys.length] ?? ["X", "Y"];
    return { item, labels, order1Sys, order2Sys };
  });

  // Select planted controls (~10% of items, at least 9 when includeSubtleControls so every corruption type is tested)
  const activeCorruptions = includeSubtleControls ? ALL_CORRUPTIONS : OBVIOUS_CORRUPTIONS;
  const controlCount = Math.min(items.length, Math.max(activeCorruptions.length, Math.ceil(items.length * 0.1)));
  const controlTasks = [];
  for (let i = 0; i < controlCount; i++) {
    const cType = activeCorruptions[i % activeCorruptions.length];
    let picked = items[Math.floor((i * items.length) / controlCount)];
    if (cType === "dropped_placeholder") {
      picked = items.find((it) => /(\{[^}]+\}|%\{[^}]+\}|%\([^)]+\)[a-zA-Z]|#)/.test(it.candidates.A ?? "")) ?? picked;
    } else if (cType === "glossary_dnt_violation") {
      picked = items.find((it) => (it.glossaryHits?.length ?? 0) > 0) ?? picked;
    } else if (cType === "wrong_sense") {
      picked = items.find((it) => Boolean(it.intendedSense)) ?? picked;
    } else if (cType === "missing_negation") {
      picked = items.find((it) => /\b(not|cannot|without|no|never)\b/i.test(it.source)) ?? picked;
    } else if (cType === "wrong_number_or_unit") {
      picked = items.find((it) => /\b(\d+|two|fourteen|ninety|seven|four)\b/i.test(it.source)) ?? picked;
    } else if (cType === "wrong_formality") {
      picked = items.find((it) => /\b(you|your|please)\b/i.test(it.source)) ?? picked;
    } else if (cType === "small_meaning_shift") {
      picked = items.find((it) => /\b(before|same day|monthly|every|all)\b/i.test(it.source)) ?? picked;
    }

    const cleanText = picked.candidates.A ?? picked.candidates.H ?? picked.candidates.B ?? "";
    const { corrupted } = generatePlantedCorruption(picked, cleanText, targetLocale, cType);
    const swapOrder = i % 2 === 1;
    controlTasks.push({
      corruptionType: cType,
      isSubtle: SUBTLE_CORRUPTIONS.includes(cType),
      item: picked,
      cleanText,
      corruptedText: corrupted,
      orderSys: swapOrder ? ["CORRUPT", "CLEAN"] : ["CLEAN", "CORRUPT"],
    });
  }

  const callUnits = [];
  for (let idx = 0; idx < compareTasks.length; idx++) {
    const task = compareTasks[idx];
    for (const judgeName of judges) {
      for (const orderIdx of [0, 1]) {
        const orderSys = orderIdx === 0 ? task.order1Sys : task.order2Sys;
        const blinded = orderSys.map((sys, k) => ({ label: task.labels[k], sys, text: task.item.candidates[sys] }));
        callUnits.push({
          kind: "compare",
          taskIdx: idx,
          judgeName,
          orderIdx,
          item: task.item,
          labels: task.labels,
          blinded,
          prompt: buildJudgePrompt({ targetLocale, item: task.item, blindedCandidates: blinded }),
        });
      }
    }
  }
  for (let idx = 0; idx < controlTasks.length; idx++) {
    const ct = controlTasks[idx];
    for (const judgeName of judges) {
      const blinded = ct.orderSys.map((sys, k) => ({
        label: k === 0 ? "X" : "Y",
        sys,
        text: sys === "CLEAN" ? ct.cleanText : ct.corruptedText,
      }));
      callUnits.push({
        kind: "control",
        controlIdx: idx,
        judgeName,
        orderIdx: 0,
        item: ct.item,
        labels: ["X", "Y"],
        blinded,
        prompt: buildJudgePrompt({ targetLocale, item: ct.item, blindedCandidates: blinded }),
      });
    }
  }

  // Group into batches (6 for Gemini to stay well under timeout with thinking tokens, 12 for Claude)
  // by (judgeName, kind, orderIdx) so order1 & order2 are ALWAYS separate blinded calls!
  const groups = new Map();
  for (const u of callUnits) {
    const gKey = `${u.judgeName}|${u.kind}|${u.orderIdx}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(u);
  }
  const batchJobs = [];
  for (const [, units] of groups) {
    const bSize = units[0].judgeName === "gemini" ? 6 : 12;
    for (let s = 0; s < units.length; s += bSize) {
      batchJobs.push({ judgeName: units[s].judgeName, units: units.slice(s, s + bSize) });
    }
  }

  const batchOutputs = await runPool(
    batchJobs,
    22,
    async (job) => {
      const results = await callBatchJudge({
        judgeName: job.judgeName,
        stageName,
        targetLocale,
        units: job.units,
        ignoreSpendCap,
      });
      return job.units.map((u, i) => ({ unit: u, res: results[i] }));
    },
    (done, total) => console.log(`  [judges-batch ${stageName}:${targetLocale}] ${done}/${total} batches complete`)
  );
  const callResults = batchOutputs.flat();

  const perItem = compareTasks.map((t) => ({
    key: t.item.key,
    source: t.item.source,
    category: t.item.category ?? null,
    isChallenge: Boolean(t.item.isChallenge ?? (t.item.category && t.item.category !== "general")),
    intendedSense: t.item.intendedSense ?? null,
    candidates: t.item.candidates,
    judges: { claude: {}, gemini: {} },
  }));

  const mapLabelToSys = (blinded, label) => {
    if (!label || label === "tie") return label;
    const found = blinded.find((b) => b.label === label);
    return found ? found.sys : label;
  };

  for (const { unit, res } of callResults) {
    if (unit.kind !== "compare") continue;
    const slot = perItem[unit.taskIdx].judges[unit.judgeName];
    const prefSys = mapLabelToSys(unit.blinded, res.output.preference);
    const worstSys = mapLabelToSys(unit.blinded, res.output.worstCandidate);
    const bySys = {};
    for (const c of res.output.candidates) {
      const sys = mapLabelToSys(unit.blinded, c.label);
      bySys[sys] = { errors: c.errors, conveysIntendedSense: c.conveysIntendedSense };
    }
    slot[unit.orderIdx === 0 ? "order1" : "order2"] = {
      preference: prefSys,
      worstCandidate: worstSys,
      bySys,
      rationale: res.output.rationale,
    };
  }

  const judgeStats = {};
  const verdictLists = { claude: [], gemini: [] };
  const humanLastCounts = { claude: { last: 0, total: 0 }, gemini: { last: 0, total: 0 } };

  for (const j of judges) {
    let flips = 0;
    let total = 0;
    const wins = { tie: 0 };
    for (const s of allSysIds) wins[s] = 0;
    const ind = Object.fromEntries(allSysIds.map((s) => [s, []]));

    for (const row of perItem) {
      const o1 = row.judges[j].order1;
      const o2 = row.judges[j].order2;
      if (!o1 || !o2) continue;
      total++;
      const agreed = o1.preference === o2.preference;
      if (!agreed) flips++;
      const finalVerdict = agreed ? o1.preference : "tie";
      row.judges[j].finalVerdict = finalVerdict;
      row.judges[j].flipped = !agreed;
      verdictLists[j].push(finalVerdict);

      wins[finalVerdict] = (wins[finalVerdict] ?? 0) + 1;
      for (const s of allSysIds) ind[s].push(finalVerdict === s ? 1 : 0);

      if (row.candidates.H !== undefined) {
        humanLastCounts[j].total++;
        if (o1.worstCandidate === "H" && o2.worstCandidate === "H") {
          humanLastCounts[j].last++;
        }
      }
    }

    judgeStats[j] = {
      totalItems: total,
      flips,
      flipRate: total > 0 ? Number((flips / total).toFixed(4)) : 0,
      wins,
      winRateCI: Object.fromEntries(allSysIds.map((s) => [s, proportionCI(ind[s])])),
      humanRankedLastRate:
        humanLastCounts[j].total > 0
          ? Number((humanLastCounts[j].last / humanLastCounts[j].total).toFixed(4))
          : null,
    };
  }

  for (let i = 0; i < perItem.length; i++) {
    if (judges.length === 1) {
      perItem[i].panelVerdict = verdictLists[judges[0]][i] ?? "tie";
    } else {
      const vc = verdictLists.claude[i] ?? "tie";
      const vg = verdictLists.gemini[i] ?? "tie";
      perItem[i].panelVerdict = vc === vg ? vc : "tie";
    }
  }

  // Overall, Challenge-only, and Non-Challenge breakdowns (Change #3)
  const overallSummary = summarizeSubset(perItem, allSysIds, judges);
  const challengeRows = perItem.filter((r) => r.isChallenge);
  const nonChallengeRows = perItem.filter((r) => !r.isChallenge);
  const challengeSummary = challengeRows.length > 0 ? summarizeSubset(challengeRows, allSysIds, judges) : null;
  const nonChallengeSummary = nonChallengeRows.length > 0 ? summarizeSubset(nonChallengeRows, allSysIds, judges) : null;

  // Controls aggregation (all 9 types: 5 obvious + 4 subtle)
  const controls = {
    claude: { total: 0, detected: 0, obvious: { detected: 0, total: 0 }, subtle: { detected: 0, total: 0 }, byType: {} },
    gemini: { total: 0, detected: 0, obvious: { detected: 0, total: 0 }, subtle: { detected: 0, total: 0 }, byType: {} },
  };
  const controlDetails = [];

  for (const { unit, res } of callResults) {
    if (unit.kind !== "control") continue;
    const ct = controlTasks[unit.controlIdx];
    const prefSys = mapLabelToSys(unit.blinded, res.output.preference);
    const corruptLabel = unit.blinded.find((b) => b.sys === "CORRUPT").label;
    const corruptCand = res.output.candidates.find((c) => c.label === corruptLabel);
    const flaggedError = (corruptCand?.errors ?? []).some(
      (e) => e.severity === "major" || e.severity === "critical" || (ct.isSubtle && e.severity === "minor")
    );
    const detected = prefSys === "CLEAN" || flaggedError;

    const bucket = controls[unit.judgeName];
    bucket.total++;
    if (detected) bucket.detected++;
    const tier = ct.isSubtle ? bucket.subtle : bucket.obvious;
    tier.total++;
    if (detected) tier.detected++;
    if (!bucket.byType[ct.corruptionType]) bucket.byType[ct.corruptionType] = { detected: 0, total: 0, subtle: ct.isSubtle };
    bucket.byType[ct.corruptionType].total++;
    if (detected) bucket.byType[ct.corruptionType].detected++;

    controlDetails.push({
      judge: unit.judgeName,
      key: ct.item.key,
      corruptionType: ct.corruptionType,
      isSubtle: ct.isSubtle,
      detected,
      preference: prefSys,
      corruptErrors: corruptCand?.errors ?? [],
    });
  }

  for (const j of judges) {
    controls[j].detectionRate = controls[j].total > 0 ? Number((controls[j].detected / controls[j].total).toFixed(4)) : 0;
    controls[j].obviousRate = controls[j].obvious.total > 0 ? Number((controls[j].obvious.detected / controls[j].obvious.total).toFixed(4)) : 0;
    controls[j].subtleRate = controls[j].subtle.total > 0 ? Number((controls[j].subtle.detected / controls[j].subtle.total).toFixed(4)) : 0;
  }

  const kappa = judges.length === 2 ? cohensKappa(verdictLists.claude, verdictLists.gemini) : { kappa: null, observedAgreement: null, expectedAgreement: null, n: 0 };
  const humanReliable =
    (judgeStats.claude?.humanRankedLastRate ?? 0) <= 0.4 &&
    (judgeStats.gemini?.humanRankedLastRate ?? 0) <= 0.4;

  return {
    targetLocale,
    systems: allSysIds,
    itemCount: perItem.length,
    lowConfidenceNote,
    partialJudgeMode: judgeMode !== "all" ? judgeMode : null,
    validation: {
      controls,
      controlDetails,
      agreement: kappa,
      flipRates: {
        claude: judgeStats.claude?.flipRate ?? null,
        gemini: judgeStats.gemini?.flipRate ?? null,
      },
      humanAnchorLastRate: {
        claude: judgeStats.claude?.humanRankedLastRate ?? null,
        gemini: judgeStats.gemini?.humanRankedLastRate ?? null,
      },
      humanAnchorReliable: humanReliable,
    },
    judgeStats,
    panel: {
      wins: overallSummary.panelWins,
      winRateCI: overallSummary.winRateCI,
    },
    mqmPer100: overallSummary.mqmPer100,
    senseAccuracy: overallSummary.senseAccuracy,
    bySubset: {
      challenge: challengeSummary,
      nonChallenge: nonChallengeSummary,
    },
    items: perItem,
  };
}
