# Wraith Architectural Decisions

This log records implementation choices made where the kickoff brief intentionally left details open. Every decision optimizes for: model-free determinism, minimal dependencies, permissive licenses, and zero-jargon developer experience.

---

## ADR-001: Single Binary & Packaging Strategy
- **Decision:** Build the entire CLI and MCP server in TypeScript (ESM, targeting Node 20+). Distribute via npm (`npx wraith ...`) using an `esbuild`-bundled entry point, and compile standalone binaries using Node.js Single Executable Applications (`node --build-sea` / SEA config) for Linux, macOS, and Windows (with an optional Bun compile fallback script when `bun` is installed).
- **Rationale:** Node 26 is available in the local environment and natively supports Single Executable Applications without requiring Bun to be preinstalled, while keeping the npm distribution tiny and standard.

## ADR-002: `.wraith/` Storage Format
- **Decision:** Use canonically sorted JSON (`2-space` indentation, trailing newline) for structured files (`config.json`, `glossary.json`, `usage.json`, `records.json`, `assumptions.json`, `reviews.json`) and JSONL (`memory.jsonl`) for translation memory pairs.
- **Rationale:** JSON needs zero external parsing dependencies, validates cleanly with Zod, produces predictable diffs when keys are sorted alphabetically, and is immediately readable by both humans and coding agents. JSONL keeps translation memory diffs strictly one-line-per-entry.

## ADR-003: Context Fingerprint Stability
- **Decision:** Compute `contextFingerprint` as the first 16 hex chars of SHA-256 over sorted unique `(componentName, elementRole)` tuples — explicitly excluding line numbers, file paths, and sibling label copy.
- **Rationale:** Excluding file paths and sibling copy prevents false-positive `context_changed` churn when refactoring/moving files or tweaking unrelated labels in the same component, while moving a key to a different component/element role or adding a second usage site in another component reliably triggers `context_changed`.

## ADR-004: Lossless Format Editing
- **Decision:**
  - **JSON:** Splice-based JSON CST editor (`src/formats/json.ts`) that patches only modified/inserted spans while preserving untouched integer-like key ordering, Unicode escape sequences (`\u00e9`), UTF-8 BOM, indentation, and line endings.
  - **YAML (Rails):** Use the `yaml` package's `parseDocument()` AST/CST with `lineWidth: 0` so comments, long lines, key order, and formatting survive writes intact.
  - **PO (Django):** Dedicated lossless PO parser/writer preserving headers, `Plural-Forms`, translator/extracted comments, reference lines, and flags (clearing `#, fuzzy` upon `apply`).
- **Rationale:** Developers commit locale files to git; reformatting an entire locale file on every `apply` creates noisy diffs and destroys comments or key order.

## ADR-005: Byte-Preserving DOCX Engine
- **Decision:** Use `fflate` (pure MIT) for ZIP handling and a dedicated offset-tracking XML scanner for OOXML parts (`document.xml`, headers, footers, footnotes, endnotes, comments) instead of parsing into an XML DOM and re-serializing.
- **Rationale:** Re-serializing OOXML frequently drops namespaces, reorders attributes, or corrupts Word-specific extensions. Splice-based patching on exact `<w:t>` spans guarantees that untouched XML stays byte-for-byte identical, and unchanged round-trips preserve original document fidelity.

## ADR-006: Zero-Bloat XLSX Escalation Export
- **Decision:** Generate `.xlsx` workbooks directly as minimal valid OOXML ZIP archives via `fflate` (inline strings, standard sheet/workbook/styles XML), alongside `.csv` and a self-contained `.html` reviewer page.
- **Rationale:** Avoids pulling in large or licensing-ambiguous spreadsheet packages while producing clean `.xlsx` files that open natively in Excel, Google Sheets, and LibreOffice Calc, and round-trip cleanly on correction import.

## ADR-007: Compact MCP Output Budgeting
- **Decision:** Every MCP tool returns a compact summary header (counts by severity/category) plus at most `limit` items (default `25` for `check`/`scan`, `20` for `prepare`, `10` for `memory`) with `offset`, `total`, and `hasMore` pagination metadata and filter parameters (`locale`, `severity`, `category`, `file`).
- **Rationale:** Coding agents operate under tight context budgets. Returning ranked top issues with exact counts prevents context overflow on large codebases while letting the agent drill into any slice on demand.

