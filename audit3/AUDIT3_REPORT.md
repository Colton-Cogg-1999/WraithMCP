# Polyglot: Third Independent Audit (Round-2 Remediation Verification)

**Date:** 2026-11-24 · **Target:** `remediation` @ `f317563` (12 commits after `0eb5251`) · **Implementation not modified.**
- New tests: `audit3/` (16 tests).
- `audit/` is unchanged per git.
- `audit2/` is untracked, but every file's mtime predates the first round-2 commit (5beab45, 23:01), so it is unmodified.

## 1. Verdict

Round 2 genuinely fixed most of what the second audit raised:

- The DOCX positional-identity corruption.
- The three false-PASS paths.
- The symlink write escapes.
- Lost concurrent writes.
- The MCP annotation mismatch.

All of these hold under new inputs, not just the audit fixtures.

Two round-2 fixes introduced or left serious correctness problems:

1. **A FAIL that can't be fixed on correct react-i18next apps.** The new `missing_source_key` check doesn't understand i18next plural/context suffixes or `keyPrefix`. A correct app using `t("items", { count })` gets a blocking error that no edit to the catalogs can clear (**MISS-1**, **MISS-2**). With the pre-commit hook installed, that blocks every commit.
2. **Staleness can be laundered.** One manual edit to a translation permanently exempts that key from `stale_source`. The English can later change meaning entirely while `check` reports PASS (**STALE-1**).

**Recommendation:**
- **Dogfooding:** fine on next-intl, Vue, Svelte, Rails and Django projects. Hold off on react-i18next until MISS-1/2 are fixed.
- **Experimental public release:** blocked on MISS-1/2 and STALE-1 only. Both are narrow, local fixes. Everything else is release-notes material.

## 2. Reported results: reproduced exactly

| Command | Reported | Reproduced |
|---|---|---|
| `tsc --noEmit` | 0 errors | ✅ |
| `vitest run` | 52 passed (17 files) | ✅ |
| `audit/` suite | 119 pass / 1 fail (E4) / 6 skip | ✅ |
| `audit/` suite with the original DOCX corpus | n/a | 123 pass / 3 fail (E4, P-LO-2, P-LO-3: known defective tests). Real Word template 3/3. |
| `audit2/` suite | 46 pass / 1 fail (V4) | ✅ (V4 is a known over-strict test) |
| MCP suite on the SEA binary | 10/10 | ✅ |

**Count note:** the implementation agent's summary says the core suite "includes all 25 original tests, all 38 Round 1 tests, and 14 new". The 38 already included the 25, so the honest breakdown is 38 + 14 = 52. The total is right; the wording double-counts.

The fixture adjustments in `f317563` (adding a source file so B3 applies; `skipScan` in a pagination test) are legitimate and weaken no assertion.

## 3. Status of second-audit findings

| ID | Status | Evidence |
|---|---|---|
| B1/B2/N5 DOCX identity, stale segments, reviewer edits | **Resolved** | audit2 DX1–DX3 pass. A reviewer-edited paragraph whose source later changes is reported stale (**DOC-2**). |
| B3/B4/B5 false PASS | **Resolved, but B4 regressed** | audit2 V3/V8/V9 pass. MISS-4 (Rails lazy lookup in partials) and MISS-5 (Django `pgettext`/`ngettext`) are correct. **MISS-1/2/3** false FAIL on react-i18next/next-intl idioms. |
| B6/B7 symlink escapes | **Resolved** | audit2 SEC2-1/SEC2-3 pass |
| N1 concurrency | **Resolved** | audit2 CONC-1 passes; glossary writes from two processes keep 50/50 (**LOCK-1**); lock released on failure (**LOCK-2**); stale lock from a dead PID recovered in ~0.5 s (**LOCK-3**) |
| N2 hand-update both sides | **Resolved, but regressed into laundering** | **STALE-1** |
| N3 hand-added translations | **Partially resolved** | Keys present at `init` are baselined. A key *added* after `init` by hand and never applied or imported is never baselined, so it never goes stale (**STALE-2**). |
| N4 memory ranking | **Resolved** | audit2 MT5 passes |
| N6 annotations | **Resolved** | audit2 ANN-1 passes; MCP `scan` no longer writes |
| N7 scanner recall | **Partially resolved** | Fourth unseen app: **4/9 (44%)**, 0 false positives (**SCAN-1**). README now states the limits honestly. REMEDIATION §5.3's "100% on four apps" isn't an independent measure: two of those apps were audit tests the code was tuned against, and one was written by the same agent. |
| N8 vue pipe plurals | **Resolved** | audit2 PL8 passes |
| N9 install strings | **Resolved** | No `npx polyglot-mcp` left in `src/`. The binary is still not portable (42 `ldd` entries, disclosed). |
| N10, N11, N12, N13 | **Resolved** | audit2 PL3–PL5, ZIP2-2, V6 pass. A README/CHANGELOG at the root doesn't trigger INCONCLUSIVE (**UNS-1**); the Storybook `.mdx` case gives an actionable reason and clears via `paths.ignore` (**UNS-2**). |

