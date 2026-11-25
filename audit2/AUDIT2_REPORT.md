# Wraith: Second Independent Audit (Remediation Verification)

**Date:** 2026-11-24 · **Target:** branch `remediation` @ `0eb5251` (8 remediation commits on baseline `5022913`) · **Implementation not modified.** New tests live in `audit2/`. The original `audit/` is untouched (verified: `git diff 5022913 HEAD -- audit/` is empty).

---

## 1. Verdict

The remediation is substantial and mostly genuine. The fixes are general mechanisms, not patches shaped to the audit fixtures:

- a central path-confinement layer;
- separate plural models for ICU, gettext, Rails, i18next and Vue;
- a splice-based JSON writer;
- tri-state `check`;
- read-only analysis tools;
- reworked DOCX extraction.

A source search found no audit-fixture strings in `src/`. The reported audit numbers reproduce exactly.

New adversarial inputs, however, found **three classes of problem that make the tool unsafe to publish as-is**, even as experimental:

1. **DOCX incremental state is positional.** If the source document changes between batches, earlier translations are written onto the *wrong paragraphs*. A changed paragraph silently keeps its old translation, and `check` reports `PASS`. This is a new defect introduced by the C6 fix.
2. **`check` still false-passes on common real-world states:**
   - zero source files scanned, when catalog keys exist;
   - keys used in code but absent from the source catalog;
   - a Django project with marked strings but no catalogs yet.
3. **The workspace boundary still has two write paths outside the repository:** a symlinked `.wraith/` directory, and a symlinked `CLAUDE.md`/`AGENTS.md` during `init`. Both are reachable from an untrusted cloned repository.

**Recommendation:**
- **Dogfooding** on the team's own trusted repos: acceptable now, with documents excluded or translated in a single pass from a frozen source.
- **Experimental public release:** blocked on the items in §6. All are narrow fixes; none needs new features.

---

## 2. Reported results: independently reproduced

| Claim (REMEDIATION.md) | Reproduced | Notes |
|---|---|---|
| `tsc --noEmit` clean | ✅ | |
| Core suite 38/38 (11 files) | ✅ | |
| Audit suite **119 pass / 1 fail / 6 skip** (126) | ✅ exact | 6 skips are the DOCX corpus tests, which need `AUDIT_REF_DOCX`/`AUDIT_LO_DOCX`. |
| Audit MCP suite on the SEA binary 10/10 | ✅ | `AUDIT_MCP_BIN=release/wraith-linux-x64` |
| Baseline 24 / 96 / 6 | ✅ consistent | My original 28 pass / 98 fail figure included the 6 corpus tests (4 pass, 2 fail). Excluding them: 24 / 96 / 6. **The counts reconcile.** |
| "Real third-party Word template not available" | Ran it | With the original corpus supplied: **123 pass / 3 fail**. All three failures are test defects (§4). P-REF-1/2/3 pass on the real Word template. |

**Net:** every executable original audit test either passes or is a defective test. The remaining risk lies in behavior those tests didn't exercise (§3).

---

## 3. New findings (second-audit suite: 47 tests, 22 fail, 25 pass)

Run with `npx vitest run --config audit2/vitest.config.ts`. Each test prints `[ID] …` evidence.

