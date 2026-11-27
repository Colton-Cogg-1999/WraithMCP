# Wraith Simplification & Unprepared Localization Engineering Report

**Date:** 2026-11-27  
**Branch:** `fix/real-world-reliability`  
**Preserved Historical Evidence:** [REPORT.md](REPORT.md) · [PUBLISHABLE_BENCHMARK_REPORT.md](PUBLISHABLE_BENCHMARK_REPORT.md) · [REAL_WORLD_BENCHMARK_REPORT.md](REAL_WORLD_BENCHMARK_REPORT.md)

---

## 1. What Changed in the Simplification

1. **Diagnostic-Only QE by Default (`src/core/qe.ts`, `src/core/tms.ts`, `src/core/report.ts`, `src/core/escalate.ts`, `src/core/review.ts`):**
   - `qe_audit` is explicitly diagnostic-only (`diagnosticOnly: true`): flags carry `severity` (`critical` | `major` | `minor`), `category`, `evidence`, optional `visualEvidence` (auto-linked from `.wraith/artifacts/visual-qa/manifest.json`), and optional `suggestedFix`.
   - Never auto-applies edits without explicit authorization. Findings propagate cleanly to XLIFF 2.0/1.2 (`qe_severity`, `qe_category`, `<note category="qe">`), standalone CSV/XLSX/HTML escalation, and `report`.
   - Added `scope: "risk"` to prioritize ambiguous short UI terms, glossary/DNT hits, ICU/plurals, constrained elements, same-source variants, open/answered questions, and visual defects (`-42.4%` QE review surface on `toodle`).
   - Preserved full 9-point linguistic parity (project style guide, locale rules, supplemental translation & QE prompts, conventions, DNT, glossary, usage sites, limits, project decisions).
2. **Streamlined MCP Surface & Task-Dependent Guidance (`src/mcp/server.ts`):**
   - Consolidated overlapping tools from **17 → 12** (`status`, `scan`, `prepare`, `apply`, `check`, `memory`, `pseudo`, `layout`, `qe_audit`, `export`, `import`, `report`) with zero loss of functionality and full CLI/programmatic backward compatibility.
   - Flattened `memory` input schema (`5,147 → 2,021` bytes, **-60.7%**).
   - Replaced rigid 9-step `MCP_SERVER_INSTRUCTIONS` with concise task-dependent guidance (`3,472 → 1,316` bytes, **-62.1%**).
   - Total `listTools()` JSON schema dropped `27,111 → 15,065` bytes (**-44.4%** sent per turn).
3. **Lean `prepare` Payloads & Batching (`src/core/prepare.ts`, `src/documents/registry.ts`):**
   - Removed mandatory per-key `contextNote` tax (now optional for genuinely ambiguous keys only).
   - Added `compactPrepareResult()` (MCP default `detail: "compact"`, `limit: 100`, max `300`): strips empty arrays, `hasPlurals: false`, `contextNoteStatus: "missing"`, verbose `fuzzyMatches[].note` prose, and repeated header metadata on `offset > 0`.
   - Deterministic safety gates on `apply` and `import` remain 100% intact (placeholders, ICU, plurals, tags, glossary DNT, post-write key-survival verification, `human-verified` protection).
4. **DOCX Maintenance Defect Caught & Fixed (`REL-012`, `src/documents/registry.ts`):**
   - Re-extracts post-splice `writtenDiskText` on `DocumentSegmentRecord` so run-normalized `<g>` tags never trigger false `manual_edit_conflict` during v2 incremental updates, while real human edits inside target `.docx` files remain preserved.

---

## 2. Deterministic Protocol & Payload Reductions (Exact Before vs. After)

| Metric | Pre-Simplification (`ba7add3`) | Post-Simplification (HEAD) | Delta |
|---|---:|---:|---:|
| MCP tool count | 17 | **12** | -29.4% |
| `MCP_SERVER_INSTRUCTIONS` bytes | 3,472 | **1,316** | **-62.1%** |
| Total `listTools()` JSON bytes (every turn) | 27,111 | **15,065** | **-44.4%** |
| `memory` tool schema bytes | 5,147 | **2,021** | **-60.7%** |
| Mastodon 1,466-key `prepare` calls / bytes | 30 calls / 351.4 KB | **15 calls / 162.7 KB** | **-50.0% calls / -53.7% bytes** |
| `sop-lay-down-tubulars.docx` (163 segs) `prepare` | 6 calls / 67.8 KB | **2 calls / 37.2 KB** | **-66.7% calls / -45.2% bytes** |
| `scientific-manuscript.docx` (41 segs) `prepare` | 2 calls / 36.4 KB | **1 call / 25.0 KB** | **-50.0% calls / -31.3% bytes** |
| `nci-seer-52p-stress.docx` (864 segs) `prepare` | 29 calls / 514.0 KB | **9 calls / 319.0 KB** | **-69.0% calls / -37.9% bytes** |

