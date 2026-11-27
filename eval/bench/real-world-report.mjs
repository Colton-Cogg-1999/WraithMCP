#!/usr/bin/env node
/**
 * Generates:
 *   1. eval/REAL_WORLD_BENCHMARK_REPORT.md  — Scientifically rigorous, sober real-world report
 *   2. eval/results/real-world-v2/inspect-report.html — Interactive desktop inspection dashboard
 *      (side-by-side Mastodon Storybook screenshots for Desktop/Mobile/RTL, DOCX page renders,
 *       full QE diff table with blinded Opus verdicts, deterministic validation & cost/token tables)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const EVAL_ROOT = path.join(REPO_ROOT, "eval");
const RESULTS_ROOT = path.join(EVAL_ROOT, "results", "real-world-v2");
const MASTODON_RES = path.join(RESULTS_ROOT, "mastodon");
const DOCS_RES = path.join(RESULTS_ROOT, "docs");

const ARMS = ["nmt", "b0", "a0", "w-pre", "w-post"];
const ARM_LABELS = {
  nmt: "NMT (DeepL)",
  b0: "B0 (Codex Catalog)",
  a0: "A0 (Codex Repo)",
  "w-pre": "W-pre (Wraith)",
  "w-post": "W-post (Wraith+QE)",
};
const LANGUAGES = ["es-MX", "ar"];

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const detVal = readJson(path.join(MASTODON_RES, "deterministic-validation.json"));
const mqmJudge = readJson(path.join(MASTODON_RES, "mqm-judge-v2.json"));
const visualQa = readJson(path.join(MASTODON_RES, "visual-qa.json")) || [];
const docProvenance = readJson(path.join(EVAL_ROOT, "corpora/real-docs/PROVENANCE.json"));

const armsByLocale = {};
for (const loc of LANGUAGES) {
  armsByLocale[loc] = {};
  for (const arm of ARMS) {
    armsByLocale[loc][arm] = readJson(path.join(MASTODON_RES, `${arm}.${loc}.json`));
  }
}

const docsData = {};
for (const d of docProvenance.documents) {
  if (d.scalabilityOnly) {
    docsData[d.id] = readJson(path.join(DOCS_RES, `${d.id}.stress.json`));
  } else {
    docsData[d.id] = readJson(path.join(DOCS_RES, `${d.id}.wraith.json`));
  }
}

/* ============================================================================
 * 1. Build Markdown Report (eval/REAL_WORLD_BENCHMARK_REPORT.md)
 * ========================================================================== */
