---
name: qe-triage
description: Run Wraith's tiered translation quality estimation (deterministic Tier 1, three-critic Tier 2, risk-score Tier 3), interpret `.wraith/qe-report.json`, apply at most one bounded repair pass, and route everything else to human review. Use when asked to "QE", "score", or "triage" translations, when `wraith qe` exits 1, or before release sign-off.
---

# qe-triage

QE ranks risk; it does not certify quality. Tier 1 is deterministic and free; Tier 2 costs model tokens and runs only when `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set (model override: `WRAITH_QE_MODEL`).

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). New-tool arguments mirror the CLI flags in camelCase.

## Sequence

1. `check` (CLI `wraith check`) must be `PASS` first. QE on a failing catalog wastes tokens: Tier 1 hard failures score risk 100 without any model call.
2. `qe_audit` with `autoRepair: false` (CLI `wraith qe --json [--locales …]`). Writes `.wraith/qe-report.json`.
3. Read the report:
   - `tier2: "unavailable"` → segments passing Tier 1 are `unscored`. Report that QE was not performed; do not call them verified.
   - `riskScore < 25` → `verified`.
   - `25–60` → candidate for one repair pass.
   - `> 60`, or any Tier 1 failure / over-budget (`budgetUtilization` = 1 with overflow) → `needs_review`.
   - Inspect `swarm[]` per segment: `critic` (`terminology` / `ui_context` / `semantic`), `severity`, `issue`, `suggestedFix`.
4. **Repair (optional, once)** — either `qe_audit` with `autoRepair: true` (CLI `wraith qe --auto-repair`), which writes through the validated apply path and re-scores; or manually re-`apply` the 25–60 segments using `suggestedFix` only when it is consistent with glossary, TM, and UI context. Then `check` again.
5. Remaining `needs_review` → hand off with the **tms-roundtrip** skill (`tms_export` with `onlyFlagged: true`).
6. Summarize: counts per status, top 10 by `riskScore` with critic issues, and whether Tier 2 ran.

## Risk formula (for explaining scores)

`Risk = round(min(100, 100 × (0.35·S_swarm + 0.25·(1 − TM_sim) + 0.20·U_budget + 0.20·C_novelty)))`, severity weights critical 1.0 / major 0.75 / minor 0.35 / none 0.

## Stop conditions

- Done: no segment above `--fail-above` (if given), no `needs_review` left unexported, `check` `PASS`.
- One repair pass maximum per run. Segments still ≥ 25 after repair stay `needs_review`.

## Never

- Never edit `.wraith/qe-report.json` or set `status`/`provenance` by hand.
- Never treat `unscored` as `verified`, or a low risk score as proof of correctness.
- Never apply a critic `suggestedFix` that breaks placeholders, glossary, DNT, or width budgets — `apply` will reject it; do not work around it.
- Never run repeated repair passes to push a score under 25.
- Never send secrets, customer data, or non-catalog content to the QE model.
