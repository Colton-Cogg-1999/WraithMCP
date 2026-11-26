# GitHub CI

## Quick start: the Wraith Action

For most repos this is all you need. It makes no model calls and needs no secrets:

```yaml
# .github/workflows/wraith.yml in your app repo
name: Wraith
on:
  pull_request:
  issue_comment:
    types: [created]
permissions:
  contents: read
jobs:
  gate:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: Colton-Cogg-1999/WraithMCP@v1
  answer:
    if: >-
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request &&
      contains(github.event.comment.body, '/wraith answer') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    concurrency:
      group: wraith-answer-pr-${{ github.event.issue.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - run: gh pr checkout ${{ github.event.issue.number }}
        env: { GH_TOKEN: "${{ github.token }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: Colton-Cogg-1999/WraithMCP@v1
        with: { command: answer }
```

- **`gate`** (every PR): runs `wraith extract --fail-on-unextracted` and `wraith check`, and fails the job unless both pass. It writes the Wraith report to the job summary and posts/updates one sticky PR comment (on fork PRs where `GITHUB_TOKEN` is read-only, it falls back cleanly to the job summary while still enforcing the gate). Inputs: `working-directory`, `fail-on-unextracted`, `comment`, `wraith-version`. Outputs: `check`, `flagged`, `open-questions`.
- **`answer`** (PR comments): a comment line `/wraith answer Q1 it's a social-media post` (or `A2 use informal du`) from an owner, member or collaborator is recorded with `wraith answer`, committed to the PR branch, and confirmed in a reply. Comment text is passed to Wraith as a plain argument after `--`, never through a shell. Note: commits pushed with the default `GITHUB_TOKEN` do not re-trigger `pull_request` workflows (and fork PR branches cannot be pushed with `GITHUB_TOKEN`); pass a PAT or GitHub App token via `with: { github-token: ... }` if required status checks must re-run automatically. Then comment `/localize` (full workflow below) or run your agent locally to revisit the affected strings.
- **Wraith version:** by default the Action installs its own version of `wraith-mcp` from npm, falling back to building from its source when that version isn't published. Set `wraith-version` to pin one.

## Full workflow (visual QA + `/localize` agent)

Workflow template: [`examples/workflows/wraith.yml`](../examples/workflows/wraith.yml)

| Job | Trigger | Tokens | Purpose |
|---|---|---|---|
| `deterministic-l10n-gate` | `pull_request` | **0** | `extract --fail-on-unextracted`, `check`, `visual-qa` vs baseline; sticky PR comment; artifacts on failure |
| `update-baseline` | `push` to `main` | 0 | recapture `.wraith/visual-baseline.json`, upload as artifact |
| `agentic-localize` | `/localize` PR comment (OWNER/MEMBER/COLLABORATOR) or `workflow_dispatch` | agent | translate changed source keys, `check`, ok/flag review in a fresh subagent context, commit if `PASS`, export + comment flagged strings |

## Setup

1. Add Wraith as a dev dependency (`npm i -D wraith-mcp`) so `npx wraith` resolves, and commit `.wraith/config.json` with `layout.routes` and `layout.localeUrlPattern`.
2. Add `playwright` as a dev dependency (visual-qa uses the optional peer).
3. Copy [`examples/workflows/wraith.yml`](../examples/workflows/wraith.yml) into `.github/workflows/wraith.yml` in your app repo (or into a shared workflows repo to call via `workflow_call`), and adjust `PREVIEW_BUILD` / `PREVIEW_START` / `PREVIEW_URL` (defaults: `npm run build`, `npm run start`, `http://localhost:3000`):

```yaml
# .github/workflows/l10n.yml in your app repo
on:
  pull_request:
  push: { branches: [main] }
jobs:
  wraith:
    uses: <owner>/<repo>/.github/workflows/wraith.yml@main
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

4. Bootstrap the baseline once: run `wraith visual-qa --capture-baseline --url <url>` locally (or take the `wraith-visual-baseline` artifact from the first `main` run) and commit `.wraith/visual-baseline.json`. Without it, visual-qa returns `INCONCLUSIVE` and the gate fails.

## Secrets

| Secret | Used by | Required |
|---|---|---|
| `GITHUB_TOKEN` | PR comments, push of verified translations | automatic |
| `ANTHROPIC_API_KEY` | `agentic-localize` with `agent: claude` | for `/localize` (claude) |
| `OPENAI_API_KEY` | `agentic-localize` with `agent: codex` | for `/localize` (codex) |

The deterministic gate uses no secrets. Wraith itself never calls a model; the only model is the `/localize` agent.

## Permissions

Workflow default is `contents: read`. Per job:

- `deterministic-l10n-gate`: `contents: read`, `pull-requests: write` (sticky comment only). On fork PRs the token is read-only; the comment step is `continue-on-error` and the gate still enforces.
- `update-baseline`: `contents: read`.
- `agentic-localize`: `contents: write` (push translations), `pull-requests: write`, `issues: write` (comments/reactions). It refuses fork PRs so secrets never run against untrusted code.

## Gate behavior

Each gate step runs with `continue-on-error`, records its exit code, and a final `Enforce gate` step fails the job if any did not succeed. Exit `2` is reported as `INCONCLUSIVE` in the PR table and still fails. The sticky comment is found and updated by the marker `<!-- wraith-l10n-gate -->`. On failure `.wraith/artifacts/` (gate logs, visual-qa screenshots + `manifest.json`) is uploaded as `wraith-l10n-gate-<PR>`.

## Baseline updates on main

`update-baseline` uploads `wraith-visual-baseline` but does **not** push to `main`. To accept new geometry:

```bash
gh run download <run-id> -n wraith-visual-baseline -D .wraith
git checkout -b chore/visual-baseline && git add .wraith/visual-baseline.json
git commit -m "chore(l10n): refresh visual baseline" && gh pr create --fill
```

Review the diff like code: a baseline that absorbs a regression disables the gate for it.

## `/localize` and PR escalation

1. A maintainer comments `/localize` on a PR (or runs the workflow manually with `agent`, `pr_number`, `base_ref`).
2. The job checks out the PR head (`fetch-depth: 0`) and diffs source-locale files against `origin/<base>`; changed JSON keys are listed as `file<TAB>key` (YAML/PO files as `file<TAB>*`).
3. The agent runs with the body of [`skills/localize-pr/SKILL.md`](../skills/localize-pr/SKILL.md) as its prompt and Wraith as its MCP server:
   - Claude: `claude -p … --mcp-config mcp.json --allowedTools mcp__wraith,Read,Glob,Grep,Edit,Write,Agent --permission-mode acceptEdits` (`Agent` lets it review in a fresh subagent context)
   - Codex: `codex exec --full-auto …` with `[mcp_servers.wraith]` in `~/.codex/config.toml`
   Agent CLI flags change between releases; pin versions if you depend on them.
4. The agent reviews its translations with the **qe-review** skill in a fresh subagent context. Then `wraith check` and `wraith qe --json` (review status). Translations are committed and pushed only if `check` passes. Commits pushed with `GITHUB_TOKEN` do not retrigger workflows; re-run the gate or push a commit to re-check.
5. If any strings are flagged, the job runs `wraith export --only-flagged --include-tm --include-glossary --bundle-screenshots --out .wraith/artifacts/tms-review`, uploads it as `wraith-tms-review-<PR>`, and comments a table of flagged keys with their reasons. Linguists return the XLIFF; import it with `wraith import <dir>` (see [QE_AND_TMS.md](QE_AND_TMS.md)).

`issue_comment` workflows always run the workflow file from the default branch, so changes to `wraith.yml` take effect for `/localize` only after merge.
