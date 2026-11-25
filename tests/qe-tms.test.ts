import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { runCheck } from "../src/core/check.js";
import { importGlossaryTbx, importMemoryTmx } from "../src/core/importers.js";
import { initProject } from "../src/core/init.js";
import {
  computeBudgetUtilization,
  computeNovelty,
  computeRiskScore,
  computeSwarmScore,
  CriticRequest,
  QeModelClient,
  readQeReport,
  routeRisk,
  runQe,
} from "../src/core/qe.js";
import { scanDirectionalAssetsInText } from "../src/core/static-layout.js";
import { WraithStore } from "../src/core/store.js";
import { findTmMatches, readTm, upsertTmEntries } from "../src/core/tm.js";
import { fromXliffInline, parseXliff2, runTmsExport, runTmsImport, toXliffInline } from "../src/core/tms.js";

ensureBootstrapped();

function makeProject(files: Record<string, string>, targets = ["de"]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-v2-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  initProject({ rootDir: dir, sourceLocale: "en", targetLocales: targets, writeAgentRule: false });
  return dir;
}

const PKG = JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } });
const PANEL = `import { useTranslations } from "next-intl";
export function Panel() {
  const t = useTranslations();
  return (
    <div>
      <button>{t("btnSave")}</button>
      <p>{t("greeting", { name: "x" })}</p>
      <span>{t("items", { count: 2 })}</span>
      <p>{t("rich")}</p>
    </div>
  );
}
`;

function qeProject(): string {
  return makeProject({
    "package.json": PKG,
    "messages/en.json": JSON.stringify(
      {
        btnSave: "Save",
        greeting: "Hello {name}, welcome back",
        items: "{count, plural, one {# item} other {# items}}",
        rich: "Read the <b>terms</b> now",
      },
      null,
      2
    ),
    "messages/de.json": JSON.stringify(
      {
        btnSave: "Speichern",
        greeting: "Hallo {name}, willkommen zurück",
        items: "{count, plural, one {# Element} other {# Elemente}}",
        rich: "Lies die <b>Bedingungen</b> jetzt",
      },
      null,
      2
    ),
    "src/Panel.tsx": PANEL,
  });
}

function mockClient(findingsByCritic: Partial<Record<CriticRequest["critic"], Record<string, { severity: "none" | "minor" | "major" | "critical"; score: number; issue?: string; suggestedFix?: string }>>>, repairTo?: Record<string, string>): QeModelClient & { calls: CriticRequest[] } {
  const calls: CriticRequest[] = [];
  return {
    model: "mock-model",
    calls,
    async runCritic(req) {
      calls.push(req);
      return req.items.map((it) => {
        const key = String(it.key);
        const f = findingsByCritic[req.critic]?.[key];
        return f ? { key, severity: f.severity, score: f.score, issue: f.issue ?? "", suggestedFix: f.suggestedFix } : { key, severity: "none" as const, score: 0, issue: "" };
      });
    },
    async repair(req) {
      return repairTo?.[req.key];
    },
  };
}

