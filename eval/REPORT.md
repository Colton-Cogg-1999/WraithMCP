# Wraith Independent Evaluation Report

Generated: 2026-11-25T17:57:48.526Z  
Repository: `Wraith MCP` (evaluated unmodified; zero edits to `src/`, `audit/`, `audit2/`, `audit3/`)  
Codex Model: `gpt-6.2-astra` (`reasoning_effort=high`, approval flags: `--approve-for-me`, cutoff `2026-03-01`)  
Judge Panel: Claude `sonnet` (`effort=medium`) + Gemini `gemini-4-carbon-medium` (blinded, position-swapped; zero OpenAI judges)

## Executive Summary

This evaluation compares **Wraith + Coding Agent (System A)** against **Coding Agent without Wraith (System A0)**, **DeepL API (System B)**, **DeepL API with native `context` parameter (System B+ctx)**, **DeepL + Wraith deterministic QA (System C)**, and **existing human OSS translations (System H)** across 4 synthetic framework stacks, 5 real open-source repositories, 4 complex OOXML DOCX documents, an end-to-end extraction test, Playwright visual layout QA, and a Release N→N+1 TM/glossary replay.

- **Cal.com skipped as instructed:** `audit3` MISS suite failed 3/5 (`MISS-1`, `MISS-2`, `MISS-3`), so Cal.com was excluded and documented here.
- **Pilot `de` DeepL note:** In Stage 2 Pilot, `de` ran **without** a DeepL glossary due to DeepL Free tier's 1-glossary account limit (HTTP 456). In Stage 3, the harness deletes only its own `wraith-eval-*` glossaries before/after each run (logged by ID below), so Stage 3 `es-MX`, `de`, `ja`, and `pl` **all** ran with live DeepL glossaries (`ar` has no DeepL glossary support).

## 1. Judge Validation (Reported First)

All proportion confidence intervals use **Wilson 95% score intervals** (avoiding degenerate 0% / 100% bootstrap intervals).

| Validation Metric | Claude (`sonnet`) | Gemini (`gemini-4-carbon-medium`) |
|---|---|---|
| Total blinded, position-swapped items judged | 1122 | 1122 |
| Position-swap flip rate (95% Wilson CI) | 14.9% [12.9%, 17.1%] | 7.5% [6.1%, 9.2%] |
| Overall planted corruption detection (95% Wilson CI) | 100.0% [98.3%, 100.0%] | 100.0% [98.8%, 100.0%] |
| Obvious corruptions (5 types) detection (95% Wilson CI) | 100.0% [96.9%, 100.0%] | 100.0% [97.9%, 100.0%] |
| **Subtle corruptions (4 types) detection (95% Wilson CI)** | 100.0% [96.2%, 100.0%] | 100.0% [97.4%, 100.0%] |

### Planted Corruption Detection by Type (5 Obvious + 4 Subtle)

| Corruption Type | Tier | Claude Detection (Wilson 95% CI) | Gemini Detection (Wilson 95% CI) |
|---|---|---|---|
| `dropped_placeholder` | Obvious | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `glossary_dnt_violation` | Obvious | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `missing_negation` | Subtle | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `small_meaning_shift` | Subtle | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `truncated_meaning` | Obvious | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `wrong_formality` | Subtle | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `wrong_language` | Obvious | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `wrong_number_or_unit` | Subtle | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |
| `wrong_sense` | Obvious | 24/24 — 100.0% [86.2%, 100.0%] | 36/36 — 100.0% [90.4%, 100.0%] |

### Inter-Judge Agreement (Cohen's κ) & DOCX Low-Confidence Caveat

> **DOCX Judge Caveat:** Pilot DOCX judging exhibited low inter-rater agreement (κ = 0.34, Claude flip rate = 35%). All DOCX judge verdicts in this report are explicitly marked **low-confidence**; DOCX conclusions rest primarily on deterministic OOXML structure counts, formatting retention, LibreOffice rendering, source-text leakage, and incremental update integrity.

