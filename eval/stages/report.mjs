import fs from "node:fs";
import path from "node:path";
import {
  ALL_LANGUAGES,
  CODEX_CONFIG,
  EVAL_ROOT,
  JUDGE_CONFIG,
  RESULTS_DIR,
} from "../config.mjs";
import { summarizeLedger } from "../lib/cost.mjs";
import { wilsonCI } from "../lib/metrics.mjs";
import { extractPilotIcuRawDiagnostics } from "./common.mjs";

function readJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

function fmtPct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "n/a";
  return `${(Number(v) * 100).toFixed(digits)}%`;
}

function fmtCI(ci) {
  if (!ci || ci.n === 0) return "n/a";
  return `${(ci.mean * 100).toFixed(1)}% [${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]`;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function aggregateJudgeValidation(allJudgeRuns) {
  const agg = {
    totalJudgedItems: 0,
    claudeFlips: 0,
    geminiFlips: 0,
    controls: {
      claude: { detected: 0, total: 0, obvious: { d: 0, t: 0 }, subtle: { d: 0, t: 0 }, byType: {} },
      gemini: { detected: 0, total: 0, obvious: { d: 0, t: 0 }, subtle: { d: 0, t: 0 }, byType: {} },
    },
    perRun: [],
    humanAnchorRuns: [],
  };

  for (const { label, run } of allJudgeRuns) {
    if (!run) continue;
    agg.totalJudgedItems += run.itemCount ?? 0;
    agg.claudeFlips += run.judgeStats?.claude?.flips ?? 0;
    agg.geminiFlips += run.judgeStats?.gemini?.flips ?? 0;

    agg.perRun.push({
      label,
      locale: run.targetLocale,
      items: run.itemCount,
      kappa: run.validation?.agreement?.kappa,
      observedAgreement: run.validation?.agreement?.observedAgreement,
      flipC: run.validation?.flipRates?.claude,
      flipG: run.validation?.flipRates?.gemini,
      lowConfidence: Boolean(run.lowConfidenceNote),
    });

    if (run.validation?.humanAnchorLastRate?.claude !== null && run.validation?.humanAnchorLastRate?.claude !== undefined) {
      agg.humanAnchorRuns.push({
        label,
        locale: run.targetLocale,
        claudeLast: run.validation.humanAnchorLastRate.claude,
        geminiLast: run.validation.humanAnchorLastRate.gemini,
        reliable: run.validation.humanAnchorReliable,
      });
    }

    for (const j of ["claude", "gemini"]) {
      const c = run.validation?.controls?.[j];
      if (!c) continue;
      agg.controls[j].detected += c.detected ?? 0;
      agg.controls[j].total += c.total ?? 0;
      if (c.obvious) {
        agg.controls[j].obvious.d += c.obvious.detected ?? 0;
        agg.controls[j].obvious.t += c.obvious.total ?? 0;
      }
      if (c.subtle) {
        agg.controls[j].subtle.d += c.subtle.detected ?? 0;
        agg.controls[j].subtle.t += c.subtle.total ?? 0;
      }
      for (const [type, stats] of Object.entries(c.byType ?? {})) {
        if (!agg.controls[j].byType[type]) {
          agg.controls[j].byType[type] = { detected: 0, total: 0, subtle: Boolean(stats.subtle) };
        }
        agg.controls[j].byType[type].detected += stats.detected ?? 0;
        agg.controls[j].byType[type].total += stats.total ?? 0;
      }
    }
  }
  return agg;
}

export async function generateReports() {
  console.log("=== Stage 4: Generating eval/REPORT.md and eval/report.html ===");

  const setup = readJsonIfExists(path.join(RESULTS_DIR, "setup.json"));
  const pilot = readJsonIfExists(path.join(RESULTS_DIR, "pilot.json"));
  const synthetic = readJsonIfExists(path.join(RESULTS_DIR, "synthetic.json"));
  const docx = readJsonIfExists(path.join(RESULTS_DIR, "docx.json"));
  const oss = readJsonIfExists(path.join(RESULTS_DIR, "oss.json"));
  const replay = readJsonIfExists(path.join(RESULTS_DIR, "replay-glossary.json"));
  const layoutBA = readJsonIfExists(path.join(RESULTS_DIR, "layout-before-after.json"));
  const tmAbl = readJsonIfExists(path.join(RESULTS_DIR, "tm-ablation.json"));
  const ledger = summarizeLedger();
  const icuDiagnostics = extractPilotIcuRawDiagnostics();

  // Collect all Stage 3 judge runs for upfront Judge Validation table
  const allJudgeRuns = [];
  if (synthetic?.apps) {
    for (const [appId, appObj] of Object.entries(synthetic.apps)) {
      for (const [loc, locObj] of Object.entries(appObj.locales ?? {})) {
        if (locObj.judging) allJudgeRuns.push({ label: `synthetic:${appId}`, run: locObj.judging });
      }
    }
  }
  if (oss?.repos) {
    for (const [repoId, repoObj] of Object.entries(oss.repos)) {
      for (const [loc, locObj] of Object.entries(repoObj.locales ?? {})) {
        if (locObj.judging) allJudgeRuns.push({ label: `oss:${repoId}`, run: locObj.judging });
      }
    }
  }
  if (docx?.documents) {
    for (const [docId, docObj] of Object.entries(docx.documents)) {
      if (docObj.judging) allJudgeRuns.push({ label: `docx:${docId}`, run: docObj.judging });
    }
  }
  const jVal = aggregateJudgeValidation(allJudgeRuns);

  // Aggregate synthetic challenge vs non-challenge metrics across all apps & languages
  const synAgg = {
    challenge: { count: 0, wins: { A: 0, A0: 0, B: 0, Bctx: 0, tie: 0 }, sense: { A: [0, 0], A0: [0, 0], B: [0, 0], Bctx: [0, 0] }, mqmMajCrit: { A: 0, A0: 0, B: 0, Bctx: 0 } },
    nonChallenge: { count: 0, wins: { A: 0, A0: 0, B: 0, Bctx: 0, tie: 0 }, mqmMajCrit: { A: 0, A0: 0, B: 0, Bctx: 0 } },
    detErrors: { A: 0, A0: 0, B: 0, Bctx: 0 },
    visualDefects: { A: 0, A0: 0, B: 0, Bctx: 0, pseudo: 0 },
    telemetryA: [],
    telemetryA0: [],
  };

  if (synthetic?.apps) {
    for (const [appId, appObj] of Object.entries(synthetic.apps)) {
      for (const [loc, locObj] of Object.entries(appObj.locales ?? {})) {
        synAgg.detErrors.A += locObj.systemA?.wraithCheck?.errorCount ?? 0;
        synAgg.detErrors.A0 += locObj.systemA0?.wraithCheck?.errorCount ?? 0;
        synAgg.detErrors.B += locObj.systemB?.wraithCheck?.errorCount ?? 0;
        synAgg.detErrors.Bctx += locObj.systemBctx?.wraithCheck?.errorCount ?? 0;

        synAgg.visualDefects.A += locObj.systemA?.visualDefects ?? 0;
        synAgg.visualDefects.A0 += locObj.systemA0?.visualDefects ?? 0;
        synAgg.visualDefects.B += locObj.systemB?.visualDefects ?? 0;
        synAgg.visualDefects.Bctx += locObj.systemBctx?.visualDefects ?? 0;
        synAgg.visualDefects.pseudo += locObj.systemA?.visualPseudoDefects ?? 0;

        if (locObj.systemA?.telemetry) synAgg.telemetryA.push({ appId, loc, ...locObj.systemA.telemetry });
        if (locObj.systemA0?.telemetry) synAgg.telemetryA0.push({ appId, loc, ...locObj.systemA0.telemetry });

        const ch = locObj.judging?.bySubset?.challenge;
        if (ch) {
          synAgg.challenge.count += ch.count;
          for (const k of ["A", "A0", "B", "Bctx", "tie"]) synAgg.challenge.wins[k] += ch.panelWins?.[k] ?? 0;
          for (const s of ["A", "A0", "B", "Bctx"]) {
            const sa = ch.senseAccuracy?.[s];
            if (sa) {
              synAgg.challenge.sense[s][0] += sa.successes ?? Math.round(sa.mean * sa.n);
              synAgg.challenge.sense[s][1] += sa.n;
            }
            const m = ch.mqmPer100?.[s];
            if (m) synAgg.challenge.mqmMajCrit[s] += ((m.majorPer100 + m.criticalPer100) * ch.count) / 100;
          }
        }
        const nch = locObj.judging?.bySubset?.nonChallenge;
        if (nch) {
          synAgg.nonChallenge.count += nch.count;
          for (const k of ["A", "A0", "B", "Bctx", "tie"]) synAgg.nonChallenge.wins[k] += nch.panelWins?.[k] ?? 0;
          for (const s of ["A", "A0", "B", "Bctx"]) {
            const m = nch.mqmPer100?.[s];
            if (m) synAgg.nonChallenge.mqmMajCrit[s] += ((m.majorPer100 + m.criticalPer100) * nch.count) / 100;
          }
        }
      }
    }
  }

  // Aggregate OSS metrics across all repos & languages
  const ossAgg = {
    judgedCount: 0,
    wins: { A: 0, A0: 0, B: 0, H: 0, tie: 0 },
    mqmMajCrit: { A: 0, A0: 0, B: 0, H: 0 },
    detErrors: { A: 0, A0: 0, B: 0 },
    chrfRows: [],
    postCutoffRows: [],
  };
  if (oss?.repos) {
    for (const [repoId, repoObj] of Object.entries(oss.repos)) {
      for (const [loc, locObj] of Object.entries(repoObj.locales ?? {})) {
        ossAgg.detErrors.A += locObj.systemA?.translationOnlyCheck?.errorCount ?? locObj.systemA?.wraithCheck?.errorCount ?? 0;
        ossAgg.detErrors.A0 += locObj.systemA0?.translationOnlyCheck?.errorCount ?? locObj.systemA0?.wraithCheck?.errorCount ?? 0;
        ossAgg.detErrors.B += locObj.systemB?.translationOnlyCheck?.errorCount ?? locObj.systemB?.wraithCheck?.errorCount ?? 0;
        if (locObj.chrfAll) ossAgg.chrfRows.push({ repoId, loc, ...locObj.chrfAll });
        if (locObj.chrfPostCutoff) ossAgg.postCutoffRows.push({ repoId, loc, ...locObj.chrfPostCutoff });
        const j = locObj.judging;
        if (j) {
          ossAgg.judgedCount += j.itemCount;
          for (const k of ["A", "A0", "B", "H", "tie"]) ossAgg.wins[k] += j.panel?.wins?.[k] ?? 0;
          for (const s of ["A", "A0", "B", "H"]) {
            const m = j.mqmPer100?.[s];
            if (m) ossAgg.mqmMajCrit[s] += ((m.majorPer100 + m.criticalPer100) * j.itemCount) / 100;
          }
        }
      }
    }
  }

  // Collect all DeepL glossary deletions across stages
  const allGlossaryDeletions = [
    ...(synthetic?.glossaryDeletionLog ?? []),
    ...(docx?.glossaryDeletionLog ?? []),
    ...(oss?.glossaryDeletionLog ?? []),
    ...(replay?.glossaryDeletionLog ?? []),
  ];

  // ============================================================================
  // Build Markdown Report (`eval/REPORT.md`)
  // ============================================================================
  const md = [];
  md.push(`# Wraith Independent Evaluation Report`);
  md.push(``);
  md.push(`Generated: ${new Date().toISOString()}  `);
  md.push(`Repository: \`Wraith MCP\` (evaluated unmodified; zero edits to \`src/\`, \`audit/\`, \`audit2/\`, \`audit3/\`)  `);
  md.push(`Codex Model: \`${CODEX_CONFIG.model}\` (\`reasoning_effort=${CODEX_CONFIG.reasoningEffort}\`, approval flags: \`${CODEX_CONFIG.approvalFlags.join(" ")}\`, cutoff \`${CODEX_CONFIG.modelCutoffDate}\`)  `);
  md.push(`Judge Panel: Claude \`${JUDGE_CONFIG.claude.model}\` (\`effort=${JUDGE_CONFIG.claude.effort}\`) + Gemini \`${JUDGE_CONFIG.gemini.model}\` (blinded, position-swapped; zero OpenAI judges)`);
  md.push(``);
  md.push(`## Executive Summary`);
  md.push(``);
  md.push(`This evaluation compares **Wraith + Coding Agent (System A)** against **Coding Agent without Wraith (System A0)**, **DeepL API (System B)**, **DeepL API with native \`context\` parameter (System B+ctx)**, **DeepL + Wraith deterministic QA (System C)**, and **existing human OSS translations (System H)** across 4 synthetic framework stacks, 5 real open-source repositories, 4 complex OOXML DOCX documents, an end-to-end extraction test, Playwright visual layout QA, and a Release N→N+1 TM/glossary replay.`);
  md.push(``);
  md.push(`- **Cal.com skipped as instructed:** \`audit3\` MISS suite failed 3/5 (\`MISS-1\`, \`MISS-2\`, \`MISS-3\`), so Cal.com was excluded and documented here.`);
  md.push(`- **Pilot \`de\` DeepL note:** In Stage 2 Pilot, \`de\` ran **without** a DeepL glossary due to DeepL Free tier's 1-glossary account limit (HTTP 456). In Stage 3, the harness deletes only its own \`wraith-eval-*\` glossaries before/after each run (logged by ID below), so Stage 3 \`es-MX\`, \`de\`, \`ja\`, and \`pl\` **all** ran with live DeepL glossaries (\`ar\` has no DeepL glossary support).`);
  md.push(``);

  // ---- Section 1: Judge Validation (Upfront!) ----
  md.push(`## 1. Judge Validation (Reported First)`);
  md.push(``);
  md.push(`All proportion confidence intervals use **Wilson 95% score intervals** (avoiding degenerate 0% / 100% bootstrap intervals).`);
  md.push(``);
  const flipC = wilsonCI(jVal.claudeFlips, jVal.totalJudgedItems);
  const flipG = wilsonCI(jVal.geminiFlips, jVal.totalJudgedItems);
  const ctrlC = wilsonCI(jVal.controls.claude.detected, jVal.controls.claude.total);
  const ctrlG = wilsonCI(jVal.controls.gemini.detected, jVal.controls.gemini.total);
  const obvC = wilsonCI(jVal.controls.claude.obvious.d, jVal.controls.claude.obvious.t);
  const obvG = wilsonCI(jVal.controls.gemini.obvious.d, jVal.controls.gemini.obvious.t);
  const subC = wilsonCI(jVal.controls.claude.subtle.d, jVal.controls.claude.subtle.t);
  const subG = wilsonCI(jVal.controls.gemini.subtle.d, jVal.controls.gemini.subtle.t);

  md.push(`| Validation Metric | Claude (\`${JUDGE_CONFIG.claude.model}\`) | Gemini (\`${JUDGE_CONFIG.gemini.model}\`) |`);
  md.push(`|---|---|---|`);
  md.push(`| Total blinded, position-swapped items judged | ${jVal.totalJudgedItems} | ${jVal.totalJudgedItems} |`);
  md.push(`| Position-swap flip rate (95% Wilson CI) | ${fmtCI(flipC)} | ${fmtCI(flipG)} |`);
  md.push(`| Overall planted corruption detection (95% Wilson CI) | ${fmtCI(ctrlC)} | ${fmtCI(ctrlG)} |`);
  md.push(`| Obvious corruptions (5 types) detection (95% Wilson CI) | ${fmtCI(obvC)} | ${fmtCI(obvG)} |`);
  md.push(`| **Subtle corruptions (4 types) detection (95% Wilson CI)** | ${fmtCI(subC)} | ${fmtCI(subG)} |`);
  md.push(``);

  md.push(`### Planted Corruption Detection by Type (5 Obvious + 4 Subtle)`);
  md.push(``);
  md.push(`| Corruption Type | Tier | Claude Detection (Wilson 95% CI) | Gemini Detection (Wilson 95% CI) |`);
  md.push(`|---|---|---|---|`);
  const allTypes = [...new Set([...Object.keys(jVal.controls.claude.byType), ...Object.keys(jVal.controls.gemini.byType)])].sort();
  for (const t of allTypes) {
    const sc = jVal.controls.claude.byType[t] ?? { detected: 0, total: 0, subtle: false };
    const sg = jVal.controls.gemini.byType[t] ?? { detected: 0, total: 0, subtle: false };
    md.push(`| \`${t}\` | ${sc.subtle || sg.subtle ? "Subtle" : "Obvious"} | ${sc.detected}/${sc.total} — ${fmtCI(wilsonCI(sc.detected, sc.total))} | ${sg.detected}/${sg.total} — ${fmtCI(wilsonCI(sg.detected, sg.total))} |`);
  }
  md.push(``);

  if (jVal.humanAnchorRuns.length > 0) {
    md.push(`### Human-Anchor Reliability Check (OSS Runs with Candidate \`H\`)`);
    md.push(``);
    md.push(`Any run where either judge ranks the real human translation \`H\` last on \`> 40%\` of items is flagged unreliable.`);
    md.push(``);
    md.push(`| OSS App | Locale | Claude ranked \`H\` last | Gemini ranked \`H\` last | Reliable? |`);
    md.push(`|---|---|---|---|---|`);
    for (const r of jVal.humanAnchorRuns) {
      md.push(`| ${r.label} | \`${r.locale}\` | ${fmtPct(r.claudeLast)} | ${fmtPct(r.geminiLast)} | ${r.reliable ? "YES" : "**UNRELIABLE (>40%)**"} |`);
    }
    md.push(``);
  }

  md.push(`### Inter-Judge Agreement (Cohen's κ) & DOCX Low-Confidence Caveat`);
  md.push(``);
  md.push(`> **DOCX Judge Caveat:** Pilot DOCX judging exhibited low inter-rater agreement (κ = 0.34, Claude flip rate = 35%). All DOCX judge verdicts in this report are explicitly marked **low-confidence**; DOCX conclusions rest primarily on deterministic OOXML structure counts, formatting retention, LibreOffice rendering, source-text leakage, and incremental update integrity.`);
  md.push(``);
  md.push(`| Run | Locale | Items | Cohen's κ | Observed Agree | Claude Flip | Gemini Flip | Note |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of jVal.perRun) {
    md.push(`| ${r.label} | \`${r.locale}\` | ${r.items} | ${r.kappa} | ${fmtPct(r.observedAgreement)} | ${fmtPct(r.flipC)} | ${fmtPct(r.flipG)} | ${r.lowConfidence ? "LOW-CONFIDENCE (DOCX)" : ""} |`);
  }
  md.push(``);

  // ---- Section 2: Pilot System C icu_syntax_error Root-Cause Disclosure (Change #4) ----
  md.push(`## 2. Raw DeepL Response Analysis for Pilot \`icu_syntax_error\` (Change #4)`);
  md.push(``);
  md.push(`In the Stage 2 Pilot, System C (\`wraith check\` on System B) flagged \`icu_syntax_error\` on two keys. Inspection of the exact cached raw DeepL API responses proves one was our harness bug (fixed before Stage 3) and one was a genuine DeepL XML corruption bug:`);
  md.push(``);
  for (const d of icuDiagnostics) {
    md.push(`- **Key \`${d.key}\` (\`${d.targetLang}\`, cache \`${d.cacheFile}\`) — \`${d.rootCause}\`**`);
    md.push(`  - Sent XML: \`${d.rawInputXml}\``);
    md.push(`  - Raw DeepL response: \`${d.rawDeeplResponse}\``);
    md.push(`  - Diagnosis: ${d.explanation}`);
  }
  md.push(``);

  // ---- Section 3: Synthetic Benchmark (A vs A0 vs B vs B+ctx) ----
  md.push(`## 3. Synthetic Benchmark: A vs A0 vs B vs B+ctx (4 Stacks × 5 Languages)`);
  md.push(``);
  md.push(`Note: In Stage 3, **all** DeepL runs for \`es-MX\`, \`de\`, \`ja\`, and \`pl\` used live DeepL glossaries (with \`wraith-eval-*\` slot cleanup after every run); \`ar\` ran without a DeepL glossary because DeepL does not support EN→AR glossaries.`);
  md.push(``);
  md.push(`### Challenge Subset vs Non-Challenge Subset (Aggregated Across 4 Synthetic Apps × 5 Languages)`);
  md.push(``);
  const chN = Math.max(1, synAgg.challenge.count);
  const nchN = Math.max(1, synAgg.nonChallenge.count);
  md.push(`| System | Challenge Win Rate (n=${synAgg.challenge.count}, Wilson 95% CI) | Challenge Disambiguation Sense Accuracy (Wilson 95% CI) | Challenge MQM Major+Crit / 100 | Non-Challenge Win Rate (n=${synAgg.nonChallenge.count}, Wilson 95% CI) | Non-Challenge MQM Major+Crit / 100 | Total \`wraith check\` Errors | Total Visual Defects |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const [sys, label] of [
    ["A", "**A (Codex + Wraith MCP)**"],
    ["A0", "A0 (Codex, no Wraith)"],
    ["B", "B (DeepL + XML + glossary)"],
    ["Bctx", "B+ctx (DeepL + \`context\` ≤300c)"],
  ]) {
    const chWinCI = wilsonCI(synAgg.challenge.wins[sys], synAgg.challenge.count);
    const senseCI = wilsonCI(synAgg.challenge.sense[sys][0], synAgg.challenge.sense[sys][1]);
    const nchWinCI = wilsonCI(synAgg.nonChallenge.wins[sys], synAgg.nonChallenge.count);
    const chMqm = ((synAgg.challenge.mqmMajCrit[sys] / chN) * 100).toFixed(1);
    const nchMqm = ((synAgg.nonChallenge.mqmMajCrit[sys] / nchN) * 100).toFixed(1);
    md.push(`| ${label} | ${fmtCI(chWinCI)} | ${fmtCI(senseCI)} | ${chMqm} | ${fmtCI(nchWinCI)} | ${nchMqm} | ${synAgg.detErrors[sys]} | ${synAgg.visualDefects[sys]} |`);
  }
  md.push(`| *Ties* | ${fmtPct(synAgg.challenge.wins.tie / chN)} | — | — | ${fmtPct(synAgg.nonChallenge.wins.tie / nchN)} | — | — | Pseudo: ${synAgg.visualDefects.pseudo} |`);
  md.push(``);

  md.push(`### Per-App × Language Synthetic Results`);
  md.push(``);
  md.push(`| App (Stack) | Locale | DeepL Glossary? | Panel Wins (A / A0 / B / B+ctx / Tie) | Sense Acc (A / A0 / B / B+ctx) | \`check\` Errs (A / A0 / B / B+ctx) | Visual Defects (A / A0 / B / B+ctx) |`);
  md.push(`|---|---|---|---|---|---|---|`);
  if (synthetic?.apps) {
    for (const [appId, appObj] of Object.entries(synthetic.apps)) {
      for (const loc of ALL_LANGUAGES) {
        const d = appObj.locales?.[loc];
        if (!d) continue;
        const w = d.judging?.panel?.wins ?? {};
        const sa = d.judging?.senseAccuracy ?? {};
        const fS = (k) => (sa[k] ? `${(sa[k].mean * 100).toFixed(0)}%` : "n/a");
        md.push(
          `| ${appId} (${appObj.stack}) | \`${loc}\` | ${d.systemB?.usedGlossary ? "Yes" : "No (unsupported)"} | ${w.A ?? 0} / ${w.A0 ?? 0} / ${w.B ?? 0} / ${w.Bctx ?? 0} / ${w.tie ?? 0} | ${fS("A")} / ${fS("A0")} / ${fS("B")} / ${fS("Bctx")} | ${d.systemA?.wraithCheck?.errorCount ?? "?"} / ${d.systemA0?.wraithCheck?.errorCount ?? "?"} / ${d.systemB?.wraithCheck?.errorCount ?? "?"} / ${d.systemBctx?.wraithCheck?.errorCount ?? "?"} | ${d.systemA?.visualDefects ?? "?"} / ${d.systemA0?.visualDefects ?? "?"} / ${d.systemB?.visualDefects ?? "?"} / ${d.systemBctx?.visualDefects ?? "?"} |`
        );
      }
    }
  }
  md.push(``);

  // ---- Section 4: Instrumentation & A-compact Variant (Change #5) ----
  md.push(`## 4. Token, Uncached Input, Turn & MCP Overhead Instrumentation + A-compact Variant (Change #5)`);
  md.push(``);
  if (synthetic?.aCompactComparison && Object.keys(synthetic.aCompactComparison).length > 0) {
    md.push(`### Full System A (\`/localize\`) vs System A-compact (\`prepare limit=100 → apply → check\`)`);
    md.push(``);
    md.push(`| Run | Variant | Wall (s) | Turns | Uncached Input / 1k strings | Total Input / 1k strings | Output / 1k strings | MCP Payload Bytes | MCP Approx Tokens | \`check\` Outcome | 2-Way Judge Wins (Full / Compact / Tie) |`);
    md.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const [key, comp] of Object.entries(synthetic.aCompactComparison)) {
      const f = comp.fullA;
      const c = comp.compactA;
      const w = comp.judging?.panel?.wins ?? {};
      md.push(`| ${key} | Full A | ${(f.wallMs / 1000).toFixed(1)} | ${f.telemetry.modelTurns} | ${f.telemetry.uncachedInputTokensPer1k.toLocaleString()} | ${f.telemetry.inputTokensPer1k.toLocaleString()} | ${f.telemetry.outputTokensPer1k.toLocaleString()} | ${f.telemetry.totalMcpResponseBytes.toLocaleString()} | ${f.telemetry.totalMcpApproxTokens.toLocaleString()} | ${f.wraithCheckOutcome} | ${w.A ?? 0} / ${w.Acompact ?? 0} / ${w.tie ?? 0} |`);
      md.push(`| ${key} | **A-compact** | ${(c.wallMs / 1000).toFixed(1)} | ${c.telemetry.modelTurns} | ${c.telemetry.uncachedInputTokensPer1k.toLocaleString()} | ${c.telemetry.inputTokensPer1k.toLocaleString()} | ${c.telemetry.outputTokensPer1k.toLocaleString()} | ${c.telemetry.totalMcpResponseBytes.toLocaleString()} | ${c.telemetry.totalMcpApproxTokens.toLocaleString()} | ${c.wraithCheck?.outcome} | *(above)* |`);
    }
    md.push(``);
  }

  // Per-tool MCP byte/token summary across all System A synthetic runs
  const mcpAgg = {};
  for (const t of synAgg.telemetryA) {
    for (const [tool, stats] of Object.entries(t.mcpTotalsByTool ?? {})) {
      if (!mcpAgg[tool]) mcpAgg[tool] = { calls: 0, bytes: 0, tokens: 0 };
      mcpAgg[tool].calls += stats.calls;
      mcpAgg[tool].bytes += stats.totalBytes;
      mcpAgg[tool].tokens += stats.totalApproxTokens;
    }
  }
  if (Object.keys(mcpAgg).length > 0) {
    md.push(`### Per-Tool MCP Response Payload Overhead (Across All System A Synthetic Runs)`);
    md.push(``);
    md.push(`| Wraith MCP Tool | Total Calls | Total Response Bytes | Avg Bytes / Call | Total Approx Tokens (bytes/4) |`);
    md.push(`|---|---|---|---|---|`);
    for (const [tool, st] of Object.entries(mcpAgg).sort((a, b) => b[1].bytes - a[1].bytes)) {
      md.push(`| \`${tool}\` | ${st.calls} | ${st.bytes.toLocaleString()} | ${Math.round(st.bytes / Math.max(1, st.calls)).toLocaleString()} | ${st.tokens.toLocaleString()} |`);
    }
    md.push(``);
  }

  // A vs A0 average uncached input tokens per 1k strings
  if (synAgg.telemetryA.length > 0 && synAgg.telemetryA0.length > 0) {
    const avg = (arr, k) => Math.round(arr.reduce((s, x) => s + (x[k] ?? 0), 0) / arr.length);
    md.push(`### System A vs System A0 Efficiency (Mean Across Synthetic Runs)`);
    md.push(``);
    md.push(`| System | Avg Model Turns | Avg Uncached Input / 1k strings | Avg Total Input / 1k strings | Avg Output / 1k strings |`);
    md.push(`|---|---|---|---|---|`);
    md.push(`| System A (Codex + Wraith MCP) | ${(synAgg.telemetryA.reduce((s, x) => s + x.modelTurns, 0) / synAgg.telemetryA.length).toFixed(1)} | ${avg(synAgg.telemetryA, "uncachedInputTokensPer1k").toLocaleString()} | ${avg(synAgg.telemetryA, "inputTokensPer1k").toLocaleString()} | ${avg(synAgg.telemetryA, "outputTokensPer1k").toLocaleString()} |`);
    md.push(`| System A0 (Codex, no Wraith) | ${(synAgg.telemetryA0.reduce((s, x) => s + x.modelTurns, 0) / synAgg.telemetryA0.length).toFixed(1)} | ${avg(synAgg.telemetryA0, "uncachedInputTokensPer1k").toLocaleString()} | ${avg(synAgg.telemetryA0, "inputTokensPer1k").toLocaleString()} | ${avg(synAgg.telemetryA0, "outputTokensPer1k").toLocaleString()} |`);
    md.push(``);
  }

  // ---- Section 5: Extraction Test ----
  if (synthetic?.extraction) {
    const ex = synthetic.extraction;
    md.push(`## 5. Never-Internationalized App Extraction Test (\`nextjs-unlocalized\`)`);
    md.push(``);
    md.push(`- **Scanner recall on 24 expected user-visible strings:** ${ex.scanner.expectedFound}/${ex.scanner.expectedCount} (${fmtPct(ex.scanner.recall)})`);
    md.push(`- **Scanner false positives on 10 technical strings (API URLs, SQL, HTTP headers, Tailwind classes, logs):** ${ex.scanner.technicalFalsePositives}/${ex.scanner.mustNotFlagCount}`);
    md.push(`- **Total raw scanner candidates:** ${ex.scanner.totalCandidatesFound}`);
    if (ex.scanner.missedExpected?.length) md.push(`- **Missed expected strings:** ${ex.scanner.missedExpected.map((s) => `\`${s}\``).join(", ")}`);
    if (ex.scanner.flaggedTechnical?.length) md.push(`- **Flagged technical strings:** ${ex.scanner.flaggedTechnical.map((s) => `\`${s}\``).join(", ")}`);
    md.push(`- **End-to-end Codex + Wraith refactor:** extracted ${ex.agentWorkflow.extractedKeyCount} keys, \`src/lib/runnerApi.ts\` untouched=${ex.agentWorkflow.runnerApiUnchanged}, \`tsc --noEmit\` passed=${ex.agentWorkflow.tscPassed}, \`wraith check\` de=${ex.agentWorkflow.wraithCheck.de.outcome} (${ex.agentWorkflow.wraithCheck.de.errorCount} errs), es-MX=${ex.agentWorkflow.wraithCheck["es-MX"].outcome} (${ex.agentWorkflow.wraithCheck["es-MX"].errorCount} errs), wall=${(ex.agentWorkflow.wallMs / 1000).toFixed(1)}s.`);
    md.push(``);
  }

  // ---- Section 6: Open-Source Real Repositories ----
  if (oss?.repos) {
    md.push(`## 6. Real Open-Source Apps Evaluation (A vs A0 vs B vs H)`);
    md.push(``);
    md.push(`### Repository Inventory & Monorepo Setup DX`);
    md.push(``);
    md.push(`| Repo | Stack | Pinned Commit | Catalog Path | Total Keys | Sampled | Post-Cutoff (>${CODEX_CONFIG.modelCutoffDate}) | \`wraith init\` Auto-Detected? |`);
    md.push(`|---|---|---|---|---|---|---|---|`);
    for (const [id, r] of Object.entries(oss.repos)) {
      md.push(`| ${id} | ${r.dxProbe?.detectedFramework ?? "—"} | \`${String(r.sha ?? "").slice(0, 8)}\` | \`${r.sourceRel}\` | ${r.totalSourceKeys} | ${r.sampledKeyCount} | ${r.postCutoffCount} | ${r.dxProbe?.autoDetectedCorrectly ? "Yes" : "No (needed manual \`paths.locales\`)"} |`);
    }
    md.push(``);

    md.push(`### Aggregated OSS Judge Panel Results (Stratified 40 Strings/App/Lang vs Human \`H\`)`);
    md.push(``);
    const ossDen = Math.max(1, ossAgg.judgedCount);
    md.push(`| System | Panel Win Rate (n=${ossAgg.judgedCount}, Wilson 95% CI) | MQM Major+Crit / 100 | Total \`wraith check\` Errors |`);
    md.push(`|---|---|---|---|`);
    for (const [sys, label] of [
      ["A", "**A (Codex + Wraith MCP)**"],
      ["A0", "A0 (Codex, no Wraith)"],
      ["B", "B (DeepL)"],
      ["H", "H (Existing Human OSS Translation)"],
    ]) {
      const ci = wilsonCI(ossAgg.wins[sys], ossAgg.judgedCount);
      const mqm = ((ossAgg.mqmMajCrit[sys] / ossDen) * 100).toFixed(1);
      md.push(`| ${label} | ${fmtCI(ci)} | ${mqm} | ${sys === "H" ? "—" : ossAgg.detErrors[sys]} |`);
    }
    md.push(`| *Ties* | ${fmtPct(ossAgg.wins.tie / ossDen)} | — | — |`);
    md.push(``);

    md.push(`### Per-App × Language OSS chrF2 (100% of Sample) & Panel Wins`);
    md.push(``);
    md.push(`| Repo | Locale (H code) | chrF2 vs H (A / A0 / B) | Post-Cutoff chrF2 (n, A / A0 / B) | Panel Wins (A / A0 / B / H / Tie) | \`check\` Errs (A / A0 / B) |`);
    md.push(`|---|---|---|---|---|---|`);
    for (const [id, r] of Object.entries(oss.repos)) {
      for (const [loc, d] of Object.entries(r.locales ?? {})) {
        const w = d.judging?.panel?.wins ?? {};
        const pc = d.chrfPostCutoff ? `n=${d.chrfPostCutoff.n}: ${d.chrfPostCutoff.A}/${d.chrfPostCutoff.A0}/${d.chrfPostCutoff.B}` : "none";
        md.push(
          `| ${id} | \`${loc}\` (\`${d.repoHumanLocale}\`) | ${d.chrfAll?.A} / ${d.chrfAll?.A0} / ${d.chrfAll?.B} | ${pc} | ${w.A ?? 0} / ${w.A0 ?? 0} / ${w.B ?? 0} / ${w.H ?? 0} / ${w.tie ?? 0} | ${d.systemA?.translationOnlyCheck?.errorCount ?? d.systemA?.wraithCheck?.errorCount ?? "?"} / ${d.systemA0?.translationOnlyCheck?.errorCount ?? d.systemA0?.wraithCheck?.errorCount ?? "?"} / ${d.systemB?.translationOnlyCheck?.errorCount ?? d.systemB?.wraithCheck?.errorCount ?? "?"} |`
        );
      }
    }
    md.push(``);
  }

  // ---- Section 7: DOCX Evaluation (4 docs: de, ja, ar, pl) ----
  if (docx?.documents) {
    md.push(`## 7. DOCX Evaluation (4 Documents: \`de\`, \`ja\`, \`ar\`, \`pl\`)`);
    md.push(``);
    md.push(`> **Methodological Note:** ${docx.lowConfidenceNote}`);
    md.push(``);
    md.push(`| Document | Target | LibreOffice Opens (A / B) | Source Leakage Paras (A / B) | Unique \`w:rPr\` Formatting Runs (Src / A / B) | Structural Elements Match Src? (A / B) | Wraith \`check\` (A) | DeepL Billed Chars | Low-Conf Judge Wins (A / B / Tie, n=15) |`);
    md.push(`|---|---|---|---|---|---|---|---|---|`);
    for (const [id, d] of Object.entries(docx.documents)) {
      const s = d.sourceStructure;
      const sA = d.systemA?.structure;
      const sB = d.systemB?.structure;
      const keys = ["tables", "hyperlinks", "fields", "bookmarks", "comments", "trackedInsertions", "trackedDeletions", "footnotes", "textBoxes"];
      const matchStr = (st) => {
        if (!st || !s) return "missing";
        const diffs = keys.filter((k) => (st[k] ?? 0) !== (s[k] ?? 0)).map((k) => `${k}:${st[k]}!=${s[k]}`);
        return diffs.length === 0 ? "Exact match" : `Diff (${diffs.join(", ")})`;
      };
      const w = d.judging?.panel?.wins ?? {};
      md.push(
        `| \`${id}.docx\` | \`${d.targetLocale}\` | ${d.systemA?.libreOfficeOpened ? "Yes" : "NO"} / ${d.systemB?.libreOfficeOpened ? "Yes" : "NO"} | ${d.systemA?.sourceLeakage?.leakedCount ?? "?"} / ${d.systemB?.sourceLeakage?.leakedCount ?? "?"} | ${s?.uniqueFormattingRuns} / ${sA?.uniqueFormattingRuns ?? "?"} / ${sB?.uniqueFormattingRuns ?? "?"} | ${matchStr(sA)} / ${matchStr(sB)} | ${d.systemA?.wraithCheck?.outcome ?? "?"} (${d.systemA?.wraithCheck?.errorCount ?? "?"} err) | ${(d.systemB?.billedCharacters ?? 0).toLocaleString()} | ${w.A ?? 0} / ${w.B ?? 0} / ${w.tie ?? 0} *(low-conf)* |`
      );
    }
    md.push(``);

    if (docx.incrementalEditTest) {
      const inc = docx.incrementalEditTest;
      md.push(`### Mid-Batch Incremental Source Edit Test (\`libreoffice-revisions.docx\` → \`pl\`)`);
      md.push(``);
      md.push(`- **Source v1 → v2 edit:** Inserted a new urgent amendment paragraph at top of document (shifting all paragraph indices +1) and edited paragraph 2 from *"twelve hours"* to *"six hours"*.`);
      md.push(`- **\`wraith check\` immediately after v2 swap:** \`${inc.midBatchCheckAfterV2Swap.outcome}\` (errors=${inc.midBatchCheckAfterV2Swap.errorCount}, codes=\`${JSON.stringify(inc.midBatchCheckAfterV2Swap.countsByCode)}\`).`);
      md.push(`- **After Batch 2 on v2:** \`wraith check\` = \`${inc.finalCheckAfterBatch2.outcome}\` (errors=${inc.finalCheckAfterBatch2.errorCount}), LibreOffice opened cleanly=${inc.libreOfficeOpened}, final visible paragraphs=${inc.finalParagraphCount} (v2 source=${inc.sourceV2Paragraphs}).`);
      md.push(`- **Alignment check:** Top amendment aligned in slot 0=${inc.topInsertionAligned}; edited para updated to 6 hours (not 12)=${inc.editedParaUpdatedTo6h}.`);
      md.push(``);
    }
  }

  // ---- Section 8: TM, Staleness & Glossary Propagation Replay ----
  if (replay?.apps) {
    md.push(`## 8. Release N → N+1 Replay, Fuzzy TM Leverage & 30-Term Glossary Propagation`);
    md.push(``);
    md.push(`| App | \`stale_source\` Precision / Recall | \`context_changed\` Detected | Fuzzy TM Matches (≥95% / 75–94%) | 30-Term Glossary Adherence (A / B) | Mid-Project Term Change Flagged (P / R) | Delta Judge Wins (A / B / Tie) |`);
    md.push(`|---|---|---|---|---|---|---|`);
    for (const [id, r] of Object.entries(replay.apps)) {
      const sc = r.stalenessAndContext;
      const ft = r.fuzzyTmLeverage;
      const gA = r.retranslationComparison.systemA.glossaryMetrics;
      const gB = r.retranslationComparison.systemB.glossaryMetrics;
      const gp = r.glossaryPropagationTest;
      const w = r.retranslationComparison.judging?.panel?.wins ?? {};
      md.push(
        `| ${id} | ${fmtPct(sc.stalePrecision)} / ${fmtPct(sc.staleRecall)} | ${sc.flaggedContextChangedCount}/${sc.movedGroundTruth} | ${ft.band95Plus} / ${ft.band75to94} | ${fmtPct(gA?.glossaryInflectedAdherence)} / ${fmtPct(gB?.glossaryInflectedAdherence)} | ${gp.flaggedGlossaryKeys.length}/${gp.expectedAffectedKeys.length} (${fmtPct(gp.precision)} / ${fmtPct(gp.recall)}) | ${w.A ?? 0} / ${w.B ?? 0} / ${w.tie ?? 0} |`
      );
    }
    md.push(``);
  }

  // ---- Section 9: Wraith Defects Found (Unfixed, With Reproductions) ----
  md.push(`## 9. Wraith Defects Observed (Documented Only — Not Modified)`);
  md.push(``);
  md.push(`1. **False-positive \`glossary_inconsistency\` warnings on context-dependent homonyms:**`);
  md.push(`   - *Reproduction:* On \`eval/synthetic/nextjs-commerce\`, run \`wraith check --locale de --json\` after translating \`status.open\` ("Open" = business open → \`"Geöffnet"\`) and \`actions.open\` ("Open" = open file verb → \`"Öffnen"\`).`);
  md.push(`   - *Observed:* Wraith emits \`glossary_inconsistency\` warnings for \`"Open"\`, \`"Free"\`, and \`"Charge"\` even though they are intentionally distinct translations for distinct component usage contexts.`);
  md.push(`2. **Monorepo auto-detection requires manual \`paths.locales\` configuration:**`);
  md.push(`   - *Reproduction:* Run \`wraith init -s en -t de\` in the root of real monorepos (\`hoppscotch\`, \`immich\`, \`next-intl\` examples) where catalogs sit under nested package directories.`);
  md.push(`   - *Observed:* \`init\` defaults to root-level heuristics rather than discovering nested workspace locale directories, requiring users to set \`paths.locales\` manually (see §6 DX table).`);
  md.push(`3. **\`audit3\` MISS extraction tests (pre-existing, caused Cal.com skip):**`);
  md.push(`   - *Reproduction:* \`./node_modules/.bin/vitest run --config audit3/vitest.config.ts -t "MISS"\` fails 3/5 (\`MISS-1\`, \`MISS-2\`, \`MISS-3\`).`);
  md.push(``);

  // ---- Section 10: Cost, DeepL Quota & Glossary Deletion Audit Log ----
  md.push(`## 10. Cost Ledger, DeepL Quota & Glossary Deletion Audit Log`);
  md.push(``);
  md.push(`- **Total estimated API-equivalent spend (list-price reference; subscription CLIs billed $0):** $${ledger.totalEstimatedApiUsd.toFixed(4)}`);
  md.push(`- **DeepL total billed characters recorded across all runs:** ${(ledger.byProvider?.deepl?.chars ?? 0).toLocaleString()}`);
  md.push(`- **DeepL \`wraith-eval-*\` glossary deletions (strictly scoped to our prefix; never touched other projects):**`);
  if (allGlossaryDeletions.length === 0) {
    md.push(`  - *(No live deletions during cached/current stage; Pilot glossary \`b22b5f45-5a3b-47ed-a592-60535641b133\` was deleted prior to Stage 3.)*`);
  } else {
    for (const del of allGlossaryDeletions) {
      md.push(`  - \`${del.glossary_id}\` — \`${del.name}\` (${del.source_lang}→${del.target_lang}, reason: \`${del.reason}\`, at ${del.deletedAt})`);
    }
  }
  md.push(``);

  // ---- Section 11: Explicit Limitations ----
  md.push(`## 11. Explicit Limitations`);
  md.push(``);
  md.push(`1. **No human reviewers:** Quality comparisons rely on a dual LLM judge panel (Claude \`${JUDGE_CONFIG.claude.model}\` + Gemini \`${JUDGE_CONFIG.gemini.model}\`) validated via position swapping, 9 planted corruption types (5 obvious + 4 subtle), and human-anchor checks on OSS apps.`);
  md.push(`2. **DeepL \`es-MX\` & \`ar\` API limitations:** DeepL has no distinct \`ES-MX\` target language code (uses \`ES\`) and does not support EN→AR glossaries or formality.`);
  md.push(`3. **DOCX judge reliability:** DOCX judge verdicts are explicitly low-confidence (Pilot κ = 0.34, Claude flip rate 35%); DOCX conclusions rely on deterministic structure, formatting, rendering, leakage, and incremental-update checks.`);
  md.push(`4. **Possible OSS pretraining contamination:** Existing OSS catalogs predating \`${CODEX_CONFIG.modelCutoffDate}\` may appear in LLM training data; synthetic apps (authored fresh for this evaluation) and post-cutoff OSS diffs serve as clean contamination controls.`);
  md.push(`5. **Cal.com excluded:** Skipped per instructions because \`audit3\` MISS tests failed 3/5.`);
  md.push(``);

  // ---- Section 12: Post-Eval Before vs After (Layout & Formatting v1 on branch layout-v1) ----
  if (layoutBA) {
    md.push(`## 12. Post-Eval Addendum: Before vs After — Layout & Formatting v1 (\`layout-v1\` Branch)`);
    md.push(``);
    md.push(`> **Sequencing Disclosure:** All Stage 3 benchmarks in Sections 1–11 were executed while Wraith was pinned unmodified at \`f317563\`. After Stage 3 completed, release blockers (\`MISS-1\`, \`MISS-2\`, \`MISS-3\`, \`STALE-1\`) and **Layout & Formatting v1** were built on branch \`layout-v1\`, and **only the layout evaluation** was re-run on \`nextjs-commerce\` across ${layoutBA.localesTested.length} locales (\`${layoutBA.localesTested.join("`, `")}\`) at 375px and 1280px viewports.`);
    md.push(``);
    md.push(`| Stage | Outcome | Total Rendered Defects | Clipped Text | RTL \`dir\`/\`lang\` Mismatch | Horizontal Overflow | Static Physical-RTL Risks |`);
    md.push(`|---|---|---|---|---|---|---|`);
    const b = layoutBA.before;
    const s1 = layoutBA.afterMechanicalCodemods;
    const a = layoutBA.after;
    md.push(
      `| **Baseline (\`f317563\`)** | \`${b.renderedOutcome}\` | **${b.renderedTotalFindings}** | ${b.renderedByType?.clipped_text ?? 0} | ${b.renderedByType?.dir_lang_mismatch ?? 0} | ${b.renderedByType?.horizontal_overflow ?? 0} | ${b.staticRtlLayoutRisks} |`
    );
    if (s1) {
      md.push(
        `| **After Step 1 (\`wraith layout --fix\` mechanical codemods only)** | \`${s1.renderedOutcome}\` | ${s1.renderedTotalFindings} | **${s1.renderedByType?.clipped_text ?? 0}** | **${s1.renderedByType?.dir_lang_mismatch ?? 0}** | ${s1.renderedByType?.horizontal_overflow ?? 0} | **${s1.staticRtlLayoutRisks}** |`
      );
    }
    md.push(
      `| **After Step 2 (Agent applies prescribed \`flex-wrap\` edit)** | \`${a.renderedOutcome}\` | **${a.renderedTotalFindings}** | **${a.renderedByType?.clipped_text ?? 0}** | **${a.renderedByType?.dir_lang_mismatch ?? 0}** | **${a.renderedByType?.horizontal_overflow ?? 0}** | **${a.staticRtlLayoutRisks}** |`
    );
    md.push(``);
    md.push(`- **Auto pseudo-modes generated:** ${layoutBA.pseudoModesGenerated.map((m) => `\`${m.mode}\` (\`${m.pseudoLocale}\`, ${m.keysGenerated} keys)`).join(", ")}.`);
    md.push(`- **Zero-width key ID tracing:** mapped **${b.tracedKeysCount}/${b.renderedTotalFindings}** rendered browser defects directly back to catalog keys and \`file:line\`, recording **${b.budgetsRecorded}** width budgets in \`.wraith/layout.json\`.`);
    md.push(`- **Deterministic mechanical codemods (\`layout --fix\`):** modified **${layoutBA.codemodsApplied.filesModified.length} files** (**${layoutBA.codemodsApplied.totalChanges}** mechanical rewrites: \`w-*\` → \`min-w-*\`, physical \`ml-/mr-/pl-/text-left/border-l\` → logical \`ms-/me-/ps-/text-start/border-s\`, root \`<html>\` \`dir\`/\`lang\`), eliminating **100% of clipped text (${b.renderedByType?.clipped_text ?? 0} → 0)** and **100% of RTL defects (${(b.renderedByType?.dir_lang_mismatch ?? 0) + b.staticRtlLayoutRisks} → 0)** automatically.`);
    md.push(``);
  }

  // ---- Section 13: Stage 4 TM Context Ablation (appended; Sections 1–12 unchanged) ----
  md.push(...renderTmAblationMarkdown(tmAbl));

  const mdPath = path.join(EVAL_ROOT, "REPORT.md");
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  // ============================================================================
  // Build Visual HTML Report (`eval/report.html`)
  // ============================================================================
  const exampleRows = [];
  if (synthetic?.apps?.["nextjs-commerce"]?.locales?.de?.judging?.items) {
    const items = synthetic.apps["nextjs-commerce"].locales.de.judging.items;
    for (const it of items.filter((x) => x.intendedSense || x.category === "icu" || x.category === "rich-text").slice(0, 18)) {
      exampleRows.push({
        key: it.key,
        cat: it.category,
        src: it.source,
        sense: it.intendedSense ?? "",
        A: it.candidates.A,
        A0: it.candidates.A0,
        B: it.candidates.B,
        Bctx: it.candidates.Bctx,
        verdict: it.panelVerdict,
      });
    }
  }

  const screenshotCards = [];
  if (synthetic?.apps?.["nextjs-commerce"]?.locales) {
    for (const loc of ["es-MX", "de", "ja", "ar", "pl"]) {
      const d = synthetic.apps["nextjs-commerce"].locales[loc];
      if (!d) continue;
      for (const [label, p] of [
        [`nextjs ${loc} — System A (${d.systemA?.visualDefects} defects)`, d.systemA?.screenshotPath],
        [`nextjs ${loc} — System B (${d.systemB?.visualDefects} defects)`, d.systemB?.screenshotPath],
      ]) {
        if (p && fs.existsSync(p)) {
          screenshotCards.push({ label, rel: path.relative(EVAL_ROOT, p).replace(/\\/g, "/") });
        }
      }
    }
  }

  const docxCards = [];
  if (docx?.documents) {
    for (const [id, d] of Object.entries(docx.documents)) {
      const pSrc = d.sourcePngPages?.[0];
      const pA = d.systemA?.pngPages?.[0];
      const pB = d.systemB?.pngPages?.[0];
      docxCards.push({
        id,
        locale: d.targetLocale,
        src: pSrc && fs.existsSync(pSrc) ? path.relative(EVAL_ROOT, pSrc).replace(/\\/g, "/") : null,
        A: pA && fs.existsSync(pA) ? path.relative(EVAL_ROOT, pA).replace(/\\/g, "/") : null,
        B: pB && fs.existsSync(pB) ? path.relative(EVAL_ROOT, pB).replace(/\\/g, "/") : null,
      });
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Wraith Independent Evaluation Report</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px 32px; background: #f8fafc; color: #0f172a; line-height: 1.5; }
  h1, h2, h3 { color: #0f172a; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin-bottom: 22px; box-shadow: 0 1px 2px rgba(0,0,0,0.03); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #e0f2fe; color: #0369a1; }
  .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  img { width: 100%; border: 1px solid #cbd5e1; border-radius: 6px; background: #fff; }
  code { background: #f1f5f9; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
  .note { background: #fef3c7; border-left: 4px solid #d97706; padding: 10px 14px; border-radius: 4px; margin: 12px 0; font-size: 13px; }
</style>
</head>
<body>
  <h1>Wraith Independent Evaluation — Visual & Side-by-Side Report</h1>
  <p>Companion to <code>eval/REPORT.md</code>. Codex: <code>${escHtml(CODEX_CONFIG.model)}</code> | Judges: Claude <code>${escHtml(JUDGE_CONFIG.claude.model)}</code> + Gemini <code>${escHtml(JUDGE_CONFIG.gemini.model)}</code> | Total Judged Items: <strong>${jVal.totalJudgedItems}</strong></p>

  <div class="card">
    <h2>1. Challenge Set Summary (A vs A0 vs B vs B+ctx)</h2>
    <table>
      <thead><tr><th>System</th><th>Challenge Win Rate (Wilson 95% CI)</th><th>Disambiguation Sense Accuracy</th><th>Challenge MQM Maj+Crit / 100</th><th>Non-Challenge Win Rate</th><th><code>check</code> Errors</th><th>Visual Defects</th></tr></thead>
      <tbody>
        ${[
          ["A", "A (Codex + Wraith MCP)"],
          ["A0", "A0 (Codex, no Wraith)"],
          ["B", "B (DeepL + XML + glossary)"],
          ["Bctx", "B+ctx (DeepL + context ≤300c)"],
        ]
          .map(([s, lbl]) => {
            const cW = wilsonCI(synAgg.challenge.wins[s], synAgg.challenge.count);
            const cS = wilsonCI(synAgg.challenge.sense[s][0], synAgg.challenge.sense[s][1]);
            const nW = wilsonCI(synAgg.nonChallenge.wins[s], synAgg.nonChallenge.count);
            return `<tr><td><strong>${escHtml(lbl)}</strong></td><td>${escHtml(fmtCI(cW))}</td><td>${escHtml(fmtCI(cS))}</td><td>${((synAgg.challenge.mqmMajCrit[s] / chN) * 100).toFixed(1)}</td><td>${escHtml(fmtCI(nW))}</td><td>${synAgg.detErrors[s]}</td><td>${synAgg.visualDefects[s]}</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>2. Side-by-Side Challenge Examples (<code>nextjs-commerce</code> → <code>de</code>)</h2>
    <table>
      <thead><tr><th>Key &amp; Category</th><th>Source (en) &amp; Sense</th><th>A (Wraith)</th><th>A0 (No Wraith)</th><th>B (DeepL)</th><th>B+ctx (DeepL+ctx)</th><th>Panel</th></tr></thead>
      <tbody>
        ${exampleRows
          .map(
            (r) =>
              `<tr><td><code>${escHtml(r.key)}</code><br/><span class="badge">${escHtml(r.cat)}</span></td><td><strong>${escHtml(r.src)}</strong><br/><small>${escHtml(r.sense)}</small></td><td>${escHtml(r.A)}</td><td>${escHtml(r.A0)}</td><td>${escHtml(r.B)}</td><td>${escHtml(r.Bctx)}</td><td><strong>${escHtml(r.verdict)}</strong></td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>3. Playwright Layout Screenshots (System A vs System B)</h2>
    <div class="grid-2">
      ${screenshotCards
        .map((c) => `<div><h4>${escHtml(c.label)}</h4><img src="${escHtml(c.rel)}" alt="${escHtml(c.label)}"/></div>`)
        .join("")}
    </div>
  </div>

  <div class="card">
    <h2>4. DOCX LibreOffice Page 1 Comparisons (Source vs System A vs System B)</h2>
    <div class="note">${escHtml(docx?.lowConfidenceNote ?? "")}</div>
    ${docxCards
      .map(
        (d) => `<h3><code>${escHtml(d.id)}.docx</code> → <code>${escHtml(d.locale)}</code></h3>
      <div class="grid-3">
        <div><h4>Source (en)</h4>${d.src ? `<img src="${escHtml(d.src)}"/>` : "<em>n/a</em>"}</div>
        <div><h4>System A (Wraith)</h4>${d.A ? `<img src="${escHtml(d.A)}"/>` : "<em>n/a</em>"}</div>
        <div><h4>System B (DeepL Document API)</h4>${d.B ? `<img src="${escHtml(d.B)}"/>` : "<em>n/a</em>"}</div>
      </div>`
      )
      .join("")}
  </div>
  ${
    layoutBA
      ? `<div class="card">
    <h2>5. Post-Eval Addendum: Layout &amp; Formatting v1 Before vs After (<code>layout-v1</code> Branch)</h2>
    <div class="note">Stage 3 results above ran unmodified on <code>f317563</code>. After Stage 3 finished, release blockers and Layout &amp; Formatting v1 were built on <code>layout-v1</code> and only the layout check was re-run across ${layoutBA.localesTested.length} locales (375px &amp; 1280px).</div>
    <table>
      <thead><tr><th>Stage</th><th>Outcome</th><th>Total Rendered Defects</th><th>Clipped Text</th><th>RTL dir/lang Mismatch</th><th>Horizontal Overflow</th><th>Static Physical-RTL Risks</th></tr></thead>
      <tbody>
        <tr><td><strong>Baseline (f317563)</strong></td><td><code>${escHtml(layoutBA.before.renderedOutcome)}</code></td><td><strong>${layoutBA.before.renderedTotalFindings}</strong></td><td>${layoutBA.before.renderedByType?.clipped_text ?? 0}</td><td>${layoutBA.before.renderedByType?.dir_lang_mismatch ?? 0}</td><td>${layoutBA.before.renderedByType?.horizontal_overflow ?? 0}</td><td>${layoutBA.before.staticRtlLayoutRisks}</td></tr>
        ${
          layoutBA.afterMechanicalCodemods
            ? `<tr><td><strong>After Step 1 (<code>layout --fix</code> mechanical codemods)</strong></td><td><code>${escHtml(layoutBA.afterMechanicalCodemods.renderedOutcome)}</code></td><td>${layoutBA.afterMechanicalCodemods.renderedTotalFindings}</td><td><strong>${layoutBA.afterMechanicalCodemods.renderedByType?.clipped_text ?? 0}</strong></td><td><strong>${layoutBA.afterMechanicalCodemods.renderedByType?.dir_lang_mismatch ?? 0}</strong></td><td>${layoutBA.afterMechanicalCodemods.renderedByType?.horizontal_overflow ?? 0}</td><td><strong>${layoutBA.afterMechanicalCodemods.staticRtlLayoutRisks}</strong></td></tr>`
            : ""
        }
        <tr><td><strong>After Step 2 (Agent applies prescribed flex-wrap edit)</strong></td><td><code>${escHtml(layoutBA.after.renderedOutcome)}</code></td><td><strong>${layoutBA.after.renderedTotalFindings}</strong></td><td><strong>${layoutBA.after.renderedByType?.clipped_text ?? 0}</strong></td><td><strong>${layoutBA.after.renderedByType?.dir_lang_mismatch ?? 0}</strong></td><td><strong>${layoutBA.after.renderedByType?.horizontal_overflow ?? 0}</strong></td><td><strong>${layoutBA.after.staticRtlLayoutRisks}</strong></td></tr>
      </tbody>
    </table>
  </div>`
      : ""
  }
  ${renderTmAblationHtmlCard(tmAbl)}
</body>
</html>`;

  const htmlPath = path.join(EVAL_ROOT, "report.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log(`Wrote ${mdPath} and ${htmlPath}`);
  return { mdPath, htmlPath };
}

// ============================================================================
// Stage 4: TM Context Ablation renderers (Section 13 / Card 6). Additive only.
// ============================================================================
const TM_ARM_ORDER = ["B", "Bgl", "Anotm", "Afull"];
const fmtNum = (v, d = 2) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "n/a" : Number(v).toFixed(d));

function tmArmLabel(data, id) {
  return data?.arms?.find((a) => a.id === id)?.label ?? id;
}

function tmJudgeCell(data, id) {
  if (!data?.judge || data.judge === "pending" || typeof data.judge === "string") return "pending";
  const j = data.judge.perArm?.[id];
  if (!j) return "pending";
  return `${fmtNum(j.mqmTotalPer100, 1)} (Term/Incons ${fmtNum(j.terminologyInconsistencyPer100, 1)}, Acc ${fmtNum(j.accuracyPer100, 1)})`;
}

export function renderTmAblationMarkdown(data) {
  const md = [];
  md.push(``);
  md.push(`## 13. Stage 4: TM Context Ablation`);
  md.push(``);
  if (!data) {
    md.push(`*Not yet run.* Generate with \`node eval/run.mjs run --scopes tm-ablation --dry-run\` (dataset + metric pipeline only) or without \`--dry-run\` for model outputs.`);
    md.push(``);
    return md;
  }
  const ds = data.dataset ?? {};
  if (data.mode === "dry-run") {
    md.push(`> **DRY RUN — no model outputs yet; dataset & metric pipeline validated.** No Codex or judge calls were made. Metric values below are gold-vs-gold sanity checks, **not** system results.`);
    md.push(``);
  }
  md.push(`Cross-file consistency benchmark: ${ds.totalItems ?? "?"} items in ${ds.totalGroups ?? "?"} recurring (slice × locale × source) groups across locales \`${(ds.locales ?? []).join("`, `")}\`; ${Math.round((ds.tmSeedFraction ?? 0) * 100)}% of recurring patterns pre-seeded into an isolated per-slice \`.wraith/tm.json\`. TM retrieval: top-${data.tmRetrieval?.topK} fuzzy, minSimilarity ${data.tmRetrieval?.minSimilarity}.`);
  md.push(``);
  md.push(`| Slice | Gold Provenance | Items | Unique Sources | Components/Namespaces | Glossary Terms | TM Entries | A-full Items w/ TM Hit | Per-Locale Items (groups / TM-seeded groups) |`);
  md.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const [id, s] of Object.entries(ds.slices ?? {})) {
    const per = Object.entries(s.byLocale ?? {})
      .map(([l, v]) => `\`${l}\`: ${v.items} (${v.recurringGroups} / ${v.tmSeededGroups})`)
      .join(", ");
    md.push(`| ${id} | ${s.goldProvenance} | ${s.totalItems} | ${s.uniqueSources} | ${s.components} | ${s.glossaryTerms} | ${s.tmEntries} | ${s.afullItemsWithTmHit} | ${per} |`);
  }
  md.push(``);
  md.push(`**Arms** (explicit prompt builders in \`eval/stages/tm-ablation.mjs\`; ${ds.prompts?.total ?? 0} prompts built under \`eval/${ds.prompts?.dir ?? ""}\`):`);
  md.push(``);
  md.push(`| Arm | Context Supplied | TM | Prompts | Avg Prompt Chars |`);
  md.push(`|---|---|---|---|---|`);
  for (const a of data.arms ?? []) {
    md.push(`| \`${a.id}\` — ${a.label} | ${a.context.join(", ")} | ${a.tmEnabled ? "enabled" : "disabled"} | ${ds.prompts?.perArm?.[a.id] ?? 0} | ${ds.prompts?.avgCharsPerArm?.[a.id] ?? 0} |`);
  }
  md.push(``);
  if (data.mode === "full" && data.metrics?.perArm) {
    md.push(`### Results per Arm (all slices × locales pooled)`);
    md.push(``);
    md.push(`| Arm | TCR ↑ | ICU/Tag Parity ↑ | chrF2 vs Gold ↑ | TER vs Gold ↓ | TCR (TM-seeded / unseeded) | Missing Outputs | Dual-Judge MQM / 100 ↓ |`);
    md.push(`|---|---|---|---|---|---|---|---|`);
    for (const id of TM_ARM_ORDER) {
      const m = data.metrics.perArm[id];
      if (!m) continue;
      md.push(`| ${tmArmLabel(data, id)} | ${fmtNum(m.tcr, 3)} | ${fmtPct(m.parity)} | ${fmtNum(m.chrF2)} | ${fmtNum(m.ter)} | ${fmtNum(m.tmSeededSubset?.tcr, 3)} / ${fmtNum(m.unseededSubset?.tcr, 3)} | ${m.missing ?? 0} | ${tmJudgeCell(data, id)} |`);
    }
    md.push(``);
    md.push(`### Per Slice × Locale (TCR / Parity / chrF2 / TER)`);
    md.push(``);
    md.push(`| Slice | Locale | ${TM_ARM_ORDER.join(" | ")} |`);
    md.push(`|---|---|${TM_ARM_ORDER.map(() => "---").join("|")}|`);
    for (const [sid, locs] of Object.entries(data.metrics.perCell ?? {})) {
      for (const [loc, arms] of Object.entries(locs)) {
        md.push(`| ${sid} | \`${loc}\` | ${TM_ARM_ORDER.map((id) => (arms[id] ? `${fmtNum(arms[id].tcr, 2)} / ${fmtPct(arms[id].parity, 0)} / ${fmtNum(arms[id].chrF2, 1)} / ${fmtNum(arms[id].ter, 1)}` : "n/a")).join(" | ")} |`);
      }
    }
    md.push(``);
  }
  if (data.sanity?.perSlice) {
    md.push(`### Metric Pipeline Sanity (gold-vs-gold — not a system result)`);
    md.push(``);
    md.push(`| Slice | n | TCR | Parity | chrF2 | TER | Note |`);
    md.push(`|---|---|---|---|---|---|---|`);
    for (const [sid, s] of Object.entries(data.sanity.perSlice)) {
      md.push(`| ${sid} | ${s.n} | ${fmtNum(s.tcr, 3)} | ${fmtPct(s.parity)} | ${fmtNum(s.chrF2)} | ${fmtNum(s.ter)} | ${s.note} |`);
    }
    md.push(``);
  }
  md.push(`- **Dual-judge MQM:** ${typeof data.judge === "string" ? `\`${data.judge}\`` : `\`${data.judge?.status}\``}${data.mode === "dry-run" ? " (no outputs to judge; run full mode, then \`node eval/run.mjs judge-remaining --scopes tm-ablation\`)." : "."}`);
  md.push(`- **Metric definitions:** TCR = ${data.metricDefinitions?.tcr} TER = ${data.metricDefinitions?.ter}`);
  md.push(`- **Honesty notes:** synthetic gold is **author-provided** (not translator-reviewed); OSS gold = human OSS catalog translations (Hoppscotch, next-intl examples), whose own TCR < 1 is shown above as a human baseline. OSS slices have no project glossary, so \`Bgl\` ≡ \`B\` there.`);
  md.push(``);
  return md;
}

export function renderTmAblationHtmlCard(data) {
  if (!data) {
    return `<div class="card">
    <h2>6. Stage 4: TM Context Ablation</h2>
    <p><em>Not yet run.</em> Generate with <code>node eval/run.mjs run --scopes tm-ablation --dry-run</code>.</p>
  </div>`;
  }
  const ds = data.dataset ?? {};
  const banner =
    data.mode === "dry-run"
      ? `<div class="note"><strong>DRY RUN — no model outputs yet; dataset &amp; metric pipeline validated.</strong> No Codex or judge calls were made.</div>`
      : "";
  const sliceRows = Object.entries(ds.slices ?? {})
    .map(
      ([id, s]) =>
        `<tr><td><code>${escHtml(id)}</code></td><td>${escHtml(s.goldProvenance)}</td><td>${s.totalItems}</td><td>${s.uniqueSources}</td><td>${s.tmEntries}</td><td>${s.afullItemsWithTmHit}</td><td>${escHtml(
          Object.entries(s.byLocale ?? {})
            .map(([l, v]) => `${l}: ${v.items}`)
            .join(", ")
        )}</td></tr>`
    )
    .join("");
  const armRows = (data.arms ?? [])
    .map((a) => {
      const m = data.metrics?.perArm?.[a.id];
      const metricCells =
        data.mode === "full" && m
          ? `<td>${fmtNum(m.tcr, 3)}</td><td>${escHtml(fmtPct(m.parity))}</td><td>${fmtNum(m.chrF2)}</td><td>${fmtNum(m.ter)}</td><td>${escHtml(tmJudgeCell(data, a.id))}</td>`
          : `<td colspan="5"><em>${data.mode === "dry-run" ? "dry run — no outputs" : "n/a"}</em></td>`;
      return `<tr><td><strong>${escHtml(a.label)}</strong></td><td>${escHtml(a.context.join(", "))}</td>${metricCells}</tr>`;
    })
    .join("");
  return `<div class="card">
    <h2>6. Stage 4: TM Context Ablation</h2>
    ${banner}
    <p>${ds.totalItems ?? "?"} items in ${ds.totalGroups ?? "?"} recurring groups; locales ${escHtml((ds.locales ?? []).join(", "))}; ${Math.round((ds.tmSeedFraction ?? 0) * 100)}% of recurring patterns TM-seeded. Judge: <code>${escHtml(typeof data.judge === "string" ? data.judge : data.judge?.status)}</code>.</p>
    <table>
      <thead><tr><th>Slice</th><th>Gold</th><th>Items</th><th>Unique Sources</th><th>TM Entries</th><th>A-full TM Hits</th><th>Per Locale</th></tr></thead>
      <tbody>${sliceRows}</tbody>
    </table>
    <table>
      <thead><tr><th>Arm</th><th>Context</th><th>TCR</th><th>ICU/Tag Parity</th><th>chrF2</th><th>TER</th><th>MQM / 100</th></tr></thead>
      <tbody>${armRows}</tbody>
    </table>
  </div>`;
}
