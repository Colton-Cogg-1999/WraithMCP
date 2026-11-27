# TMS Round-Trip (`wraith export` / `wraith import`)

Wraith exports strings and translator context to standard localization formats (XLIFF 2.0, XLIFF 1.2 for Crowdin, TMX 1.4b, TBX-Basic) and re-imports reviewed translations into your catalogs and Translation Memory.

## TMS export (`wraith export` / MCP `export`)

```bash
wraith export [--format xliff2|xliff12] [--out .wraith/exports/tms] [--locales de,ja] \
  [--only-flagged] [--include-tm] [--include-glossary] [--bundle-screenshots] [--json]
```

MCP `export` (`format: "xliff2" | "xliff12" | "human"`) has `destructiveHint: false` and writes only to the explicit export directory.

Every unit carries the translator context Wraith has:
- the **Context Note** (`Meaning:`)
- where the string is used (`Where: src/Cart.tsx:27 (CartBadge <span>)`)
- its **Character Limit** (`Length: max 18 characters (required | estimated …)`)
- answered **Open Questions** (`Clarified:`)
- the QE flag reason (see [QE_REVIEW.md](QE_REVIEW.md)), the closest TM match, and any layout constraint

**`--format xliff12`** writes the dialect Crowdin documents: `source.xlf` plus `<locale>.xlf` (with targets). `source.xlf` always holds every source string (it ignores `--only-flagged`, because `crowdin upload sources` removes strings missing from it) and only context that holds for every language: meaning, location, required limits and answers that aren't locale-specific. Each fact is a separate `<note>`; Crowdin shows the source file's notes as string context. Declared Character Limits become `maxwidth="N" size-unit="char"`; estimated limits stay in a note, because a TMS enforces `maxwidth` as a hard limit. Placeholders and tags become `<ph id="n">{name}</ph>`. Target `state` is `translated`, `needs-review-translation` (flagged in QE) or `final` (human-verified). Import accepts both 1.2 and 2.0, skips source-only files, and matches a TMS language code to your locale (`de-DE` → `de`, or by file name). Only approved/final units are recorded as human-verified. See the **crowdin-sync** skill for the full Crowdin push/pull loop.

| File | Format |
|---|---|
| `<locale>.xliff` | XLIFF 2.0 with `mda:` metadata |
| `source.xlf`, `<locale>.xlf` | XLIFF 1.2 (`--format xliff12`) |
| `tm.tmx` | TMX 1.4b (`--include-tm`) |
| `glossary.tbx` | TBX-Basic (`--include-glossary`) |
| `screenshots/` + `manifest.json` | visual-qa / layout screenshots (`--bundle-screenshots`) |

`--only-flagged` limits target units to strings flagged in QE review.

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

## TMS import (`wraith import` / MCP `import`)

```bash
wraith import reviewed/de.xliff        # or a directory of .xliff/.xlf files
wraith import reviewed/ --format xliff
```

`.xliff`/`.xlf` files (or directories of them) are auto-detected. For each unit Wraith:

1. Validates the target through the same placeholder / ICU / plural / glossary pipeline as `apply`; failing units are rejected and listed.
2. Writes catalogs losslessly, preserving key order.
3. For units the TMS marks as reviewed (XLIFF 2.0 `state="reviewed"`/`"final"`, XLIFF 1.2 `approved="yes"` or `state="final"`): upserts `.wraith/tm.json` with `provenance: "human-reviewed"` and `verifiedAt`, and records the string as `human-verified` in `qe-verdicts.json`. Any other state (e.g. `translated`, `needs-review-translation`) is still validated and written if the text changed, but is counted as `notReviewed` and never becomes human-verified. Re-importing Wraith's own export therefore verifies nothing.
4. Runs `check` (and `visual-qa` when `layout.baseUrl` is configured) and prints a diff summary.

MCP `import` is `destructiveHint: true` and handles XLIFF 2.0/1.2, reviewer corrections (`format: "corrections"`), and CSV / TBX / TMX / locale-file asset imports (`format: "auto" | "xliff" | "corrections" | "csv" | "tbx" | "tmx" | "locales"`).

## TM benchmark status

The TM ablation (Stage 4: how `human-reviewed` TM changes outcomes) is **dry-run validated; full run pending**. Run it with `node eval/run.mjs run --scopes tm-ablation`; results will be published in `eval/REPORT.md` Section 13. No Stage 4 numbers are claimed here.

**Preliminary proof of concept (2026-11-25, Stage 4 arms Anotm vs Afull, synthetic-app, 60 items):** both arms reached TCR 1.0, so within one batch the model is already consistent. Afull matched the project's established phrasing more closely: chrF2 97.5 vs 90.3. On items whose gold translation was in the TM the scores were 100 vs 85.4, which is expected copying. On unseeded items they were 96.0 vs 93.3. TM's real value is consistency across runs and sessions, which a single-batch test cannot show. Results: `eval/results/poc-tm.json`.
