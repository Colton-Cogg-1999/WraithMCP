# Polyglot Remediation Log

Historical audit preserved verbatim in [`audit/AUDIT_REPORT.md`](audit/AUDIT_REPORT.md).

## Baseline Snapshot (`main` commit `5022913`)

- **TypeScript (`tsc --noEmit`):** 0 errors
- **Original test suite (`vitest run`):** 6 files, 25 passed / 0 failed
- **Independent audit suite (`vitest run --config audit/vitest.config.ts`):**
  - 8 files, 126 total tests: **24 passed, 96 failed, 6 skipped**
  - Skipped: `P-REF-1/2/3` and `P-LO-1/2/3` (env vars `AUDIT_REF_DOCX` and `AUDIT_LO_DOCX` unset in default invocation; `soffice` is installed and available for LibreOffice corpus verification).
- **Available external verification tools:**
  - `msgfmt` (`/usr/bin/msgfmt`)
  - `libreoffice` / `soffice` (`/usr/bin/soffice`)
  - `python3` (`/usr/bin/python3`)
  - `ruby` (`/usr/bin/ruby`)
  - `xmllint` (`/usr/bin/xmllint`)
  - `unzip` / `zip` (`/usr/bin/unzip`, `/usr/bin/zip`)

---

## Finding Tracking

| Finding | Priority | Status | Root Cause & Fix Summary |
|---|---|---|---|
| C1 (S1–S5, MCP rootDir, symlinks, archive limits) | P0 | In progress | Centralized filesystem security boundary (`src/core/security.ts`) + BCP-47 locale validation + relative Django/Rails locale rewrites + MCP root confinement + archive decompression caps |
| C4, F5 (Verification semantics) | P0 | Pending | Explicit `PASS` / `FAIL` / `INCONCLUSIVE` outcomes, coverage/skipped/parse-error reporting, non-zero exit on FAIL & INCONCLUSIVE, read-only `status`/`check` |
| C2, C3 (plurals), C5, H4 (A1–A5, A9–A10, B1–B2, C1–C3, D1, D3) | P0 | Pending | Separate ICU / CLDR / Gettext Plural-Forms / Rails / i18next / Vue plural & placeholder models; reject scalar-over-plural; fix original `nextjs-e2e.test.ts` |
| C6 (R1–R2, document batching & atomic writes) | P0 | Pending | Incremental document apply starting from existing target + stable segment identity + pre-write full validation + atomic writes + refuse `targetFile == sourceFile` |
| H6 (Install path, pre-commit hook, binary portability) | P0 | Pending | Honest local install instructions, working pre-commit hook resolution, portable runtime guidance |
| C3 (Django makemessages, fuzzy), H1, H2, H3, H5 | P1 | Pending | Django source-from-msgid & fuzzy handling, usage tracking idioms & dynamic-key uncertainty, scanner recall/precision, staleness & manual-edit reconciliation, DOCX Word constructs |
| M1–M13, L1–L5 | P2–P3 | Pending | Lossless JSON/YAML writers, input hardening, MCP annotations/outputSchemas/structuredContent/discriminated `memory`, glossary integrity, Markdown paragraphs/MDX, pseudo ICU escapes, layout `cn()`/`clsx()`, docs & fixtures alignment |