### Release blockers

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **B1** | Critical | **DOCX translations land on the wrong paragraphs after the source document is edited.** Segment IDs are positional (`document-p1…`), and `.wraith/documents.json` maps translations by ID with no per-segment source hash. After the author inserted one paragraph at the top between batches, the "Apples are red." paragraph received the *Bananas* translation, and "Bananas…" stayed English. `apply` returned `ok: true`. | **DX1** output: `["WICHTIG…", "Bananen sind gelb.", "Bananas are yellow.", …]` |
| **B2** | High | **Changed source paragraphs keep their old translation and `check` reports PASS.** "Apples are red." → "Apples are green." still renders "Äpfel sind rot." `check` (document configured): `PASS {}`. | **DX2** |
| **B3** | High | **`check` returns PASS when no source file was scanned.** INCONCLUSIVE fires only when *both* `totalSourceKeys === 0` *and* `filesScanned === 0` (`src/core/check.ts:666-673`). A mistyped `paths.source` yields `PASS` with `filesScanned: 0`. | **V3** |
| **B4** | High | **Keys used in code but missing from the source catalog are not detected.** `t("subtitle")` with no `en.json` entry renders the raw key in every language, and the outcome is `PASS`. This is the most common failure after agent-driven extraction. | **V9** |
| **B5** | High | **Django project with `_()`/`{% translate %}` usage but no catalogs yet → PASS.** Same root cause as B3/B4: used keys aren't compared against catalogs. | **V8** |
| **B6** | High (security) | **A symlinked `.wraith/` directory redirects state writes outside the repo.** `records.json`, `glossary.json` and `memory.jsonl` were written into the symlink target. `WraithStore` writes aren't confined (`src/core/store.ts` uses `fs.writeFileSync`/`atomicWriteFileSync` on `this.dir` without a realpath check). Filenames and content are fixed, which limits exploitability, but it violates the boundary REMEDIATION.md marks **Resolved**. | **SEC2-1** |
| **B7** | High (security) | **`init` appends through a symlinked `CLAUDE.md`/`AGENTS.md` to any file the user can write** (`src/core/init.ts:92`). With `CLAUDE.md → ~/.bashrc`, the appended rule text contains backticks (`` `wraith check` ``) that bash executes as command substitution at every shell start. | **SEC2-3** |

### Not blockers (fix before or soon after release)

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| N1 | High | **Concurrent processes lose translations.** Two processes applying different keys to one locale lost up to 13/40 locale-file entries and 20/40 records across five runs. REMEDIATION §4.5 discloses missing locking but frames it as `.wraith/` merges; the loss also hits **user locale files**. `check` would report the lost keys as `missing_key`, so it's recoverable. | **CONC-1** (intermittent: 40/40, 38/40, 36/40, 27/40) |
| N2 | High (maintenance) | **Hand-updating English and its translation together leaves a permanent `stale_source` error.** `import` deliberately preserves hashes (the L3 fix) and the CLI has no `apply`, so the pre-commit hook blocks the commit until an agent re-applies the same text. This regression comes from over-correcting L3. | **MT2**, **MT3** |
| N3 | Medium | **Translations added by hand *after* `init` are never baselined**, so they never go stale (L1 is fixed only for translations present at `init`). | **MT1** |
| N4 | Medium | **Hand-corrected translations don't replace the old agent text in memory suggestions** (L2 claimed fixed). | **MT5**: suggestions `["Kaufen jetzt"]` after the file says `"Jetzt kaufen"` |
| N5 | Medium | **Reviewer edits made directly in the translated DOCX are discarded** by the next batch, which rebuilds the file from source plus stored state. | **DX3** |
| N6 | Medium | **`apply` is annotated `destructiveHint: false`** but overwrites existing translations (observed `messages/de.json` "Hallo" → "Servus"). `escalate import` and a second `pseudo` run do the same. Clients may treat "non-destructive" as safe to auto-approve. `scan` with opt-in `saveUsage: true` writes despite `readOnlyHint`. | **ANN-1** |
| N7 | Medium | **Scanner recall on a third, unseen app is ~50%** (7/13, with one hit possibly a substring match). The audit fixture (19/19) and the implementation's own held-out app (12/12) overstate it. Precision held (0 false positives). Missed: ternaries assigned to variables, `as const` arrays, `setState("…")`, the `hint` prop. | **GEN-1** |
| N8 | Medium | **vue-i18n: a correct 4-form Russian pipe plural is rejected** ("`count` appears 3 times, expected 1"). The per-message placeholder count is applied across pipe branches. | **PL8** |
| N9 | Medium | **Distribution:** `release/wraith-linux-x64` still links 42 host libraries (honestly disclosed). The CI matrix has never run. **`wraith init` still prints `claude mcp add wraith -- npx -y wraith-mcp mcp`** (`src/cli.ts:76`), and the hook error text says `npm install -D wraith-mcp`. That name is unpublished, so a squatter's package would be executed. | `ldd`, source |
| N10 | Low | Advisory plural categories (fr `many` for millions; cs/lt fractional `many`) are computed but **never surfaced** in `check`/`prepare` issues. The integers-0..100 policy is defensible, but the advisory signal is invisible. | **PL3–PL5** |
| N11 | Low | Hook fallback `node ./dist/bin.js check` runs the **user project's own** `dist/bin.js` if present. | `src/core/init.ts` hook |
| N12 | Low | The archive guard rejects any entry name containing `..` as a substring (e.g. `item..1.xml`). Wraith never extracts entries to disk, so this is over-strict but harmless. | **ZIP2-2** |
| N13 | Low | `.mdx` pages in a Next.js app aren't scanned and aren't reported as unscanned in `coverage`. | **V6** |