| Run | Locale | Items | Cohen's κ | Observed Agree | Claude Flip | Gemini Flip | Note |
|---|---|---|---|---|---|---|---|
| synthetic:nextjs-commerce | `es-MX` | 60 | 0.5851 | 86.7% | 8.3% | 1.7% |  |
| synthetic:nextjs-commerce | `de` | 60 | 0.5526 | 85.0% | 11.7% | 5.0% |  |
| synthetic:nextjs-commerce | `ja` | 60 | 0.3769 | 76.7% | 23.3% | 11.7% |  |
| synthetic:nextjs-commerce | `ar` | 60 | 0.43 | 75.0% | 26.7% | 10.0% |  |
| synthetic:nextjs-commerce | `pl` | 60 | 0.513 | 76.7% | 25.0% | 8.3% |  |
| synthetic:vue-dashboard | `es-MX` | 25 | 0.4737 | 92.0% | 12.0% | 0.0% |  |
| synthetic:vue-dashboard | `de` | 25 | 0.7826 | 96.0% | 32.0% | 8.0% |  |
| synthetic:vue-dashboard | `ja` | 25 | 0.734 | 96.0% | 24.0% | 4.0% |  |
| synthetic:vue-dashboard | `ar` | 25 | 0.5 | 84.0% | 32.0% | 4.0% |  |
| synthetic:vue-dashboard | `pl` | 25 | 0.5833 | 84.0% | 36.0% | 8.0% |  |
| synthetic:rails-portal | `es-MX` | 20 | 0.708 | 90.0% | 25.0% | 10.0% |  |
| synthetic:rails-portal | `de` | 20 | 0.4667 | 90.0% | 40.0% | 15.0% |  |
| synthetic:rails-portal | `ja` | 20 | 0.6429 | 85.0% | 40.0% | 0.0% |  |
| synthetic:rails-portal | `ar` | 20 | -0.0843 | 55.0% | 40.0% | 10.0% |  |
| synthetic:rails-portal | `pl` | 20 | 0.3548 | 80.0% | 35.0% | 10.0% |  |
| synthetic:django-clinic | `es-MX` | 16 | 0.3043 | 87.5% | 31.3% | 6.3% |  |
| synthetic:django-clinic | `de` | 16 | 0.6444 | 93.8% | 43.8% | 12.5% |  |
| synthetic:django-clinic | `ja` | 16 | 0.4904 | 68.8% | 31.3% | 6.3% |  |
| synthetic:django-clinic | `ar` | 16 | 0.2233 | 68.8% | 18.8% | 0.0% |  |
| synthetic:django-clinic | `pl` | 16 | 0.5733 | 75.0% | 18.8% | 18.8% |  |
| oss:next-intl | `de` | 30 | null | n/a | n/a | 3.3% |  |
| oss:next-intl | `ja` | 30 | null | n/a | n/a | 10.0% |  |
| oss:hoppscotch | `es-MX` | 40 | null | n/a | n/a | 5.0% |  |
| oss:hoppscotch | `de` | 40 | null | n/a | n/a | 15.0% |  |
| oss:hoppscotch | `ja` | 40 | null | n/a | n/a | 5.0% |  |
| oss:hoppscotch | `ar` | 40 | null | n/a | n/a | 12.5% |  |
| oss:hoppscotch | `pl` | 40 | null | n/a | n/a | 2.5% |  |
| oss:immich | `ar` | 40 | null | n/a | n/a | 10.0% |  |
| oss:immich | `pl` | 40 | null | n/a | n/a | 5.0% |  |
| oss:mastodon | `es-MX` | 40 | null | n/a | n/a | 2.5% |  |
| oss:mastodon | `ja` | 40 | null | n/a | n/a | 15.0% |  |
| oss:mastodon | `ar` | 40 | null | n/a | n/a | 7.5% |  |
| docx:northstar-policy | `de` | 15 | 0.3478 | 60.0% | 33.3% | 13.3% | LOW-CONFIDENCE (DOCX) |
| docx:gov-grant-form | `ja` | 15 | 0.3478 | 60.0% | 33.3% | 0.0% | LOW-CONFIDENCE (DOCX) |
| docx:open-sustainability-report | `ar` | 15 | 0.2913 | 60.0% | 33.3% | 6.7% | LOW-CONFIDENCE (DOCX) |
| docx:libreoffice-revisions | `pl` | 12 | 0.2 | 41.7% | 16.7% | 8.3% | LOW-CONFIDENCE (DOCX) |

## 2. Raw DeepL Response Analysis for Pilot `icu_syntax_error` (Change #4)

In the Stage 2 Pilot, System C (`wraith check` on System B) flagged `icu_syntax_error` on two keys. Inspection of the exact cached raw DeepL API responses proves one was our harness bug (fixed before Stage 3) and one was a genuine DeepL XML corruption bug:

- **Key `icu.orderPipeline` (`ES`, cache `50062d237844b36a40a9ab7a2873c2ab8e2550d5b90a30934ddb9584bc5d0f7c.json`) — `HARNESS_BUG`**
  - Sent XML: `{count, plural, one {<ph id="0"/> pending order} other {<ph id="1"/> pending orders}}`
  - Raw DeepL response: `{número, plural, una {<ph id="0"/> orden pendiente} otra {<ph id="1"/> órdenes pendientes}}`
  - Diagnosis: Pilot splitIcuTopLevel() did not recurse into nested {count, plural, ...} inside {status, select, ...}, so raw ICU syntax was sent to DeepL, which translated keywords ('plural', 'one', 'other') and variable name ('count' -> 'número'/'Anzahl'). Fixed in Stage 3 via splitIcuRecursive().
- **Key `rich.backupNotice` (`DE`, cache `6c4bd06a5b1685b327e293010a4dd771bc1d0ea29ebc3cf8d78511d3295a9d07.json`) — `DEEPL_API_XML_BUG`**
  - Sent XML: `Automatic snapshots are stored in <ph id="0"/>LedgerVault<ph id="1"/> every <ph id="2"/>24h<ph id="3"/>.`
  - Raw DeepL response: `Automatische Snapshots werden alle <ph id="2"/>24 Stunden&lt;img id="4"/&gt; in <ph id="0"/>LedgerVault<ph id="1"/> gespeichert<ph id="3"/>.`
  - Diagnosis: Genuine DeepL XML tag_handling corruption: input had four self-closing <ph id='0..3'/> tags; DeepL hallucinated a literal '&lt;img id="4"/&gt;' and cross-nested <ph id="3"/> after 'gespeichert', causing unbalanced <codeTag> in restored output. Stage 3 also upgraded rich text protection to paired <rt0>...</rt0> tags.
