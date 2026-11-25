# Wraith

**Your coding agent already writes the code. Wraith turns it into a localization engineer.** The agent does the translating. Wraith gives it memory, rules and deterministic checks: placeholders, ICU plurals, glossary, staleness, and rendered layout down to the pixel. Except for one opt-in quality-estimation step, no model is called.

> CLI: `wraith` · MCP server: `wraith mcp` · project state lives in `.wraith/`

## Results

An independent, judge-validated evaluation (two judges, blinded and position-swapped, 100% planted-corruption detection). Full report: **[eval/REPORT.md](eval/REPORT.md)** · [report.html](eval/report.html)

**4 framework stacks × 5 languages (es-MX, de, ja, ar, pl)**

| System | Sense accuracy on ambiguous strings | Deterministic check errors |
|---|---:|---:|
| **Codex + Wraith (A)** | **99.5%** | **0** |
| Codex alone (A0) | 99.8% | 28 |
| DeepL + glossary (B) | 59.3% | 53 |
| DeepL + `context` (B+ctx) | 86.7% | 42 |

- **5 real OSS repos** (next-intl, hoppscotch, immich, mastodon, wagtail): check errors **A 6** · A0 67 · B 116
- **Release replay (N → N+1):** stale-source detection precision = recall = **1.0**
- **Rendered layout (nextjs-commerce, 7 locales, 375/1280 px):** **26 → 8 → 0** defects (baseline → `layout --fix` codemods → one prescribed agent edit)
- **Stage 4 (TM context ablation, 482 items):** dataset and metrics pipeline validated in a dry run; full run pending ([Section 13](eval/REPORT.md))

The agent alone translates about as well as with Wraith. What Wraith adds is that the output ships: no broken placeholders, plurals or glossary terms, no stale strings, and no clipped or mirrored-wrong UI.

---

## Example session

```text
> Make my site available in Mexican Spanish, French and Simplified Chinese.

● wraith.scan   → nextjs, next-intl · 14 hardcoded strings · 3 concatenations
● (agent extracts strings and translates in full component context via prepare + apply)
● wraith.check  → FAIL · 2 broken {count} placeholders · "Post" → entrada / publicar (inconsistent)
● (agent fixes)
● wraith.pseudo → generated en-x-pseudo · 2 layout QA hotspots (w-20 truncate whitespace-nowrap)
● wraith.check  → PASS · 0 errors · 3 strings worth a native speaker's look

## Wraith Localization Report

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

## Why Wraith?

- **Model-free translation:** Wraith never translates and never calls an MT API. Your coding agent (Claude Code, Codex, Gemini CLI, etc.) is the only translation engine. The single opt-in model call is `wraith qe` Tier 2 (three LLM critics), which runs only if `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`/`GOOGLE_API_KEY` is set; without keys it is skipped and segments are `unscored`, never `verified`.
- **Deterministic core:** Scanning, placeholder/ICU/plural verification, fuzzy matching, lossless file writes, and reporting are 100% deterministic and work offline.
- **Explicit verification outcomes (`PASS` / `FAIL` / `INCONCLUSIVE`):** `wraith check` fails closed — unsupported projects, monorepos with unconfigured apps, or zero scanned coverage return `INCONCLUSIVE` (exit code `2`) rather than a false `PASS`. Deterministic verification checks structure, placeholders, plurals, glossary rules, and static scanner heuristics; it does **not** establish linguistic accuracy or native fluency.
- **State lives in git:** All memory is plain, diffable JSON/JSONL inside `.wraith/`, committed alongside your code. `status`, `check`, `prepare`, and `report` are strictly read-only.
- **Workspace security boundary:** All reads, writes, locale identifiers, reviewer imports, document outputs, and MCP `rootDir` parameters are confined to the authorized project workspace with symlink and archive-size protections.
- **Advisory memory, never blind auto-fill:** Even 100% lexical matches are surfaced as strong contextual suggestions with prior usage context so your agent verifies meaning before reusing them.
- **Visual & layout QA:** Pseudo-locales (`wraith pseudo`), rendered layout checks (`wraith layout`), and a baseline geometry diff (`wraith visual-qa`, 0 LLM tokens, no VLM) catch truncation, overflow, wrap regressions, occlusion, tofu, contrast, and RTL breakage.
- **CI and human loop:** A deterministic PR gate (`extract` + `check` + `visual-qa`), an on-demand `/localize` agent job, QE risk routing, and XLIFF 2.0 / TMX / TBX round-trips with any TMS.

---

## Installation (Local Source Build)

> **Release status:** `wraith-mcp` is **not yet published to npm**. Install and run from a local checkout until an official release is published.

```bash
git clone <this-repo> wraith
cd wraith
npm ci
npm run build
# Optional: make `wraith` available on PATH locally
npm link
```

### Connect to your coding agent (MCP over stdio)

```bash
# Claude Code (if linked on PATH)
claude mcp add wraith -- wraith mcp