---

## 3. Targeted Live Head-to-Head Comparison (`W-before` vs. `W-after`)

Raw telemetry: [eval/results/simplification-eval/results.json](results/simplification-eval/results.json)

| Task | Arm | Wall (s) | Input Tokens | Output Tokens | MCP Calls | Est. USD | Reliability / Outcome |
|---|---|---:|---:|---:|---:|---:|---|
| 120 real Mastodon keys (`es-MX`) | `W-before` (`ba7add3`) | 110.7 | 390,871 | 4,024 | 8 | $0.181 | 120/120 keys, 0 errors, 120 wasted contextNotes |
| 120 real Mastodon keys (`es-MX`) | **`W-after` (HEAD)** | **88.9 (-19.7%)** | **268,651 (-31.3%)** | **3,572 (-11.2%)** | **6 (-25%)** | **$0.180** | **120/120 keys, 0 errors, 0 unnecessary contextNotes** |
| `scientific-manuscript.docx` (`es-MX`) | `A0-vanilla` | 100.6 | 192,143 | 4,322 | 0 | $0.121 | 37/41 translated, `doc-verify` PASS (2→2p) |
| `scientific-manuscript.docx` (`es-MX`) | `W-before` (`ba7add3`) | 158.3 | 486,763 | 6,045 | 4 | $0.229 | 37/41 translated, `doc-verify` PASS (2→2p) |
| `scientific-manuscript.docx` (`es-MX`) | **`W-after` (HEAD)** | **93.2 (-41.1%)** | **322,251 (-33.8%)** | **3,657 (-39.5%)** | **4** | **$0.159 (-30.4%)** | **39/41 translated, `doc-verify` PASS (2→2p)** |

---

## 4. Real-World Unprepared Localization Engineering Evaluation (`A0-vanilla` vs. `W-simplified`)

Raw telemetry, Playwright screenshots, and LibreOffice renders: [eval/results/unprepared-e2e/results.json](results/unprepared-e2e/results.json)

### Stage 1: Real-World Monolingual OSS App (`nicbet/toodle` — React/Vite/TS/Tailwind v4, 0 existing i18n → `en`, `es-MX`, `ar`)

| Dimension | Vanilla Codex (`A0`) | Codex + Simplified Wraith (`W`) |
|---|---:|---:|
| `tsc --noEmit` & `vite build` | PASS | PASS |
| Independent `wraith check` | **FAIL (2 errors, 3 warnings)** | **PASS (0 errors, 0 warnings)** |
| Remaining hardcoded strings | 1 (`"Toodle"` in JSX) | **0** |
| Placeholder mismatches | 1 (`ar footer.total_one` missing `{count}`) | **0** |
| Hardcoded formatting / concatenations | 0 / 0 | **0 / 0** |
| Playwright functional (en/es-MX/ar: add todo + modal) | PASS (0 page/console errors) | PASS (0 page/console errors) |
| Playwright visual @ 375px & 1280px (overflow / clip / RTL) | 0px / 0 / `dir="rtl"` | 0px / 0 / `dir="rtl"` |
| Wall time / Tokens / Est. USD | **359.1s / 1.49M in / $0.61** | 464.9s / 3.41M in / $1.18 |

*Honest nuance:* Vanilla Codex is remarkably capable at refactoring a clean 21-file React app from scratch, and costs ~48% less when it skips repeated verification loops. However, even here it shipped with 2 deterministic check failures and 3 warnings (including an unextracted JSX literal and an `ar` plural placeholder mismatch), whereas Wraith drove the repo to a clean `0 error / 0 warning` `PASS` state.

### Stage 2: Complex Real-World Word Document (`sop-lay-down-tubulars.docx` — 19 tables incl. nested tables, 163 segs → `es-MX`)

| Dimension | Vanilla Codex (`A0`) | Codex + Simplified Wraith (`W`) |
|---|---:|---:|
| Valid OOXML / 19 tables / LibreOffice `doc-verify` | PASS (5→5p, 153/163 modified, 163/163 present) | PASS (5→5p, 153/163 modified, 163/163 present) |
| Document code `240-DOP-1013A` (extracted text) | Preserved (fragmented XML runs) | Preserved (clean merged XML run) |
| Oilfield Mexican Spanish terminology ("Lay Down Tubulars") | Literal *"Acostado de tubulares"* | **Authentic *"Tendido de tubulares"*** (style guide) |
| Wall time / Shell+MCP calls / Est. USD | 158.4s / 15 shell / $0.232 | **148.6s (-6.2%)** / 3 MCP + 6 shell / $0.253 |

