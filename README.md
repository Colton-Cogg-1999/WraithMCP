# Polyglot

**Turn the coding agent you already use into a context-aware localization engineer. The agent translates. Polyglot gives it memory, rules, and proof.**

```text
> Make my site available in Mexican Spanish, French and Simplified Chinese.

● polyglot.scan   → nextjs, next-intl · 14 hardcoded strings · 3 concatenations
● (agent extracts strings and translates in full component context via prepare + apply)
● polyglot.check  → 2 broken {count} placeholders · "Post" → entrada / publicar (inconsistent)
● (agent fixes)
● polyglot.pseudo → generated en-x-pseudo · 2 layout QA hotspots (w-20 truncate whitespace-nowrap)
● polyglot.check  → ✓ clean · 0 errors · 3 strings worth a native speaker's look

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
- **State lives in git:** All memory is plain, diffable JSON/JSONL inside `.polyglot/`, committed right alongside your code. No database, no server, no dashboard.
- **Advisory memory, never blind auto-fill:** Even 100% lexical matches are surfaced as strong contextual suggestions with their prior usage context so your agent verifies meaning before reusing them.
- **Visual & layout QA:** Pseudo-locale generation (`polyglot pseudo`) plus deterministic layout/RTL hazard detection (`whitespace-nowrap`, `truncate`, narrow fixed widths, physical `ml-`/`mr-` classes for RTL locales) help your agent catch and fix visual breakage before shipping.

---

## Quick Start

### 1. Connect to your coding agent (MCP)

```bash
# Claude Code
claude mcp add polyglot -- npx -y polyglot-mcp mcp

# Or add to any MCP client config:
# { "mcpServers": { "polyglot": { "command": "npx", "args": ["-y", "polyglot-mcp", "mcp"] } } }
```

### 2. Initialize your repository (optional)

```bash
npx polyglot-mcp init --targets es-MX,fr,zh-Hans --hook
```

This creates `.polyglot/config.json`, adds the completion rule (`Localization is not done until \`polyglot check\` passes.`) to `AGENTS.md` / `CLAUDE.md`, and optionally installs a git pre-commit hook.

### 3. Ask your coding agent

> *"Make my site available in Mexican Spanish, French, and Simplified Chinese."*

Or invoke the built-in `/localize` MCP prompt.

---

## Supported Frameworks & Documents

### Software Stacks (Two-Layer Architecture: Lossless Format + AST Scanner)

| Stack | Library | Locale Format | Placeholder Syntax | Parser |
|---|---|---|---|---|
| **React / Next.js** | `next-intl`, `react-i18next` | Lossless JSON | ICU, `{{x}}` | `@babel/parser` |
| **Vue / Nuxt** | `vue-i18n`, `@nuxtjs/i18n` | Lossless JSON | `{x}`, `@:linked` | `@vue/compiler-sfc` + Babel |
| **SvelteKit** | Paraglide, `svelte-i18n` | Lossless JSON | ICU-like `{x}` | `svelte/compiler` + Babel |
| **Rails** | Built-in I18n | Lossless YAML (comments preserved) | `%{x}`, plural subkeys | ERB & Ruby scanner |
| **Django** | Gettext | Lossless PO (comments/refs preserved) | `%(x)s`, `{x}`, `msgstr[n]` | Django template & Python scanner |

### Documents

- **DOCX (`.docx`):** Byte-preserving OOXML engine — never re-serializes into a lossy object model. Merges fragmented runs with identical `<w:rPr>` formatting, protects inline formatting/hyperlinks/fields/drawings as XLIFF-style `<x/>`/`<g>` tags, handles body, tables, headers/footers, footnotes, comments, and text boxes, and explicitly protects tracked changes (`w:ins`, `w:del`). Unchanged round-trips are byte-identical.
- **Markdown / MDX (`.md`, `.mdx`):** Preserves frontmatter, code blocks, inline code, URLs, and JSX components losslessly with `<x/>`/`<g>` inline tags and whole-document context.

---

## CLI Commands (Works Without Any Agent)

```bash
polyglot init [--source en] [--targets es-MX,fr] [--hook]
polyglot status [--json]
polyglot scan [--file <substr>] [--json]
polyglot check [--locale <tag>] [--severity error|warning] [--json]   # exits non-zero on errors (CI/pre-commit)
polyglot pseudo [--locale en-x-pseudo] [--json]
polyglot review --locale es-MX [--output job.json] | --ingest results.json
polyglot escalate [--locale es-MX] [--output-dir .polyglot/escalations] | --import corrections.xlsx
polyglot import [glossary.csv|terms.tbx|memory.tmx] [--format auto|csv|tbx|tmx|locales]
polyglot report [--json]
polyglot mcp
```

## MCP Tools

`status` · `scan` · `prepare` · `apply` · `check` · `memory` · `pseudo` · `review` · `escalate` · `import` · `report` — plus the `/localize` prompt.

All MCP tools return compact, ranked summaries with counts and pagination (`offset`, `limit`, `hasMore`) to protect your agent's context window.

---

## Standalone Executables (No Node Required)

For Rails, Django, or CI environments without Node.js:

```bash
npm run build:sea
# Produces release/polyglot-<platform>-<arch>
```

---

## Architecture & Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SCHEMAS.md](docs/SCHEMAS.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)

## License

MIT — all runtime dependencies are permissively licensed (MIT / Apache-2.0 / BSD / ISC).
