# Wraith MCP — Localization & Document Benchmark Audit (Pre-Release Evaluation)

**Date:** 2026-11-27  
**Package Version:** `wraith-mcp@0.1.0` (pre-release)  
**Translation & Fresh-Context QE Engine:** OpenAI Codex (`codex exec`)  
**Blinded Quality Judge:** Claude Opus (`claude -p --model opus`, anonymized and position-randomized arms)  
**Independent Visual QA Auditor:** Gemini (direct inspection of rendered Playwright & LibreOffice PNGs)  
**NMT Baseline:** DeepL API (glossary-enabled catalog translation + DeepL Document API for `.docx`)  
**Target Languages:** German (`de`), Simplified Chinese (`zh-Hans`), Mexican Spanish (`es-MX`), Arabic (`ar`)

---

## Scope & Methodology (What This Benchmark Actually Tests — and What It Does Not)

To keep conclusions strictly grounded in evidence, this evaluation separates **synthetic stress-test fixtures** from **real open-source repository samples**:

| Target | Origin | Source Commit | Total Unique EN Strings in Repo | Sample Evaluated | Sampling Method | Instances (×4 Langs) |
| :--- | :--- | :--- | :---: | :---: | :--- | :---: |
| `nextjs-commerce` | **Synthetic fixture** (`eval/fixtures`) | N/A | 63 | 63 (100%) | Full fixture (engineered with homonyms, tight CSS budgets, ICU plurals, 3 ambiguous keys) | 252 (65.6%) |
| `FossifyOrg/Calendar` | **Real OSS** (Android `strings.xml`) | `7f1e9b10` (2026-11-24) | 257 | 13 (5.1%) | Deterministic stratified slice (placeholder, short UI, general) | 52 (13.5%) |
| `Dimillian/IceCubesApp` | **Real OSS** (iOS `.xcstrings`) | `98098b9c` (2026-10-13) | 741 | 20 (2.7%) | Deterministic stratified slice (placeholder, short UI, general) | 80 (20.8%) |
| **Software Total** | **1 synthetic + 2 real OSS** | — | **1,061** | **96 unique** | — | **384 instances** |
| **Document Suite (6 files)** | **Synthetic fixtures** (`eval/docx`, `eval/bench`) | N/A | 24 + 14 segs (DOCX) | 6 files (1-page DOCX × 2, 3-slide PPTX, 1-sheet XLSX, 5-cue VTT, 3-cue SRT) | Full synthetic files | 6 docs (`de`, `es-MX`) |

> **Key Limitation:** Only **132 of 384 software string instances (34.4%, 33 unique source strings)** came from real open-source repositories, and all 6 documents were small synthetic fixtures (1.7–4.1 KB). While the results clearly show structural differences between NMT, vanilla Codex, and Wraith on targeted failure modes (homonyms, layout clipping, glossary enforcement, tracked changes, regional register), **a larger real-world scale-up (1,000+ unique strings from a single production OSS repo such as `mastodon/mastodon` or `hoppscotch/hoppscotch`, plus messy multi-page real-world `.docx` files) is needed before making broad claims about large-scale production localization.**

---

## Executive Findings (Supported by Current Evidence)

1. **DeepL NMT substantially underperformed all LLM arms on context-dependent UI strings, layout safety, and constrained Word documents.**
   - Across 384 software instances (1,920 blinded Opus evaluations), DeepL produced **212 MQM errors** (**25 Critical**, **78 Major**, **109 Minor**), **69 context-missed errors**, **24 terminology errors**, and **15 rendered Playwright layout defects** (weighted MQM `98.05`).
   - On the two synthetic `.docx` benchmarks, DeepL Document API scored **`79.17` MQM** on `northstar-policy.docx` (`de`) — reversing a legal tracked change (`"formally"` → `"unteroffiziell"`, *unofficially*) and dropping the space in the page-number footer (`"Seite1"`) — and **`47.14` MQM** on `clinical-patient-letter.docx` (`es-MX`), where DeepL lacks an `es-MX` locale and produced informal Peninsular Spanish (`"Tómate un comprimido"`, `"zumo de pomelo"`). DeepL billed its 50,000-character document minimum (`$1.25`/doc) vs. `$0.07–$0.08`/doc for Codex + Wraith.
