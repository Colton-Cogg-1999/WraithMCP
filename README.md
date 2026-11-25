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

### Documents

- **DOCX (`.docx`):** Byte-preserving OOXML splice engine — never deserializes into a lossy DOM.
  - Merges adjacent `<w:r>` runs with identical `<w:rPr>` formatting while keeping bookmark and comment-range anchors intact.
  - Handles body, tables, headers/footers, footnotes/endnotes, comments, text boxes (deduplicating `mc:Fallback`), inline content controls (`w:sdt`), smart tags (`w:smartTag`/`w:customXml`), hyperlinks (including `HYPERLINK` complex fields), and tracked insertions (`w:ins`).
  - Protects tracked deletions (`w:del`), dynamic fields (`PAGE`, `DATE`), and drawings; strips XML-invalid control characters; enforces ZIP decompression limits.
  - Incremental batch translation persists state in `.polyglot/documents.json` so multi-page translations retain earlier batches; unchanged round-trips are byte-identical.
- **Markdown / MDX (`.md`, `.mdx`):** Paragraph-level segmentation (preserves soft-wrapped prose & CRLF), skips fenced/indented code blocks, link-reference URLs, and multi-line MDX `import`/`export` blocks, and protects inline code, URLs, and MDX `{expressions}` via `<x/>`/`<g>` tags.

---

## CLI Commands (Works Without Any Agent)

```bash
polyglot init [--source en] [--targets es-MX,fr] [--hook]
polyglot status [--json]
polyglot scan [--file <substr>] [--json]
polyglot check [--locale <tag>] [--severity error|warning] [--json]   # exit 0=PASS, 1=FAIL, 2=INCONCLUSIVE
polyglot pseudo [--locale en-x-pseudo] [--json]
polyglot review --locale es-MX [--output job.json] | --ingest results.json
polyglot escalate [--locale es-MX] [--output-dir .polyglot/escalations] | --import corrections.xlsx
polyglot import [glossary.csv|terms.tbx|memory.tmx] [--format auto|csv|tbx|tmx|locales]
polyglot report [--json]
polyglot mcp
```

## MCP Tools

All 11 tools declare MCP behavioural `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `outputSchema`, and return `structuredContent`:

- **Read-only (`readOnlyHint: true`):** `status`, `scan`, `prepare`, `check`, `report`
- **Mutating (`readOnlyHint: false`):** `apply`, `memory` (discriminated union per action), `pseudo`, `review`, `escalate`, `import`
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