describe("directional_asset static rule", () => {
  it("flags unmirrored directional icons/assets and accepts rtl mirroring or logical swaps", () => {
    const src = `import { ChevronRight, ArrowLeft } from "lucide-react";
export function Nav({ isRtl }) {
  return (
    <nav>
      <ChevronRight className="h-4 w-4" />
      <ArrowLeft className="h-4 w-4 rtl:-scale-x-100" />
      <img src="/icons/back-arrow.svg" alt="" />
      <img src="/icons/next-arrow.svg" className="rtl:rotate-180" alt="" />
      {isRtl ? <ChevronLeft /> : <ChevronRight />}
      <CaretLeftIcon
        size={12}
      />
    </nav>
  );
}`;
    const findings = scanDirectionalAssetsInText(src, "src/Nav.tsx");
    const assets = findings.map((f) => `${f.asset}@${f.line}`);
    expect(assets).toContain("ChevronRight@5");
    expect(assets).toContain("back-arrow@7");
    expect(assets).toContain("CaretLeftIcon@10");
    expect(assets.some((a) => a.startsWith("ArrowLeft"))).toBe(false);
    expect(assets.some((a) => a.startsWith("next-arrow"))).toBe(false);
    expect(findings.some((f) => f.line === 9)).toBe(false); // logical swap via isRtl ternary
    expect(findings.some((f) => f.line === 1)).toBe(false); // import line ignored
  });

  it("emits directional_asset warnings in check only when an RTL target is configured (Vue/Svelte too)", () => {
    const files = {
      "package.json": PKG,
      "messages/en.json": JSON.stringify({ a: "Next" }),
      "messages/ar.json": JSON.stringify({ a: "التالي" }),
      "messages/de.json": JSON.stringify({ a: "Weiter" }),
      "src/Pager.tsx": `export const P = () => <button><ChevronRightIcon /></button>;\n`,
      "src/Back.vue": `<template>\n  <button><svg class="icon arrow-left"><use href="#arrow-left" /></svg></button>\n</template>\n`,
      "src/Next.svelte": `<button><img src="next-arrow.png" alt="" /></button>\n`,
    };
    const rtlDir = makeProject(files, ["ar"]);
    const ltrDir = makeProject(files, ["de"]);
    const rtl = runCheck({ rootDir: rtlDir, code: "directional_asset", limit: 100 });
    expect(rtl.countsByCode["directional_asset"]).toBeGreaterThanOrEqual(3);
    const filesFlagged = new Set(rtl.issues.items.map((i) => i.file));
    expect(filesFlagged.has("src/Pager.tsx")).toBe(true);
    expect(filesFlagged.has("src/Back.vue")).toBe(true);
    expect(filesFlagged.has("src/Next.svelte")).toBe(true);
    expect(rtl.issues.items.every((i) => i.severity === "warning")).toBe(true);
    const ltr = runCheck({ rootDir: ltrDir, limit: 100 });
    expect(ltr.countsByCode["directional_asset"] ?? 0).toBe(0);
  });
});

describe("QE — pure scoring math", () => {
  it("computes S_swarm, composite risk, budget utilization, novelty, and routing thresholds", () => {
    expect(computeSwarmScore([])).toBe(0);
    expect(computeSwarmScore([{ severity: "minor", score: 1 }, { severity: "major", score: 0.8 }])).toBeCloseTo(0.6, 5);
    expect(computeSwarmScore([{ severity: "critical", score: 1 }])).toBe(1);
    // 100 × (0.35·0 + 0.25·(1−1) + 0.2·0 + 0.2·0) = 0
    expect(computeRiskScore({ sSwarm: 0, tmSimilarity: 1, budgetUtilization: 0, novelty: 0 })).toBe(0);
    // 100 × (0.35·0.75 + 0.25·0.5 + 0.2·0.5 + 0.2·0.4) = 26.25+12.5+10+8 = 56.75 → 57
    expect(computeRiskScore({ sSwarm: 0.75, tmSimilarity: 0.5, budgetUtilization: 0.5, novelty: 0.4 })).toBe(57);
    expect(computeRiskScore({ sSwarm: 1, tmSimilarity: 0, budgetUtilization: 1, novelty: 1 })).toBe(100);
    expect(routeRisk(24, false)).toBe("verified");
    expect(routeRisk(25, false)).toBe("needs_review");
    expect(routeRisk(25, true)).toBe("repair");
    expect(routeRisk(60, true)).toBe("repair");
    expect(routeRisk(61, true)).toBe("needs_review");
    expect(computeBudgetUtilization("Speichern", undefined)).toEqual({ utilization: 0, raw: 0 });
    const over = computeBudgetUtilization("Einstellungen speichern", { budgetChars: 10, maxWidthPx: 60 });
    expect(over.utilization).toBe(1);
    expect(over.raw).toBeGreaterThan(1);
    expect(computeNovelty({ source: "Save", hasUsageContext: true, tmSimilarity: 0 })).toBe(0);
    expect(computeNovelty({ source: "{n, plural, one {#} other {#}} <b>x</b>", hasUsageContext: false, tmSimilarity: 0 })).toBe(1);
    expect(computeNovelty({ source: "{n, plural, one {#} other {#}}", hasUsageContext: true, tmSimilarity: 0.9 })).toBe(0);
  });
});

