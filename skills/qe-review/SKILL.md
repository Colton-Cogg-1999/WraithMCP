---
name: qe-review
description: Run a diagnostic-only quality audit of translated strings in their real code and visual context in a fresh context, flagging defects with evidence, severity, and optional suggested fixes without auto-editing deliverables. Use when asked to "QE", "review", or "audit" translations, when `wraith qe` exits 1 or 2, or before release sign-off.
---

# qe-review

QE is a **diagnostic-only** audit by default. Never automatically post-edit catalogs without explicit authorization. Wraith calls no model; it prepares file-scoped tasks with full style/glossary/locale/visual context and stores pinned verdicts.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`).

## Fresh context

Do the review in a context that did not produce the translations (use a subagent if available). Never approve strings in the same context that translated them.

## Sequence

1. `check` (CLI `wraith check`) first. Strings with deterministic errors are listed in `blockedByCheck`.
2. `qe_audit` with `mode: "prepare"` (optionally `scope: "risk"` for high-risk strings; CLI `wraith qe --prepare [--scope risk] --json`). You receive full linguistic parity (`styleGuide`, locale rules, `conventionsByLocale`, `doNotTranslate`, `projectDecisions`) plus file-scoped tasks with `fingerprint`, `sameSourceElsewhere`, `termBase`, and `visualDefects`.
3. For each task, **open the file** and inspect how each key is used plus any `visualDefects`. Mark `"flag"` only when a user would find it wrong, misleading, visually broken, or in violation of an explicit rule. Include `fingerprint`, `severity` (`critical`|`major`|`minor`), `category`, `reason`, `evidence`, optional `visualEvidence`, and optional `suggestedFix`.
4. `qe_audit` with `mode: "submit"` and `verdicts: [...]` (CLI `wraith qe --submit verdicts.json`).
5. **Do not auto-apply edits without authorization.** Present diagnostic findings with `report`, or hand off flagged items to a TMS (`export` `onlyFlagged: true`) or human review (`export` `format: "human"`). Only apply corrections via `apply` if explicitly authorized by the user.
6. `qe_audit` (status mode, CLI `wraith qe`) shows final counts and severity breakdown.

## Never

- Never auto-edit target catalogs during QE without explicit authorization.
- Never review in the same context that translated, or mark strings `ok` without inspecting usage context.
- Never edit `.wraith/qe-verdicts.json` by hand or overwrite `human-verified` records.
- Never flag style preferences or acceptable alternatives unless they violate an explicit style guide or prompt rule.