---

## 4. Original audit assertions found incorrect

| Original test | Verdict | Evidence |
|---|---|---|
| **E4** (JSON integer-key order) | **Test defective; finding M1 was real.** The test builds `fr.json` with `JSON.stringify`, which already emits `"404"` before `"generic"` (ECMA-262 integer-key ordering), so the assertion can never pass for a lossless writer. A raw-string probe settles the finding: baseline `5022913` moved `"404"` before `"generic"`; `0eb5251` keeps `"generic"` first. **M1 is resolved; the implementation agent's disagreement is correct.** | probe output (§7) |
| **P-LO-2 / P-LO-3** | **Oracle defective.** LibreOffice's text export includes tracked-deletion text ("obsolete wording"); the test treated it as untranslated. The only genuine leftover in the first audit ("formally", inside `w:ins`) is now translated. Deleted revision text should stay untouched; **DX5** confirms `w:del` is byte-preserved. | P-LO-2: missing words only `budgetobsolete`, `wording` |
| **M10** cause ("plausible") | **Confirmed.** After annotations were added, headless `codex exec` (`approval: never`) completed `status` and `check`; before, both were refused. | live Codex run |

---

## 5. Status of original findings

| Finding | Status | Basis |
|---|---|---|
| C1 path traversal (S1–S5) | **Resolved** for the original vectors; reads also confined (**SEC2-5/6**); locale-tag grammar sound (**SEC2-7**); symlinked locale dir and `documents.json` redirection blocked | New vectors open: **B6**, **B7** |
| C2 Romance plurals | **Resolved** | Audit A1–E2; **PL1**, **PL2**, **PL6**, **PL7** |
| C3 Django model, plural forms, fuzzy | **Resolved** | Audit H1–H5; **PL9** (ru nplurals=3, ar nplurals=6 pass), **PL10** |
| C4 false PASS | **Partially resolved** | Unknown stack (**V5**), monorepo (**V4**: INCONCLUSIVE with actionable reason) and missing locale (**V7**) are correct. **B3**, **B4**, **B5** still pass falsely. |
| C5 Rails plural overwrite | **Resolved** | Audit I3–I5 |
| C6 DOCX batches | **Partially resolved; new defect** | Batches persist (**DX6**, LibreOffice reopens). **B1**, **B2**, **N5**. |
| H1 scanner recall | **Partially resolved** | **N7** |
| H2 usage idioms | **Resolved** (audit tests) | Not re-measured beyond them |
| H3 staleness | **Partially resolved** | **MT4**, **MT6–MT8** pass; **N2**, **N3**, **N4** |
| H4 placeholder holes | **Resolved**, except vue pipe-plural counts (**N8**) | |
| H5 DOCX constructs | **Resolved** | Audit Q1–Q11. **DX4** formatting kept; **DX5** `w:ins` author/date kept, `w:del` byte-identical |
| H6 install/distribution | **Partially resolved** | README is honest; hook is portable; **N9**, **N11** |
| M1 JSON | **Resolved** | §4 probe |
| M5 TMX, M6 malformed input, M11 pseudo | **Resolved** | Audit tests |
| M7 archives | **Resolved** | **ZIP2-1**: a zip that lies about 200 MB → 1 KB is decompressed to 1 KB, ~5 MB RSS |
| M9/M10 MCP contract | **Mostly resolved** | Read-only tools verified side-effect-free by file snapshots (**ANN-1**); Codex works; **N6** |
| M13 check/status writes | **Resolved** | **ANN-1** |
| Atomic writes | **Verified** | **CONC-2**: 0 parse errors while interleaving writes and checks |

