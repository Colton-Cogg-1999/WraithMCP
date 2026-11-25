# GitHub CI

Workflow: [`.github/workflows/polyglot.yml`](../.github/workflows/polyglot.yml)

| Job | Trigger | Tokens | Purpose |
|---|---|---|---|
| `deterministic-l10n-gate` | `pull_request` | **0** | `extract --fail-on-unextracted`, `check`, `visual-qa` vs baseline; sticky PR comment; artifacts on failure |
| `update-baseline` | `push` to `main` | 0 | recapture `.polyglot/visual-baseline.json`, upload as artifact |
| `agentic-localize` | `/localize` PR comment (OWNER/MEMBER/COLLABORATOR) or `workflow_dispatch` | agent + optional QE | translate changed source keys, `check`, `qe`, commit if `PASS`, export + comment escalations |

## Setup

1. Add Wraith as a dev dependency so `npx polyglot` resolves (until published, install from a tarball/git URL), and commit `.polyglot/config.json` with `layout.routes` and `layout.localeUrlPattern`.
2. Add `playwright` as a dev dependency (visual-qa uses the optional peer).
3. Copy `polyglot.yml` into `.github/workflows/` and adjust `PREVIEW_BUILD` / `PREVIEW_START` / `PREVIEW_URL` (defaults: `npm run build`, `npm run start`, `http://localhost:3000`), or call it as a reusable workflow:

```yaml
# .github/workflows/l10n.yml in your app repo
on:
  pull_request:
  push: { branches: [main] }
jobs:
  polyglot:
    uses: <owner>/<repo>/.github/workflows/polyglot.yml@main
    with:
      preview_build: pnpm build
      preview_start: pnpm start --port 4173
      preview_url: http://localhost:4173
    secrets: inherit
    permissions:
      contents: write
      pull-requests: write
      issues: write
```

4. Bootstrap the baseline once: run `polyglot visual-qa --capture-baseline --url <url>` locally (or take the `polyglot-visual-baseline` artifact from the first `main` run) and commit `.polyglot/visual-baseline.json`. Without it, visual-qa returns `INCONCLUSIVE` and the gate fails.

## Secrets

| Secret | Used by | Required |
|---|---|---|
| `GITHUB_TOKEN` | PR comments, push of verified translations | automatic |
| `ANTHROPIC_API_KEY` | `agentic-localize` with `agent: claude`; also QE Tier 2 | for `/localize` (claude) |
| `OPENAI_API_KEY` | `agentic-localize` with `agent: codex` | for `/localize` (codex) |
| `GEMINI_API_KEY` | QE Tier 2 fallback when no Anthropic key | optional |

The deterministic gate uses no secrets. Without any QE key, `polyglot qe` still runs Tier 1 and marks the rest `unscored`.

## Permissions

Workflow default is `contents: read`. Per job:

- `deterministic-l10n-gate`: `contents: read`, `pull-requests: write` (sticky comment only). On fork PRs the token is read-only; the comment step is `continue-on-error` and the gate still enforces.
- `update-baseline`: `contents: read`.
- `agentic-localize`: `contents: write` (push translations), `pull-requests: write`, `issues: write` (comments/reactions). It refuses fork PRs so secrets never run against untrusted code.

## Gate behavior

Each gate step runs with `continue-on-error`, records its exit code, and a final `Enforce gate` step fails the job if any did not succeed. Exit `2` is reported as `INCONCLUSIVE` in the PR table and still fails. The sticky comment is found and updated by the marker `<!-- polyglot-l10n-gate -->`. On failure `.polyglot/artifacts/` (gate logs, visual-qa screenshots + `manifest.json`) is uploaded as `polyglot-l10n-gate-<PR>`.

## Baseline updates on main

`update-baseline` uploads `polyglot-visual-baseline` but does **not** push to `main`. To accept new geometry:

```bash
gh run download <run-id> -n polyglot-visual-baseline -D .polyglot
git checkout -b chore/visual-baseline && git add .polyglot/visual-baseline.json
git commit -m "chore(l10n): refresh visual baseline" && gh pr create --fill
```

Review the diff like code: a baseline that absorbs a regression disables the gate for it.

## `/localize` and PR escalation

1. A maintainer comments `/localize` on a PR (or runs the workflow manually with `agent`, `pr_number`, `base_ref`).
2. The job checks out the PR head (`fetch-depth: 0`) and diffs source-locale files against `origin/<base>`; changed JSON keys are listed as `file<TAB>key` (YAML/PO files as `file<TAB>*`).
3. The agent runs with the body of [`skills/localize-pr/SKILL.md`](../skills/localize-pr/SKILL.md) as its prompt and Wraith as its MCP server:
   - Claude: `claude -p … --mcp-config mcp.json --allowedTools mcp__polyglot,Read,Glob,Grep,Edit,Write --permission-mode acceptEdits`
   - Codex: `codex exec --full-auto …` with `[mcp_servers.polyglot]` in `~/.codex/config.toml`
   Agent CLI flags change between releases; pin versions if you depend on them.
4. `polyglot check` then `polyglot qe --json`. Translations are committed and pushed only if `check` passes. Commits pushed with `GITHUB_TOKEN` do not retrigger workflows; re-run the gate or push a commit to re-check.
5. If `qe-report.json` contains `needs_review` segments, the job runs `polyglot export --only-flagged --include-tm --include-glossary --bundle-screenshots --out .polyglot/artifacts/tms-review`, uploads it as `polyglot-tms-review-<PR>`, and comments a table of escalated keys with risk scores. Linguists return the XLIFF; import it with `polyglot import <dir>` (see [QE_AND_TMS.md](QE_AND_TMS.md)).

`issue_comment` workflows always run the workflow file from the default branch, so changes to `polyglot.yml` take effect for `/localize` only after merge.
