# Polyglot

**Turn the coding agent you already use into a context-aware localization engineer. The agent translates. Polyglot gives it memory, rules, and proof.**

```text
> Make my site available in Mexican Spanish, French and Simplified Chinese.

● polyglot.scan   → nextjs, next-intl · 14 hardcoded strings · 3 concatenations
● (agent extracts strings and translates in full component context via prepare + apply)
● polyglot.check  → FAIL · 2 broken {count} placeholders · "Post" → entrada / publicar (inconsistent)
● (agent fixes)
● polyglot.pseudo → generated en-x-pseudo · 2 layout QA hotspots (w-20 truncate whitespace-nowrap)
● polyglot.check  → PASS · 0 errors · 3 strings worth a native speaker's look

## Polyglot Localization Report

**Status:** ✓ Clean (0 errors) · **Warnings:** 1 · **Source:** `en` · **Targets:** `es-MX`, `fr`, `zh-Hans`

### Assumptions Made
- **brand**: Kept "Acme Pulse" untranslated across all locales.
- **tone** (`es-MX`): Used informal "tú" register for es-MX consumer UI.

### Strings Worth a Native Speaker's Look (3)
| Locale | Key | Source | Translation | Why |
|---|---|---|---|---|
| `es-MX` | `feed.postHeading` | Post | Publicación | Ambiguous short UI term "Post" — verify meaning matches context. |
| `fr` | `feed.openMenu` | Open | Ouvert | Usage context changed (moved from FileMenu to StoreHoursBanner). |
| `zh-Hans` | `home.roleBadge` | Admin ({count, plural, ...}) | 管理员（...） | Verify plural & role phrasing in context. |
```

---

## Why Polyglot?

- **Model-free:** Polyglot never calls an LLM or MT API. No API keys, no provider config, no cloud. Your coding agent (Claude Code, Codex, Gemini CLI, etc.) is the only engine.
- **Deterministic core:** Scanning, placeholder/ICU/plural verification, fuzzy matching, lossless file writes, and reporting are 100% deterministic and work offline.
- **Explicit verification outcomes (`PASS` / `FAIL` / `INCONCLUSIVE`):** `polyglot check` fails closed — unsupported projects, monorepos with unconfigured apps, or zero scanned coverage return `INCONCLUSIVE` (exit code `2`) rather than a false `PASS`. Deterministic verification checks structure, placeholders, plurals, glossary rules, and static scanner heuristics; it does **not** establish linguistic accuracy or native fluency.
- **State lives in git:** All memory is plain, diffable JSON/JSONL inside `.polyglot/`, committed alongside your code. `status`, `check`, `prepare`, and `report` are strictly read-only.
- **Workspace security boundary:** All reads, writes, locale identifiers, reviewer imports, document outputs, and MCP `rootDir` parameters are confined to the authorized project workspace with symlink and archive-size protections.
- **Advisory memory, never blind auto-fill:** Even 100% lexical matches are surfaced as strong contextual suggestions with prior usage context so your agent verifies meaning before reusing them.
- **Visual & layout QA:** Pseudo-locale generation (`polyglot pseudo`) plus layout/RTL hazard detection (`whitespace-nowrap`, `truncate`, narrow fixed widths, `cn()`/`clsx()`, and physical `ml-`/`mr-` classes for RTL locales) help your agent catch and fix visual breakage.

---

## Installation (Local Source Build)

> **Release status:** `polyglot-mcp` is **not yet published to npm**. Install and run from a local checkout until an official release is published.

```bash
git clone <this-repo> polyglot
cd polyglot
npm ci
npm run build
# Optional: make `polyglot` available on PATH locally
npm link
```

### Connect to your coding agent (MCP over stdio)

```bash
# Claude Code (if linked on PATH)
claude mcp add polyglot -- polyglot mcp

# Or point directly at the built CLI with Node (no PATH changes needed):
claude mcp add polyglot -- node /absolute/path/to/polyglot/dist/bin.js mcp
```

### Initialize a project & pre-commit hook

```bash
polyglot init --targets es-MX,fr,zh-Hans --hook
```

This creates `.polyglot/config.json`, seeds staleness baselines for any existing translations, adds the completion rule (`Localization is not done until \`polyglot check\` passes.`) to `AGENTS.md` / `CLAUDE.md`, and installs a pre-commit hook that resolves `POLYGLOT_BIN`, `./node_modules/.bin/polyglot`, or `polyglot` on `PATH`.

---

## Supported Frameworks & Documents

### Software Stacks (Two-Layer Architecture: Format Layer + Scanner Layer)

