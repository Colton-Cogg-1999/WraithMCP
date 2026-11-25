# Polyglot — Product Specification (Original Kickoff Brief)

> Restored verbatim from the original project kickoff specification for historical traceability.

## 1. Thesis

> Polyglot turns the coding agent you already use into a context-aware localization engineer. The agent translates. Polyglot gives it memory, rules, and proof.

Traditional localization pipelines extract strings, strip their context, translate segments in isolation, and reinsert them. A coding agent can translate *while looking at* the component, route, neighbouring strings, and product purpose. Polyglot's job is to make that context-aware translation **consistent, verifiable, and maintainable**.

## 2. Non-negotiable principles

1. **Model-free.** Polyglot never calls an LLM, MT engine, or any generative/judging model. The user's coding agent is the only engine. No API keys, no provider config.
2. **Deterministic core.** Everything Polyglot does on its own (scanning, checking, matching, file I/O, reporting) is deterministic and works offline.
3. **State lives in the repo.** All memory is plain, human-readable, diffable files under `.polyglot/`, committed with the code. No database, no server, no cloud, no auth, no dashboard.
4. **No localization jargon in the default experience.** A developer who has never heard of a TM, termbase, TMX, or MQM must never need to. Expert features exist but are opt-in.
5. **Not a TMS.** No projects, vendors, jobs, workflows, pricing, user accounts, or web UI.
6. **Minimal configuration.** Sensible defaults; a short config file. Resist adding options.
7. **Compact tool output.** MCP tool results consume the agent's context window. Return ranked summaries with counts; let the agent request details (pagination / filters). Never dump hundreds of strings by default.
8. **Licenses.** Only permissively licensed dependencies (MIT/Apache/BSD/ISC). No non-commercial-licensed models or data.

## 3. Users

- **Primary:** a solo developer or small startup with no localization knowledge and no localization assets, who says something like *"Make my site available in Mexican Spanish, French, and Simplified Chinese."*
- **Secondary:** anyone (solo or team) who has assets — a glossary of preferred terms, a TMX file, existing translations — can optionally bring them. Assets are never required.

## 4. Tech stack

- **TypeScript** on Node, distributed two ways:
  - npm package so `npx polyglot mcp` / `npx polyglot <command>` works.
  - Standalone compiled executables so Rails/Django users don't need Node.
- **One codebase, one binary:** the CLI and MCP server are the same program; `polyglot mcp` starts the MCP server (stdio).
- Official MCP TypeScript SDK.
- Prefer ecosystem reference libraries (`@formatjs/icu-messageformat-parser`, `Intl.PluralRules`, `Intl.Segmenter`, Babel, `@vue/compiler-sfc`, `svelte/compiler`). No Python dependency in the core.

## 5. Scope

- **Frameworks:** React / Next.js (`next-intl`, `react-i18next`), Vue / Nuxt (`vue-i18n`), SvelteKit (Paraglide / `svelte-i18n`), Rails (built-in I18n, YAML, `%{x}`), Django (gettext, PO, `%(x)s`, `{x}`).
- **Two-layer adapters:** Format layer (lossless read/write + placeholder syntax) separated from Scanner layer (hardcoded strings, concatenations, usage sites).
- **Documents:** DOCX (byte-preserving OOXML splice engine with `<x/>`/`<g>` inline tags, run merging, tables/headers/footers/footnotes/comments/text boxes, tracked changes, mandatory round-trip tests) and Markdown/MDX. Document-level context available during translation.

## 6. Developer Experience & Quality Cascade

- **MCP tools:** `status`, `scan`, `prepare`, `apply`, `check`, `memory`, `pseudo`, `review`, `escalate`, `import`, `report` + `/localize` prompt + server instructions.
- **CLI:** `polyglot init | status | scan | check | pseudo | review | escalate | import | report | mcp`.
- **Checks:** missing/extra/orphaned keys, placeholder/ICU/plural/select/inline-tag integrity, glossary consistency & DNT, untranslated, hardcoded strings & concatenations, length expansion risk, staleness (`stale_source`, `context_changed`, `orphaned`).
- **Quality cascade:** deterministic checks → cross-model MQM review with false-positive verification pass → human escalation (CSV/XLSX/HTML).
- **Additional user requirements:**
  - Even 100% memory matches are strong contextual suggestions, never blindly trusted auto-fills.
  - Pseudo-locale & translation visual/layout QA support so agents can detect and fix formatting, truncation, and RTL continuity breakage.
