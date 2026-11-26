# Quality Estimation & TMS Round-Trip

## QE review (`wraith qe` / MCP `qe_audit`)

QE is a review, not a score. Each translated string gets one verdict, `ok` or `flag`, from your coding agent, which reads the code where the string is used. Wraith calls no model. It decides what needs reviewing, supplies facts the agent can't see from one file, and stores the verdicts.

```bash
wraith qe --prepare [--locales de,ja] [--all] [--json]   # write review tasks → .wraith/qe-tasks.json
wraith qe --submit verdicts.json                          # store verdicts
wraith qe [--locales de,ja] [--json]                      # status: PASS / FAIL (flagged) / INCONCLUSIVE (unreviewed)
```

MCP: `qe_audit` with `mode: "prepare" | "submit" | "status"` (default `status`). It never edits catalogs; flagged strings are fixed with `apply`.

**Loop:**

1. **Prepare.** One task per locale × file, covering every translated string without a current verdict. Strings with `check` errors are listed in `blockedByCheck` and left out until they're fixed. Each string carries:
   - `sameSourceElsewhere`: how the project translates the same source text in other files.
   - `termBase`: Term Base hits.
   - `comment`: the developer comment, if any.

   The result also includes `projectDecisions` (recorded assumptions such as register or brand handling) and one set of reviewer `instructions`.
2. **Review in a fresh context.** In Claude Code that means a subagent; elsewhere, a separate step after translating. The reviewer opens each file and reads how every key is used, then marks a string `flag` only if a user of that UI would find it wrong, misleading or broken. Every flag needs a reason, plus `suggestedFix` when the fix is clear. An unclear source gets a reason starting "Unclear meaning:".
3. **Submit.** Each verdict is stored in `.wraith/qe-verdicts.json`, pinned to the exact source and target it judged. Editing either one makes the string `unreviewed` again, so the next run reviews only what changed.
4. **Fix and hand off.** Fix flagged strings with `apply` and re-review them once. Strings that still need a human go out through `export --only-flagged`, and TMS import records them as `human-verified`.

Status per string: `unreviewed` | `ok` | `flagged` | `human-verified`.

### `qe-verdicts.json`

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

## TMS export (`wraith export` / MCP `tms_export`)

```bash
wraith export [--format xliff2] [--out .wraith/exports/tms] [--locales de,ja] \
  [--only-flagged] [--include-tm] [--include-glossary] [--bundle-screenshots] [--json]
```

`tms_export` is `readOnlyHint: true`; it writes only to the explicit export directory.

| File | Format |
|---|---|
| `<locale>.xliff` | XLIFF 2.0 with `mda:` metadata |
| `tm.tmx` | TMX 1.4b (`--include-tm`) |
| `glossary.tbx` | TBX-Basic (`--include-glossary`) |
| `screenshots/` + `manifest.json` | visual-qa / layout screenshots (`--bundle-screenshots`) |

`--only-flagged` limits units to strings flagged in QE review.

### XLIFF 2.0 unit

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0"
       xmlns:mda="urn:oasis:names:tc:xliff:metadata:2.0"
       version="2.0" srcLang="en" trgLang="de">
  <file id="f1" original="messages/en.json">
    <unit id="cart.itemCount">
      <mda:metadata>
        <mda:metaGroup category="wraith">
          <mda:meta type="file">src/components/Cart.tsx</mda:meta>
          <mda:meta type="line">27</mda:meta>
          <mda:meta type="component">CartBadge</mda:meta>
          <mda:meta type="qe_status">flagged</mda:meta>
          <mda:meta type="max_chars">18</mda:meta>
          <mda:meta type="max_width_px">120</mda:meta>
          <mda:meta type="tm_similarity">0.71</mda:meta>
        </mda:metaGroup>
      </mda:metadata>
      <notes>
        <note category="qe">Flagged in review: "Artikel" reads as products, but this badge counts list items</note>
        <note category="tm">Fuzzy 71%: "{count} items in basket" → "{count} Artikel im Warenkorb" (human-reviewed)</note>
      </notes>
      <segment state="translated">
        <source><ph id="1" disp="{count}"/> items in cart</source>
        <target><ph id="1" disp="{count}"/> Artikel im Warenkorb</target>
      </segment>
    </unit>
  </file>
