# QE Review (`wraith qe` / MCP `qe_audit`)

QE is a review, not a score. Each translated string gets one verdict, `ok` or `flag`, from your coding agent, which reads the code where the string is used. Wraith calls no model. It decides what needs reviewing, supplies facts the agent can't see from one file, and stores the verdicts.

```bash
wraith qe --prepare [--locales de,ja] [--all] [--json]   # write review tasks → .wraith/qe-tasks.json
wraith qe --submit verdicts.json                          # store verdicts
wraith qe [--locales de,ja] [--json]                      # status: PASS / FAIL (flagged) / INCONCLUSIVE (unreviewed)
```

MCP: `qe_audit` with `mode: "prepare" | "submit" | "status"` (default `status`). It never edits catalogs; flagged strings are fixed with `apply`.

## Review loop

1. **Prepare.** One task per locale × file, covering every translated string without a current verdict (`human-verified` strings are excluded even with `--all`). Strings with `check` errors are listed in `blockedByCheck` and left out until they're fixed. Each string carries:
   - `fingerprint`: short content hash of `source + target` at prepare time.
   - `sameSourceElsewhere`: how the project translates the same source text elsewhere.
   - `termBase`: Term Base hits.
   - `comment`: the developer comment, if any.

   The result also includes `projectDecisions` (recorded assumptions such as register or brand handling) and one set of reviewer `instructions`.
2. **Review in a fresh context.** Spawn a subagent (e.g. Claude Code `Agent` tool or a fresh `codex exec` session) so the reviewer never shares context with the translator. The reviewer opens each file and reads how every key is used, then marks a string `flag` only if a user of that UI would find it wrong, misleading or broken. Every flag needs a reason, plus `suggestedFix` when the fix is clear. An unclear source gets a reason starting `"Unclear meaning:"`.
3. **Submit.** Each verdict must echo the string's `fingerprint` (or `target`) and is stored in `.wraith/qe-verdicts.json`. If the catalog changed between `prepare` and `submit`, the verdict is rejected (`text_changed`) so an `ok` or `flag` never lands on unreviewed text; agent submits also cannot overwrite `human-verified` records (`human_verified`). Editing source or target later makes the string `unreviewed` again, so the next run reviews only what changed. Corrupt `qe-verdicts.json` files fail loudly rather than being overwritten.
4. **Fix and hand off.** Fix flagged strings with `apply` and re-review them once. Strings that still need a human go out through `wraith export --only-flagged`, and TMS import records reviewed units as `human-verified` (see [TMS.md](TMS.md)).

Status per string: `unreviewed` | `ok` | `flagged` | `human-verified`.

## `qe-verdicts.json`

```json
{
  "version": 2,
  "records": [
    {
      "locale": "de", "key": "toolbar.save", "source": "Save", "target": "Sparen",
      "verdict": "flag", "reason": "'Sparen' means saving money; this button saves the document",
      "suggestedFix": "Speichern", "reviewedAt": "2026-11-25T19:00:00.000Z"
    }
  ]
}
```

`verdict` is `ok`, `flag` or `human-verified`. The last is written only by TMS import.

## Proof of concept (2026-11-25): not publishable evidence

This was one locale (de), one blind agent run per arm, with a test set written by the evaluator. Scripts are in `eval/poc/` and results in `eval/results/poc-qe-*.json` and `eval/results/poc-trial.json`.

**QE review.** One German locale. 40 recurring strings (20 clean, 20 with planted meaning errors) plus 10 strings that appear only once (5 clean, 5 with planted errors), so for those nothing elsewhere in the project gives the error away. The error types were wrong word sense, negation, inversion, omission, addition, register and UI form. Every planted error kept its placeholders, ICU and tags intact, so deterministic `check` caught **0** of them. The reviewer was a blind subagent in a fresh context, with only the task file and the component files.

| Run | Errors flagged (all) | Recurring | One-off | Clean strings flagged |
|---|---:|---:|---:|---:|
| Earlier three-critic design + risk score, Sonnet, before no-TM fix | 20/20 | 20/20 | — | **20/20** |
| Earlier three-critic design + risk score, Sonnet, after no-TM fix | 17/20 | 17/20 | — | 0/20 |
| **Binary review in code context, Opus** | **25/25** | **20/20** | **5/5** | **0/25** |

The three misses in the earlier design (dropped "E-Mail", a noun used for a button verb, du/Sie register) were all found by the critics but rated `minor`, so the risk score let them through. The binary review flagged all three.

The last row changed both the design and the model, so the comparison doesn't show which helped more. The planted errors are also blunt ones written by the evaluator. Read this as "the loop works end to end," not as an accuracy figure. Results: `eval/results/poc-qe-opus.json` and `eval/results/poc-qe-three-critic-sonnet.json`.

**Behavioural trial: Context Notes, Character Limits, Open Questions.** A headless Claude Code agent with Wraith over MCP and the `localize-pr` + `qe-review` skills localized `nextjs-commerce` (63 strings) into de. The app has 20 short strings whose meaning the code settles (Open/Post/Close/Save…). We added 3 whose meaning it can't settle ("Cover", "Lead", "Drop") and 2 declared limits.

- **Round 1** ($1.27, 2.8 min): 63/63 translated, `check` PASS. The agent filed **1 question covering all 3 seeded strings**, with best guesses and alternatives, and asked about **none** of the 60 others; all 20 short ambiguous ones were resolved correctly from code. Both declared limits held ("Optionen" 8/10, "Erstatten" 9/14). It wrote Context Notes for 63/63 (median 76 chars, all specific). The fresh-context QE review found 60 ok and flagged 3, the same strings as the question.
- **Round 2**, after answering Q1 with two answers that contradicted the agent's guesses ($0.49, 42 s): exactly those two strings changed ("Titelbild" → "Hülle", "Neuheit" → "Reduziert"). The correct guess was kept, all three notes were rewritten, Q1 was resolved, and QE ended at 63/63 ok.

The trial led to two fixes:
- The reviewer no longer flags strings that already have an open question.
- A new Answer now resets the QE verdicts of the strings it covers.

Results: `eval/results/poc-trial.json`; harness: `eval/poc/trial.mjs`.