# Or point directly at the built CLI with Node (no PATH changes needed):
claude mcp add wraith -- node /absolute/path/to/wraith/dist/bin.js mcp
```

### Initialize a project & pre-commit hook

```bash
wraith init --targets es-MX,fr,zh-Hans --hook
```

This creates `.wraith/config.json`, seeds staleness baselines for any existing translations, adds the completion rule (`Localization is not done until \`wraith check\` passes.`) to `AGENTS.md` / `CLAUDE.md`, and installs a pre-commit hook that resolves `WRAITH_BIN`, `./node_modules/.bin/wraith`, or `wraith` on `PATH`.

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

- **Hardcoded-string detection is heuristic.** Static AST/template scanning catches common JSX, attribute, variable-initializer, array, state-setter, and template patterns while suppressing technical strings (URLs, SQL, headers, loggers), but it cannot guarantee 100% recall on arbitrary dynamic indirection or custom helpers. Combine `wraith scan` with `wraith pseudo` visual inspection to catch anything missed statically.
- **Deterministic checks do not verify linguistic accuracy.** `wraith check` returns `PASS`, `FAIL`, or `INCONCLUSIVE` for structural, placeholder, plural, glossary, staleness, and scanner checks — it does not prove native fluency.

### Documents

- **DOCX (`.docx`):** Byte-preserving OOXML splice engine — never deserializes into a lossy DOM.
  - Merges adjacent `<w:r>` runs with identical `<w:rPr>` formatting while keeping bookmark and comment-range anchors intact.
  - Handles body, tables, headers/footers, footnotes/endnotes, comments, text boxes (deduplicating `mc:Fallback`), inline content controls (`w:sdt`), smart tags (`w:smartTag`/`w:customXml`), hyperlinks (including `HYPERLINK` complex fields), and tracked insertions (`w:ins`).
  - Protects tracked deletions (`w:del`), dynamic fields (`PAGE`, `DATE`), and drawings; strips XML-invalid control characters; enforces ZIP decompression limits.
  - Incremental batch translation persists content-hashed segment records in `.wraith/documents.json` so insertions/deletions/reordering never shift translations onto the wrong paragraph, source edits surface as `stale_source`, and manual reviewer edits in the target document survive subsequent batches; unchanged round-trips are byte-identical.
- **Markdown / MDX (`.md`, `.mdx`):** Paragraph-level segmentation (preserves soft-wrapped prose & CRLF), skips fenced/indented code blocks, link-reference URLs, and multi-line MDX `import`/`export` blocks, and protects inline code, URLs, and MDX `{expressions}` via `<x/>`/`<g>` tags.

---

## CLI Commands (Works Without Any Agent)

Global option: `-C, --cwd <dir>` (project root). Gates exit `0` PASS · `1` FAIL · `2` INCONCLUSIVE.