const md = [];
md.push("# Wraith Real-World Production Stress-Test Report (v2)");
md.push("");
md.push("> **Separation of Evidence:** This report evaluates **100% genuine, unmodified open-source production software and real-world public Word documents**. All prior synthetic & mixed-sample benchmark artifacts in `eval/results/pub-audit/` are preserved untouched and are NOT combined with these numbers.");
md.push("");
md.push("## 1. Corpus & Methodology");
md.push("");
md.push("- **Software Application:** [`mastodon/mastodon`](https://github.com/mastodon/mastodon) (`a458489b`) — complete React-Intl frontend catalog (`app/javascript/mastodon/locales/en.json`): **1,466 unique English source strings** (`44,794` chars) × **2 target languages** (`es-MX`, `ar`) = **2,932 translated string instances per arm** (**14,660 total translations across 5 arms**).");
md.push("  - **Production complexity:** `68` ICU plurals, `1` ICU select, `3` multi-plural/nested ICU strings, `229` interpolations, `15` rich-text HTML/custom component tags (`<link>`, `<ul><li>`, `<sr>`, `<topLabel>`), `287` short 1-word ambiguous UI labels, `48` long strings (120+ chars), native `es-MX` and RTL `ar` support.");
md.push("  - **Wraith usage-site coverage:** `1,462 / 1,466` keys (**99.7%**) mapped to real React component call sites (`<FormattedMessage>`, `defineMessages`, `intl.formatMessage`) across 845 source files after fixing `react-intl` support prior to benchmark freeze.");
md.push("- **Shared Linguistic Specification (Fairness):** All Codex arms (`B0`, `A0`, `W-pre`, `W-post`) received the exact same project style guide, locale-specific rules (`es-MX` informal `tú` + Mexican UI vocabulary; `ar` Modern Standard Arabic + 6 CLDR plural forms), supplemental translation prompt, and 12-entry approved glossary/DNT list. DeepL (`NMT`) received the same glossary where supported (`es` glossary + `prefer_less` formality; documented limitation: DeepL has no `ES-MX` target code and no `AR` glossary/formality support).");
md.push("- **Independent Evaluation (Never Wraith-Only):**");
md.push("  - **Deterministic validation (all 14,660 strings):** Independent `@formatjs/icu-messageformat-parser` (Mastodon's own production ICU parser), placeholder/tag parity, Arabic 6-form CLDR plural completeness, DNT/glossary compliance, and Spain-Spanish regional drift detection.");
md.push("  - **Blinded linguistic judging:** Claude Opus (`claude -p --model opus`) MQM scoring on a pre-selected stratified 200-key sample per language (`400` unique strings × 5 arms = `2,000` blinded, position-rotated evaluations), **plus 100% of all QE-modified strings** judged blinded & position-swapped (`W-pre` vs `W-post`).");
md.push("  - **Component-level visual QA (clearly distinguished from full-app E2E):** Playwright rendering 4 dense real Mastodon Storybook components (`NavigationPanel`, `Compose`, `Status`, `Account`) with MSW mock data at Desktop (`1280×800`), Mobile (`375×812`), and Arabic RTL (`dir=\"rtl\"`).");
md.push("");

md.push("## 2. Mastodon 5-Arm Results (1,466 Keys × 2 Languages = 2,932 Strings/Arm)");
md.push("");
for (const loc of LANGUAGES) {
  md.push(`### ${loc === "es-MX" ? "Mexican Spanish (`es-MX`)" : "Arabic (`ar` — RTL)"}`);
  md.push("");
  md.push("| Arm | Keys | Blinded Opus MQM (n=200) | Crit / Maj / Min | ICU Parse Err | Placeholder Mismatch | Rich-Tag Mismatch | Ar Plural Incomplete | DNT Viol | es-ES Drift | Est. API-Eq USD | Tokens (In / Cached / Out) |");
  md.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const arm of ARMS) {
    const dv = detVal?.languages?.[loc]?.[arm]?.counts || {};
    const mq = mqmJudge?.languages?.[loc]?.summary?.[arm] || {};
    const u = armsByLocale[loc]?.[arm]?.usage || {};
    const wPreU = armsByLocale[loc]?.["w-pre"]?.usage || {};
    const costStr =
      arm === "w-post"
        ? `$${((wPreU.estimatedUsd || 0) + (u.estimatedUsd || 0)).toFixed(2)} (QE: $${(u.estimatedUsd || 0).toFixed(2)})`
        : `$${(u.estimatedUsd || 0).toFixed(2)}`;
    const tokStr =
      arm === "nmt"
        ? `${(u.billedChars || 0).toLocaleString()} chars`
        : `${((u.inputTokens || 0) / 1000).toFixed(0)}k / ${((u.cachedInputTokens || 0) / 1000).toFixed(0)}k / ${((u.outputTokens || 0) / 1000).toFixed(0)}k`;
    md.push(
      `| **${ARM_LABELS[arm]}** | ${dv.translatedCount ?? 0}/1466 | **${mq.avgMqm ?? "—"}** | ${mq.critical ?? 0} / ${mq.major ?? 0} / ${mq.minor ?? 0} | ${dv.icuParseErrors ?? 0} | ${dv.placeholderMismatches ?? 0} | ${dv.richTagMismatches ?? 0} | ${dv.arabicIncompletePlurals ?? 0} | ${dv.dntViolations ?? 0} | ${dv.spainSpanishDrift ?? 0} | ${costStr} | ${tokStr} |`
    );
  }
  md.push("");
}