- **Key `icu.orderPipeline` (`DE`, cache `bb1f20e633c310373499bb6769ac2335e2229cc2feaa449fac15b24af6a0a4e8.json`) — `HARNESS_BUG`**
  - Sent XML: `{count, plural, one {<ph id="0"/> pending order} other {<ph id="1"/> pending orders}}`
  - Raw DeepL response: `{Anzahl, Plural, eine {<ph id="0"/> ausstehende Bestellung} weitere {<ph id="1"/> ausstehende Bestellungen}}`
  - Diagnosis: Pilot splitIcuTopLevel() did not recurse into nested {count, plural, ...} inside {status, select, ...}, so raw ICU syntax was sent to DeepL, which translated keywords ('plural', 'one', 'other') and variable name ('count' -> 'número'/'Anzahl'). Fixed in Stage 3 via splitIcuRecursive().
- **Key `icu.orderPipeline` (`DE`, cache `d5cf75f51f47e1dc72cf720bf7df33300feeefbb46f79e54f7a97af75a14ba01.json`) — `HARNESS_BUG`**
  - Sent XML: `{count, plural, one {<ph id="0"/> pending order} other {<ph id="1"/> pending orders}}`
  - Raw DeepL response: `{Anzahl, Plural, eine {<ph id="0"/> versandte Bestellung} weitere {<ph id="1"/> versandte Bestellungen}}`
  - Diagnosis: Pilot splitIcuTopLevel() did not recurse into nested {count, plural, ...} inside {status, select, ...}, so raw ICU syntax was sent to DeepL, which translated keywords ('plural', 'one', 'other') and variable name ('count' -> 'número'/'Anzahl'). Fixed in Stage 3 via splitIcuRecursive().
- **Key `icu.orderPipeline` (`ES`, cache `daa3340e263d23cf7512628235a48ab7fb562ff3dd4eca992cd98edbb552e32c.json`) — `HARNESS_BUG`**
  - Sent XML: `{count, plural, one {<ph id="0"/> pending order} other {<ph id="1"/> pending orders}}`
  - Raw DeepL response: `{número, plural, un {<ph id="0"/> pedido enviado} otros {<ph id="1"/> pedidos enviados}}`
  - Diagnosis: Pilot splitIcuTopLevel() did not recurse into nested {count, plural, ...} inside {status, select, ...}, so raw ICU syntax was sent to DeepL, which translated keywords ('plural', 'one', 'other') and variable name ('count' -> 'número'/'Anzahl'). Fixed in Stage 3 via splitIcuRecursive().

## 3. Synthetic Benchmark: A vs A0 vs B vs B+ctx (4 Stacks × 5 Languages)

Note: In Stage 3, **all** DeepL runs for `es-MX`, `de`, `ja`, and `pl` used live DeepL glossaries (with `wraith-eval-*` slot cleanup after every run); `ar` ran without a DeepL glossary because DeepL does not support EN→AR glossaries.

### Challenge Subset vs Non-Challenge Subset (Aggregated Across 4 Synthetic Apps × 5 Languages)

| System | Challenge Win Rate (n=545, Wilson 95% CI) | Challenge Disambiguation Sense Accuracy (Wilson 95% CI) | Challenge MQM Major+Crit / 100 | Non-Challenge Win Rate (n=60, Wilson 95% CI) | Non-Challenge MQM Major+Crit / 100 | Total `wraith check` Errors | Total Visual Defects |
|---|---|---|---|---|---|---|---|
| **A (Codex + Wraith MCP)** | 2.8% [1.7%, 4.5%] | 99.5% [98.3%, 99.9%] | 4.8 | 6.7% [2.6%, 15.9%] | 7.5 | 0 | 25 |
| A0 (Codex, no Wraith) | 4.8% [3.3%, 6.9%] | 99.8% [98.7%, 100.0%] | 1.8 | 11.7% [5.8%, 22.2%] | 5.8 | 28 | 26 |
| B (DeepL + XML + glossary) | 0.5% [0.2%, 1.6%] | 59.3% [54.6%, 63.8%] | 34.0 | 0.0% [0.0%, 6.0%] | 21.3 | 53 | 66 |
| B+ctx (DeepL + `context` ≤300c) | 0.5% [0.2%, 1.6%] | 86.7% [83.2%, 89.6%] | 18.0 | 3.3% [0.9%, 11.4%] | 9.6 | 42 | 57 |
| *Ties* | 91.4% | — | — | 78.3% | — | — | Pseudo: 70 |

### Per-App × Language Synthetic Results