| Command | Purpose | Key options |
|---|---|---|
| `wraith init` | create `.wraith/config.json`, agent rule, optional hook | `--source en` `--targets es-MX,fr` `--hook` |
| `wraith status` | project facts (read-only) | `--json` |
| `wraith scan` | hardcoded strings, concatenations, usage | `--file <substr>` `--json` |
| `wraith extract` | deterministic extraction gate: hardcoded strings / concatenations / hardcoded formatting left in source (reports; the agent refactors) | `--fail-on-unextracted` `--json` |
| `wraith check` | deterministic verification gate | `-l <locale>` `--severity` `--code` `--json` |
| `wraith pseudo` | pseudo-locales with zero-width key IDs | `--mode auto\|expand\|rtl\|cjk\|tall\|long-word\|format` `--no-key-ids` `--format-overlay` |
| `wraith layout` | rendered layout checks + codemods | `--url` `--routes` `-l` `--locale-pattern query\|prefix\|cookie` `--fix` `--dry-run` |
| `wraith visual-qa` | geometry regression diff vs baseline | `--capture-baseline` `--base <path>` `--routes` `--locales` `--url` `--locale-pattern` `--json` |
| `wraith qe` | tiered quality estimation → `.wraith/qe-report.json` | `--locales` `--auto-repair` `--fail-above <n>` `--json` |
| `wraith review` | package / ingest cross-model MQM review | `--locale` `--output` `--ingest` |
| `wraith escalate` | CSV/XLSX/HTML human review export / import | `--locale` `--output-dir` `--import` |
| `wraith export` | TMS bundle: XLIFF 2.0, TMX 1.4b, TBX-Basic, screenshots | `--format xliff2` `--out` `--locales` `--only-flagged` `--include-tm` `--include-glossary` `--bundle-screenshots` |
| `wraith import <file-or-dir>` | glossary/TM/locale assets, or reviewed `.xliff`/`.xlf` (auto-detected, validated, stored as human-reviewed TM) | `--format auto\|csv\|tbx\|tmx\|locales\|xliff` |
| `wraith report` | end-of-run Markdown/JSON report | `--json` |
| `wraith mcp` | start the MCP server (stdio) | |

Exit codes for `visual-qa`: `1` regression, `2` no Playwright/server/baseline. `qe` exits `1` if any segment risk > `--fail-above` or any `needs_review`. `extract --fail-on-unextracted` exits `1` while hardcoded strings or concatenations remain.

## Layout & Formatting QA (v1)

Wraith stays model-free while verifying rendered UI layout and locale formatting deterministically:

- **Target-aware pseudo-locales (`wraith pseudo --mode auto`):** generates `en-XA` (IBM length-scaled expansion + format overlay), `ar-XB` (RTL RLO/PDF with LRI/PDI isolation for placeholders & DNT brands), `ja-XC` (CJK fullwidth without spaces), `th-XD` (stacked tall diacritics), and `de-XE` (unbreakable compound words) based on `targetLocales`. Each pseudo string embeds its key ID in invisible zero-width characters so rendered browser findings map directly back to catalog keys.
- **Rendered Playwright checks (`wraith layout`):** renders configured routes across pseudo and target locales at 375px and 1280px to measure horizontal/vertical overflow, clipped text, overlapping sibling boxes, tofu/missing glyphs, `dir`/`lang` mismatches, and hardcoded formats surviving in `format` mode. Returns `INCONCLUSIVE` (never `PASS`) when Playwright is not installed or no `baseUrl` is configured.
- **Remediation ladder (`wraith layout --fix` + `.wraith/layout.json` budgets):**
  1. Deterministic mechanical codemods (`layout --fix`, `destructiveHint: true`): Tailwind physical→logical (`ml-/mr-`→`ms-/me-`, `pl-/pr-`→`ps-/pe-`, `left-/right-`→`start-/end-`, `text-left/right`→`text-start/end`, `rounded-l/r`, `border-l/r`), fixed `w-*`→`min-w-*` on constrained text, root `<html>` `dir`/`lang` injection across Next.js/React, Vue, SvelteKit, Rails, and Django, and `hyphens-auto` on flagged long-word elements.
  2. Structured agent prescriptions (`file:line`, constraint, measured overflow px) for judgment edits.
  3. Per-key/locale width budgets saved to `.wraith/layout.json`, surfaced in `prepare`, and enforced in `check` (`layout_budget_exceeded`).
  4. Approved locale abbreviations in `.wraith/glossary.json` (`abbreviations`) with full labels kept in `title` / `aria-label`.
