# Wraith MCP Pre-Launch Validation v3 — Frozen Methodology & Pre-Registration

> **Status:** FROZEN BEFORE EXECUTION  
> **Freeze Timestamp:** 2026-11-27  
> **Evaluated Wraith Baseline Commit:** `d9a8e34260672b81d8af13ad969b697e763bce93` (`v1.0.0`, PR #14 merged)  
> **Agent Runtime:** `codex-cli 0.172.0` (`gpt-6.2-astra`, `model_reasoning_effort = "high"`, `--ephemeral` fresh sessions per task/release)  
> **Target Locales:** Mexican Spanish (`es-MX`) and Arabic (`ar`, RTL + 6-form CLDR plurals)

---

## 1. Central Research Question

Does Wraith enable an existing coding agent (`Codex`) to perform professional localization engineering—including linguistic instruction adherence, translation memory leverage, terminology enforcement, change propagation, diagnostic QE, greenfield internationalization, complex document reconstruction, and multi-release maintenance—more **consistently, reliably, and efficiently** across projects, sessions, and releases than the same coding agent working unassisted?

---

## 2. Fairness & Experimental Conditions

We evaluate **Vanilla Codex (`A0`)** against **Codex + Simplified Wraith (`W`)** under two explicitly distinct experimental conditions:

### Condition 1: Equal-Information Comparison (`cond1-equal-info`)
- Both `A0` and `W` receive the **exact same** workspace files, source code, companion DOCX manual, project style guide, locale-specific overrides, custom translation prompt, CSV + TBX termbases, and seeded TMX 1.4 translation memory.
- For `W`, those linguistic assets are loaded into `.wraith/` via Wraith's documented configuration and importers (`styleGuide`, `importGlossaryCsv`, `importGlossaryTbx`, `importMemoryTmx`).
- For `A0`, the exact same files are placed prominently in `localization/` (e.g., `STYLE_GUIDE.md`, `TRANSLATION_PROMPT.md`, `LOCALE_RULES.md`, `glossary.csv`, `termbase.tbx`, `memory.tmx`) and explicitly referenced in the task prompt.
- **What this isolates:** Tooling, structured retrieval, and deterministic verification/enforcement value when both agents have identical information at session start.

### Condition 2: Persistent-Workflow Comparison (`cond2-persistent`, `v1 → v2 → v3`)
- Both `A0` and `W` begin in **Session 1 (`v1`)** with identical requirements, assets, and notice that this repository will undergo future releases (`v2`, `v3`) handled by **fresh ephemeral sessions** that will not have all rules re-pasted into the prompt.
- **`A0` is NOT artificially disadvantaged:** `A0` is explicitly permitted to establish whatever persistent files, documentation, glossaries, TM files, scripts, or validation harnesses it chooses in the repo during `v1` and maintain them across `v2` and `v3`. We record `A0`'s engineering effort (extra files, LOC, custom scripts) and token/cost overhead to build and maintain its own infrastructure alongside `W`.
- **Session 2 (`v2`, fresh `--ephemeral` session):** Source adds 15 new keys across components + edits 3 source keys; 3 target keys receive manual human edits between `v1` and `v2`. The developer gives only a concise release instruction (*"Localize the new and updated strings for v2 in `es-MX` and `ar`, preserving any human edits and following the project's established localization rules and assets"*).
- **Session 3 (`v3`, fresh `--ephemeral` session):** Mid-project linguistic asset updates occur (glossary term change, locale style override change, translation prompt update) while 2 affected keys are human-approved and 20+ keys are unrelated. The developer describes only the asset update and asks the agent to propagate changes accurately without breaking unrelated or human-approved strings.

---

## 3. Strict Separation: Controlled Challenges vs. Organic Production

- **Track 1 — Controlled Linguistic Asset & Instruction-Adherence Suite (`eval/results/prelaunch-v3/track1-linguistic/`):**  
  Multi-surface workspace (`PulseDesk`: React/TS UI across `nav`, `settings`, `forms`, `notifications`, `legal`, `sync`, `help`, Markdown docs `docs/guide.md`, and companion Word manual `docs/workspace-admin-manual.docx`) with **pre-registered expected outcomes** in `EXPECTED_OUTCOMES.json` covering all 9 linguistic asset dimensions (`PROMPT`, `STYLE`, `TERM`, `TM`, `XCOMP`, `XSESS`, `PROP`, `CONF`, `QE`).
- **Track 2 — Six Organic Unprepared Open-Source Applications (`eval/results/prelaunch-v3/track2-oss/`):**  
  Zero planted linguistic traps mixed into organic scores. Every app is pinned to an exact upstream commit verified to have **zero existing i18n**:

| ID | Repository | Pinned Commit SHA | Framework | Verification |
|---|---|---|---|---|
| `expensetracker` | `MaheshGitH/expensetracker` | `9b795b65242374606ce665ee255c92b0e45f02ac` | Next.js 16 + React 19 | `next build` + Playwright functional/visual/RTL + v2 maintenance + XLIFF round-trip |
| `shadcn-admin` | `satnaing/shadcn-admin` | `76b0248cb6a1fa6ab60c6de80a2f242cf2b3878f` | React + Vite + TS + shadcn/ui | `tsc -b && vite build` + Vitest + Playwright visual/RTL + v2 maintenance |
| `jovVix` | `Improwised/jovVix` (`app/`) | `fd16e6ba8e0ed425b1e63bf073a30c5812b9b255` | Nuxt 4 / Vue 3 + TS (open issue `#311`) | `nuxt build` + Vitest + Playwright visual/RTL + v2 maintenance |
| `crag-stats` | `Luen/crag-stats` | `1cf02343e2f1a60267d4a37be2168dd8b3361d46` (parent before `#11`) | SvelteKit + Svelte 5 + TS | `vite build` + Vitest + Playwright visual/RTL + v2 maintenance |
| `shelfarr` | `Pedro-Revez-Silva/shelfarr` | `7624b07096ed01e46c94a92a8ddb41351cf2161e` | Ruby on Rails 8.1 + Tailwind (open issue `#454`) | Ruby/ERB/YAML parse + Wraith Rails adapter + v2 maintenance |
| `calendars` | `suitenumerique/calendars` (`src/backend/`) | `de766e14ce322a5ff7b7c7e8b36b8ba616ba60cf` | Django 5.2 + Python (open issue `#142`) | Python/Django gettext compile + Wraith Django adapter + pytest where runnable + v2 maintenance |

- **Track 3 — Real-World Messy DOCX Corpus (`eval/results/prelaunch-v3/track3-docs/`):**  
  All 6 public DOCX specimens with frozen SHA-256 hashes (including **100% full translation of all 864 segments of the 52-page NCI SEER report**):

| ID | File | SHA-256 | Stress Features |
|---|---|---|---|
| `sop-lay-down-tubulars` | `eval/corpora/real-docs/sop-lay-down-tubulars.docx` | `c29e83dcc0b9d18e904849ec6e20ee93e91f9561a3d666deffee26740da4fe9e` | 19 nested tables, 163 segs, v1 + v2 maintenance + human edits |
| `hipaa-privacy-notice` | `eval/corpora/real-docs/hipaa-privacy-notice.docx` | `cebd91383486a63d4d9a79b77fc771faa6ccfdb081a5e72b5d358eddfb640f75` | 5p formal `usted`, header + 2 footers, 91 segs |
| `scientific-manuscript` | `eval/corpora/real-docs/scientific-manuscript.docx` | `958cc680955ae5ef86bee0834a762996b53a0e5c0c9016d99cd59b2989bcff8b` | 5.09 runs/para fragmentation, textbox, hyperlinks, 41 segs |
| `consulate-visa-form-footnotes` | `eval/corpora/real-docs/consulate-visa-form-footnotes.docx` | `a890294bfbdc63f6d03eab61efc1e98cb51d59f0920541150dd7082f9bdf31f1` | 69 Word form fields (`w:ffData`), footnotes + endnotes + footer, 105 segs |
| `tracked-changes-revisions` | `eval/corpora/real-docs/tracked-changes-revisions.docx` | `7ecad102602586be7f1371f117fc567ea47f3ed0ca703b353e003002f1ff8d3f` | 32 tracked insertions (`w:ins`) + 4 deletions (`w:del`), fragmented hyperlinks, 21 segs |
| `nci-seer-52p-stress` | `eval/corpora/real-docs/nci-seer-52p-stress.docx` | `89d0abb8eed1a58f262c49c386f74d8a82798d6344bed690d66b389514f0751c` | **52 pages, 864 segs, 117.8k chars, 30 fields, 296 links — 100% FULLY TRANSLATED** |

- **Track 4 — Real GitHub Action CI Execution (`eval/results/prelaunch-v3/track4-ci/`):**  
  Live GitHub Actions execution of `action.yml` against: (a) clean localized PR (`PASS`), (b) PR with deliberately planted regressions (`FAIL` with exact diagnostics + sticky PR comment), and (c) `/wraith answer` comment workflow.
- **Track 5 — Local TMS Interoperability (`XLIFF 1.2`, `XLIFF 2.0`, `TMX 1.4`, `TBX`):**  
  End-to-end export, simulated human TMS edits/sign-off, re-import, and `human-verified` protection. *(Live Crowdin/Phrase cloud API tests are explicitly marked out-of-scope unless sandbox credentials are supplied.)*

---

## 4. Fifteen Explicit Quantitative Metrics

All 15 metrics are computed by an independent deterministic scorer (`eval/bench/score-prelaunch-v3.mjs`) plus blinded LLM/human linguistic evaluation (`eval/bench/blind-judge-prelaunch-v3.mjs`, anonymized system IDs `SYS-A` / `SYS-B` in randomized order):

1. **Translation prompt adherence rate** = `passed_prompt_checks / total_prompt_checks` (initial `v1` and subsequent `v2`/`v3` reported separately)
2. **Style-guide adherence rate** = `passed_style_checks / total_style_checks` (project-wide + locale-specific override breakdown)
3. **Approved terminology adherence rate** = `approved_term_hits / total_approved_term_opportunities`
4. **Prohibited terminology violation rate** = `prohibited_term_violations / total_evaluated_strings`
5. **Do-not-translate preservation rate** = `exact_dnt_preserved / total_dnt_occurrences`
6. **Appropriate exact & fuzzy TM reuse** = `reused_appropriate_tm / total_appropriate_tm_opportunities` (exact and fuzzy reported separately)
7. **Incorrect TM reuse** = `copied_trap_tm / total_tm_traps` (misleading fuzzy traps and wrong-context exact traps reported separately)
8. **Missed TM leverage opportunities** = `1 - appropriate_tm_reuse_rate` (count and rate)
9. **Cross-component terminology consistency** = fraction of recurring domain concepts translated identically across all 6 surfaces (nav, settings, forms, notifications, Markdown docs, DOCX manual)
10. **Cross-session consistency** = `v2` adherence & terminology consistency with `v1` in fresh ephemeral sessions without repeated instructions
11. **Context-sensitive disambiguation accuracy** = `correct_polysemy_senses / total_polysemy_pairs`
12. **Linguistic asset change-propagation precision & recall** (`v3`):
    - `Recall = updated_expected_targets / total_expected_targets`
    - `Precision = updated_expected_targets / total_keys_modified_in_v3`
13. **Human-approved translation preservation** = `preserved_human_edits / total_human_edits` (across `v2` maintenance, `v3` asset propagation, and DOCX v2 updates)
14. **QE precision, recall & false-positive rate** (on the 24-string/locale controlled ground-truth set, plus zero-unauthorized-edits verification):
    - `Precision = TP / (TP + FP)`
    - `Recall = TP / (TP + FN)`
    - `FPR = FP / (FP + TN)`
15. **Human intervention, token consumption, latency & cost**: prompt interventions required, uncached/cached input tokens, output tokens, wall-clock seconds, estimated API USD (`$2.50/1M uncached input, $0.25/1M cached, $10.00/1M output`), plus `A0` custom-infrastructure engineering effort (files & LOC).

---

## 5. Defect Preservation & Post-Fix Reporting Policy

If any defect is discovered in Wraith (`d9a8e34`) during execution:
1. All original raw results, traces, and scores from `d9a8e34` are **permanently preserved untouched** under `eval/results/prelaunch-v3/baseline-d9a8e34/`.
2. The underlying defect is fixed in `src/` with a permanent regression test in `tests/`.
3. Any post-fix rerun is stored and reported **separately** under `eval/results/prelaunch-v3/post-fix-<sha>/` so pre-fix vs. post-fix evidence is completely transparent.