| App (Stack) | Locale | DeepL Glossary? | Panel Wins (A / A0 / B / B+ctx / Tie) | Sense Acc (A / A0 / B / B+ctx) | `check` Errs (A / A0 / B / B+ctx) | Visual Defects (A / A0 / B / B+ctx) |
|---|---|---|---|---|---|---|
| nextjs-commerce (next-intl) | `es-MX` | Yes | 4 / 2 / 0 / 0 / 54 | 100% / 100% / 57% / 95% | 0 / 0 / 0 / 0 | 2 / 2 / 5 / 7 |
| nextjs-commerce (next-intl) | `de` | Yes | 1 / 3 / 1 / 1 / 54 | 98% / 98% / 50% / 80% | 0 / 0 / 0 / 0 | 2 / 2 / 6 / 5 |
| nextjs-commerce (next-intl) | `ja` | Yes | 1 / 2 / 1 / 0 / 56 | 98% / 100% / 57% / 78% | 0 / 0 / 11 / 5 | 1 / 1 / 3 / 3 |
| nextjs-commerce (next-intl) | `ar` | No (unsupported) | 2 / 4 / 0 / 1 / 53 | 100% / 100% / 55% / 88% | 0 / 3 / 8 / 7 | 1 / 1 / 1 / 1 |
| nextjs-commerce (next-intl) | `pl` | Yes | 4 / 5 / 0 / 1 / 50 | 100% / 100% / 55% / 85% | 0 / 2 / 7 / 7 | 3 / 3 / 7 / 5 |
| vue-dashboard (vue-i18n) | `es-MX` | Yes | 0 / 1 / 0 / 0 / 24 | 100% / 100% / 60% / 100% | 0 / 0 / 0 / 0 | 3 / 3 / 4 / 4 |
| vue-dashboard (vue-i18n) | `de` | Yes | 0 / 2 / 0 / 0 / 23 | 100% / 100% / 60% / 100% | 0 / 0 / 0 / 0 | 3 / 2 / 8 / 4 |
| vue-dashboard (vue-i18n) | `ja` | Yes | 1 / 0 / 0 / 0 / 24 | 100% / 100% / 80% / 90% | 0 / 0 / 2 / 2 | 2 / 3 / 5 / 6 |
| vue-dashboard (vue-i18n) | `ar` | No (unsupported) | 1 / 1 / 0 / 0 / 23 | 100% / 100% / 60% / 100% | 0 / 2 / 2 / 2 | 1 / 1 / 2 / 2 |
| vue-dashboard (vue-i18n) | `pl` | Yes | 0 / 4 / 0 / 0 / 21 | 100% / 100% / 60% / 100% | 0 / 5 / 5 / 5 | 2 / 2 / 7 / 3 |
| rails-portal (rails) | `es-MX` | Yes | 1 / 2 / 0 / 0 / 17 | 100% / 100% / 63% / 88% | 0 / 0 / 0 / 0 | 0 / 0 / 1 / 0 |
| rails-portal (rails) | `de` | Yes | 1 / 0 / 0 / 0 / 19 | 100% / 100% / 50% / 88% | 0 / 0 / 0 / 0 | 3 / 3 / 5 / 4 |
| rails-portal (rails) | `ja` | Yes | 1 / 2 / 0 / 0 / 17 | 100% / 100% / 69% / 75% | 0 / 0 / 3 / 3 | 0 / 0 / 2 / 2 |
| rails-portal (rails) | `ar` | No (unsupported) | 0 / 0 / 0 / 0 / 20 | 100% / 100% / 63% / 81% | 0 / 5 / 6 / 2 | 0 / 0 / 0 / 0 |
| rails-portal (rails) | `pl` | Yes | 1 / 0 / 0 / 0 / 19 | 100% / 100% / 63% / 75% | 0 / 1 / 3 / 3 | 0 / 0 / 2 / 2 |
| django-clinic (django) | `es-MX` | Yes | 0 / 0 / 0 / 0 / 16 | 100% / 100% / 60% / 80% | 0 / 1 / 0 / 0 | 1 / 1 / 0 / 1 |
| django-clinic (django) | `de` | Yes | 0 / 0 / 0 / 1 / 15 | 100% / 100% / 60% / 80% | 0 / 2 / 1 / 1 | 0 / 1 / 3 / 1 |
| django-clinic (django) | `ja` | Yes | 0 / 2 / 0 / 1 / 13 | 100% / 100% / 60% / 80% | 0 / 3 / 1 / 1 | 0 / 0 / 3 / 3 |
| django-clinic (django) | `ar` | No (unsupported) | 0 / 1 / 0 / 0 / 15 | 100% / 100% / 80% / 80% | 0 / 2 / 3 / 3 | 0 / 0 / 0 / 0 |
| django-clinic (django) | `pl` | Yes | 1 / 2 / 1 / 0 / 12 | 100% / 100% / 60% / 80% | 0 / 2 / 1 / 1 | 1 / 1 / 2 / 4 |

## 4. Token, Uncached Input, Turn & MCP Overhead Instrumentation + A-compact Variant (Change #5)

### Full System A (`/localize`) vs System A-compact (`prepare limit=100 → apply → check`)