describe("QE — tiered pipeline with mocked swarm", () => {
  it("Tier 1 escalates hard failures with risk 100 and no LLM calls for that segment; Tier 2 batches by file; Tier 3 routes", async () => {
    const dir = qeProject();
    // Break a placeholder in de -> Tier 1 hard failure
    const deFile = path.join(dir, "messages/de.json");
    const de = JSON.parse(fs.readFileSync(deFile, "utf8"));
    de.greeting = "Hallo, willkommen zurück";
    fs.writeFileSync(deFile, JSON.stringify(de, null, 2));
    // Seed a close TM neighbor for btnSave so TM_sim is high
    upsertTmEntries(dir, [
      { source: "Save", target: "Speichern", sourceLocale: "en", targetLocale: "de", provenance: "human-reviewed", key: "other.save", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const client = mockClient({
      semantic: { rich: { severity: "critical", score: 1, issue: "Dropped meaning" } },
      terminology: { items: { severity: "minor", score: 0.5, issue: "Prefer 'Eintrag'" } },
    });
    const res = await runQe({ rootDir: dir, locales: ["de"], client });
    const report = readQeReport(dir)!;
    expect(report.tier2).toBe("ran");
    const byKey = Object.fromEntries(report.segments.map((s) => [s.key, s]));
    expect(byKey.greeting.riskScore).toBe(100);
    expect(byKey.greeting.tier).toBe("tier1_escalate");
    expect(byKey.greeting.status).toBe("needs_review");
    // greeting must not have been sent to any critic
    for (const c of client.calls) expect(c.items.some((i) => i.key === "greeting")).toBe(false);
    // 3 critics × 1 batch (all segments share src/Panel.tsx)
    expect(client.calls.length).toBe(3);
    expect(new Set(client.calls.map((c) => c.critic))).toEqual(new Set(["terminology", "ui_context", "semantic"]));
    expect(client.calls.every((c) => c.items.length <= 25)).toBe(true);
    const ui = client.calls.find((c) => c.critic === "ui_context")!;
    expect(ui.items.find((i) => i.key === "btnSave")?.astElementType).toBe("Button");
    // btnSave: clean swarm + TM 1.0 + context → verified
    expect(byKey.btnSave.status).toBe("verified");
    expect(byKey.btnSave.riskScore).toBeLessThan(25);
    expect(byKey.btnSave.tmSimilarity).toBe(1);
    // rich: critical semantic issue → needs_review
    expect(byKey.rich.status).toBe("needs_review");
    expect(byKey.rich.riskScore).toBeGreaterThan(25);
    expect(res.outcome).toBe("FAIL");
    expect(res.summary.tier1Escalations).toBe(1);
  });

  it("auto-repair runs exactly one targeted pass through validated apply and re-scores", async () => {
    const dir = qeProject();
    let phase = 0;
    const calls: CriticRequest[] = [];
    const client: QeModelClient = {
      model: "mock",
      async runCritic(req) {
        calls.push(req);
        return req.items.map((it) => {
          const key = String(it.key);
          if (phase === 0 && key === "btnSave" && req.critic === "ui_context") {
            return { key, severity: "major" as const, score: 0.8, issue: "Infinitive form; use imperative", suggestedFix: "Sichern" };
          }
          return { key, severity: "none" as const, score: 0, issue: "" };
        });
      },
      async repair(req) {
        phase = 1;
        expect(req.issues[0].issue).toContain("imperative");
        return "Sichern";
      },
    };
    const res = await runQe({ rootDir: dir, locales: ["de"], client, autoRepair: true, keys: ["btnSave"] });
    const seg = readQeReport(dir)!.segments.find((s) => s.key === "btnSave")!;
    expect(seg.repaired).toBe(true);
    expect(seg.target).toBe("Sichern");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8")).btnSave).toBe("Sichern");
    expect(["verified", "needs_review"]).toContain(seg.status);
    expect(res.summary.llmCalls).toBe(3 + 1 + 3);
  });

  it("without a model key Tier 2 is skipped and nothing is marked verified (fail-closed)", async () => {
    const dir = qeProject();
    const res = await runQe({ rootDir: dir, locales: ["de"], client: null });
    expect(res.tier2).toBe("unavailable");
    expect(res.summary.verified).toBe(0);
    expect(res.summary.unscored).toBe(4);
    expect(res.outcome).toBe("INCONCLUSIVE");
    expect(res.summary.llmCalls).toBe(0);
  });
});

describe("TMS round-trip — XLIFF 2.0 / TMX 1.4b / TBX-Basic", () => {
  it("encodes placeholders/tags as <ph disp/>, keeps ICU literal, and decodes losslessly", () => {
    const ids = new Map<string, string>();
    const src = toXliffInline("Hello {name}, read <b>terms</b> & {{count}} %s", ids);
    expect(src).toContain('<ph id="ph1" disp="{name}"/>');
    expect(src).toContain('disp="&lt;b&gt;"');
    expect(src).toContain("&amp;");
    expect(fromXliffInline(src)).toBe("Hello {name}, read <b>terms</b> & {{count}} %s");
    const icu = "{count, plural, one {# <b>item</b>} other {# items}}";
    const enc = toXliffInline(icu, new Map());
    expect(enc).not.toContain("<ph");
    expect(fromXliffInline(enc)).toBe(icu);
  });

  it("exports XLIFF with metadata/notes, TMX and TBX that re-import cleanly; import applies human edits with precedence", async () => {
    const dir = qeProject();
    const store = new WraithStore(dir);
    // Direct glossary upsert (no propagation → btnSave is not glossary_flagged in Tier 1)
    store.upsertGlossaryEntry({ term: "Save", translations: { de: "Speichern" }, abbreviations: { de: "Spch." }, origin: "user" });
    store.setLayoutBudget("btnSave", "de", { maxWidthPx: 80, budgetChars: 12, element: "button", updatedAt: "2026-01-01T00:00:00Z" });
    // Human TM neighbors (other keys) for every segment so only the semantic flag drives escalation
    upsertTmEntries(dir, [
      { source: "Save", target: "Speichern", sourceLocale: "en", targetLocale: "de", key: "seed.save", provenance: "human-reviewed", updatedAt: "2026-01-01T00:00:00Z" },
      { source: "Hello {name}, welcome back", target: "Hallo {name}, willkommen zurück", sourceLocale: "en", targetLocale: "de", key: "seed.greeting", provenance: "human-reviewed", updatedAt: "2026-01-01T00:00:00Z" },
      { source: "{count, plural, one {# item} other {# items}}", target: "{count, plural, one {# Element} other {# Elemente}}", sourceLocale: "en", targetLocale: "de", key: "seed.items", provenance: "human-reviewed", updatedAt: "2026-01-01T00:00:00Z" },
      { source: "Read the <b>terms</b> now", target: "Lies die <b>Bedingungen</b> jetzt", sourceLocale: "en", targetLocale: "de", key: "seed.rich", provenance: "human-reviewed", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    // QE report with one flagged segment
    const client = mockClient({ semantic: { rich: { severity: "critical", score: 1, issue: "Dropped 'now'" } } });
    await runQe({ rootDir: dir, locales: ["de"], client });

    const all = runTmsExport({ rootDir: dir, outDir: "out/all", includeTm: true, includeGlossary: true, bundleScreenshots: true });
    expect(all.unitsByLocale.de).toBe(4);
    const xml = fs.readFileSync(path.join(dir, "out/all/de.xliff"), "utf8");
    expect(xml).toContain('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0"');
    expect(xml).toContain('version="2.0" srcLang="en" trgLang="de"');
    expect(xml).toContain('<unit id="btnSave">');
    expect(xml).toContain('<mda:meta type="file">src/Panel.tsx</mda:meta>');
    expect(xml).toContain('<mda:meta type="max_chars">12</mda:meta>');
    expect(xml).toContain('<mda:meta type="max_width_px">80</mda:meta>');
    expect(xml).toMatch(/<mda:meta type="qe_risk_score">\d+<\/mda:meta>/);
    expect(xml).toContain("[semantic/critical] Dropped &apos;now&apos;");
    expect(xml).toContain('<segment state="translated">');
    expect(xml).toContain('<ph id="ph1" disp="{name}"/>');
    expect(xml).toContain("<mda:meta type=\"component\">Panel</mda:meta>");
    expect(fs.existsSync(path.join(dir, "out/all/screenshots/manifest.json"))).toBe(true);

    const flagged = runTmsExport({ rootDir: dir, outDir: "out/flagged", onlyFlagged: true });
    expect(flagged.unitsByLocale.de).toBe(1);
    const parsed = parseXliff2(fs.readFileSync(path.join(dir, "out/flagged/de.xliff"), "utf8"));
    expect(parsed.trgLang).toBe("de");
    expect(parsed.units.map((u) => u.key)).toEqual(["rich"]);

    // TMX / TBX re-import into a fresh project via existing importers
    const fresh = qeProject();
    fs.copyFileSync(path.join(dir, "out/all/tm.tmx"), path.join(fresh, "tm.tmx"));
    fs.copyFileSync(path.join(dir, "out/all/glossary.tbx"), path.join(fresh, "glossary.tbx"));
    const tmxRes = importMemoryTmx(fresh, "tm.tmx");
    expect(tmxRes.memoryImported).toBeGreaterThan(0);
    const tbxRes = importGlossaryTbx(fresh, "glossary.tbx");
    expect(tbxRes.glossaryImported).toBe(1);
    expect(new WraithStore(fresh).readGlossary().entries[0].translations.de).toBe("Speichern");
    const tmxText = fs.readFileSync(path.join(dir, "out/all/tm.tmx"), "utf8");
    expect(tmxText).toContain('<tmx version="1.4">');
    expect(tmxText).toContain('<header creationtool="wraith"');
    const tbxText = fs.readFileSync(path.join(dir, "out/all/glossary.tbx"), "utf8");
    expect(tbxText).toContain('<martif type="TBX-Basic"');
    expect(tbxText).toContain("Spch.");

    // Simulate linguist post-edit in the TMS: change target, mark reviewed; break one placeholder
    let edited = fs.readFileSync(path.join(dir, "out/all/de.xliff"), "utf8");
    edited = edited.replace("Lies die <ph id=\"ph1\" disp=\"&lt;b&gt;\"/>Bedingungen<ph id=\"ph2\" disp=\"&lt;/b&gt;\"/> jetzt", "Lies jetzt die <ph id=\"ph1\" disp=\"&lt;b&gt;\"/>Bedingungen<ph id=\"ph2\" disp=\"&lt;/b&gt;\"/>");
    edited = edited.replace(/(<unit id="rich">[\s\S]*?<segment state=")translated/, "$1reviewed");
    edited = edited.replace('Hallo <ph id="ph1" disp="{name}"/>, willkommen zurück', "Hallo, willkommen zurück");
    fs.mkdirSync(path.join(dir, "in"), { recursive: true });
    fs.writeFileSync(path.join(dir, "in/de.xliff"), edited);
    const enBefore = fs.readFileSync(path.join(dir, "messages/en.json"), "utf8");

    const imp = await runTmsImport({ rootDir: dir, input: "in" });
    expect(imp.applied).toBe(1);
    expect(imp.rejected.map((r) => r.key)).toEqual(["greeting"]); // placeholder dropped → rejected by apply validation
    expect(imp.diff).toEqual([{ key: "rich", locale: "de", before: "Lies die <b>Bedingungen</b> jetzt", after: "Lies jetzt die <b>Bedingungen</b>", state: "reviewed" }]);
    const deAfter = JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8"));
    expect(deAfter.rich).toBe("Lies jetzt die <b>Bedingungen</b>");
    expect(deAfter.greeting).toBe("Hallo {name}, willkommen zurück");
    expect(Object.keys(deAfter)).toEqual(["btnSave", "greeting", "items", "rich"]); // key order preserved
    expect(fs.readFileSync(path.join(dir, "messages/en.json"), "utf8")).toBe(enBefore);
    expect(imp.check?.outcome).toBeDefined();

    const tm = readTm(dir).entries.find((e) => e.key === "rich")!;
    expect(tm.provenance).toBe("human-reviewed");
    expect(tm.verifiedAt).toBeTruthy();
    const qe = readQeReport(dir)!;
    expect(qe.segments.find((s) => s.key === "rich")!.status).toBe("human-verified");
    expect(qe.summary.humanVerified).toBeGreaterThanOrEqual(1);
  });

  it("human-reviewed TM entries outrank llm-generated ones in fuzzy retrieval and are never overwritten by them", () => {
    const dir = qeProject();
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "btnSave", value: "Speichern" }] });
    upsertTmEntries(dir, [
      { source: "Save changes", target: "Änderungen speichern (LLM)", sourceLocale: "en", targetLocale: "de", key: "k1", provenance: "llm-generated", updatedAt: "2026-02-01T00:00:00Z" },
      { source: "Save changes", target: "Änderungen sichern", sourceLocale: "en", targetLocale: "de", key: "k2", provenance: "human-reviewed", verifiedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    const top = findTmMatches(dir, "Save changes", "de", { limit: 2 });
    expect(top[0].provenance).toBe("human-reviewed");
    expect(top[0].target).toBe("Änderungen sichern");
    upsertTmEntries(dir, [{ source: "Save changes", target: "overwrite attempt", sourceLocale: "en", targetLocale: "de", key: "k2", provenance: "llm-generated", updatedAt: "2026-03-01T00:00:00Z" }]);
    expect(readTm(dir).entries.find((e) => e.key === "k2")!.target).toBe("Änderungen sichern");
  });
});