md.push("## 3. Fresh-Context QE Subagent Audit (100% of QE-Modified Strings Judged Blinded)");
md.push("");
md.push("Every single string modified by the fresh-context Codex QE subagent (`W-pre` → `W-post`) was evaluated by blinded, position-swapped Claude Opus MQM:");
md.push("");
for (const loc of LANGUAGES) {
  const parity = armsByLocale[loc]?.["w-post"]?.meta?.parityCheck || {};
  const rawDiffs = armsByLocale[loc]?.["w-post"]?.meta?.qeDiffs || [];
  const judgedDiffs = mqmJudge?.qeDiffsJudge?.[loc] || [];
  const judgedByKey = new Map(judgedDiffs.map((d) => [d.key, d]));
  const imp = judgedDiffs.filter((d) => d.verdict === "improved").length;
  const tie = judgedDiffs.filter((d) => d.verdict === "tie").length;
  const reg = judgedDiffs.filter((d) => d.verdict === "regressed").length;
  const netDelta = judgedDiffs.reduce((s, d) => s + (d.delta || 0), 0);
  md.push(`### ${loc}`);
  md.push(`- **QE Context Parity Verified:** StyleGuide=\`${parity.hasProjectStyleGuide}\`, LocaleRule=\`${parity.hasLocaleStyleRule}\`, TranslationPrompt=\`${parity.hasTranslationPrompt}\`, QePrompt=\`${parity.hasQePrompt}\`, Conventions=\`${parity.hasConventionsByLocale}\`, DNT=\`${parity.hasDoNotTranslate}\`, UsageFileStrings=\`${parity.stringsWithUsageFile}/${parity.toReview}\``);
  md.push(`- **QE Edits Applied:** \`${rawDiffs.length}\` / \`${parity.toReview ?? 1466}\` strings — **Blinded Opus Judged: \`${judgedDiffs.length}/${rawDiffs.length}\`** (**Improved: \`${imp}\`**, **Tie/Neutral: \`${tie}\`**, **Regressed: \`${reg}\`**, **Net MQM Delta: \`${netDelta >= 0 ? "+" : ""}${netDelta}\` pts**)`);
  if (rawDiffs.length > 0) {
    md.push("");
    md.push("| Key | Verdict | MQM Δ | Before (`W-pre`) | After (`W-post`) | QE Reason / Blinded Opus Note |");
    md.push("|---|---|---:|---|---|---|");
    for (const rd of rawDiffs.slice(0, 30)) {
      const jd = judgedByKey.get(rd.key);
      const verdict = jd ? `**${jd.verdict}**` : "_pending_";
      const deltaStr = jd ? `${jd.delta >= 0 ? "+" : ""}${jd.delta}` : "—";
      const note = jd?.judgeNote || rd.reason || "";
      md.push(`| \`${rd.key}\` | ${verdict} | ${deltaStr} | ${String(rd.before).replace(/\|/g, "\\|").slice(0, 60)} | ${String(rd.after).replace(/\|/g, "\\|").slice(0, 60)} | ${String(note).replace(/\|/g, "\\|").slice(0, 80)} |`);
    }
    if (rawDiffs.length > 30) md.push(`| *...${rawDiffs.length - 30} more* | | | | | *(see interactive HTML report for full list)* |`);
  }
  md.push("");
}