| Run | Variant | Wall (s) | Turns | Uncached Input / 1k strings | Total Input / 1k strings | Output / 1k strings | MCP Payload Bytes | MCP Approx Tokens | `check` Outcome | 2-Way Judge Wins (Full / Compact / Tie) |
|---|---|---|---|---|---|---|---|---|---|---|
| nextjs-commerce:es-MX | Full A | 97.0 | 1 | 371,950 | 6,355,950 | 35,217 | 70,711 | 17,678 | PASS | 2 / 4 / 54 |
| nextjs-commerce:es-MX | **A-compact** | 42.7 | 1 | 186,083 | 2,253,283 | 18,017 | 40,629 | 10,158 | PASS | *(above)* |
| nextjs-commerce:de | Full A | 89.6 | 1 | 416,583 | 6,313,117 | 33,850 | 67,652 | 16,913 | PASS | 1 / 7 / 52 |
| nextjs-commerce:de | **A-compact** | 61.4 | 1 | 223,200 | 1,558,667 | 22,300 | 39,597 | 9,900 | PASS | *(above)* |

### Per-Tool MCP Response Payload Overhead (Across All System A Synthetic Runs)

| Wraith MCP Tool | Total Calls | Total Response Bytes | Avg Bytes / Call | Total Approx Tokens (bytes/4) |
|---|---|---|---|---|
| `prepare` | 61 | 381,080 | 6,247 | 95,292 |
| `check` | 32 | 137,256 | 4,289 | 34,326 |
| `pseudo` | 25 | 90,777 | 3,631 | 22,701 |
| `report` | 20 | 59,148 | 2,957 | 14,797 |
| `scan` | 20 | 30,825 | 1,541 | 7,715 |
| `apply` | 53 | 13,898 | 262 | 3,494 |
| `status` | 20 | 13,469 | 673 | 3,372 |
| `memory` | 7 | 2,979 | 426 | 746 |

### System A vs System A0 Efficiency (Mean Across Synthetic Runs)

| System | Avg Model Turns | Avg Uncached Input / 1k strings | Avg Total Input / 1k strings | Avg Output / 1k strings |
|---|---|---|---|---|
| System A (Codex + Wraith MCP) | 1.0 | 981,569 | 13,853,846 | 66,370 |
| System A0 (Codex, no Wraith) | 1.0 | 612,327 | 5,709,335 | 66,835 |

## 5. Never-Internationalized App Extraction Test (`nextjs-unlocalized`)

- **Scanner recall on 24 expected user-visible strings:** 24/24 (100.0%)
- **Scanner false positives on 10 technical strings (API URLs, SQL, HTTP headers, Tailwind classes, logs):** 0/10
- **Total raw scanner candidates:** 24
- **End-to-end Codex + Wraith refactor:** extracted 23 keys, `src/lib/runnerApi.ts` untouched=true, `tsc --noEmit` passed=true, `wraith check` de=PASS (0 errs), es-MX=PASS (0 errs), wall=94.0s.

## 6. Real Open-Source Apps Evaluation (A vs A0 vs B vs H)

### Repository Inventory & Monorepo Setup DX

| Repo | Stack | Pinned Commit | Catalog Path | Total Keys | Sampled | Post-Cutoff (>2026-03-01) | `wraith init` Auto-Detected? |
|---|---|---|---|---|---|---|---|
| next-intl | auto | `19675be7` | `examples/example-app-router-playground/messages/en.json` | 30 | 30 | 0 | No (needed manual `paths.locales`) |
| hoppscotch | auto | `6177eae1` | `packages/hoppscotch-common/locales/en.json` | 2198 | 200 | 0 | No (needed manual `paths.locales`) |
| immich | auto | `7b27863b` | `i18n/en.json` | 2427 | 200 | 0 | No (needed manual `paths.locales`) |
| mastodon | auto | `a458489b` | `config/locales/en.yml` | 2238 | 200 | 0 | No (needed manual `paths.locales`) |
| wagtail | auto | `21e272e0` | `wagtail/admin/locale/en/LC_MESSAGES/django.po` | 858 | 200 | 0 | No (needed manual `paths.locales`) |

### Aggregated OSS Judge Panel Results (Stratified 40 Strings/App/Lang vs Human `H`)

| System | Panel Win Rate (n=460, Wilson 95% CI) | MQM Major+Crit / 100 | Total `wraith check` Errors |
|---|---|---|---|
| **A (Codex + Wraith MCP)** | 12.4% [9.7%, 15.7%] | 1.5 | 6 |
| A0 (Codex, no Wraith) | 13.7% [10.8%, 17.1%] | 1.8 | 67 |
| B (DeepL) | 8.3% [6.1%, 11.1%] | 17.2 | 116 |
| H (Existing Human OSS Translation) | 4.8% [3.2%, 7.1%] | 23.1 | — |
| *Ties* | 60.9% | — | — |

### Per-App × Language OSS chrF2 (100% of Sample) & Panel Wins