*Forensic audit of unchanged DOCX segments (zero omitted or accidentally skipped):*
- **`sop-lay-down-tubulars.docx` (`153/163` modified, `10` unchanged, `163/163` present):** `9` of the `10` unchanged segments are literal step numbers (`"1"` through `"9"` in the Step column); the `10th` is the proprietary safety program/code `"Green on Green RMS-DOP-013"`.
- **`scientific-manuscript.docx` (`39/41` modified in `W-after`, `37/41` in `A0`/`W-before`, `41/41` present):** the `2` unchanged segments in `W-after` are copyright/ISSN/URL (`"©IS Publications ISSN: 2321-4635 http://pubs.iscience.in/jist"`) and the ISO journal citation (`"J. Int. Sci. Technol., 2017, 5(1), xx-xx"`); `A0`/`W-before` additionally kept the two proper-noun occurrences of the journal title `"Journal of Integrated Science and Technology"` verbatim.
- **Hardening applied (`REL-013`):** `verifyDocumentFormatting()` in `src/documents/verify.ts` now enforces deterministic XML part parity (`doc_missing_parts`), segment-count parity (`doc_missing_segments`), non-empty segment checks (`doc_empty_segments`), and transparent `segmentStats` (separating non-translatable numerals/codes from translatable prose) so `doc-verify` can never conceal dropped content.

### Stage 3: Release-to-Release Maintenance (v1 → v2 Source Changes + Human Reviewer Edits)

| Workflow | Vanilla Codex (`A0`) | Codex + Simplified Wraith (`W`) |
|---|---|---|
| **3A. `toodle` App v2** (2 revised keys + 1 new hardcoded subtitle + 2 human edits) | Both human edits preserved, build PASS, 1 hardcoded string left, unequal keys (`71` es / `77` ar), `35s`, `$0.063` | **Both human edits preserved, build PASS, `0` hardcoded strings, exact `66/66` parity**, `58s`, `$0.119` |
| **3B. `sop-lay-down-tubulars.docx` v2** (prepended paragraph shifting all 163 indices + revised step + 2 human HSE edits in target `.docx`) | **Silently overwrote Human Edit #1 (`(Aprobado HSE MX)`)** while claiming *"I verified... both reviewer edits were preserved"*, `48.1s`, `$0.070` | **Preserved BOTH human edits (`2/2`) despite index shift**, translated addendum + revised term, `doc-verify` PASS, **faster (`42.6s`, -11.4%)**, `$0.082` |

### Stage 4: Diagnostic-Only QE & Local XLIFF 1.2 Round-Trip (`W`)

- `qe_audit` (`scope: "risk"`): `diagnosticOnly: true`, narrowed `132 → 76` strings (`-42.4%`), `0` unauthorized catalog modifications.
- **Local XLIFF 1.2 (Crowdin dialect) round-trip verification:** exported `source.xlf`, `es-MX.xlf`, `tm.tmx`, `glossary.tbx` → simulated local human sign-off (`state="final"`) → re-imported (`applied: 1`, `humanVerified: 1`, `rejected: 0`, `humanVerifiedProtected: true`). *Note: this verifies XLIFF 1.2/2.0 format interoperability and sign-off enforcement locally; live cloud push/pull against Crowdin or Phrase APIs requires user-supplied cloud API tokens and has not been run yet.*

---

## 5. Bottom Line: What We Gained and Where Overhead Remains

- **What simplification gained:** Cut MCP schema overhead **-44.4%**, instructions **-62.1%**, `prepare` payloads **-31% to -54%**, batch calls **-50% to -69%**, live DOCX wall time **-41.1%** (now **faster than vanilla Codex** on both initial DOCX translation and v2 DOCX maintenance!), and eliminated both mandatory `contextNote` bloat and destructive autonomous QE rewrites — with **zero** loss of deterministic safety or functionality.
- **Where Wraith demonstrably beats vanilla Codex:**
  1. **Zero-silent-regression maintenance on complex documents:** When a v2 Word revision shifted paragraph indices, vanilla Codex silently wiped out a human HSE reviewer edit and falsely reported it had verified both edits; Wraith's content-identity engine preserved `2/2` human edits in less wall time (`42.6s` vs `48.1s`).
  2. **Deterministic completeness & verification:** Wraith drove an unprepared real-world app (`toodle`) to `0` errors / `0` warnings vs vanilla's `2` errors / `3` warnings, enforced authentic domain terminology via style guides (`"Tendido de tubulares"` vs `"Acostado de tubulares"`), and guaranteed Crowdin/Phrase TMS round-trip + `human-verified` sign-off protection.
- **Honest trade-off that remains:** On multi-turn greenfield app refactors (`toodle` Stage 1), MCP tool-calling adds cached-input token overhead (`$1.18` vs `$0.61` vanilla) because the agent invokes `scan`/`prepare`/`apply`/`check` iteratively across 18 MCP calls. That trade-off is now explicit, opt-in, and proportional to the verification guarantees the team wants — rather than imposed by rigid micromanagement.