- **Static CSS & formatting rules:** detects tight layout constraints in inline `style={{...}}`, styled-components/Emotion, CSS Modules, and plain CSS, plus `hardcoded_formatting` findings for `.toFixed()`, locale-less `toLocaleString()`/`Intl.*Format()`, currency concatenation, manually assembled dates, `.toUpperCase()`/`.toLowerCase()` on visible text, and locale-less `.localeCompare()`.

### Honest Limits of Layout & Formatting v1
- **Rendered checks require a running dev server and optional Playwright.** Without Playwright or a reachable `baseUrl`, `wraith layout` returns `INCONCLUSIVE` and falls back to static checks only.
- **Character-based width budgets are approximate.** v1 converts measured element pixel width into `budgetChars` using an average glyph-width heuristic (`0.56 × fontSize`), so variable-width proportional fonts and CJK/Arabic scripts should still be re-verified via `wraith layout`.
- **Mechanical codemods are Tailwind-first.** Automatic `--fix` rewrites target Tailwind utility classes and root HTML `dir`/`lang`; custom CSS modules, styled-components, and structural flexbox/grid refactors are emitted as agent prescriptions rather than mutated automatically.

### Visual QA, QE & TMS

- **`visual-qa`:** per-element geometry (`lineCount`, size, overflow, clipping, occlusion, font load, contrast) diffed against `.wraith/visual-baseline.json`; rules `line_wrap_regression`, `container_blowout`, `text_truncation`, `element_occlusion`, `missing_glyph_tofu`, `contrast_regression`. Failure-only screenshots in `.wraith/artifacts/visual-qa/`. See [docs/VISUAL_QA.md](docs/VISUAL_QA.md).
- **`qe`:** Tier 1 deterministic (check validations + width budget) → Tier 2 three critics (terminology/TM drift, UI context, semantic/omission; opt-in tokens) → Tier 3 risk `0–100`. `<25` verified, `25–60` one optional `--auto-repair` pass, otherwise `needs_review`.
- **`export` / `import`:** XLIFF 2.0 units carry `mda:` metadata (file, line, component, risk, `max_chars`, `max_width_px`, TM similarity) and critic notes; reviewed XLIFF is re-validated and stored in `.wraith/tm.json` as `human-reviewed`, which outranks `llm-generated` TM. See [docs/QE_AND_TMS.md](docs/QE_AND_TMS.md).
- **`directional_asset` check (warning):** directional icons (`ArrowLeft/Right`, `ChevronLeft/Right`, `CaretLeft/Right`, back/next arrows, directional svg/img names) without `rtl:rotate-180`, `rtl:-scale-x-100`, dir-aware mirroring, or a logical swap — only when `ar`, `he`, `fa`, or `ur` is a target.

## MCP Tools

