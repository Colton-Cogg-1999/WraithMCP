---
name: localize-pr
description: Translate only the source-locale keys changed in a pull request into every configured target locale, verify them deterministically, score them with QE, and leave anything risky for human review. Use for the `/localize` PR comment in CI (agentic-localize job) or when asked to "localize this PR / branch / diff".
---

# localize-pr

You are the translator. Wraith is the memory, the rules, and the proof. Scope is the changed keys only.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). New-tool arguments mirror the CLI flags in camelCase.

## Inputs

- The list of changed source keys (`file<TAB>key`; `*` = whole file changed). In CI it is appended to this prompt. Locally: `git diff origin/main...HEAD -- <source locale files>`.

## Sequence

1. `status` (CLI `wraith status --json`) → read `sourceLocale` and `targetLocales`. If not initialized or no targets: stop and report.
2. For each target locale:
   1. `prepare` with `targetLocale` and `keys: [<changed keys>]` (paginate with `offset`/`limit` until all are returned). Read usage sites, surrounding strings, glossary hits, width budgets, conventions, and fuzzy TM matches. Treat every TM match, even 100%, as a suggestion to verify against the current UI context; `human-reviewed` TM outranks `llm-generated`.
   2. Translate in context. Keep every placeholder, ICU argument, plural category, and inline tag. Respect DNT terms, glossary translations, and `maxWidthPx`/`budgetChars` budgets (use approved glossary abbreviations; keep the full label in `title`/`aria-label`).
   3. `apply` with `targetLocale` and the translations. If `apply` rejects an item, fix that item and re-apply. Never bypass `apply`.
   4. Record non-obvious decisions (tone, brand, ambiguous sense) with `memory` (assumptions).
3. `check` (CLI `wraith check`). Fix every `error`; re-run until `PASS`. Warnings on unchanged keys are out of scope.
4. `qe_audit` (CLI `wraith qe --json`). Optionally with `autoRepair: true` (CLI `--auto-repair`) for a single repair pass on 25–60 risk segments.
   - `verified` → done.
   - `unscored` → no QE model keys; report as unscored, not verified.
   - `needs_review` → do not keep re-translating. Leave it for the human loop (**tms-roundtrip** skill / CI export).
5. If a dev server is available: `visual_qa` for the touched routes and target locales; fix layout regressions via **layout-remediation**.
6. `report` (CLI `wraith report`) → print the Markdown summary as your final message, including escalated keys with risk scores.

## Stop conditions

- Done: `check` returns `PASS` and every changed key/locale has been applied and QE-scored (any status).
- Stop after 3 consecutive `check` iterations that fail on the same issue; report it with file/key.
- Stop if `check` returns `INCONCLUSIVE`; report the reason, never claim `PASS`.

## Never

- Never edit locale files directly or touch keys outside the changed set (except fixing `check` errors you introduced).
- Never edit source code, configs, CI files, or `.wraith/visual-baseline.json` in this skill.
- Never mark anything verified yourself, edit `.wraith/qe-report.json`, or set `provenance: "human-reviewed"`.
- Never commit or push; CI (or the user) does that after `check` passes.
- Never drop, rename, or translate placeholders, ICU keywords, or DNT terms.
- Never loop on `needs_review` segments to force a lower score.