| Repo | Locale (H code) | chrF2 vs H (A / A0 / B) | Post-Cutoff chrF2 (n, A / A0 / B) | Panel Wins (A / A0 / B / H / Tie) | `check` Errs (A / A0 / B) |
|---|---|---|---|---|---|
| next-intl | `es-MX` (`es`) | 72.41 / 71.12 / 75.85 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 |
| next-intl | `de` (`de`) | 69.77 / 64.39 / 72.89 | none | 2 / 2 / 1 / 0 / 25 | 0 / 0 / 0 |
| next-intl | `ja` (`ja`) | 48.67 / 46.12 / 57.1 | none | 1 / 1 / 2 / 0 / 26 | 0 / 0 / 0 |
| hoppscotch | `es-MX` (`es`) | 65.01 / 64.86 / 71.91 | none | 6 / 5 / 3 / 3 / 23 | 0 / 2 / 2 |
| hoppscotch | `de` (`de`) | 60.59 / 61.6 / 64.28 | none | 2 / 2 / 12 / 1 / 23 | 2 / 2 / 2 |
| hoppscotch | `ja` (`ja`) | 27.47 / 26.39 / 29.8 | none | 3 / 5 / 4 / 1 / 27 | 2 / 2 / 2 |
| hoppscotch | `ar` (`ar`) | 53.64 / 55.19 / 62.9 | none | 6 / 7 / 2 / 0 / 25 | 0 / 2 / 2 |
| hoppscotch | `pl` (`pl`) | 34.81 / 33.78 / 38.09 | none | 5 / 11 / 2 / 1 / 21 | 2 / 2 / 2 |
| immich | `es-MX` (`es`) | 64.98 / 66.97 / 73.02 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 1 |
| immich | `de` (`de`) | 64.42 / 64.14 / 71.05 | none | 0 / 0 / 0 / 0 / 0 | 0 / 2 / 1 |
| immich | `ja` (`ja`) | 59.42 / 59.67 / 58.7 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 1 |
| immich | `ar` (`ar`) | 52.31 / 53.44 / 66.78 | none | 4 / 7 / 1 / 3 / 25 | 0 / 5 / 28 |
| immich | `pl` (`pl`) | 60.29 / 59.99 / 66.25 | none | 6 / 7 / 1 / 2 / 24 | 0 / 10 / 28 |
| mastodon | `es-MX` (`es-MX`) | 66.69 / 65.86 / 73.67 | none | 1 / 4 / 3 / 6 / 26 | 0 / 11 / 11 |
| mastodon | `de` (`de`) | 59.86 / 60.86 / 59.31 | none | 0 / 0 / 0 / 0 / 0 | 0 / 11 / 11 |
| mastodon | `ja` (`ja`) | 49.8 / 49.48 / 52.46 | none | 12 / 6 / 3 / 2 / 17 | 0 / 0 / 0 |
| mastodon | `ar` (`ar`) | 55.27 / 54.2 / 61.83 | none | 9 / 6 / 4 / 3 / 18 | 0 / 12 / 12 |
| mastodon | `pl` (`pl`) | 59.08 / 57.29 / 62.35 | none | 0 / 0 / 0 / 0 / 0 | 0 / 6 / 12 |
| wagtail | `es-MX` (`es`) | 67.26 / 65.69 / 72.59 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 |
| wagtail | `de` (`de`) | 70.79 / 69.92 / 72.77 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 1 |
| wagtail | `ja` (`ja`) | 53.91 / 55.66 / 62.37 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 |
| wagtail | `ar` (`ar`) | 67.66 / 68.25 / 77.84 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 |
| wagtail | `pl` (`pl`) | 58.61 / 59.08 / 61.44 | none | 0 / 0 / 0 / 0 / 0 | 0 / 0 / 0 |

## 7. DOCX Evaluation (4 Documents: `de`, `ja`, `ar`, `pl`)

> **Methodological Note:** LOW-CONFIDENCE JUDGE VERDICT (Pilot DOCX κ = 0.34, Claude flip rate = 35%): treat DOCX judge preferences as secondary; primary DOCX conclusions rest on deterministic OOXML structure preservation, LibreOffice rendering, source-text leakage, and incremental-update integrity.

| Document | Target | LibreOffice Opens (A / B) | Source Leakage Paras (A / B) | Unique `w:rPr` Formatting Runs (Src / A / B) | Structural Elements Match Src? (A / B) | Wraith `check` (A) | DeepL Billed Chars | Low-Conf Judge Wins (A / B / Tie, n=15) |
|---|---|---|---|---|---|---|---|---|
| `northstar-policy.docx` | `de` | Yes / Yes | 0 / 0 | 5 / 5 / 5 | Exact match / Exact match | PASS (0 err) | 50,000 | 4 / 1 / 10 *(low-conf)* |
| `gov-grant-form.docx` | `ja` | Yes / Yes | 0 / 0 | 2 / 2 / 2 | Exact match / Exact match | PASS (0 err) | 50,000 | 6 / 1 / 8 *(low-conf)* |
| `open-sustainability-report.docx` | `ar` | Yes / Yes | 0 / 0 | 4 / 4 / 5 | Exact match / Exact match | PASS (0 err) | 50,000 | 7 / 1 / 7 *(low-conf)* |
| `libreoffice-revisions.docx` | `pl` | Yes / Yes | 0 / 0 | 3 / 3 / 3 | Exact match / Exact match | PASS (0 err) | 50,000 | 1 / 2 / 9 *(low-conf)* |

### Mid-Batch Incremental Source Edit Test (`libreoffice-revisions.docx` → `pl`)

