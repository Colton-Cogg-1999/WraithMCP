# Known Gaps

This document tracks known limitations verified by the audit suites (`audit2/`, `audit3/`). Each item has an active `it.fails(...)` test in CI so any fix immediately surfaces as an unexpected pass.

## 1. Multi-app monorepos from a single root config (`audit2` V4)

**Symptom:** Running `wraith init` and `wraith check` once at the root of a monorepo containing multiple independent apps (e.g. `apps/web` and `apps/admin`, each with its own `messages/*.json` and `package.json`) resolves a single primary locale layout and returns `INCONCLUSIVE` or evaluates only one app rather than aggregating across sub-packages.

**Workaround:** Initialize and run Wraith per application directory (e.g. `working-directory: apps/web` and `working-directory: apps/admin` in separate matrix jobs with the Wraith GitHub Action).

## 2. Keys added manually to both source and target after `init` (`audit3` STALE-2)

**Symptom:** Keys present when `wraith init` runs are baselined automatically, and keys written via `wraith apply` or `wraith import` record source hashes in `.wraith/records.json`. However, if a developer adds a brand-new key to both `en.json` and `de.json` by hand *after* `init` without running `wraith import --format locales`, Wraith has no baseline hash for that key, so a subsequent edit to the English string alone will not raise `stale_source`.

**Workaround:** Write translations through `wraith apply` / `wraith import`, or run `wraith import --format locales` after hand-adding new bilingual keys to record their baseline hashes.

## 3. Identical repeated DOCX paragraphs translated differently (`audit3` DOC-1)

**Symptom:** DOCX segment identity is content-derived `(part, sourceHash, occurrenceIndex)` so edits, insertions, and deletions elsewhere in the document keep translations attached to their paragraphs. In the edge case where two paragraphs in the same XML part have identical source text (e.g. `"Yes."` twice), receive *different* translations, and are later swapped in order, their occurrence indices swap as well.

**Workaround:** Review repeated short identical responses after structural reordering in DOCX files.

## 4. Heuristic React scanner recall on indirect dataflow (`audit3` SCAN-1)

**Symptom:** The AST hardcoded-string scanner prioritizes zero false positives on technical identifiers, URLs, CSS classes, storage keys, and console/error strings. On unseen apps that construct copy via `switch` statements in helper functions, nested object-literal prop arrays (`items={[{ label: "..." }]}`), or custom non-standard prop names, recall is ~45–55% while false positives remain 0%.

**Workaround:** Combine `wraith scan` / `wraith extract` with coding-agent code inspection (`i18n-prep` skill) when onboarding an unlocalized codebase.
