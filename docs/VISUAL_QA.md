# Visual QA

`wraith visual-qa` is a deterministic visual regression gate for localized UI. It renders routes with Playwright, records per-element geometry for every translatable element, and diffs against a committed baseline. **0 LLM tokens, no VLM screenshot judging.**

## How it differs from `wraith layout`

| | `layout` | `visual-qa` |
|---|---|---|
| Question | "Is this locale broken right now?" (absolute) | "Did this change make it worse?" (relative to baseline) |
| Input | live render | live render + `.wraith/visual-baseline.json` |
| Output | findings + width budgets in `layout.json` | regressions + failure-only screenshots |
| Use | local remediation | PR gate |

## Usage

```bash
# Capture/refresh the baseline (on main, or locally after an approved change)
wraith visual-qa --capture-baseline --url http://localhost:3000

# Compare (PR gate)
wraith visual-qa --base .wraith/visual-baseline.json --url http://localhost:3000 \
  [--routes /,/settings] [--locales en-XA,ar-XB,de] [--locale-pattern query|prefix|cookie] [--json]
```

Defaults: baseline `.wraith/visual-baseline.json`; routes, viewports, and locale pattern come from `config.json` → `layout`. MCP tool: `visual_qa` (`readOnlyHint: true`).

Exit codes: `0` PASS · `1` FAIL (≥1 regression) · `2` INCONCLUSIVE (no Playwright, server unreachable, or baseline missing).

## Element mapping

Pseudo strings carry invisible zero-width key IDs (`wraith pseudo`), and usage sites in `usage.json` map keys to `file:line`. Each measured element therefore resolves to a catalog `key`, `file`, and `line`.

## Baseline format

```json
{
  "version": 1,
  "capturedAt": "2026-11-25T17:00:00.000Z",
  "baseUrl": "http://localhost:3000",
  "snapshots": {
    "/settings|375x812|de": [
      {
        "key": "settings.save", "file": "src/app/settings/page.tsx", "line": 42, "tag": "button",
        "width": 96, "height": 36, "lineCount": 1,
        "scrollWidth": 96, "clientWidth": 96, "overflowX": 0,
        "clipped": false, "occluded": false, "fontLoaded": true, "contrastRatio": 7.1
      }
    ]
  }
}
```

Snapshot key: `"<route>|<WxH>|<locale>"`.

## Regression rules

| Rule | Fires when (curr vs base) |
|---|---|
| `line_wrap_regression` | `curr.lineCount > base.lineCount` |
| `container_blowout` | `curr.height > base.height × 1.15` **or** `curr.overflowX > 1` |
| `text_truncation` | `curr.clipped` **or** `curr.scrollWidth > curr.clientWidth + 1` |
| `element_occlusion` | `elementFromPoint` at the element's center hits an unrelated element |
| `missing_glyph_tofu` | `curr.fontLoaded === false` |
| `contrast_regression` | `curr.contrastRatio < 4.5` **and** `< base.contrastRatio − 0.5` |

## Artifacts (failure only)

`.wraith/artifacts/visual-qa/<locale>/<key>-<WxH>.png` plus `manifest.json` listing rule, key, file, line, route, viewport, and measured values. CI uploads `.wraith/artifacts/` on failure.

## Baseline policy

- Baseline changes are code changes: capture on `main` (the `update-baseline` CI job uploads it as an artifact) and commit it via a reviewed PR.
- Never recapture to silence a regression. Fix it with the `layout-remediation` skill, or recapture only when the new geometry is intended.

## Limits

- Requires Playwright (optional peer dependency) and a reachable server; otherwise `INCONCLUSIVE`.
- Geometry-only: it will not notice a wrong but well-fitting translation (that is `check`/`qe`'s job) or pure color/image changes outside text elements.
- Font rendering differs across OSes; capture and compare on the same runner image.