</xliff>
```

`<segment state>`: `initial` (no target), `translated` (agent/MT), `reviewed` (human-verified). Placeholders are always `<ph id disp="{var}"/>` so TMS editors cannot alter them.

### TMX 1.4b skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4">
  <header creationtool="wraith" creationtoolversion="0.1.0" datatype="plaintext"
          segtype="sentence" adminlang="en" srclang="en" o-tmf="wraith"/>
  <body>
    <tu tuid="checkout.cta">
      <prop type="x-provenance">human-reviewed</prop>
      <tuv xml:lang="en"><seg>Place order</seg></tuv>
      <tuv xml:lang="de"><seg>Bestellung aufgeben</seg></tuv>
    </tu>
  </body>
</tmx>
```

### TBX-Basic skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<tbx type="TBX-Basic" style="dct" xml:lang="en" xmlns="urn:iso:std:iso:30042:ed-2">
  <tbxHeader><fileDesc><sourceDesc><p>Wraith glossary export</p></sourceDesc></fileDesc></tbxHeader>
  <text><body>
    <conceptEntry id="c1">
      <langSec xml:lang="en"><termSec><term>Workspace</term></termSec></langSec>
      <langSec xml:lang="de"><termSec><term>Arbeitsbereich</term></termSec></langSec>
    </conceptEntry>
    <conceptEntry id="c2">
      <descrip type="definition">Do not translate (brand)</descrip>
      <langSec xml:lang="en"><termSec><term>Acme Pulse</term></termSec></langSec>
    </conceptEntry>
  </body></text>
</tbx>
```

---

## TMS import (`wraith import` / MCP `tms_import`)

```bash
wraith import reviewed/de.xliff        # or a directory of .xliff/.xlf files
wraith import reviewed/ --format xliff
```

`.xliff`/`.xlf` files (or directories of them) are auto-detected. For each unit Wraith:

1. Validates the target through the same placeholder / ICU / plural / glossary pipeline as `apply`; failing units are rejected and listed.
2. Writes catalogs losslessly, preserving key order.
3. Upserts `.wraith/tm.json` with `provenance: "human-reviewed"` and `verifiedAt`.
4. Records the string as `human-verified` in `qe-verdicts.json`.
5. Runs `check` (and `visual-qa` when `layout.baseUrl` is configured) and prints a diff summary.

`tms_import` is `destructiveHint: true`. CSV / TBX / TMX / locale-file asset import is unchanged (`--format auto|csv|tbx|tmx|locales`).

## Benchmark status

The TM ablation (Stage 4: how `human-reviewed` TM changes outcomes) is **dry-run validated; full run pending**. Run it with `node eval/run.mjs run --scopes tm-ablation`; results will be published in `eval/REPORT.md` Section 13. No Stage 4 numbers are claimed here.

### Proof of concept (2026-11-25): not publishable evidence

This was one locale (de), one blind agent run per arm, with a test set written by the evaluator. Scripts are in `eval/poc/` and results in `eval/results/poc-qe-*.json` and `eval/results/poc-tm.json`.

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

**TM context (Stage 4 arms Anotm vs Afull, synthetic-app, 60 items):** both arms reached TCR 1.0, so within one batch the model is already consistent. Afull matched the project's established phrasing more closely: chrF2 97.5 vs 90.3. On items whose gold translation was in the TM the scores were 100 vs 85.4, which is expected copying. On unseeded items they were 96.0 vs 93.3. TM's real value is consistency across runs and sessions, which a single-batch test cannot show.
