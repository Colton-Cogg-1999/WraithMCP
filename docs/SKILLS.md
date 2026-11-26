# Agent Skills

Skills are Markdown playbooks (`skills/<name>/SKILL.md`, YAML frontmatter `name` + `description`) that pin an agent to a deterministic-first sequence of Wraith tools, with explicit stop conditions and "never" rules.

| Skill | Use when | Core sequence |
|---|---|---|
| [`i18n-prep`](../skills/i18n-prep/SKILL.md) | repo not yet internationalized; hardcoded strings/formatting/RTL hazards | `extract` → `layout_fix` → `check` (hardcoded_formatting, directional_asset, rtl_layout_risk) → patch → `pseudo` en-XA/ar-XB → `layout` + `visual_qa` |
| [`localize-pr`](../skills/localize-pr/SKILL.md) | translate changed keys in a PR; CI `/localize` | `status` → `prepare` → translate → `apply` → `check` → `qe_audit` review (fresh context) → `report` |
| [`layout-remediation`](../skills/layout-remediation/SKILL.md) | `layout` / `visual_qa` FAIL | reproduce → `layout_fix` → prescribed edits → width budgets via `prepare`/`apply` → verify |
| [`qe-review`](../skills/qe-review/SKILL.md) | review translations in context; `wraith qe` exits 1/2; release sign-off | `check` → `qe_audit` prepare → fresh-context review of each file → submit → fix flagged once → hand off |
| [`crowdin-sync`](../skills/crowdin-sync/SKILL.md) | review in Crowdin | `check` → `tms_export` xliff12 → `crowdin upload sources/translations` → (review) → `crowdin download translations --export-only-approved` → `tms_import` → `check` |
| [`tms-roundtrip`](../skills/tms-roundtrip/SKILL.md) | human linguist review via any other TMS | `check` → `qe_audit` review → `tms_export` → TMS → `tms_import` → `check` |

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

Wraith needs no API keys: review (`qe_audit`) is done by your agent.

## Use a skill

- **Claude Code:** copy or symlink the folders into `.claude/skills/` (project) or `~/.claude/skills/` (user). Claude loads a skill when the request matches its `description`, or invoke it explicitly: "Use the localize-pr skill."
- **Codex / other agents:** reference it from `AGENTS.md` (e.g. "For localization PRs follow `skills/localize-pr/SKILL.md`"), or paste the body as the prompt.
- **CI:** `agentic-localize` strips the frontmatter of `skills/localize-pr/SKILL.md` and passes the body plus the changed-key list to `claude -p` / `codex exec` ([GITHUB_CI.md](GITHUB_CI.md)).

### Examples

```text
> Use i18n-prep on this repo; targets are de, ar, ja.
> Localize the keys changed on this branch (localize-pr).
> visual-qa failed on /checkout at 375px for de — run layout-remediation.
> Review the ja translations in context and fix what's flagged (qe-review).
> Send the flagged German strings to our TMS; later import reviewed/de.xliff (tms-roundtrip).
> Push our German strings to Crowdin for review, and pull back what's approved (crowdin-sync).
```

## Rules shared by all skills

- Writes to target catalogs go through `apply` or `tms_import` — all validated. Never hand-edit locale files.
- `INCONCLUSIVE` is never reported as `PASS`; `unreviewed` is never reported as `ok`.
- Agents never set `human-reviewed` provenance, edit `qe-verdicts.json`, or recapture the visual baseline to silence a regression.