2. **Text-only MQM differences between vanilla Codex (`B0`/`A0`) and Wraith (`W-pre`/`W-post`) are small and mixed — Wraith's measurable advantage is in shipping guardrails, not raw string fluency.**
   - Weighted MQM across all 384 instances was nearly tied across all four Codex arms: `B0` (`99.88`), `W-pre` (`99.84`), `A0` (`99.83`), `W-post` (`99.83`).
   - On short, unambiguous mobile strings (`FossifyOrg/Calendar` and `IceCubesApp`), `B0` and `A0` slightly outperformed `W-pre`/`W-post` on minor stylistic phrasing (`B0`: `99.84`, `W-post`: `99.73` on `IceCubesApp`), though both `B0` and `A0` each had **1 Critical error** on `oss-ios-icecubes::ar` while Wraith had **0**.
   - Where Wraith clearly outperformed `B0` and `A0`:
     - **0 Critical MQM errors** (vs. `1` B0, `1` A0, `25` NMT)
     - **0 Terminology errors** (vs. `4` B0, `1` A0, `24` NMT)
     - **0 Rendered Playwright layout defects** on `nextjs-commerce` across all 4 languages (vs. **`11` for `B0`** and **`15` for `NMT`**)
     - **12 / 12 Open Questions recall (`0 / 372` false positives)** on the 3 intentionally ambiguous keys (`Cover`, `Lead`, `Drop`) + **384 / 384 (100%)** context notes.
3. **Fresh-Context QE (`W-pre` → `W-post`) caught 3 genuine semantic/grammatical improvements, but 1 over-edit caused a net `-0.01` MQM dip.**
   - Across all 384 instances, the fresh-context Codex QE subagent modified **4 strings** (all in `nextjs-commerce`).
   - Three edits were genuine improvements (`de: rich.trialEnd`, `zh-Hans: general.emptyInbox` which improved Opus score `+1`, and `ar: icu.ticketAssign`).
   - The fourth edit (`ar: storage.freeTag`, source `"Free"`) saw that `StorageQuota.tsx` renders `{gbRemaining} {storage("freeTag")}` without `"GB"` in JSX, and expanded `"متاحة"` → `"غيغابايت من المساحة المتاحة"` (*"GB of available space"*). Blinded Opus penalized this `-5` points as a major addition absent from the English source. That single edit (`-5` vs `+1` = net `-4` points across 384 strings) explains 100% of the `99.84 → 99.83` aggregate dip, and indicates QE should be instructed to **file an Open Question for apparent source-UI omissions rather than silently adding unstated units to one target locale.**
4. **Wraith's token overhead (`3.9×` `A0` for `W-pre`, `6.9×` `A0` including QE) is driven primarily by multi-turn round-trip count, not individual payload size.**
   - Individual MCP payloads are compact (`status`: `533 B`, `prepare`: `1.9 KB`, `check`: `1.4–5.2 KB`), and prompt caching absorbed `91.4–92.4%` of input tokens.
   - However, `W-pre` averaged `11.7` MCP calls/run (including `3–5` repeated `check` calls on `IceCubesApp` triggered by 63 pre-existing Swift hardcoded-string errors in the repo), plus `mcpTextResult` pretty-prints JSON and duplicates `structuredContent`. Reducing round-trips and compacting JSON serialization is a clear optimization target.

---

## Suite 1: 5-Arm Software Localization Results (384 String Instances × 5 Arms = 1,920 Opus Evaluations)

### Overall Aggregate

| Arm | Weighted MQM (scoreSum / 384) | Critical | Major | Minor | Total MQM Errors | Context Missed | Terminology Errors | Playwright Layout Defects (`nextjs-commerce`) | Open Questions (Recall / FP) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `NMT` (DeepL) | `98.05` (`37,651`) | 25 | 78 | 109 | 212 | 69 | 24 | 15 (+1 visual CJK collapse) | N/A |
| `B0` (Raw Catalog Codex) | `99.88` (`38,352`) | 1 | 2 | 28 | 31 | 1 | 4 | 11 | N/A |
| `A0` (Codex in Repo) | `99.83` (`38,335`) | 1 | 4 | 35 | 40 | 1 | 1 | Not rendered | N/A |
| `W-pre` (Wraith Pre-QE) | `99.84` (`38,340`) | **0** | 6 | 30 | 36 | 3 | **0** | Not rendered | **12/12** (`0/372`) |
| `W-post` (Wraith + Fresh QE) | `99.83` (`38,336`) | **0** | 7 | 29 | 36 | 3 | **0** | **0 (PASS)** | **12/12** (`0/372`) |