## 4. New findings (round-3 suite: 16 tests, 8 fail)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **MISS-1** | **High (blocker)** | **react-i18next plural/context keys are reported as missing.** `t("items", { count })` with `items_one`/`items_other` in the catalog, and `t("friend", { context })` with `friend_male`/`friend_female`, each produce a blocking `missing_source_key`. The suffixed keys are also reported `orphaned_key`. A correct catalog can't be made to pass. | `FAIL {"missing_source_key":2,"orphaned_key":4}` |
| **MISS-2** | **High (blocker)** | **react-i18next `keyPrefix` is ignored.** `useTranslation("common", { keyPrefix: "nav" })` + `t("home")` → `missing_source_key: common.home`. | `FAIL {"missing_source_key":2,"orphaned_key":2}` |
| **STALE-1** | **High (blocker)** | **One manual edit permanently disables staleness for that key.** `src/core/check.ts` suppresses `stale_source` whenever the live target differs from the record (`targetChangedManually`). It never asks whether the edit came after the source change. Repro: the agent applies "Jetzt kaufen"; a translator adds "!"; weeks later the English becomes "Cancel subscription". Result: `PASS`, with only an info-level `manual_edit_detected`. | `PASS {"manual_edit_detected":1}` |
| STALE-2 | Medium | A key added after `init` (English and German by hand, never applied or imported) has no source baseline, so a later English change is invisible. | `PASS {}` |
| MISS-3 | Low | next-intl `t.has("subtitle")` guards are counted as required usages, raising a blocking error for an intentionally optional key. | `FAIL {"missing_source_key":1}` |
| DOC-1 | Low | Repeated identical paragraphs translated differently swap translations when the author reorders blocks. Identity is `(part, sourceHash, occurrence)`, and occurrence order changed. | `["…two?","Ja, gern.","…one?","Ja, genau."]` |
| SEC3-1 | Low | `init --hook` inside a git worktree, where `.git` is a file, throws a raw `ENOTDIR` instead of a clear message. | `ENOTDIR: not a directory, mkdir '…/.git/hooks'` |
| SCAN-1 | Medium (disclosed) | Recall 44% on a fourth unseen app. Missed: string returns from helper functions or `switch`, object-literal props (`items={[{ label }]}`), and the `content` prop. Precision stayed perfect (no technical strings flagged). | `recall 4/9` |

## 5. Live agent interoperability

| Agent | Result |
|---|---|
| Codex 0.172 (`codex exec`, approval `never`) | ✅ `status` and `check` completed (round 2) |
| **Antigravity CLI (`agy -p`)** | ✅ with MCP permitted. Discovered the server, called `status` and `check`, and reported correct numbers (`outcome=FAIL`, 7 errors, by-code breakdown). Headless mode denies all MCP calls unless `permissions.allow` contains an MCP rule. `mcp(polyglot)` did not match; `mcp(*)` did. That's Antigravity policy, independent of Polyglot's annotations, and worth a line in the README. |
| Claude Code | Passed in the first audit; not re-run |

For the Antigravity test, Polyglot was registered with `agy mcp add` and removed afterwards. `~/.gemini/config/mcp_config.json` was restored byte-for-byte from a backup.

## 6. Release blockers (experimental public release)

1. **MISS-1/MISS-2:** make `missing_source_key` resolve i18next plural suffixes (`_zero/_one/_two/_few/_many/_other`, plus `_ordinal_*`), context suffixes (`key_<context>`, including dynamic context → treat as resolved if any `key_*` exists), and `keyPrefix`. Apply the same resolution to `orphaned_key`.
2. **STALE-1:** suppress `stale_source` only when the target changed *after* the source change, i.e. relative to the target recorded alongside the current source hash. Record the source hash at the moment a manual edit is accepted (for example, when `import` re-baselines), rather than comparing live target to the agent's original record forever.

**Release notes, not blockers:** STALE-2, MISS-3, DOC-1, SEC3-1, scanner recall (~45–55% on unseen apps), non-portable binary, Antigravity permission rule.

## 7. Reproduce

```bash
npx vitest run --config audit3/vitest.config.ts   # 16 tests: 8 fail = findings in §4
npx vitest run --config audit2/vitest.config.ts   # 46/47 (V4 known over-strict)
npx vitest run --config audit/vitest.config.ts    # 119/1/6 (E4 known defective)
```

## 8. Not verified

macOS and Windows binaries, the CI release workflow, Microsoft Word itself, Claude Code re-run, scanner recall for Rails/Django/Vue on unseen apps.
