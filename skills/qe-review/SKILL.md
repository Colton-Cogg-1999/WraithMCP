---
name: qe-review
description: Review translated strings in their real code context and give each one a binary ok/flag verdict, working in a fresh context, then fix what is flagged and hand anything a human must decide to the TMS loop. Use when asked to "QE", "review", or "check the quality of" translations, after translating a batch, when `wraith qe` exits 1 or 2, or before release sign-off.
---

# qe-review

QE is a review, not a score. For each translated string you answer one question: would a user of this UI in the target locale find this translation wrong, misleading or broken? Wraith calls no model. It tells you what to review, supplies facts you can't see from one file, and stores your verdicts.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). Arguments mirror the CLI flags in camelCase.

## Fresh context

Do the review in a context that did not produce the translations. In Claude Code, hand steps 2–3 to a subagent (Agent tool) with the task list. Where no subagent is available, finish translating first and then review as a separate step. Never approve strings while you are still translating them.

## Sequence

1. `check` (CLI `wraith check`) first. Strings with check errors are not sent for review (`blockedByCheck`). Fix them with `apply`.
2. `qe_audit` with `mode: "prepare"` (CLI `wraith qe --prepare --json`). You get `instructions`, `projectDecisions` (register, brand handling and similar), and `tasks`, one per locale × file. Each string comes with `sameSourceElsewhere` (how the project translates the same text elsewhere) and `termBase` hits. Only strings without a current verdict are included.
3. For each task, **open the file** and read how each key is used: the element, the neighbouring strings, and what the code does with it. Then decide `ok` or `flag` following `instructions`. Every flag needs a one-line `reason`. Add `suggestedFix` (the full target, with placeholders, ICU and tags intact) when the fix is clear. If the meaning of the source itself is unclear even with the code, flag it with a reason starting "Unclear meaning:".
4. `qe_audit` with `mode: "submit"` and `verdicts: [...]` (CLI `wraith qe --submit verdicts.json`).
5. Fix flagged strings with `apply`. An edited string becomes `unreviewed` again, so run steps 2–4 once more for just those strings. Anything that needs a human decision goes to **tms-roundtrip** (`tms_export` with `onlyFlagged: true`).
6. `qe_audit` (status mode, CLI `wraith qe`) shows the final counts: `PASS` means everything is ok or human-verified, `FAIL` means something is still flagged, `INCONCLUSIVE` means something is unreviewed.

## Stop conditions

- Done: no `unreviewed` strings in scope, and every `flagged` string is either fixed and re-reviewed or exported for human review.
- At most one fix-and-re-review round per string per run. If it is still flagged, it goes to a human.

## Never

- Never review in the same context that translated, or mark strings `ok` without opening the file they are used in.
- Never edit `.wraith/qe-verdicts.json` by hand or set `human-verified`. Only TMS import does that.
- Never flag style preferences or acceptable alternatives. A flag means a user would be misled or the UI would break.