### Per-Target Breakdown (4 Languages Each: `de`, `zh-Hans`, `es-MX`, `ar`)

#### 1. `nextjs-commerce` (Synthetic Fixture — 63 keys × 4 langs = 252 instances)
| Arm | Weighted MQM | Critical | Major | Minor | Context Missed | Terminology Errors | Playwright Layout Defects |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `NMT` | `97.47` | 21 | 69 | 82 | 59 | 12 | 15 |
| `B0` | `99.86` | 0 | 2 | 25 | 1 | 3 | 11 |
| `A0` | `99.82` | 0 | 3 | 30 | 0 | 0 | — |
| `W-pre` | `99.86` | 0 | 3 | 21 | 0 | 0 | — |
| `W-post` | `99.84` | 0 | 4 | 20 | 0 | 0 | **0** |

#### 2. `FossifyOrg/Calendar` (Real OSS Android — 13 sampled keys × 4 langs = 52 instances)
| Arm | Weighted MQM | Critical | Major | Minor | Context Missed | Terminology Errors |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `NMT` | `99.31` | 0 | 4 | 16 | 4 | 9 |
| `B0` | `100.00` | 0 | 0 | 0 | 0 | 0 |
| `A0` | `99.94` | 0 | 0 | 3 | 0 | 0 |
| `W-pre` | `99.96` | 0 | 0 | 2 | 0 | 0 |
| `W-post` | `99.96` | 0 | 0 | 2 | 0 | 0 |

*Note: During the `zh-Hans` run, Wraith's Android adapter wrote to `values-zh-hans/strings.xml` (invalid for Android `aapt2`) instead of `values-b+zh+Hans/strings.xml`. The bug was fixed in `src/adapters/android.ts` with a regression test; the scores above reflect the actual `zh-Hans` translations Codex produced in that run.*

#### 3. `Dimillian/IceCubesApp` (Real OSS iOS — 20 sampled keys × 4 langs = 80 instances)
| Arm | Weighted MQM | Critical | Major | Minor | Context Missed | Terminology Errors |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `NMT` | `99.05` | 4 | 5 | 11 | 6 | 3 |
| `B0` | `99.84` | 1 | 0 | 3 | 0 | 1 |
| `A0` | `99.79` | 1 | 1 | 2 | 1 | 1 |
| `W-pre` | `99.73` | **0** | 3 | 7 | 3 | **0** |
| `W-post` | `99.73` | **0** | 3 | 7 | 3 | **0** |

---

## Audit of Every Fresh-Context QE Edit (`W-pre` → `W-post`)

| Run & Key | Source | `W-pre` | `W-post` | Opus Score Delta | Assessment |
| :--- | :--- | :--- | :--- | :---: | :--- |
| `nextjs-commerce::de` · `rich.trialEnd` | `...<link>upgrade now</link>...` | `Wechseln Sie jetzt den Tarif` | `Steigen Sie jetzt auf einen höheren Tarif um` | `0` (`99.78 → 99.78`) | **Genuine semantic fix** (avoids implying downgrade). |
| `nextjs-commerce::zh-Hans` · `general.emptyInbox` | `...customer messages and payout notices...` | `收款通知` | `结算打款通知` | **`+1`** (`99.86 → 99.87`) | **Genuine terminology fix** (merchant payout vs incoming payment). |
| `nextjs-commerce::ar` · `icu.ticketAssign` | `{actor} assigned ticket {ticket} to {assignee}.` | `أسند ⁨{actor}⁩ التذكرة...` | `أُسندت التذكرة ⁨{ticket}⁩ إلى ⁨{assignee}⁩ من قِبل ⁨{actor}⁩.` | `0` | **Genuine grammar fix** (avoids masculine verb agreement error for female actors). |
| `nextjs-commerce::ar` · `storage.freeTag` | `Free` | `متاحة` | `غيغابايت من المساحة المتاحة` | **`-5`** (`100 → 95`, Major addition) | **Over-edit:** JSX renders `{gbRemaining} {storage("freeTag")}` without `"GB"`, so QE tried to patch a source UI omission inside the Arabic string. Should have been filed as an Open Question instead. |