- **Source v1 → v2 edit:** Inserted a new urgent amendment paragraph at top of document (shifting all paragraph indices +1) and edited paragraph 2 from *"twelve hours"* to *"six hours"*.
- **`wraith check` immediately after v2 swap:** `FAIL` (errors=1, codes=`{"missing_document_translation":1}`).
- **After Batch 2 on v2:** `wraith check` = `PASS` (errors=0), LibreOffice opened cleanly=true, final visible paragraphs=13 (v2 source=13).
- **Alignment check:** Top amendment aligned in slot 0=true; edited para updated to 6 hours (not 12)=true.

## 8. Release N → N+1 Replay, Fuzzy TM Leverage & 30-Term Glossary Propagation

| App | `stale_source` Precision / Recall | `context_changed` Detected | Fuzzy TM Matches (≥95% / 75–94%) | 30-Term Glossary Adherence (A / B) | Mid-Project Term Change Flagged (P / R) | Delta Judge Wins (A / B / Tie) |
|---|---|---|---|---|---|---|
| next-intl | 100.0% / 100.0% | 0/5 | 0 / 9 | 100.0% / 100.0% | 1/1 (100.0% / 100.0%) | 8 / 3 / 5 |
| hoppscotch | 100.0% / 100.0% | 0/5 | 1 / 11 | 100.0% / 90.5% | 4/4 (100.0% / 100.0%) | 4 / 6 / 6 |

## 9. Wraith Defects Observed (Documented Only — Not Modified)

1. **False-positive `glossary_inconsistency` warnings on context-dependent homonyms:**
   - *Reproduction:* On `eval/synthetic/nextjs-commerce`, run `wraith check --locale de --json` after translating `status.open` ("Open" = business open → `"Geöffnet"`) and `actions.open` ("Open" = open file verb → `"Öffnen"`).
   - *Observed:* Wraith emits `glossary_inconsistency` warnings for `"Open"`, `"Free"`, and `"Charge"` even though they are intentionally distinct translations for distinct component usage contexts.
2. **Monorepo auto-detection requires manual `paths.locales` configuration:**
   - *Reproduction:* Run `wraith init -s en -t de` in the root of real monorepos (`hoppscotch`, `immich`, `next-intl` examples) where catalogs sit under nested package directories.
   - *Observed:* `init` defaults to root-level heuristics rather than discovering nested workspace locale directories, requiring users to set `paths.locales` manually (see §6 DX table).
3. **`audit3` MISS extraction tests (pre-existing, caused Cal.com skip):**
   - *Reproduction:* `./node_modules/.bin/vitest run --config audit3/vitest.config.ts -t "MISS"` fails 3/5 (`MISS-1`, `MISS-2`, `MISS-3`).

## 10. Cost Ledger, DeepL Quota & Glossary Deletion Audit Log

- **Total estimated API-equivalent spend (list-price reference; subscription CLIs billed $0):** $98.2924
- **DeepL total billed characters recorded across all runs:** 482,953
- **DeepL `wraith-eval-*` glossary deletions (strictly scoped to our prefix; never touched other projects):**
  - `7c65e287-6afc-4672-9372-ea2f03d9be8d` — `polyglot-eval-docx-libreoffice-revisions-pl` (en→pl, reason: `after-docx-pl`, at 2026-11-25T14:10:13.855Z)

## 11. Explicit Limitations

1. **No human reviewers:** Quality comparisons rely on a dual LLM judge panel (Claude `sonnet` + Gemini `gemini-4-carbon-medium`) validated via position swapping, 9 planted corruption types (5 obvious + 4 subtle), and human-anchor checks on OSS apps.
2. **DeepL `es-MX` & `ar` API limitations:** DeepL has no distinct `ES-MX` target language code (uses `ES`) and does not support EN→AR glossaries or formality.
3. **DOCX judge reliability:** DOCX judge verdicts are explicitly low-confidence (Pilot κ = 0.34, Claude flip rate 35%); DOCX conclusions rely on deterministic structure, formatting, rendering, leakage, and incremental-update checks.
4. **Possible OSS pretraining contamination:** Existing OSS catalogs predating `2026-03-01` may appear in LLM training data; synthetic apps (authored fresh for this evaluation) and post-cutoff OSS diffs serve as clean contamination controls.
5. **Cal.com excluded:** Skipped per instructions because `audit3` MISS tests failed 3/5.

## 12. Post-Eval Addendum: Before vs After — Layout & Formatting v1 (`layout-v1` Branch)

> **Sequencing Disclosure:** All Stage 3 benchmarks in Sections 1–11 were executed while Wraith was pinned unmodified at `f317563`. After Stage 3 completed, release blockers (`MISS-1`, `MISS-2`, `MISS-3`, `STALE-1`) and **Layout & Formatting v1** were built on branch `layout-v1`, and **only the layout evaluation** was re-run on `nextjs-commerce` across 7 locales (`en-XA`, `ar-XB`, `de`, `es-MX`, `ja`, `ar`, `pl`) at 375px and 1280px viewports.

