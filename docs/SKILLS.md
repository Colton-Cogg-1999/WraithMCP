# Agent Skills

Skills are Markdown playbooks (`skills/<name>/SKILL.md`, YAML frontmatter `name` + `description`) that pin an agent to a deterministic-first sequence of Wraith tools, with explicit stop conditions and "never" rules.

| Skill | Use when | Core sequence |
|---|---|---|
| [`i18n-prep`](../skills/i18n-prep/SKILL.md) | repo not yet internationalized; hardcoded strings/formatting/RTL hazards | `extract` → `layout_fix` → `check` (hardcoded_formatting, directional_asset, rtl_layout_risk) → patch → `pseudo` en-XA/ar-XB → `layout` + `visual_qa` |
| [`localize-pr`](../skills/localize-pr/SKILL.md) | translate changed keys in a PR; CI `/localize` | `status` → `prepare` → translate → `apply` → `check` → `qe_audit` → `report` |
| [`layout-remediation`](../skills/layout-remediation/SKILL.md) | `layout` / `visual_qa` FAIL | reproduce → `layout_fix` → prescribed edits → width budgets via `prepare`/`apply` → verify |
| [`qe-triage`](../skills/qe-triage/SKILL.md) | score/triage translations; `wraith qe` exits 1 | `check` → `qe_audit` → ≤1 repair pass → route `needs_review` |
| [`tms-roundtrip`](../skills/tms-roundtrip/SKILL.md) | human linguist review via TMS | `check` → `qe_audit` → `tms_export` → TMS → `tms_import` → `check` |

## Connect the MCP server

Until `wraith-mcp` is published, replace `npx wraith` with `node /absolute/path/to/wraith/dist/bin.js` (or `wraith` after `npm link`).

**Claude Code (CLI):**

```bash
claude mcp add wraith -- npx wraith mcp
```

**Project-scoped `.mcp.json`** (Claude Code, checked into the repo):

```json
{
  "mcpServers": {
    "wraith": { "command": "npx", "args": ["wraith", "mcp"] }
  }
}
```

**Claude Desktop `claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "wraith": {
      "command": "npx",
      "args": ["wraith", "-C", "/absolute/path/to/your/app", "mcp"]
    }
  }
}
```

`-C, --cwd <dir>` is the global project-root flag; Claude Desktop does not launch in your repo, so set it explicitly.

**Codex `~/.codex/config.toml`** (documentation only; not validated by Wraith's test suite):

```toml
[mcp_servers.wraith]
command = "npx"
args = ["wraith", "mcp"]
```

QE Tier 2 reads `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `WRAITH_QE_MODEL` from the server's environment; add an `env` block to the MCP config only if you want `qe_audit` to run Tier 2 from the agent.

## Use a skill

- **Claude Code:** copy or symlink the folders into `.claude/skills/` (project) or `~/.claude/skills/` (user). Claude loads a skill when the request matches its `description`, or invoke it explicitly: "Use the localize-pr skill."
- **Codex / other agents:** reference it from `AGENTS.md` (e.g. "For localization PRs follow `skills/localize-pr/SKILL.md`"), or paste the body as the prompt.
- **CI:** `agentic-localize` strips the frontmatter of `skills/localize-pr/SKILL.md` and passes the body plus the changed-key list to `claude -p` / `codex exec` ([GITHUB_CI.md](GITHUB_CI.md)).

### Examples

```text
> Use i18n-prep on this repo; targets are de, ar, ja.
> Localize the keys changed on this branch (localize-pr).
> visual-qa failed on /checkout at 375px for de — run layout-remediation.
> Triage QE for ja and fix what you safely can (qe-triage).
> Send the flagged German strings to our TMS; later import reviewed/de.xliff (tms-roundtrip).
```

## Rules shared by all skills

- Writes to target catalogs go through `apply`, `qe_audit` auto-repair, or `tms_import` — all validated. Never hand-edit locale files.
- `INCONCLUSIVE` is never reported as `PASS`; `unscored` is never reported as `verified`.
- Agents never set `human-reviewed` provenance, edit `qe-report.json`, or recapture the visual baseline to silence a regression.