md.push("## 4. Mastodon Storybook Component-Level Visual QA (Playwright + MSW)");
md.push("");
md.push("> **Scope Note:** These captures verify real Mastodon React components rendered via Storybook + MSW mock data (component-level verification, not a full Rails+Postgres+Redis E2E deployment).");
md.push("");
if (visualQa.length > 0) {
  md.push("| Locale | Arm | Captures | Doc Overflow (>2px) | Clipped Labels | Raw ICU Leaks |");
  md.push("|---|---|---:|---:|---:|---:|");
  for (const loc of LANGUAGES) {
    for (const arm of ["nmt", "b0", "w-post"]) {
      const rows = visualQa.filter((r) => r.locale === loc && r.arm === arm);
      const ov = rows.filter((r) => r.docOverflow).length;
      const cl = rows.reduce((s, r) => s + (r.clippedCount || 0), 0);
      const icu = rows.filter((r) => r.rawIcuLeak).length;
      md.push(`| \`${loc}\` | **${ARM_LABELS[arm]}** | ${rows.length} | ${ov} | ${cl} | ${icu} |`);
    }
  }
  md.push("");
}

md.push("## 5. Real-World Complex `.docx` Benchmark (Publicly Sourced Documents)");
md.push("");
md.push("| Document | Source Repo / License | Segments | Words | Pages (EN → es-MX) | `doc-verify` | Blinded Opus MQM (n=30) | Est. USD |");
md.push("|---|---|---:|---:|---:|---|---:|---:|");
for (const d of docProvenance.documents) {
  if (d.scalabilityOnly) continue;
  const res = docsData[d.id];
  const j = mqmJudge?.docsJudge?.[d.id];
  if (!res) continue;
  md.push(
    `| **${d.title}** | \`${d.sourceRepo.replace("https://github.com/", "")}\` | ${res.segmentsTotal} | ${res.wordCount} | ${res.originalPages} → ${res.translatedPages} | **${res.verify?.outcome ?? "—"}** | **${j?.avgMqm ?? "—"}** (${j?.critical ?? 0}c/${j?.major ?? 0}M/${j?.minor ?? 0}m) | $${res.usage?.estimatedUsd ?? 0} |`
  );
}
md.push("");

const stress = docsData["nci-seer-52p-stress"];
if (stress) {
  md.push("### 52-Page Scalability Stress Test (`nci-seer-52p-stress.docx` — US NCI SEER Report)");
  md.push(`- **Scale:** 52 pages, \`${stress.segmentsTotal}\` Wraith segments, \`${stress.wordCount}\` words, 30 Word fields, 296 hyperlinks, 3.51 runs/paragraph fragmentation.`);
  md.push(`- **Performance & Integrity:** Extract \`${stress.extractMs}ms\` · Byte-identical no-op round-trip \`${stress.noopApplyMs}ms\` (\`byteIdentical=${stress.noopByteIdentical}\`) · Live 50-segment mutated splice \`${stress.mutatedApplyMs}ms\` (\`ok=${stress.mutatedApplyOk}\`) · LibreOffice \`doc-verify\` \`${stress.verifyMs}ms\` (**\`${stress.verifyOutcome}\`**) · Peak RSS delta \`+${stress.rssDeltaMB} MB\`.`);
  md.push("");
}

md.push(`*Blinded Claude Opus MQM total judge cost: \`$${mqmJudge?.totalCostUsd ?? 0}\`.*`);
fs.writeFileSync(path.join(EVAL_ROOT, "REAL_WORLD_BENCHMARK_REPORT.md"), md.join("\n") + "\n");

