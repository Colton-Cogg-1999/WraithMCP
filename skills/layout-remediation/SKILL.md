---
name: layout-remediation
description: Fix rendered localization layout defects (clipped/truncated text, overflow, container blowout, line-wrap regressions, occlusion, RTL dir/lang mismatch, tofu, contrast regressions) found by `wraith layout` or `wraith visual-qa`, using the deterministic remediation ladder — codemods first, then prescribed code edits, then width-budgeted retranslation. Use when layout or visual_qa returns FAIL or a PR gate shows visual-qa failures.
---

# layout-remediation

Follow the ladder strictly in order. Each rung is cheaper and safer than the next.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). New-tool arguments mirror the CLI flags in camelCase.

## Sequence

0. **Reproduce** — `layout` (CLI `wraith layout --url <url> [--routes …] [-l …]`) and/or `visual_qa` (CLI `wraith visual-qa --url <url> --json`). Record each finding: rule, key, `file:line`, viewport, locale, measured px. If either returns `INCONCLUSIVE`, stop and report why (no Playwright, no server, no baseline).
1. **Mechanical codemods** — `layout_fix` with `dryRun: true`, inspect, then `layout_fix` (CLI `wraith layout --fix [--dry-run]`). Pass `flaggedWidthLines` / `flaggedLongWordLines` from step 0 so `w-*`→`min-w-*` and `hyphens-auto` target only measured lines. Re-run step 0.
2. **Prescribed code edits** — for remaining findings, edit the exact `file:line`:
   | Rule | Typical fix |
   |---|---|
   | `text_truncation`, clipped text | remove `truncate`/`whitespace-nowrap` on translatable text, `min-w-0` + `flex-wrap`, allow 2 lines |
   | `container_blowout`, overflow | `flex-wrap`, `min-w-0`, `max-w-full`, grid `minmax(0,1fr)`, `overflow-wrap:anywhere` |
   | `line_wrap_regression` | widen the container or let siblings wrap; if wrapping is acceptable, it is a baseline update (see below), not a code fix |
   | `element_occlusion` | remove absolute positioning that assumes text length; use flow/gap |
   | `missing_glyph_tofu` | add a font stack/subset covering the script (e.g. Noto Sans Arabic/JP) |
   | `contrast_regression` | restore token colors; never change contrast to fit text |
   | RTL `dir`/`lang` mismatch | set `dir`/`lang` on `<html>` from the active locale |
   Re-run step 0.
3. **Width budgets** — for keys still over budget: confirm budgets were saved to `.wraith/layout.json` (`layout` with `saveBudgets: true`), then `prepare` those keys (budgets appear in the batch) and re-`apply` shorter translations. Use approved glossary `abbreviations` with the full label in `title`/`aria-label`. Add a new abbreviation only through `memory` and record it as an assumption.
4. **Verify** — `layout`, `visual_qa`, then `check` (CLI `wraith check`) must be `PASS`.

## Baseline updates

`visual_qa` compares against `.wraith/visual-baseline.json`. Only recapture (`wraith visual-qa --capture-baseline`) when the geometry change is intentional (redesign, approved wrap). In CI the `update-baseline` job captures it on `main`; commit it through a reviewed PR.

## Stop conditions

- Done: `layout` and `visual_qa` `PASS` at all configured viewports for affected locales, and `check` `PASS`.
- Stop after two full ladder passes with the same finding; report the finding with px measurements and the attempted fixes.

## Never

- Never hide overflow with `overflow:hidden`, `text-overflow:ellipsis`, smaller `font-size`, or negative letter-spacing to make a check pass.
- Never shorten a translation before rungs 1–2 are exhausted, or beyond the meaning of the source.
- Never edit `.wraith/visual-baseline.json` by hand or recapture it to silence a regression.
- Never apply `layout_fix` without reviewing the dry-run diff first.
- Never claim `PASS` from an `INCONCLUSIVE` run.