---

## 6. Release blockers (experimental public release)

1. **B1/B2: DOCX segment identity.** Store a per-segment source hash (or a content-derived ID) in `documents.json`. Drop or flag stored translations whose source hash no longer matches. Make `check` report such segments as `stale_source`.
2. **B3/B4/B5: close the remaining false passes.**
   - INCONCLUSIVE when `filesScanned === 0` and a framework adapter is active.
   - An error for keys referenced in code but missing from the source catalog.
   - A Django state where used msgids have no catalog entries must not PASS.
3. **B6/B7: confine every write.** Route `WraithStore`, `init` agent-rule writes and hook writes through `resolveConfinedPath`, or refuse when `.wraith`, `AGENTS.md` or `CLAUDE.md` is a symlink resolving outside the root.
4. **N9 (install string only):** stop printing `npx -y wraith-mcp` until the package name is published or reserved.

**Strongly recommended before release:** N1 (a lock file around read-modify-write of locale and state files), N2 (let `import` re-baseline keys whose target changed since the record, or add a non-agent accept path), N6 (`destructiveHint: true` for `apply`, `escalate`, `pseudo`, `import`).

---

## 7. Reproduction

```bash
# Original audit, as reported by the implementation agent (119/1/6)
npx vitest run --config audit/vitest.config.ts
# Original audit with the original corpus (123/3: E4 + P-LO-2/3 test defects)
AUDIT_REF_DOCX=<reference.docx> AUDIT_LO_DOCX=<complex.docx> npx vitest run --config audit/vitest.config.ts
# MCP suite against the shipped binary (10/10)
AUDIT_MCP_BIN=release/wraith-linux-x64 npx vitest run --config audit/vitest.config.ts audit/tests/mcp.test.ts
# Second audit (47 tests: 22 fail = findings above; CONC-1 is a race and fails intermittently)
npx vitest run --config audit2/vitest.config.ts
```

**E4 raw-string probe:** `en.json` and `fr.json` written as literal strings with `"generic"` before `"404"`, then one `apply` of `errors.500`:
- `5022913` → `{"404","500","generic"}` (reordered).
- `0eb5251` → `{"generic","404","500"}` (preserved).

**Live agents:**
- Claude Code: not re-run; it passed in the first audit and the protocol surface is now strictly richer.
- Codex 0.172 `codex exec -s read-only` against `release/wraith-linux-x64`: `wraith/status (completed)`, `wraith/check (completed)`.

## 8. Not independently verified

- macOS/Windows binaries and the GitHub release workflow; portability of a CI-built Linux binary.
- Gemini CLI. Microsoft Word itself (LibreOffice used as the oracle).
- Scanner recall for Rails, Django and Vue beyond the original audit tests.
- The provenance of `docs/SPEC.md` ("restored verbatim"): there's no earlier copy to compare against.
- Multi-agent concurrency through a single MCP server. Handlers are synchronous, so calls into one server serialize; only multi-process races were tested.