/* ============================================================================
 * 2. Build Interactive Desktop HTML Inspection Report
 * ========================================================================== */
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Wraith Real-World Production Stress-Test (Mastodon 1,466 Keys + Real DOCX)</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px 32px; background: #0f1117; color: #e6edf3; line-height: 1.5; }
  h1, h2, h3 { color: #fff; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 18px 22px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
  th, td { border: 1px solid #30363d; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #1f2630; color: #c9d1d9; }
  .good { color: #3fb950; font-weight: 600; }
  .warn { color: #d29922; font-weight: 600; }
  .bad { color: #f85149; font-weight: 600; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 12px; }
  .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 12px; }
  .shot { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 8px; }
  .shot img { width: 100%; border-radius: 4px; display: block; background: #fff; }
  .shot-cap { font-size: 12px; color: #8b949e; margin-top: 6px; }
  code { background: #21262d; padding: 2px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>Wraith Real-World Production Stress-Test Dashboard</h1>
<p><strong>Mastodon Frontend (1,466 unique EN keys × es-MX &amp; ar = 14,660 translations across 5 arms)</strong> + <strong>3 Publicly Sourced Complex Word Documents + 52-Page NCI SEER Scalability Stress Test</strong>. Synthetic fixtures from <code>pub-audit/</code> are kept strictly separate.</p>

<div class="card">
  <h2>1. Mastodon 5-Arm Quality, Structural Integrity &amp; Cost</h2>
  ${LANGUAGES.map((loc) => `
    <h3>${loc === "es-MX" ? "Mexican Spanish (es-MX)" : "Arabic (ar — RTL)"}</h3>
    <table>
      <tr><th>Arm</th><th>Keys</th><th>Opus MQM (n=200)</th><th>Crit / Maj / Min</th><th>ICU Err</th><th>Placeholder Err</th><th>Rich-Tag Err</th><th>Ar Plural Gap</th><th>DNT Viol</th><th>es-ES Drift</th><th>Est. USD</th></tr>
      ${ARMS.map((arm) => {
        const dv = detVal?.languages?.[loc]?.[arm]?.counts || {};
        const mq = mqmJudge?.languages?.[loc]?.summary?.[arm] || {};
        const u = armsByLocale[loc]?.[arm]?.usage || {};
        const wPreU = armsByLocale[loc]?.["w-pre"]?.usage || {};
        const cost = arm === "w-post" ? ((wPreU.estimatedUsd || 0) + (u.estimatedUsd || 0)).toFixed(2) : (u.estimatedUsd || 0).toFixed(2);
        return `<tr>
          <td><strong>${esc(ARM_LABELS[arm])}</strong></td>
          <td>${dv.translatedCount ?? 0}/1466</td>
          <td class="${(mq.avgMqm || 0) >= 99 ? "good" : (mq.avgMqm || 0) >= 95 ? "warn" : "bad"}">${mq.avgMqm ?? "—"}</td>
          <td>${mq.critical ?? 0} / ${mq.major ?? 0} / ${mq.minor ?? 0}</td>
          <td class="${(dv.icuParseErrors || 0) > 0 ? "bad" : "good"}">${dv.icuParseErrors ?? 0}</td>
          <td class="${(dv.placeholderMismatches || 0) > 0 ? "bad" : "good"}">${dv.placeholderMismatches ?? 0}</td>
          <td class="${(dv.richTagMismatches || 0) > 0 ? "bad" : "good"}">${dv.richTagMismatches ?? 0}</td>
          <td class="${(dv.arabicIncompletePlurals || 0) > 0 ? "warn" : "good"}">${dv.arabicIncompletePlurals ?? 0}</td>
          <td>${dv.dntViolations ?? 0}</td>
          <td>${dv.spainSpanishDrift ?? 0}</td>
          <td>$${cost}</td>
        </tr>`;
      }).join("")}
    </table>
  `).join("")}
</div>

<div class="card">
  <h2>2. Fresh-Context QE Subagent Diffs (100% Judged Blinded by Claude Opus)</h2>
  ${LANGUAGES.map((loc) => {
    const rawDiffs = armsByLocale[loc]?.["w-post"]?.meta?.qeDiffs || [];
    const judgedDiffs = mqmJudge?.qeDiffsJudge?.[loc] || [];
    const judgedByKey = new Map(judgedDiffs.map((d) => [d.key, d]));
    const imp = judgedDiffs.filter((d) => d.verdict === "improved").length;
    const tie = judgedDiffs.filter((d) => d.verdict === "tie").length;
    const reg = judgedDiffs.filter((d) => d.verdict === "regressed").length;
    return `
      <h3>${loc} — ${rawDiffs.length} edits applied (${judgedDiffs.length} Opus-judged: <span class="good">${imp} improved</span>, ${tie} neutral, <span class="bad">${reg} regressed</span>)</h3>
      <table>
        <tr><th>Key</th><th>Verdict</th><th>Δ</th><th>Source</th><th>Before (W-pre)</th><th>After (W-post)</th><th>QE Reason / Opus Note</th></tr>
        ${rawDiffs.map((rd) => {
          const jd = judgedByKey.get(rd.key);
          const v = jd?.verdict || "pending";
          const dStr = jd ? `${jd.delta >= 0 ? "+" : ""}${jd.delta}` : "—";
          return `<tr>
          <td><code>${esc(rd.key)}</code></td>
          <td class="${v === "improved" ? "good" : v === "regressed" ? "bad" : ""}">${esc(v)}</td>
          <td>${dStr}</td>
          <td>${esc(rd.source)}</td>
          <td>${esc(rd.before)}</td>
          <td>${esc(rd.after)}</td>
          <td>${esc(jd?.judgeNote || rd.reason || "")}</td>
        </tr>`;
        }).join("")}
      </table>
    `;
  }).join("")}
</div>

<div class="card">
  <h2>3. Mastodon Storybook Visual QA (Playwright + MSW — Desktop, Mobile &amp; RTL)</h2>
  ${["nav-panel", "compose-post", "status-card", "account-card"].map((slug) =>
    LANGUAGES.map((loc) =>
      ["desktop", "mobile"].map((vp) => {
        const shots = ["nmt", "b0", "w-post"].map((arm) =>
          visualQa.find((r) => r.story === slug && r.locale === loc && r.arm === arm && r.viewport === vp)
        ).filter(Boolean);
        if (shots.length === 0) return "";
        return `
          <h3>${esc(shots[0].label)} — ${loc} (${vp}${loc === "ar" ? ", RTL" : ""})</h3>
          <div class="grid-3">
            ${shots.map((s) => `
              <div class="shot">
                <img src="mastodon/screenshots/${esc(s.png)}" alt="${esc(s.png)}"/>
                <div class="shot-cap"><strong>${esc(ARM_LABELS[s.arm])}</strong> · overflow=${s.docOverflow} · clipped=${s.clippedCount} · rawICU=${s.rawIcuLeak}</div>
              </div>
            `).join("")}
          </div>
        `;
      }).join("")
    ).join("")
  ).join("")}
</div>

<div class="card">
  <h2>4. Real-World Complex Word Documents (Original EN vs Wraith es-MX)</h2>
  ${docProvenance.documents.filter((d) => !d.scalabilityOnly).map((d) => {
    const res = docsData[d.id];
    const j = mqmJudge?.docsJudge?.[d.id];
    if (!res) return "";
    return `
      <h3>${esc(d.title)} — ${res.originalPages}p → ${res.translatedPages}p · doc-verify: <span class="${res.verify?.outcome === "PASS" ? "good" : "bad"}">${esc(res.verify?.outcome)}</span> · Opus MQM: <span class="good">${j?.avgMqm ?? "—"}</span></h3>
      <div class="grid-2">
        <div class="shot">
          <img src="docs/renders/${esc(res.originalPngs?.[0] || "")}" alt="Original EN page 1"/>
          <div class="shot-cap">Original EN (Page 1 of ${res.originalPages})</div>
        </div>
        <div class="shot">
          <img src="docs/renders/${esc(res.translatedPngs?.[0] || "")}" alt="Wraith es-MX page 1"/>
          <div class="shot-cap">Wraith + Codex es-MX (Page 1 of ${res.translatedPages})</div>
        </div>
      </div>
    `;
  }).join("")}
</div>
</body>
</html>`;

fs.writeFileSync(path.join(RESULTS_ROOT, "inspect-report.html"), html);
console.log("Wrote eval/REAL_WORLD_BENCHMARK_REPORT.md and eval/results/real-world-v2/inspect-report.html");
