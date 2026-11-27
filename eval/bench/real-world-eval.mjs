#!/usr/bin/env node
/**
 * Independent Evaluation, Blinded Claude Opus MQM Judge & Mastodon Storybook Playwright Visual QA
 * for the Real-World Production Stress-Test (eval/results/real-world-v2/).
 *
 * Subcommands:
 *   node eval/bench/real-world-eval.mjs validate   # Independent deterministic validation on all 14,660 Mastodon translations
 *   node eval/bench/real-world-eval.mjs judge      # Blinded Claude Opus MQM on stratified 200/lang sample + 100% QE diffs + 3 real DOCX
 *   node eval/bench/real-world-eval.mjs visual     # Playwright + Mastodon Storybook + MSW visual QA (Desktop, Mobile, RTL)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const MASTODON_SRC = path.join(EVAL_ROOT, "corpora", "mastodon");
const RESULTS_ROOT = path.join(EVAL_ROOT, "results", "real-world-v2");
const MASTODON_RES = path.join(RESULTS_ROOT, "mastodon");
const DOCS_RES = path.join(RESULTS_ROOT, "docs");
const SCREENSHOTS_DIR = path.join(MASTODON_RES, "screenshots");

const CLAUDE_BIN = fs.existsSync("/home/colton/.local/share/mise/command-wrappers/bin/claude")
  ? "/home/colton/.local/share/mise/command-wrappers/bin/claude"
  : "claude";
const JUDGE_MODEL = process.env.WRAITH_JUDGE_MODEL ?? "opus";

const ARMS = ["nmt", "b0", "a0", "w-pre", "w-post"];
const LANGUAGES = ["es-MX", "ar"];

// Independent FormatJS ICU parser (NOT Wraith's own validator!)
const require = createRequire(import.meta.url);
const icuParser = require(path.join(MASTODON_SRC, "node_modules/@formatjs/icu-messageformat-parser"));

const DNT_TERMS = ["Mastodon", "ActivityPub", "RSS", "URL", "HTML", "API", "WebAuthn", "TOTP"];
const GLOSSARY_TERMS = [
  { term: "Boost", "es-MX": ["impulsar", "impulso", "impulsado", "impulsos"], ar: ["ترويج", "روّج", "روج"] },
  { term: "Bookmark", "es-MX": ["marcador", "marcadores", "guardar en marcadores"], ar: ["إشارة مرجعية", "إشارات مرجعية", "الإشارات المرجعية"] },
  { term: "Mute", "es-MX": ["silenciar", "silenciado", "silenciados", "silencio"], ar: ["كتم", "مكتوم", "مكتومون"] },
  { term: "Timeline", "es-MX": ["cronología", "cronologías"], ar: ["الخط الزمني", "خط زمني", "الخطوط الزمنية"] },
];

const SPAIN_SPANISH_RE = /\b(?:vosotros|vuestro|vuestra|vuestros|vuestras|ordenador|móvil|fichero|pulsad|guardad|iniciad|cerrad|podéis|tenéis|queréis|estáis|sois)\b/i;

function loadSourceEn() {
  return JSON.parse(fs.readFileSync(path.join(MASTODON_SRC, "app/javascript/mastodon/locales/en.json"), "utf8"));
}

function loadArm(arm, locale) {
  const p = path.join(MASTODON_RES, `${arm}.${locale}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function extractIcuVars(ast, vars = new Set(), tags = new Set(), plurals = []) {
  for (const node of ast) {
    if (node.type === 1 || node.type === 2 || node.type === 3 || node.type === 4) {
      vars.add(node.value);
    } else if (node.type === 5 || node.type === 6) {
      vars.add(node.value);
      const optionKeys = Object.keys(node.options || {});
      if (node.type === 6) plurals.push({ varName: node.value, categories: optionKeys });
      for (const opt of Object.values(node.options || {})) {
        extractIcuVars(opt.value || [], vars, tags, plurals);
      }
    } else if (node.type === 8) {
      tags.add(node.value);
      extractIcuVars(node.children || [], vars, tags, plurals);
    }
  }
  return { vars, tags, plurals };
}

function validateAll() {
  const en = loadSourceEn();
  const keys = Object.keys(en).sort();
  const report = { totalSourceKeys: keys.length, languages: {} };

  for (const locale of LANGUAGES) {
    report.languages[locale] = {};
    for (const arm of ARMS) {
      const data = loadArm(arm, locale);
      if (!data) continue;
      const tr = data.translations || {};
      const counts = {
        totalKeys: keys.length,
        translatedCount: 0,
        missingOrEmpty: 0,
        untranslatedIdentical: 0,
        icuParseErrors: 0,
        placeholderMismatches: 0,
        richTagMismatches: 0,
        arabicIncompletePlurals: 0,
        dntViolations: 0,
        glossaryMisses: 0,
        spainSpanishDrift: 0,
      };
      const examples = {
        icuParseErrors: [],
        placeholderMismatches: [],
        richTagMismatches: [],
        arabicIncompletePlurals: [],
        dntViolations: [],
        spainSpanishDrift: [],
      };

      for (const k of keys) {
        const src = en[k];
        const tgt = tr[k];
        if (typeof tgt !== "string" || !tgt.trim()) {
          counts.missingOrEmpty++;
          continue;
        }
        counts.translatedCount++;

        // Untranslated check (ignoring short codes/DNT/URLs/pure symbols)
        const stripped = src.replace(/\{[^}]+\}/g, "").replace(/<[^>]+>/g, "").trim();
        if (
          tgt.trim() === src.trim() &&
          stripped.length >= 4 &&
          /[a-zA-Z]{3,}/.test(stripped) &&
          !DNT_TERMS.some((d) => stripped === d) &&
          !/^(?:OK|CSV|JSON|GIF|PNG|JPEG|WebP|HEIC|AVIF|MP4|MP3|OGG|WAV|FLAC|OPUS|AAC|M4A|DM|ID|FAQ|Pro|Beta|Alt|UTC|ISO)$/i.test(stripped)
        ) {
          counts.untranslatedIdentical++;
        }

        // Independent @formatjs/icu-messageformat-parser validation
        let srcInfo = null;
        try {
          const srcAst = icuParser.parse(src, { ignoreTag: false });
          srcInfo = extractIcuVars(srcAst);
        } catch {
          // Some Mastodon strings may have literal < or {
        }

        if (srcInfo) {
          try {
            const tgtAst = icuParser.parse(tgt, { ignoreTag: false });
            const tgtInfo = extractIcuVars(tgtAst);
            const srcVars = [...srcInfo.vars].sort().join(",");
            const tgtVars = [...tgtInfo.vars].sort().join(",");
            if (srcVars !== tgtVars) {
              counts.placeholderMismatches++;
              if (examples.placeholderMismatches.length < 8) {
                examples.placeholderMismatches.push({ key: k, src, tgt, srcVars, tgtVars });
              }
            }
            const srcTags = [...srcInfo.tags].sort().join(",");
            const tgtTags = [...tgtInfo.tags].sort().join(",");
            if (srcTags !== tgtTags) {
              counts.richTagMismatches++;
              if (examples.richTagMismatches.length < 8) {
                examples.richTagMismatches.push({ key: k, src, tgt, srcTags, tgtTags });
              }
            }
            if (locale === "ar" && srcInfo.plurals.length > 0) {
              const missingCats = tgtInfo.plurals.some(
                (p) => !p.categories.includes("two") || !p.categories.includes("few") || !p.categories.includes("many")
              );
              if (missingCats || tgtInfo.plurals.length < srcInfo.plurals.length) {
                counts.arabicIncompletePlurals++;
                if (examples.arabicIncompletePlurals.length < 8) {
                  examples.arabicIncompletePlurals.push({ key: k, src, tgt });
                }
              }
            }
          } catch (err) {
            counts.icuParseErrors++;
            if (examples.icuParseErrors.length < 8) {
              examples.icuParseErrors.push({ key: k, src, tgt, error: err.message });
            }
          }
        }

        // DNT check
        for (const dnt of DNT_TERMS) {
          const re = new RegExp(`\\b${dnt}\\b`);
          if (re.test(src) && !re.test(tgt)) {
            counts.dntViolations++;
            if (examples.dntViolations.length < 6) examples.dntViolations.push({ key: k, term: dnt, src, tgt });
            break;
          }
        }

        // Glossary check (case-insensitive whole word in source)
        for (const g of GLOSSARY_TERMS) {
          const re = new RegExp(`\\b${g.term}\\b`, "i");
          if (re.test(src)) {
            const accepted = g[locale] || [];
            if (!accepted.some((a) => tgt.toLowerCase().includes(a.toLowerCase()))) {
              counts.glossaryMisses++;
            }
          }
        }

        if (locale === "es-MX" && SPAIN_SPANISH_RE.test(tgt)) {
          counts.spainSpanishDrift++;
          if (examples.spainSpanishDrift.length < 6) examples.spainSpanishDrift.push({ key: k, src, tgt });
        }
      }

      report.languages[locale][arm] = {
        counts,
        examples,
        usage: data.usage,
        qeDiffCount: (data.meta?.qeDiffs || []).length,
      };
    }
  }

  fs.writeFileSync(path.join(MASTODON_RES, "deterministic-validation.json"), JSON.stringify(report, null, 2));
  console.log("=== INDEPENDENT DETERMINISTIC VALIDATION SUMMARY ===");
  for (const loc of LANGUAGES) {
    console.log(`\n--- ${loc} (1,466 keys) ---`);
    for (const arm of ARMS) {
      const r = report.languages[loc][arm];
      if (!r) continue;
      console.log(arm.padEnd(7), JSON.stringify(r.counts));
    }
  }
  return report;
}

/* ============================================================================
 * BLINDED CLAUDE OPUS MQM JUDGE
 * ========================================================================== */
