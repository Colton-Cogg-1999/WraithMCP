---
name: i18n-prep
description: Make a codebase localization-ready before any translation happens — extract hardcoded strings and concatenations, replace hardcoded number/date/currency formatting with Intl.* or ICU, convert physical CSS and directional icons to RTL-safe equivalents, then prove it with pseudo-locales and rendered layout/visual QA. Use when a repo has never been internationalized, when `polyglot extract` or `polyglot check` reports hardcoded_string / string_concatenation / hardcoded_formatting / directional_asset / rtl_layout_risk, or before adding the first RTL or CJK target.
---

# i18n-prep

Deterministic first. Wraith reports; you refactor; Wraith re-verifies. No translation happens in this skill.

MCP tool names below are the Wraith server's tools (in Claude Code they appear as `mcp__polyglot__<name>`). New-tool arguments mirror the CLI flags in camelCase.

## Sequence

1. **Baseline facts** — `status` (CLI `polyglot status --json`). If not initialized, stop and ask the user to run `polyglot init --targets <locales>`; never guess target locales.
2. **Extraction gate** — CLI `polyglot extract --json` (no MCP equivalent; use `scan` + `check {code:"hardcoded_string"}` / `{code:"string_concatenation"}` when only MCP is available).
   - For each hardcoded string: move it into the source catalog under a semantic key (`feature.element.purpose`) and replace it with the project's i18n call (`t()`, `$t()`, `m.key()`, `{% trans %}`, `t(".key")`).
   - For each concatenation: replace with a single ICU message with named placeholders (`{count, plural, one {# item} other {# items}}`, `Hello, {name}`). Never split a sentence across keys.
   - Re-run `polyglot extract --fail-on-unextracted` until exit 0.
3. **Mechanical layout codemods** — `layout_fix` with `dryRun: true` (CLI `polyglot layout --fix --dry-run`), review the diff, then `layout_fix` (CLI `polyglot layout --fix`). This converts Tailwind physical → logical (`ml-`→`ms-`, `text-left`→`text-start`, …), `w-*`→`min-w-*` on constrained text, and injects root `<html dir lang>`.
4. **Remaining static findings** — `check` filtered by code (CLI `polyglot check --code <code> --json`):
   - `hardcoded_formatting` → `Intl.NumberFormat(locale, …)`, `Intl.DateTimeFormat(locale, …)`, `Intl.RelativeTimeFormat`, `Intl.ListFormat`, `Intl.Collator(locale).compare`, or ICU `{n, number}` / `{d, date, medium}` arguments. Pass the active locale explicitly; never rely on the runtime default. Remove `.toUpperCase()` on visible text (use CSS `text-transform`) and `.toFixed()` for display.
   - `directional_asset` (only reported when `ar`, `he`, `fa`, or `ur` is a target) → add `rtl:rotate-180` / `rtl:-scale-x-100`, use a `dir`-aware mirror, or swap to the logical icon (`ChevronLeft` ⇄ `ChevronRight` by `dir`). Do not mirror non-directional icons (play, checkmarks, logos, clocks).
   - `rtl_layout_risk` left in non-Tailwind CSS → `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, `border-inline-start`.
5. **Pseudo-locales** — `pseudo` with `mode: "auto"` (CLI `polyglot pseudo --mode auto`). Confirm at least `en-XA` (expansion) and `ar-XB` (RTL) were generated; key IDs stay embedded (`embedKeyIds: true`).
6. **Rendered verification** (needs a running dev server):
   - `layout` with `baseUrl`, `locales: ["en-XA","ar-XB"]` (CLI `polyglot layout --url <url> -l en-XA,ar-XB`).
   - `visual_qa` against the committed baseline (CLI `polyglot visual-qa --url <url> --locales en-XA,ar-XB`).
   - Fix residual defects with the **layout-remediation** skill.
7. **Final gate** — `check` (CLI `polyglot check`) must return `PASS`; `polyglot extract --fail-on-unextracted` must exit 0.

## Stop conditions

- Done: extract exit 0, `check` `PASS`, `layout` and `visual_qa` `PASS` for `en-XA` and `ar-XB`.
- Stop and report `INCONCLUSIVE` (do not claim success) if Playwright is missing or no dev server is reachable; list the static results you did verify.
- Stop and ask if a string's user-facing status is ambiguous (log line vs UI copy) after reading its call site.

## Never

- Never translate in this skill; only source-locale catalogs change.
- Never hand-edit target locale files; target writes go through `apply`.
- Never suppress a finding by renaming variables, moving strings into constants, or adding ignore comments to get extract to exit 0.
- Never replace a concatenation with multiple keys glued together in code.
- Never call `Intl.*` without an explicit locale argument.
- Never mirror icons globally (`[dir=rtl] svg { transform: scaleX(-1) }`).
- Never report `PASS` from a run that returned `INCONCLUSIVE`.
