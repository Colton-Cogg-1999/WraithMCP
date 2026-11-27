---
name: localize-pr
description: Translate only the source-locale keys changed in a pull request into every configured target locale, verify them deterministically, review them in context (ok/flag), and leave anything a human must decide for the TMS loop. Use for the `/localize` PR comment in CI (agentic-localize job) or when asked to "localize this PR / branch / diff".
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
   2. Inspect usage sites when a string is short, ambiguous, or UI-constrained. Pass an optional `contextNote` to `apply` only for genuinely ambiguous or domain-specific keys (not needed for self-explanatory strings). Treat every Answer in `questions` as binding.
   3. Translate in context. Keep every placeholder, ICU argument, plural category, and inline tag. Respect DNT terms, glossary translations, style guide rules, and `charLimit`.
   4. `apply` with `targetLocale` and the translations. If `apply` rejects an item, fix that item and re-apply. Never bypass `apply`.
   5. Record non-obvious decisions (tone, brand, register) with `memory` (`action: "add_assumption"`). If a string's meaning is still unclear after reading the code, apply your best guess and file it with `memory` (`action: "add_question"`); don't stop to ask.
3. `check` (`scope: "translations"` or CLI `wraith check`). Fix every `error`; re-run until `PASS`.
4. Optionally run a fresh-context diagnostic audit with **qe-review** (`qe_audit` `mode: "prepare"` with `keys` or `scope: "risk"` → `mode: "submit"`). Do not auto-apply QE edits without authorization; surface diagnostic findings in `report` or hand off via **tms-roundtrip**.
5. If a dev server is available: `layout` (`mode: "visual_qa"`) for touched routes and target locales; fix layout regressions via **layout-remediation**.
6. Open Questions: list them (`memory` list_questions). Locally, ask the user all of them in one message, record replies with answer_question, revisit the affected strings, then resolve_question. In CI there's no one to ask: list them in your final message so they appear on the PR.
7. `report` (CLI `wraith report`) → print its Markdown as your final message. It already lists what needs attention, what was caught and fixed, open questions (Q1…) and assumptions (A1…) with how to reply.

## Follow-ups

When the user replies to an ID from the report ("Q1: …" answers a question, "A2: …" overrides an assumption): record it with `memory` answer_question or override_assumption, `prepare` the affected keys (answered questions show reason `question_answered`; for an override, the strings it touches), fix them with `apply`, re-review them per **qe-review**, then resolve_question or apply_override, and post the updated `report`.

## Stop conditions

- Done: `check` returns `PASS` and every changed key/locale has been applied and reviewed (ok or flagged).
- Stop after 3 consecutive `check` iterations that fail on the same issue; report it with file/key.
- Stop if `check` returns `INCONCLUSIVE`; report the reason, never claim `PASS`.

## Never

- Never edit locale files directly or touch keys outside the changed set (except fixing `check` errors you introduced).
- Never edit source code, configs, CI files, or `.wraith/visual-baseline.json` in this skill.
- Never edit `.wraith/qe-verdicts.json`, set `human-verified`, or set `provenance: "human-reviewed"`.
- Never commit or push; CI (or the user) does that after `check` passes.
- Never drop, rename, or translate placeholders, ICU keywords, or DNT terms.
- Never loop on flagged strings: one fix-and-re-review round, then hand them to a human.