async function runClaudeJudge(prompt, timeoutMs = 240_000) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(
          CLAUDE_BIN,
          ["-p", "--model", JUDGE_MODEL, "--output-format", "json"],
          { cwd: RESULTS_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } }
        );
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Claude judge timeout")); }, timeoutMs);
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`Claude exit ${code}: ${stderr.slice(-400) || stdout.slice(-300)}`));
          try {
            const envelope = JSON.parse(stdout);
            const text = envelope.result || "";
            const costUsd = Number(envelope.total_cost_usd ?? 0);
            const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
            const raw = fence ? fence[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
            resolve({ parsed: JSON.parse(raw), costUsd });
          } catch (err) {
            reject(new Error(`Failed to parse Claude judge JSON: ${err.message} (${stdout.slice(0, 300)})`));
          }
        });
        child.stdin.write(prompt);
        child.stdin.end();
      });
    } catch (err) {
      lastErr = err;
      if (attempt < 4) {
        console.error(`  [JUDGE retry ${attempt}/3]: ${err.message}`);
        await new Promise((r) => setTimeout(r, 4000 * attempt));
      }
    }
  }
  throw lastErr;
}

function selectStratifiedSample(en) {
  const keys = Object.keys(en).sort();
  const picked = new Set();
  const buckets = {
    nestedIcu: [],
    richText: [],
    icuPluralSelect: [],
    glossary: [],
    interpolation: [],
    shortAmbiguous: [],
    ordinary: [],
  };

  for (const k of keys) {
    const v = en[k];
    const isPlural = /\{[^{}]*,\s*plural\s*,/.test(v);
    const isSelect = /\{[^{}]*,\s*select\s*,/.test(v);
    const isNested = /\{[^{}]*,\s*(?:plural|select|selectordinal)\s*,[\s\S]*\{[^{}]*,\s*(?:plural|select|selectordinal)\s*,/.test(v);
    const hasRich = /<[a-zA-Z][\w-]*(\s[^>]*)?>/.test(v);
    const hasInterp = /\{[\w.-]+\}/.test(v);
    const hasGlossary = GLOSSARY_TERMS.some((g) => new RegExp(`\\b${g.term}\\b`, "i").test(v)) || DNT_TERMS.some((d) => new RegExp(`\\b${d}\\b`).test(v));
    const isShort = v.trim().length > 0 && v.trim().length <= 14 && !v.includes(" ");

    if (isNested) buckets.nestedIcu.push(k);
    else if (hasRich) buckets.richText.push(k);
    else if (isPlural || isSelect) buckets.icuPluralSelect.push(k);
    else if (hasGlossary) buckets.glossary.push(k);
    else if (hasInterp) buckets.interpolation.push(k);
    else if (isShort) buckets.shortAmbiguous.push(k);
    else buckets.ordinary.push(k);
  }

  const takeEvenly = (arr, n) => {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };

  const plan = [
    ["nestedIcu", 10],
    ["richText", 20],
    ["icuPluralSelect", 40],
    ["glossary", 25],
    ["interpolation", 35],
    ["shortAmbiguous", 40],
    ["ordinary", 30],
  ];
  const sampleWithCategory = [];
  for (const [cat, limit] of plan) {
    for (const k of takeEvenly(buckets[cat], limit)) {
      if (!picked.has(k)) {
        picked.add(k);
        sampleWithCategory.push({ key: k, category: cat });
      }
    }
  }
  return sampleWithCategory.slice(0, 200);
}

async function runBlindedJudging() {
  const en = loadSourceEn();
  const sample = selectStratifiedSample(en);
  const outPath = path.join(MASTODON_RES, "mqm-judge-v2.json");
  const result = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, "utf8"))
    : { model: JUDGE_MODEL, sampleSizePerLang: sample.length, totalCostUsd: 0, languages: {}, qeDiffsJudge: {}, docsJudge: {} };

  for (const locale of LANGUAGES) {
    if (!result.languages[locale]) {
      result.languages[locale] = { items: {}, summary: {} };
    }
    const armData = {};
    for (const arm of ARMS) armData[arm] = loadArm(arm, locale)?.translations || {};

    const pending = sample.filter((s) => !result.languages[locale].items[s.key]);
    console.log(`[JUDGE ${locale}] Pending ${pending.length}/${sample.length} stratified keys (5 arms each)...`);

    // Batch 10 keys per Opus call (50 translations per call), blinded with per-key shuffled system labels S1..S5
    for (let i = 0; i < pending.length; i += 10) {
      const batch = pending.slice(i, i + 10);
      const labelMaps = {};
      const payload = batch.map((s, idx) => {
        // Deterministic rotation per item for position-bias control
        const rot = (idx + i) % ARMS.length;
        const rotated = [...ARMS.slice(rot), ...ARMS.slice(0, rot)];
        const map = {};
        const candidates = {};
        rotated.forEach((arm, j) => {
          const lbl = `S${j + 1}`;
          map[lbl] = arm;
          candidates[lbl] = armData[arm][s.key] ?? "";
        });
        labelMaps[s.key] = map;
        return { key: s.key, category: s.category, source: en[s.key], candidates };
      });

      const prompt = `You are an independent professional MQM (Multidimensional Quality Metrics) localization evaluator scoring translations of Mastodon (open-source social network) from English to ${locale}.

Evaluation rules:
- Locale requirements for ${locale}: ${locale === "es-MX" ? "Mexican Spanish, informal 'tú' (penalize Spain 'vosotros' or Spain-only terms like 'ordenador'/'móvil' as Minor/Major), opening ¿/¡." : "Modern Standard Arabic, RTL, natural UI phrasing, full Arabic CLDR plurals (zero/one/two/few/many/other) in ICU plural strings."}
- Glossary/DNT: Mastodon/ActivityPub/RSS/URL/HTML/API/WebAuthn/TOTP must not be translated. Boost -> ${locale === "es-MX" ? "Impulsar" : "ترويج"}, Bookmark -> ${locale === "es-MX" ? "Marcador" : "إشارة مرجعية"}, Mute -> ${locale === "es-MX" ? "Silenciar" : "كتم"}, Timeline -> ${locale === "es-MX" ? "Cronología" : "الخط الزمني"}.
- Severity weights (standard MQM): Critical = -25 (broken ICU/placeholders/tags, wrong/inverted meaning, untranslated sentence), Major = -5 (wrong UI sense, missing Arabic plural forms, major mistranslation, dropped meaning, glossary violation), Minor = -1 (awkward phrasing, minor punctuation/register slip).
- Score = max(0, 100 - 25*critical - 5*major - 1*minor).

For EACH item below, independently score every blinded candidate S1..S5.
Return ONLY a JSON array of objects:
[{"key":"...","scores":{"S1":{"critical":0,"major":0,"minor":0,"note":""},"S2":...,"S3":...,"S4":...,"S5":...}}]

Items:
${JSON.stringify(payload, null, 2)}
`;
      const { parsed, costUsd } = await runClaudeJudge(prompt);
      result.totalCostUsd = +(result.totalCostUsd + costUsd).toFixed(4);
      for (const row of parsed) {
        const map = labelMaps[row.key];
        if (!map) continue;
        const unblinded = {};
        for (const [lbl, arm] of Object.entries(map)) {
          const sc = row.scores?.[lbl] || { critical: 0, major: 0, minor: 0, note: "" };
          const c = Number(sc.critical || 0), m = Number(sc.major || 0), n = Number(sc.minor || 0);
          unblinded[arm] = {
            critical: c,
            major: m,
            minor: n,
            mqm: Math.max(0, 100 - 25 * c - 5 * m - n),
            note: sc.note || "",
          };
        }
        result.languages[locale].items[row.key] = {
          category: batch.find((b) => b.key === row.key)?.category,
          arms: unblinded,
        };
      }
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`  [JUDGE ${locale}] ${Math.min(i + 10, pending.length)}/${pending.length} done (cumCost=$${result.totalCostUsd})`);
    }

    // Aggregate MQM summary per arm
    const items = Object.values(result.languages[locale].items);
    for (const arm of ARMS) {
      let sum = 0, crit = 0, maj = 0, min = 0;
      for (const it of items) {
        const a = it.arms[arm];
        if (!a) continue;
        sum += a.mqm;
        crit += a.critical;
        maj += a.major;
        min += a.minor;
      }
      result.languages[locale].summary[arm] = {
        n: items.length,
        avgMqm: +(sum / Math.max(1, items.length)).toFixed(2),
        critical: crit,
        major: maj,
        minor: min,
        totalErrors: crit + maj + min,
      };
    }

    // Separately judge 100% of ALL QE-modified strings (W-pre vs W-post, blinded & position-swapped)
    const wPostData = loadArm("w-post", locale);
    const diffs = wPostData?.meta?.qeDiffs || [];
    if (!result.qeDiffsJudge[locale]) result.qeDiffsJudge[locale] = [];
    const judgedDiffKeys = new Set(result.qeDiffsJudge[locale].map((d) => d.key));
    const pendingDiffs = diffs.filter((d) => !judgedDiffKeys.has(d.key));
    console.log(`[JUDGE QE-DIFFS ${locale}] Judging ${pendingDiffs.length}/${diffs.length} QE-modified strings...`);

    for (let i = 0; i < pendingDiffs.length; i += 15) {
      const batch = pendingDiffs.slice(i, i + 15);
      const swapMap = {};
      const payload = batch.map((d, idx) => {
        const swap = (i + idx) % 2 === 1;
        swapMap[d.key] = swap;
        return {
          key: d.key,
          source: d.source,
          file: d.file,
          A: swap ? d.after : d.before,
          B: swap ? d.before : d.after,
        };
      });
      const prompt = `You are an independent blinded MQM judge comparing two candidate ${locale} translations (A vs B) of Mastodon UI strings.
For each item, score A and B using MQM (Critical=-25, Major=-5, Minor=-1, score=max(0,100-penalties)) and pick winner ("A", "B", or "tie").
Return ONLY a JSON array:
[{"key":"...","A":{"critical":0,"major":0,"minor":0},"B":{"critical":0,"major":0,"minor":0},"winner":"A|B|tie","note":"short explanation"}]

Items:
${JSON.stringify(payload, null, 2)}
`;
      const { parsed, costUsd } = await runClaudeJudge(prompt);
      result.totalCostUsd = +(result.totalCostUsd + costUsd).toFixed(4);
      for (const row of parsed) {
        const orig = batch.find((d) => d.key === row.key);
        if (!orig) continue;
        const swap = swapMap[row.key];
        const preSc = swap ? row.B : row.A;
        const postSc = swap ? row.A : row.B;
        const calc = (s) => Math.max(0, 100 - 25 * Number(s?.critical || 0) - 5 * Number(s?.major || 0) - Number(s?.minor || 0));
        const preMqm = calc(preSc);
        const postMqm = calc(postSc);
        let verdict = "tie";
        if (row.winner === "A") verdict = swap ? "improved" : "regressed";
        else if (row.winner === "B") verdict = swap ? "regressed" : "improved";
        result.qeDiffsJudge[locale].push({
          ...orig,
          preMqm,
          postMqm,
          delta: postMqm - preMqm,
          verdict,
          judgeNote: row.note || "",
        });
      }
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    }
  }

  // Judge 3 real-world DOCX documents (30 stratified segments each)
  for (const docId of ["sop-lay-down-tubulars", "hipaa-privacy-notice", "scientific-manuscript"]) {
    if (result.docsJudge[docId]) continue;
    const p = path.join(DOCS_RES, `${docId}.wraith.json`);
    if (!fs.existsSync(p)) continue;
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    const nonTrivial = doc.segments.filter((s) => s.source.replace(/<[^>]+>/g, "").trim().length >= 8);
    const step = Math.max(1, nonTrivial.length / 30);
    const sampleSegs = [];
    for (let i = 0; i < Math.min(30, nonTrivial.length); i++) {
      sampleSegs.push(nonTrivial[Math.floor(i * step)]);
    }
    const prompt = `You are an independent MQM localization evaluator scoring a real-world Microsoft Word (.docx) document translated from English to Mexican Spanish (es-MX): "${doc.title}".
Score each segment with MQM (Critical=-25, Major=-5, Minor=-1; check accuracy, inline <g>/<x> tag integrity, domain terminology, formal/appropriate register, and Mexican Spanish conventions).
Return ONLY a JSON array:
[{"id":"...","critical":0,"major":0,"minor":0,"note":""}]

Segments:
${JSON.stringify(sampleSegs.map((s) => ({ id: s.id, part: s.part, source: s.source, translated: s.translated })), null, 2)}
`;
    const { parsed, costUsd } = await runClaudeJudge(prompt);
    result.totalCostUsd = +(result.totalCostUsd + costUsd).toFixed(4);
    let sum = 0, crit = 0, maj = 0, min = 0;
    for (const r of parsed) {
      const c = Number(r.critical || 0), m = Number(r.major || 0), n = Number(r.minor || 0);
      crit += c; maj += m; min += n;
      sum += Math.max(0, 100 - 25 * c - 5 * m - n);
    }
    result.docsJudge[docId] = {
      sampledSegments: parsed.length,
      avgMqm: +(sum / Math.max(1, parsed.length)).toFixed(2),
      critical: crit,
      major: maj,
      minor: min,
      items: parsed,
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`[JUDGE DOCX ${docId}] avgMqm=${result.docsJudge[docId].avgMqm} (crit=${crit}, maj=${maj}, min=${min})`);
  }

  console.log("\n=== BLINDED CLAUDE OPUS MQM SUMMARY ===");
  for (const loc of LANGUAGES) {
    console.log(`\n--- ${loc} ---`);
    console.table(result.languages[loc].summary);
    const diffs = result.qeDiffsJudge[loc] || [];
    const imp = diffs.filter((d) => d.verdict === "improved").length;
    const reg = diffs.filter((d) => d.verdict === "regressed").length;
    const tie = diffs.filter((d) => d.verdict === "tie").length;
    console.log(`QE Diffs (${loc}): total=${diffs.length}, improved=${imp}, tie=${tie}, regressed=${reg}`);
  }
  console.log(`Total Judge Cost: $${result.totalCostUsd}`);
}

/* ============================================================================
 * PLAYWRIGHT + MASTODON STORYBOOK + MSW VISUAL QA (Desktop, Mobile, RTL)
 * ========================================================================== */
async function runVisualQa() {
  const sbDir = "/tmp/mastodon-storybook-test";
  if (!fs.existsSync(sbDir)) throw new Error("Storybook static build missing at /tmp/mastodon-storybook-test");
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const pwPath = "/home/colton/.local/share/mise/installs/playwright/latest/node_modules/playwright/index.js";
  const { chromium } = require(pwPath);

  // Simple static HTTP server for Storybook bundle
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".gif": "image/gif" };
  const server = http.createServer((req, res) => {
    const cleanUrl = (req.url || "/").split("?")[0];
    const filePath = path.join(sbDir, cleanUrl === "/" ? "index.html" : cleanUrl);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const stories = [
    { id: "redesign-navigationpanel--default", slug: "nav-panel", label: "Navigation Panel" },
    { id: "redesign-compose--post", slug: "compose-post", label: "Compose Post" },
    { id: "components-status--default", slug: "status-card", label: "Status Card" },
    { id: "components-account--primary", slug: "account-card", label: "Account Card" },
  ];
  const viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 375, height: 812 },
  ];
  const visualArms = ["nmt", "b0", "w-post"];

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/home/colton/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  });
  const results = [];

  for (const locale of LANGUAGES) {
    for (const arm of visualArms) {
      const armJson = loadArm(arm, locale)?.translations || {};
      const context = await browser.newContext();
      const page = await context.newPage();

      // Intercept Mastodon's dynamically imported locale chunk and inject this arm's 1,466 translations!
      const chunkRe = locale === "es-MX" ? /\/assets\/es-MX-[^/]+\.js$/ : /\/assets\/ar-[^/]+\.js$/;
      await page.route(chunkRe, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/javascript; charset=utf-8",
          body: `export default ${JSON.stringify(armJson)};`,
        });
      });

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const st of stories) {
          const url = `${baseUrl}/iframe.html?id=${st.id}&viewMode=story&globals=locale:${locale};theme:light`;
          await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
          await page.evaluate((loc) => {
            document.documentElement.lang = loc;
            document.documentElement.dir = loc === "ar" ? "rtl" : "ltr";
          }, locale);
          await page.waitForTimeout(900);

          const metrics = await page.evaluate(() => {
            const root = document.getElementById("storybook-root") || document.body;
            const text = (root.innerText || "").trim();
            const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
            let clippedCount = 0;
            const clippedSamples = [];
            for (const el of root.querySelectorAll("button, a, span, h1, h2, h3, label")) {
              const cs = getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) continue;
              if (cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)") continue;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 2 || rect.height <= 2) continue;
              if ((cs.overflowX === "hidden" || cs.textOverflow === "ellipsis") && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
                clippedCount++;
                if (clippedSamples.length < 3) clippedSamples.push((el.innerText || "").trim().slice(0, 40));
              }
            }
            const rawIcuLeak = /\{[a-zA-Z_]+,\s*(?:plural|select)/.test(text);
            return {
              textLength: text.length,
              docOverflow,
              clippedCount,
              clippedSamples,
              rawIcuLeak,
              dir: document.documentElement.dir,
            };
          });

          const pngName = `${st.slug}_${locale}_${arm}_${vp.name}.png`;
          await page.screenshot({ path: path.join(SCREENSHOTS_DIR, pngName), fullPage: false });
          results.push({ story: st.slug, label: st.label, locale, arm, viewport: vp.name, png: pngName, ...metrics });
        }
      }
      await context.close();
      console.log(`[VISUAL ${locale} ${arm}] Captured ${stories.length * viewports.length} screenshots.`);
    }
  }

  await browser.close();
  server.close();
  fs.writeFileSync(path.join(MASTODON_RES, "visual-qa.json"), JSON.stringify(results, null, 2));
  console.log(`[VISUAL] Total screenshots captured: ${results.length}`);
}

const [, , cmd] = process.argv;
if (cmd === "validate") validateAll();
else if (cmd === "judge") await runBlindedJudging();
else if (cmd === "visual") await runVisualQa();
else console.log("Usage: node eval/bench/real-world-eval.mjs <validate|judge|visual>");