---

## Suite 2: Synthetic Multi-Format Document Benchmark

### Blinded Claude Opus MQM (`.docx`: DeepL Document API vs. Wraith + Codex)

| Document (Synthetic 1-Page Fixture) | Locale | Engine | Blinded Opus MQM | Critical / Major / Minor | Term / Reg Errors | `doc-verify` | Est. Cost |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: |
| `northstar-policy.docx` (24 segs) | `de` | DeepL Doc API | `79.17` | `1 / 4 / 5` | `1 / 0` | PASS (`1→1`) | `$1.25` (50k min) |
| `northstar-policy.docx` (24 segs) | `de` | Wraith + Codex | **`98.33`** | `0 / 0 / 4` | `0 / 0` | PASS (`1→1`) | **`$0.07`** |
| `clinical-patient-letter.docx` (14 segs) | `es-MX` | DeepL Doc API | `47.14` | `0 / 14 / 4` | `8 / 7` | PASS (`1→1`) | `$1.25` (50k min) |
| `clinical-patient-letter.docx` (14 segs) | `es-MX` | Wraith + Codex | **`99.29`** | `0 / 0 / 1` | `0 / 0` | PASS (`1→1`) | **`$0.08`** |

### Expanded Synthetic Formats (Wraith + Codex, No DeepL Comparison)

| File | Format | Locale | Wall Time | Input / Cached / Output Tokens | Cost | Integrity Check |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `product-launch-deck.pptx` | PPTX | `de` | `19.5s` | `81.8k / 73.7k / 515` | `$0.0437` | `doc-verify: PASS` (`3→3` slides) |
| `q4-financial-model.xlsx` | XLSX | `de` | `25.9s` | `103.0k / 87.0k / 627` | `$0.0679` | `doc-verify: PASS` (`1→1`, 5/5 `<f>` formulas intact) |
| `product-demo.vtt` | WebVTT | `de` | `37.3s` | `126.3k / 121.3k / 965` | `$0.0524` | 5/5 cues, timestamps intact |
| `webinar-clip.srt` | SRT | `es-MX` | `21.8s` | `101.8k / 94.2k / 468` | `$0.0473` | 3/3 cues, timestamps intact |
| **All 6 Documents Total** | **5 Formats** | `de`, `es-MX` | **`174.2s`** | **`657.7k / 590.6k (89.8%) / 4,471`** | **`$0.3602`** | **100% PASS** |

---

## Honest Token Usage & Cost Accounting (All 12 Software Runs, 384 Instances)

| Arm | Wall Time | Input Tokens | Cached Input (%) | Uncached Input | Output Tokens | Reasoning Tokens | MCP Calls | DeepL Chars | Est. API Cost | Cost / String |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `NMT` (DeepL) | — | — | — | — | — | — | 0 | `11,036` | `$0.28` | `$0.0007` |
| `B0` (Raw Codex) | `487.4s` | `1,135,523` | `1,039,104` (91.5%) | `96,419` | `16,358` | `773` | 0 | 0 | `$0.66` | `$0.0017` |
| `A0` (Codex in Repo) | `520.6s` | `1,507,451` | `1,338,752` (88.8%) | `168,699` | `17,834` | `712` | 0 | 0 | `$0.93` | `$0.0024` |
| `W-pre` (Wraith) | `1,157.4s` | `5,839,687` | `5,398,656` (92.4%) | `441,031` | `35,953` | `2,108` | 140 | 0 | `$2.81` | `$0.0073` |
| `W-qe` Overhead | `616.0s` | `4,491,776` | `4,104,064` (91.4%) | `387,712` | `18,961` | `1,432` | 73 | 0 | `$2.19` | `$0.0057` |
| `W-post` Total | `1,773.4s` | `10,331,463` | `9,502,720` (92.0%) | `828,743` | `54,914` | `3,540` | 213 | 0 | `$5.00` | `$0.0130` |

*Blinded Claude Opus MQM judging cost `$5.39` total (`$5.07` software + `$0.32` DOCX).*