17 tools, each with `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), `outputSchema`, and `structuredContent`:

| Tool | Annotation | Notes |
|---|---|---|
| `status`, `scan`, `prepare`, `check`, `report` | read-only | |
| `layout` | read-only | persists optional width budgets to `.wraith/layout.json` |
| `visual_qa` | read-only | writes failure artifacts / baseline only when capturing |
| `tms_export` | read-only | writes only to the explicit export dir |
| `memory`, `review` | mutating, non-destructive | |
| `apply`, `pseudo`, `layout_fix`, `escalate`, `import` | destructive | |
| `qe_audit` | destructive | `autoRepair` may write catalogs; otherwise only writes `qe-report.json` |
| `tms_import` | destructive | validated catalog writes + human-reviewed TM |

Prompt: `/localize`. Agent playbooks: [`skills/`](skills/) — `i18n-prep`, `localize-pr`, `layout-remediation`, `qe-triage`, `tms-roundtrip` ([docs/SKILLS.md](docs/SKILLS.md)).

## CI Quickstart

[`.github/workflows/wraith.yml`](.github/workflows/wraith.yml) (also usable via `workflow_call`):

- **`deterministic-l10n-gate`** (pull_request, 0 LLM tokens): `wraith extract --fail-on-unextracted`, `wraith check`, `wraith visual-qa --base .wraith/visual-baseline.json`; sticky PR summary; artifacts on failure.
- **`update-baseline`** (push to main): recaptures the baseline as an artifact; commit it via a reviewed PR.
- **`agentic-localize`** (`/localize` comment by OWNER/MEMBER/COLLABORATOR, or manual): Claude Code or Codex translates changed source keys via the `localize-pr` skill, then `check` + `qe`; commits only on `PASS`; `needs_review` keys are exported as XLIFF and commented with risk scores.

Set `preview_build` / `preview_start` / `preview_url` (defaults `npm run build`, `npm run start`, `http://localhost:3000`) and secrets `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for `/localize`. Details: [docs/GITHUB_CI.md](docs/GITHUB_CI.md).

## Benchmarks

From [eval/REPORT.md](eval/REPORT.md) (Stage 3, 4 synthetic stacks × 5 languages; A = Codex + Wraith MCP, A0 = Codex alone, B = DeepL + XML + glossary, B+ctx = DeepL with `context`):

| System | Challenge sense accuracy | `wraith check` errors |
|---|---|---|
| A | 99.5% | 0 |
| A0 | 99.8% | 28 |
| B | 59.3% | 53 |
| B+ctx | 86.7% | 42 |

Layout & Formatting v1 (`nextjs-commerce`, 7 locales, 375/1280px): **26 → 8 → 0** rendered defects (baseline → `layout --fix` → one prescribed agent edit).

Stage 4 (TM ablation: human-reviewed TM + QE routing) is **dry-run validated; full run pending** — `node eval/run.mjs run --scopes tm-ablation`, results to `eval/REPORT.md` Section 13.

---

## Standalone Executables & Platform Compatibility

```bash
# Use an official standalone nodejs.org binary for portable Linux builds:
WRAITH_NODE_BIN=/path/to/official/node npm run build:sea
```

- **Linux (`x64`):** Built and verified locally via Node SEA (`node --build-sea`). Note that building with a distro-packaged shared-library `/usr/bin/node` (e.g. Arch Linux) links distro shared libraries (`ldd` warning is printed automatically); portable Linux release binaries must be built against an official standalone `nodejs.org` runtime.
- **macOS & Windows:** CI build matrix is configured in [`.github/workflows/release.yml`](.github/workflows/release.yml) (including `codesign --sign -` on macOS), but **macOS and Windows binaries have not yet been executed or verified in this environment**.

---

## Architecture & Docs

- [docs/SPEC.md](docs/SPEC.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/SCHEMAS.md](docs/SCHEMAS.md)
- [docs/DECISIONS.md](docs/DECISIONS.md)
- [docs/VISUAL_QA.md](docs/VISUAL_QA.md)
- [docs/QE_AND_TMS.md](docs/QE_AND_TMS.md)
- [docs/GITHUB_CI.md](docs/GITHUB_CI.md)
- [docs/SKILLS.md](docs/SKILLS.md)
- [eval/REPORT.md](eval/REPORT.md)
- [REMEDIATION.md](REMEDIATION.md)
- [audit/AUDIT_REPORT.md](audit/AUDIT_REPORT.md) (historical audit record)

## License

MIT — all 142 runtime dependencies are audited permissive (MIT / Apache-2.0 / BSD / ISC).
