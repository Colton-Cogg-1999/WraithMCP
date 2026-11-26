---
name: crowdin-sync
description: Send translations to Crowdin for human review and bring approved ones back through Wraith's validation, using the Crowdin CLI and XLIFF 1.2 files that carry each string's meaning, location, length limit and answered questions as translator context. Use when the user works with Crowdin, asks to "push to Crowdin", "sync with Crowdin", "pull approved translations", or set up Crowdin for this repo.
---

# crowdin-sync

Wraith exports XLIFF 1.2, which is the dialect Crowdin documents: `<note>` becomes string context, and `maxwidth` + `size-unit="char"` becomes the max length. The Crowdin CLI moves the files. Wraith never stores Crowdin credentials: the CLI reads them from environment variables.

MCP tool names below are the Wraith server's tools (in Claude Code: `mcp__wraith__<name>`). Arguments mirror the CLI flags in camelCase.

## One-time setup

1. Check the CLI is installed: `crowdin --version`. If it's missing, tell the user to install it (`npm i -g @crowdin/cli`, or see crowdin.github.io/crowdin-cli). Don't install global tools yourself without asking.
2. The user needs a Crowdin project with the source language set to the repo's `sourceLocale` and the target languages added, and they need to set `CROWDIN_PROJECT_ID` and `CROWDIN_PERSONAL_TOKEN` in their shell or as CI secrets. Never ask the user to paste a token into chat, and never write one into a file.
3. Write `crowdin.yml` at the repo root (show it to the user before writing):
   ```yaml
   project_id_env: CROWDIN_PROJECT_ID
   api_token_env: CROWDIN_PERSONAL_TOKEN
   base_path: "."
   preserve_hierarchy: true
   files:
     - source: "/.wraith/crowdin/source.xlf"
       translation: "/.wraith/crowdin/%locale%.xlf"
       languages_mapping:
         locale:
           # Crowdin language code: Wraith target locale (only where they differ)
           de: de
   ```
   File names must use the Wraith locale from `.wraith/config.json` `targetLocales`. Crowdin's own codes can differ (Chinese Simplified is `zh-CN`, German is `de`). List them with `crowdin language list` and add a mapping for every target. Wraith's import also matches `de-DE` → `de` on its own, but the file names have to line up.
4. Suggest adding `.wraith/crowdin/` to `.gitignore`. These files are a transfer format; the locale catalogs stay the source of truth.

## Push (send strings for review)

1. `check` (CLI `wraith check`) must not `FAIL`. Linguists shouldn't be fixing placeholders.
2. Make sure strings have Context Notes (`prepare` shows `contextNoteStatus`). Write any missing ones first; they are the translator's main context.
3. Export: `tms_export` with `format: "xliff12"`, `outDir: ".wraith/crowdin"` (CLI `wraith export --format xliff12 --out .wraith/crowdin`). Add `onlyFlagged: true` to send only strings flagged in QE review; that limits the `<locale>.xlf` files only. This writes `source.xlf` (every source string, with notes and required limits; never filtered, since `crowdin upload sources` removes strings missing from it) and `<locale>.xlf` (your current translations).
4. `crowdin upload sources`
5. `crowdin upload translations --import-eq-suggestions`. The agent translations go up as suggestions to review. Don't pass `--auto-approve-imported`: approval is the linguist's job.
6. Screenshots (only if the user asked for them): capture the source-locale UI with `wraith layout --url <dev server> --locales <sourceLocale>` (screenshots land in `.wraith/screenshots/`), then run `crowdin screenshot upload .wraith/screenshots/ --auto-tag --file /.wraith/crowdin/source.xlf`. Auto-tag matches strings by reading the image, so tell the user to check the tags in Crowdin.
7. Tell the user what was sent: counts per locale, and that strings now wait for review in Crowdin.

## Pull (bring approved translations back)

1. `crowdin download translations --export-only-approved --skip-untranslated-strings`. Both flags matter: without `--skip-untranslated-strings`, unapproved strings come back as source-language text.
2. `tms_import` with `input: ".wraith/crowdin"` (CLI `wraith import .wraith/crowdin`). Every target is validated (placeholders, ICU, tags, glossary). Approved strings are written to the catalogs and recorded as `human-verified` and human-reviewed TM. `source.xlf` is skipped.
3. Report rejected units (key, locale, error) for the linguist. Never "fix" a human's text silently.
4. `check` → `report`.

## Never

- Never store, print or commit Crowdin tokens.
- Never auto-approve agent translations in Crowdin.
- Never import a download made without `--export-only-approved`. Wraith only records approved/`final` units as human-verified, but unapproved text that differs from the catalog would still be written to it.
- Never hand-edit locale catalogs to apply Crowdin results; always go through `tms_import`.