| Stack | Library | Locale Format | Placeholder & Plural Model | Scanner |
|---|---|---|---|---|
| **React / Next.js** | `next-intl`, `react-i18next` | Splice-based lossless JSON (preserves key order, escapes, BOM) | ICU (cardinal + `selectordinal` + rich tags), `{{x}}`, `$t()`, i18next `_one`/`_few`/`_many` suffix plurals | `@babel/parser` AST |
| **Vue / Nuxt** | `vue-i18n`, `@nuxtjs/i18n` | Splice-based lossless JSON | `{x}`, `@:linked`, pipe plurals `a \| b`, raw `@` check | `@vue/compiler-sfc` + Babel |
| **SvelteKit** | Paraglide (v1 & v2 variants), `svelte-i18n` | Splice-based lossless JSON (ignores `$schema`) | ICU-like `{x}`, Paraglide 2 match variants | `svelte/compiler` + Babel |
| **Rails** | Built-in I18n | Lossless YAML (`yaml` CST, `lineWidth: 0`, nested `config/locales/**`) | `%{x}`, `%<name>fmt`, plural subkeys (refuses scalar overwrite) | ERB & Ruby scanner (incl. lazy `t(".key")` & helpers) |
| **Django** | Gettext | Lossless PO (comments/refs preserved, clears `#, fuzzy`, respects `Plural-Forms`) | `%(x)s`, `{x}`, positional `%s`, `msgid`-based source (works with standard `makemessages` layout) | Django template & Python scanner (`blocktrans` → `%(var)s`) |

- **Hardcoded-string detection is heuristic.** Static AST/template scanning catches common JSX, attribute, variable-initializer, array, state-setter, and template patterns while suppressing technical strings (URLs, SQL, headers, loggers), but it cannot guarantee 100% recall on arbitrary dynamic indirection or custom helpers. Combine `polyglot scan` with `polyglot pseudo` visual inspection to catch anything missed statically.
- **Deterministic checks do not verify linguistic accuracy.** `polyglot check` returns `PASS`, `FAIL`, or `INCONCLUSIVE` for structural, placeholder, plural, glossary, staleness, and scanner checks — it does not prove native fluency.

### Documents

- **DOCX (`.docx`):** Byte-preserving OOXML splice engine — never deserializes into a lossy DOM.
  - Merges adjacent `<w:r>` runs with identical `<w:rPr>` formatting while keeping bookmark and comment-range anchors intact.
  - Handles body, tables, headers/footers, footnotes/endnotes, comments, text boxes (deduplicating `mc:Fallback`), inline content controls (`w:sdt`), smart tags (`w:smartTag`/`w:customXml`), hyperlinks (including `HYPERLINK` complex fields), and tracked insertions (`w:ins`).
  - Protects tracked deletions (`w:del`), dynamic fields (`PAGE`, `DATE`), and drawings; strips XML-invalid control characters; enforces ZIP decompression limits.
  - Incremental batch translation persists content-hashed segment records in `.polyglot/documents.json` so insertions/deletions/reordering never shift translations onto the wrong paragraph, source edits surface as `stale_source`, and manual reviewer edits in the target document survive subsequent batches; unchanged round-trips are byte-identical.
- **Markdown / MDX (`.md`, `.mdx`):** Paragraph-level segmentation (preserves soft-wrapped prose & CRLF), skips fenced/indented code blocks, link-reference URLs, and multi-line MDX `import`/`export` blocks, and protects inline code, URLs, and MDX `{expressions}` via `<x/>`/`<g>` tags.

---

## CLI Commands (Works Without Any Agent)

```bash
polyglot init [--source en] [--targets es-MX,fr] [--hook]
polyglot status [--json]
polyglot scan [--file <substr>] [--json]
polyglot check [--locale <tag>] [--severity error|warning] [--json]   # exit 0=PASS, 1=FAIL, 2=INCONCLUSIVE
polyglot pseudo [--mode auto|expand|rtl|cjk|tall|long-word|format] [--locale en-x-pseudo] [--json]
polyglot layout [--url http://localhost:3000] [--routes /,/settings] [--fix] [--dry-run] [--json]
polyglot review --locale es-MX [--output job.json] | --ingest results.json
polyglot escalate [--locale es-MX] [--output-dir .polyglot/escalations] | --import corrections.xlsx
polyglot import [glossary.csv|terms.tbx|memory.tmx] [--format auto|csv|tbx|tmx|locales]
polyglot report [--json]
polyglot mcp
```

## Layout & Formatting QA (v1)

Polyglot stays model-free while verifying rendered UI layout and locale formatting deterministically:

