#!/usr/bin/env node
/**
 * Behavioural trial (NOT publishable evidence): does an agent following localize-pr use Context
 * Notes, Character Limits and Open Questions well?
 *
 *   node eval/poc/trial.mjs setup    # copy nextjs-commerce → eval/work/poc-trial/project, seed, init (de)
 *   node eval/poc/trial.mjs grade    # inspect .wraith state after the agent ran
 *
 * Seeds: 3 strings whose sense the code cannot settle (should be asked), 2 declared limits that
 * force shortening. The app's 20 built-in ambiguous strings ARE resolvable from code (should not be asked).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = path.join(REPO, "eval/work/poc-trial");
const PROJECT = path.join(WORK, "project");
const wraith = await import(path.join(REPO, "dist/index.js"));

const SEEDED = {
  "extras.coverLabel": "Cover",
  "extras.leadLabel": "Lead",
  "extras.dropLabel": "Drop",
};
const DECLARED = { "tight.btnRefund": 14, "tight.tabSettings": 10 };
const EXTRAS_TSX = `import { useTranslations } from "next-intl";

export function CatalogExtras({ item }) {
  const t = useTranslations("extras");
  return (
    <div className="extras">
      <span className="tag">{t("coverLabel")}</span>
      <span className="col">{t("leadLabel")}</span>
      <span className="badge">{t("dropLabel")}</span>
      <span>{item.name}</span>
    </div>
  );
}
`;

function setup() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.cpSync(path.join(REPO, "eval/synthetic/nextjs-commerce"), PROJECT, { recursive: true, filter: (p) => !p.endsWith("challenge-labels.json") });
  const enPath = path.join(PROJECT, "messages/en.json");
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  en.extras = Object.fromEntries(Object.entries(SEEDED).map(([k, v]) => [k.split(".")[1], v]));
  fs.writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n");
  fs.writeFileSync(path.join(PROJECT, "src/components/CatalogExtras.tsx"), EXTRAS_TSX);
  fs.writeFileSync(path.join(PROJECT, "messages/de.json"), "{}\n");
  wraith.initProject({ rootDir: PROJECT, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
  const store = new wraith.WraithStore(PROJECT);
  store.writeConfig({ ...store.readConfig(), charLimits: DECLARED });
  fs.writeFileSync(path.join(WORK, "trial-key.json"), JSON.stringify({ seeded: SEEDED, declared: DECLARED }, null, 2));
  fs.writeFileSync(
    path.join(WORK, "mcp.json"),
    JSON.stringify({ mcpServers: { wraith: { command: "node", args: [path.join(REPO, "dist/bin.js"), "mcp"] } } })
  );
  console.log(`project: ${PROJECT}`);
}

function grade() {
  const key = JSON.parse(fs.readFileSync(path.join(WORK, "trial-key.json"), "utf8"));
  const de = JSON.parse(fs.readFileSync(path.join(PROJECT, "messages/de.json"), "utf8"));
  const flat = (o, p = "", out = {}) => {
    for (const [k, v] of Object.entries(o)) typeof v === "object" ? flat(v, p ? `${p}.${k}` : k, out) : (out[p ? `${p}.${k}` : k] = v);
    return out;
  };
  const deFlat = flat(de);
  const qs = wraith.listQuestions(PROJECT, "all");
  const asked = new Set(qs.flatMap((q) => q.keys));
  const notes = wraith.readContextNotes(PROJECT).notes;
  const enFlat = flat(JSON.parse(fs.readFileSync(path.join(PROJECT, "messages/en.json"), "utf8")));
  const check = wraith.runCheck({ rootDir: PROJECT, locale: "de", limit: 500 });
  const qe = wraith.summarizeQe({ rootDir: PROJECT, locales: ["de"] });
  const out = {
    translated: `${Object.keys(deFlat).length}/${Object.keys(enFlat).length}`,
    checkOutcome: check.outcome,
    countsByCode: check.countsByCode,
    questions: qs.map((q) => ({ id: q.id, keys: q.keys, status: q.status, question: q.question, answer: q.answer })),
    seededAsked: Object.keys(key.seeded).filter((k) => asked.has(k)),
    unseededAsked: [...asked].filter((k) => !(k in key.seeded)),
    declaredLimits: Object.entries(key.declared).map(([k, max]) => ({ key: k, max, target: deFlat[k], chars: deFlat[k] ? [...deFlat[k]].length : null })),
    notes: { written: Object.keys(notes).length, missing: Object.keys(enFlat).filter((k) => !notes[k]) },
    qe: qe.summary,
    flagged: qe.flagged,
    assumptions: new wraith.WraithStore(PROJECT).readAssumptions().assumptions.map((a) => `${a.category}${a.locale ? `/${a.locale}` : ""}: ${a.summary}`),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "grade") grade();
else console.error("usage: trial.mjs setup|grade");
