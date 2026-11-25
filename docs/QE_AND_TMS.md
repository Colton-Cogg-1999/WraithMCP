# Quality Estimation & TMS Round-Trip

## QE (`wraith qe` / MCP `qe_audit`)

```bash
wraith qe [--locales de,ja] [--auto-repair] [--fail-above 60] [--json]
```

Writes `.wraith/qe-report.json`. Exit `1` if any segment's risk > `--fail-above` or any segment is `needs_review`.

**Model selection (Tier 2 only):** `WRAITH_QE_MODEL`, else `claude-haiku-4-5-20251001` if `ANTHROPIC_API_KEY` is set, else `gemini-2.5-flash` if `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set. With no key, Tier 2 is skipped (`tier2: "unavailable"`) and segments passing Tier 1 are `unscored` — fail-closed, never `verified`.

MCP `qe_audit` is annotated `destructiveHint: true` because `autoRepair` can write catalogs; with `autoRepair: false` it only writes `qe-report.json`.

### Tiers

1. **Tier 1 — deterministic (0 tokens).** The same validations as `check` (placeholders, ICU, plurals, inline tags, glossary/DNT) plus width budget utilization `U = min(1, width / maxBudgetWidth)` from `layout.json`. Hard failure or over budget → risk 100, `needs_review`, no LLM call.
2. **Tier 2 — three critics (opt-in tokens).** Batched per source file, ≤ 25 segments per call, strict JSON output:
   - `terminology` — Terminology & TM drift (glossary, prior human-reviewed TM).
   - `ui_context` — UI context & conciseness (element role, budget, register).
   - `semantic` — Semantic accuracy & omission (meaning shifts, negation, numbers, dropped content).
3. **Tier 3 — risk score.**

```
Risk = round(min(100, 100 × (0.35·S_swarm + 0.25·(1 − TM_sim) + 0.20·U_budget + 0.20·C_novelty)))
```

Severity weights for `S_swarm`: critical 1.0 · major 0.75 · minor 0.35 · none 0.

| Risk | Without `--auto-repair` | With `--auto-repair` |
|---|---|---|
| < 25 | `verified` | `verified` |
| 25–60 | `needs_review` | one repair pass via the validated apply path, re-score: < 25 `verified`, else `needs_review` |
| > 60 | `needs_review` | `needs_review` |

### `qe-report.json`

```json
{
  "version": 1,
  "generatedAt": "2026-11-25T17:00:00.000Z",
  "model": "claude-haiku-4-5-20251001",
  "tier2": "ran",
  "segments": [
    {
      "key": "checkout.cta", "locale": "de", "source": "Place order", "target": "Bestellung aufgeben",
      "tier1": { "passed": true, "issues": [] },
      "budgetUtilization": 0.82, "tmSimilarity": 0.64, "novelty": 0.3,
      "swarm": [
        { "critic": "ui_context", "key": "checkout.cta", "severity": "minor", "score": 0.35,
          "issue": "Long for a 120px button", "suggestedFix": "Bestellen" }
      ],
      "riskScore": 28, "status": "needs_review"
    }
  ],
  "summary": {}
}
```

`status` ∈ `verified` | `needs_review` | `unscored` | `human-verified`; `repaired: true` marks auto-repaired segments.

QE ranks risk; it is not a quality certificate. Use it to decide where humans look.

---

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

`--only-flagged` limits units to `needs_review` segments.

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
          <mda:meta type="qe_risk_score">64</mda:meta>
          <mda:meta type="max_chars">18</mda:meta>
          <mda:meta type="max_width_px">120</mda:meta>
          <mda:meta type="tm_similarity">0.71</mda:meta>
        </mda:metaGroup>
      </mda:metadata>
      <notes>
        <note category="qe">[semantic/major] "items" rendered as "Artikel" in singular for count=1</note>
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
4. Sets the segment's `qe-report.json` status to `human-verified`.
5. Runs `check` (and `visual-qa` when `layout.baseUrl` is configured) and prints a diff summary.

`tms_import` is `destructiveHint: true`. CSV / TBX / TMX / locale-file asset import is unchanged (`--format auto|csv|tbx|tmx|locales`).

## Benchmark status

The TM ablation (Stage 4: how `human-reviewed` TM and QE routing change outcomes) is **dry-run validated; full run pending**. Run it with `node eval/run.mjs run --scopes tm-ablation`; results will be published in `eval/REPORT.md` Section 13. No Stage 4 numbers are claimed here.