- **Target-aware pseudo-locales (`polyglot pseudo --mode auto`):** generates `en-XA` (IBM length-scaled expansion + format overlay), `ar-XB` (RTL RLO/PDF with LRI/PDI isolation for placeholders & DNT brands), `ja-XC` (CJK fullwidth without spaces), `th-XD` (stacked tall diacritics), and `de-XE` (unbreakable compound words) based on `targetLocales`. Each pseudo string embeds its key ID in invisible zero-width characters so rendered browser findings map directly back to catalog keys.
- **Rendered Playwright checks (`polyglot layout`):** renders configured routes across pseudo and target locales at 375px and 1280px to measure horizontal/vertical overflow, clipped text, overlapping sibling boxes, tofu/missing glyphs, `dir`/`lang` mismatches, and hardcoded formats surviving in `format` mode. Returns `INCONCLUSIVE` (never `PASS`) when Playwright is not installed or no `baseUrl` is configured.
- **Remediation ladder (`polyglot layout --fix` + `.polyglot/layout.json` budgets):**
  1. Deterministic mechanical codemods (`layout --fix`, `destructiveHint: true`): Tailwind physical→logical (`ml-/mr-`→`ms-/me-`, `pl-/pr-`→`ps-/pe-`, `left-/right-`→`start-/end-`, `text-left/right`→`text-start/end`, `rounded-l/r`, `border-l/r`), fixed `w-*`→`min-w-*` on constrained text, root `<html>` `dir`/`lang` injection across Next.js/React, Vue, SvelteKit, Rails, and Django, and `hyphens-auto` on flagged long-word elements.
  2. Structured agent prescriptions (`file:line`, constraint, measured overflow px) for judgment edits.
  3. Per-key/locale width budgets saved to `.polyglot/layout.json`, surfaced in `prepare`, and enforced in `check` (`layout_budget_exceeded`).
  4. Approved locale abbreviations in `.polyglot/glossary.json` (`abbreviations`) with full labels kept in `title` / `aria-label`.
- **Static CSS & formatting rules:** detects tight layout constraints in inline `style={{...}}`, styled-components/Emotion, CSS Modules, and plain CSS, plus `hardcoded_formatting` findings for `.toFixed()`, locale-less `toLocaleString()`/`Intl.*Format()`, currency concatenation, manually assembled dates, `.toUpperCase()`/`.toLowerCase()` on visible text, and locale-less `.localeCompare()`.

### Honest Limits of Layout & Formatting v1
- **Rendered checks require a running dev server and optional Playwright.** Without Playwright or a reachable `baseUrl`, `polyglot layout` returns `INCONCLUSIVE` and falls back to static checks only.
- **Character-based width budgets are approximate.** v1 converts measured element pixel width into `budgetChars` using an average glyph-width heuristic (`0.56 × fontSize`), so variable-width proportional fonts and CJK/Arabic scripts should still be re-verified via `polyglot layout`.
- **Mechanical codemods are Tailwind-first.** Automatic `--fix` rewrites target Tailwind utility classes and root HTML `dir`/`lang`; custom CSS modules, styled-components, and structural flexbox/grid refactors are emitted as agent prescriptions rather than mutated automatically.

## MCP Tools

All 13 tools declare MCP behavioural `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `outputSchema`, and return `structuredContent`:

- **Read-only (`readOnlyHint: true`):** `status`, `scan`, `prepare`, `check`, `layout` *(persists optional width budgets to `.polyglot/layout.json`)*, `report`
- **Mutating (`readOnlyHint: false`, `destructiveHint: false`):** `memory` (discriminated union per action), `review`
- **Mutating / Overwriting (`readOnlyHint: false`, `destructiveHint: true`):** `apply`, `pseudo`, `layout_fix`, `escalate`, `import`
- **Prompt:** `/localize`

---

## Standalone Executables & Platform Compatibility

```bash
# Use an official standalone nodejs.org binary for portable Linux builds:
POLYGLOT_NODE_BIN=/path/to/official/node npm run build:sea
```

- **Linux (`x64`):** Built and verified locally via Node SEA (`node --build-sea`). Note that building with a distro-packaged shared-library `/usr/bin/node` (e.g. Arch Linux) links distro shared libraries (`ldd` warning is printed automatically); portable Linux release binaries must be built against an official standalone `nodejs.org` runtime.
- **macOS & Windows:** CI build matrix is configured in [`.github/workflows/release.yml`](.github/workflows/release.yml) (including `codesign --sign -` on macOS), but **macOS and Windows binaries have not yet been executed or verified in this environment**.

---

## Architecture & Docs

- [docs/SPEC.md](docs/SPEC.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SCHEMAS.md](docs/SCHEMAS.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)
- [REMEDIATION.md](REMEDIATION.md)
- [audit/AUDIT_REPORT.md](audit/AUDIT_REPORT.md) (historical audit record)

## License

MIT — all 142 runtime dependencies are audited permissive (MIT / Apache-2.0 / BSD / ISC).
