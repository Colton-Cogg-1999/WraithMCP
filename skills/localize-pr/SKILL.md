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
   2. Read the code at each usage site. Write a `contextNote` (one plain sentence: what the string means and where it appears) for every item whose `contextNoteStatus` is `missing` or `stale`. Treat every Answer in `questions` as binding.
   3. Translate in context. Keep every placeholder, ICU argument, plural category, and inline tag. Respect DNT terms, glossary translations, and `charLimit` (declared = binding; inferred = shorten to fit, and file an Open Question only if shortening would lose meaning) (use approved glossary abbreviations; keep the full label in `title`/`aria-label`).
   4. `apply` with `targetLocale` and the translations (include `contextNote` where needed). After each batch, post a one-line progress update from `apply`'s `progress` field (e.g. "de: 40/63 translated, 1 open question so far"). If `apply` rejects an item, fix that item and re-apply. Never bypass `apply`.
   5. Record non-obvious decisions (tone, brand, register) with `memory` add_assumption. If a string's meaning is still unclear after reading the code, apply your best guess and file it with `memory` add_question; don't stop to ask.
3. `check` (CLI `wraith check`). Fix every `error`; re-run until `PASS`. Also shorten changed strings warned as `char_limit_inferred` or `layout_budget_exceeded`. Warnings on unchanged keys are out of scope.
4. Review with the **qe-review** skill, in a fresh context (a subagent if available): `qe_audit` `mode: "prepare"` with the changed keys → open each file and judge each string `ok`/`flag` → `mode: "submit"`. Fix flagged strings once with `apply` and re-review them; anything still flagged is left for the human loop (**tms-roundtrip** skill / CI export).
5. If a dev server is available: `visual_qa` for the touched routes and target locales; fix layout regressions via **layout-remediation**.
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