## ADR-008: Lexical Fuzzy Matching
- **Decision:** Use token-level Levenshtein distance (lowercased, punctuation-stripped, whitespace/word segmented via `Intl.Segmenter`) for space-delimited languages, and grapheme/character-level Levenshtein distance (via `Intl.Segmenter` with `granularity: "grapheme"`) when the source text is predominantly CJK/scriptio continua (Chinese, Japanese, Korean, Thai, Lao, Khmer). Return integer match percentage `0..100`.
- **Rationale:** Fast, deterministic, zero native dependencies, accurate across both Western and CJK scripts using built-in ICU data in Node.

## ADR-009: Framework Parsers & Licenses
- **Decision:** Use only permissively licensed (MIT/Apache-2.0/BSD/ISC) reference parsers:
  - React / Next.js / JS / TS: `@babel/parser` + `@babel/traverse` (MIT)
  - ICU MessageFormat: `@formatjs/icu-messageformat-parser` (MIT)
  - Vue / Nuxt: `@vue/compiler-sfc` (MIT)
  - SvelteKit: `svelte/compiler` (MIT)
  - Rails ERB & Django templates: deterministic pure-TS ERB/Ruby and Django template/Python scanners (no native tree-sitter binaries or Python runtime required offline).
- **Rationale:** Guarantees 100% offline determinism, fast startup in standalone binaries, and strict MIT/Apache/BSD/ISC license compliance.

## ADR-010: Advisory Memory & Fuzzy Matches (Never Blind Auto-Fill)
- **Decision:** Even 100% lexical matches from `.wraith/memory.jsonl` or TMX are returned strictly as **strong suggestions with prior context** (`advisory`, `previousContext`, `contextAlignment`), never blindly auto-applied.
- **Rationale:** Identical source strings frequently mean different things in different UI locations (e.g., `"Open"` in a File menu vs. a store-hours banner). The coding agent sees both the previous usage context and the current component context and decides whether to reuse or adapt the match.

## ADR-011: Deterministic Layout, Formatting & Visual Continuity QA
- **Decision:** Extend scanners, `pseudo`, and `check` to detect layout/formatting hazards around localized strings (e.g., `whitespace-nowrap`, `truncate`, `overflow-hidden`, narrow fixed widths `w-16`/`max-w-[...]`, and physical directional styles `ml-`/`mr-`/`pl-`/`pr-`/`text-left`/`text-right` when RTL target locales are configured). Return ranked `layoutHotspots` and QA steps from `pseudo`, and flag `layout_risk` / `rtl_layout_risk` in `check`.
- **Rationale:** Pseudo-localization and real translations frequently expose truncation, overflow, and RTL mirroring bugs. Surfacing exact file/line CSS constraints alongside pseudo-locale generation lets the agent QA the rendered UI and fix layout or copy issues cleanly.

## ADR-012: Content-Derived Document Segment Identity, Manual Edit Preservation & Workspace Locking
- **Decision:**
  1. **Document segment identity:** Key incremental segment records in `.wraith/documents.json` by occurrence-aware content identity (`${part}:${sha256Short(sourceText)}:${occurrence}`), never by paragraph index. When a source paragraph changes in-place, drop its stale translation from re-application and surface it as `stale` in `prepareDocument` and blocking `stale_source` in `runCheck`.
  2. **Manual edits to translated documents:** Before applying a new batch, extract the existing target document on disk and compare each carried-forward segment against the last written translation at its recorded `lastSegmentId`. If a human reviewer edited the wording while keeping inline tags compatible, **preserve the manual edit automatically** and persist it back into `.wraith/documents.json` and `.wraith/memory.jsonl`. If a manual edit altered inline formatting tags incompatibly, refuse to overwrite (`manual_edit_conflict`) unless `force: true` is passed.
  3. **Multi-process concurrency:** Coordinate read-modify-write mutations across locale files and `.wraith/` state files with an exclusive lock file (`.wraith/.lock` via `O_CREAT | O_EXCL`), supporting same-process re-entrancy, configurable timeout, and stale-lock recovery (dead PID or expired mtime).
- **Rationale:** Positional document state silently misaligned translations whenever source paragraphs were inserted, deleted, or reordered, and silently clobbered human reviewer edits in Word/Markdown. Content-derived identity plus automatic preservation of compatible manual edits eliminates both failure modes while keeping incremental batch translation safe.