| Stage | Outcome | Total Rendered Defects | Clipped Text | RTL `dir`/`lang` Mismatch | Horizontal Overflow | Static Physical-RTL Risks |
|---|---|---|---|---|---|---|
| **Baseline (`f317563`)** | `FAIL` | **26** | 15 | 4 | 7 | 1 |
| **After Step 1 (`wraith layout --fix` mechanical codemods only)** | `FAIL` | 8 | **0** | **0** | 8 | **0** |
| **After Step 2 (Agent applies prescribed `flex-wrap` edit)** | `PASS` | **0** | **0** | **0** | **0** | **0** |

- **Auto pseudo-modes generated:** `expand` (`en-XA`, 60 keys), `rtl` (`ar-XB`, 56 keys), `cjk` (`ja-XC`, 60 keys), `long-word` (`de-XE`, 60 keys).
- **Zero-width key ID tracing:** mapped **13/26** rendered browser defects directly back to catalog keys and `file:line`, recording **13** width budgets in `.wraith/layout.json`.
- **Deterministic mechanical codemods (`layout --fix`):** modified **5 files** (**8** mechanical rewrites: `w-*` → `min-w-*`, physical `ml-/mr-/pl-/text-left/border-l` → logical `ms-/me-/ps-/text-start/border-s`, root `<html>` `dir`/`lang`), eliminating **100% of clipped text (15 → 0)** and **100% of RTL defects (5 → 0)** automatically.


## 13. Stage 4: TM Context Ablation

> **DRY RUN — no model outputs yet; dataset & metric pipeline validated.** No Codex or judge calls were made. Metric values below are gold-vs-gold sanity checks, **not** system results.

Cross-file consistency benchmark: 482 items in 165 recurring (slice × locale × source) groups across locales `de`, `ja`, `ar`, `es`; 40% of recurring patterns pre-seeded into an isolated per-slice `.wraith/tm.json`. TM retrieval: top-3 fuzzy, minSimilarity 0.7.

| Slice | Gold Provenance | Items | Unique Sources | Components/Namespaces | Glossary Terms | TM Entries | A-full Items w/ TM Hit | Per-Locale Items (groups / TM-seeded groups) |
|---|---|---|---|---|---|---|---|---|
| synthetic-app | author-provided | 256 | 18 | 12 | 4 | 28 | 99 | `de`: 64 (18 / 7), `ja`: 64 (18 / 7), `ar`: 64 (18 / 7), `es`: 64 (18 / 7) |
| oss-next-intl | human-oss | 40 | 7 | 12 | 0 | 7 | 18 | `de`: 24 (7 / 3), `ja`: 8 (4 / 2), `es`: 8 (4 / 2) |
| oss-hoppscotch | human-oss | 186 | 37 | 55 | 0 | 32 | 77 | `de`: 33 (14 / 6), `ja`: 28 (12 / 5), `ar`: 35 (15 / 6), `es`: 90 (37 / 15) |

**Arms** (explicit prompt builders in `eval/stages/tm-ablation.mjs`; 64 prompts built under `eval/work/tm-ablation/<slice>/prompts/`):

| Arm | Context Supplied | TM | Prompts | Avg Prompt Chars |
|---|---|---|---|---|
| `B` — B (source + locale) | source, targetLocale | disabled | 16 | 2702 |
| `Bgl` — B+glossary | source, targetLocale, glossary | disabled | 16 | 2765 |
| `Anotm` — A-no-tm (AST UI context + width budgets + glossary; tmEnabled:false) | source, targetLocale, glossary, file, component, elementType, widthBudget, localeConventions | disabled | 16 | 6701 |
| `Afull` — A-full (A-no-tm + top-3 fuzzy TM, minSimilarity 0.70) | source, targetLocale, glossary, file, component, elementType, widthBudget, localeConventions, tmMatches | enabled | 16 | 8276 |

### Metric Pipeline Sanity (gold-vs-gold — not a system result)

| Slice | n | TCR | Parity | chrF2 | TER | Note |
|---|---|---|---|---|---|---|
| synthetic-app | 256 | 1.000 | 100.0% | 100.00 | 0.00 | Author-provided gold is consistent by construction: expect TCR 1.0, parity 1.0, chrF2 100, TER 0. |
| oss-next-intl | 40 | 0.920 | 100.0% | 100.00 | 0.00 | chrF2/TER are 100/0 by definition; TCR/parity < 1 measure inconsistency/structure drift INSIDE the human OSS gold itself (human baseline). |
| oss-hoppscotch | 186 | 0.694 | 100.0% | 100.00 | 0.00 | chrF2/TER are 100/0 by definition; TCR/parity < 1 measure inconsistency/structure drift INSIDE the human OSS gold itself (human baseline). |

- **Dual-judge MQM:** `pending` (no outputs to judge; run full mode, then `node eval/run.mjs judge-remaining --scopes tm-ablation`).
- **Metric definitions:** TCR = 1 - (uniqueVariants-1)/(N-1) per recurring (slice, locale, source) group; N=1 -> 1.0; unweighted mean over groups. TER = Plain word edit distance (no shifts) / reference length x100 (upper bound on true TER); graphemes for ja.
- **Honesty notes:** synthetic gold is **author-provided** (not translator-reviewed); OSS gold = human OSS catalog translations (Hoppscotch, next-intl examples), whose own TCR < 1 is shown above as a human baseline. OSS slices have no project glossary, so `Bgl` ≡ `B` there.
