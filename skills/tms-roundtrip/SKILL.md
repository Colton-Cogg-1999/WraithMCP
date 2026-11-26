---
name: tms-roundtrip
description: Hand flagged or full translations to human linguists through a TMS (Phrase, Lokalise, Crowdin, Smartling, memoQ, Trados) as XLIFF 2.0 + TMX 1.4b + TBX-Basic with screenshots, then import the reviewed XLIFF back through Wraith's validation pipeline so human edits become verified, high-priority translation memory. Use after qe-review leaves flagged strings, before a release with human sign-off, or when a reviewed `.xliff` comes back.
---

# tms-roundtrip

Export is read-only on the project (writes only to the export directory). Import is the only step that writes catalogs, and it validates exactly like `apply`.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). New-tool arguments mirror the CLI flags in camelCase.

## Export

1. `check` (CLI `wraith check`) — must not be `FAIL` on structural errors; fix those first (human reviewers should not be fixing placeholders).
2. Optional: review first with **qe-review** so units carry `qe_status` and flag reasons, and `--only-flagged` has something to select.
3. `tms_export` (CLI):
   ```bash
   wraith export --format xliff2 --only-flagged --include-tm --include-glossary --bundle-screenshots \
     --out .wraith/exports/tms [--locales de,ja]
   ```
   Output: `<locale>.xliff` (XLIFF 2.0, `mda:` metadata, `<notes>` with review flags and top fuzzy TM), `tm.tmx`, `glossary.tbx`, `screenshots/` + `manifest.json`.
4. Tell the user which files to upload and that `<segment state>` and `<ph>` elements must be preserved by the TMS.

## Import

1. `tms_import` with `input: "<file-or-dir>"` (keep `runVerification: true`) (CLI `wraith import <file-or-dir>`; `--format xliff` forces detection).
2. Wraith validates each target (placeholders, ICU, plurals, glossary/DNT), writes catalogs preserving key order, upserts `.wraith/tm.json` entries as `provenance: "human-reviewed"` with `verifiedAt`, records those strings as `human-verified` in QE, then runs `check` (and `visual-qa` if `layout.baseUrl` is configured) and prints a diff summary.
3. For any rejected unit: report key, locale, and validation error back to the user for the linguist. Do not "fix" the human's text silently.
4. Final: `check` (CLI `wraith check`) `PASS`; `report` for the summary.

## Stop conditions

- Done: import reports 0 rejected units and `check` `PASS` (and `visual_qa` `PASS` when configured).
- Stop and report on any rejected unit, unknown key, or locale not in `targetLocales`.

## Never

- Never hand-edit exported XLIFF/TMX/TBX before sending, or the returned XLIFF before importing, except to restore a TMS-corrupted `<ph>` with the user's approval.
- Never import by copying target strings into locale files manually; always go through `tms_import` / `wraith import`.
- Never overwrite a `human-reviewed` TM entry or `human-verified` segment with an LLM translation.
- Never export outside the workspace or include files other than the export bundle.
