#!/usr/bin/env node
/**
 * Proof-of-concept (NOT publishable evidence): does fuzzy-TM context improve cross-file consistency?
 * Arms Anotm vs Afull from Stage 4, synthetic-app, de, chunk c0 (60 items), one blind agent run each.
 * Outputs expected at eval/work/poc-tm/{Anotm,Afull}-de-c0.out.json.
 *
 * Afull's TM is seeded with gold for ~40% of recurring groups, so accuracy on seeded items is
 * partly answer-copying; we report seeded and unseeded items separately. TCR (consistency) is the
 * headline: unseeded groups show whether TM-guided reuse generalises beyond copying gold.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeTmMetrics } from "../lib/tm-metrics.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ds = JSON.parse(fs.readFileSync(path.join(REPO, "eval/work/tm-ablation/dataset.json"), "utf8"));
const prompt = fs.readFileSync(path.join(REPO, "eval/work/tm-ablation/synthetic-app/prompts/Anotm-de-c0.txt"), "utf8");
const ids = new Set([...prompt.matchAll(/^- id: "([^"]+)"/gm)].map((m) => m[1]));
const items = ds.slices.find((s) => s.id === "synthetic-app").items.filter((i) => ids.has(i.id));

const out = { generatedAt: new Date().toISOString(), kind: "proof-of-concept", caveat: "60 items, de only, 1 run per arm; Afull TM contains gold for seeded groups.", n: items.length, arms: {} };
for (const arm of ["Anotm", "Afull"]) {
  const hyp = JSON.parse(fs.readFileSync(path.join(REPO, `eval/work/poc-tm/${arm}-de-c0.out.json`), "utf8"));
  const rows = items.map((i) => ({ groupId: i.groupId, source: i.source, hyp: hyp[i.id] ?? "", gold: i.gold, locale: i.locale, seeded: i.tmSeeded }));
  out.arms[arm] = {
    missing: rows.filter((r) => !r.hyp).length,
    all: computeTmMetrics(rows),
    seeded: computeTmMetrics(rows.filter((r) => r.seeded)),
    unseeded: computeTmMetrics(rows.filter((r) => !r.seeded)),
    inconsistentGroups: Object.entries(Object.groupBy(rows, (r) => r.source))
      .map(([src, rs]) => ({ src, variants: [...new Set(rs.map((r) => r.hyp))] }))
      .filter((g) => g.variants.length > 1),
  };
}
fs.writeFileSync(path.join(REPO, "eval/results/poc-tm.json"), JSON.stringify(out, null, 2) + "\n");
for (const [arm, r] of Object.entries(out.arms)) {
  console.log(`${arm}: all ${JSON.stringify(r.all)}\n  seeded ${JSON.stringify(r.seeded)}\n  unseeded ${JSON.stringify(r.unseeded)}\n  inconsistent: ${JSON.stringify(r.inconsistentGroups)}`);
}
