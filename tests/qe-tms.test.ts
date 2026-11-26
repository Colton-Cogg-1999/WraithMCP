import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { ensureBootstrapped } from "../src/core/bootstrap.js";
import { runCheck } from "../src/core/check.js";
import { importGlossaryTbx, importMemoryTmx } from "../src/core/importers.js";
import { initProject } from "../src/core/init.js";
import { prepareQeReview, qeIndex, submitQeVerdicts, summarizeQe } from "../src/core/qe.js";
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

describe("QE — binary review in code context", () => {
  it("prepares one task per file with same-source facts, skips check errors, and pins verdicts to the exact text", () => {
    const dir = qeProject();
    // A second component reuses "Save" with a different translation → reviewer must see it
    fs.writeFileSync(path.join(dir, "src/Toolbar.tsx"), `import { useTranslations } from "next-intl";\nexport function Toolbar() {\n  const t = useTranslations();\n  return <button>{t("toolbarSave")}</button>;\n}\n`);
    const en = JSON.parse(fs.readFileSync(path.join(dir, "messages/en.json"), "utf8"));
    const de = JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8"));
    en.toolbarSave = "Save";
    de.toolbarSave = "Sparen";
    de.greeting = "Hallo, willkommen zurück"; // placeholder dropped → check error → not sent for review
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify(en, null, 2));
    fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify(de, null, 2));

    const prep = prepareQeReview({ rootDir: dir, locales: ["de"] });
    expect(prep.instructions).toContain("fresh context");
    expect(prep.blockedByCheck.map((b) => b.key)).toEqual(["greeting"]);
    expect(prep.tasks.map((t) => t.file).sort()).toEqual(["src/Panel.tsx", "src/Toolbar.tsx"]);
    expect(prep.toReview).toBe(4);
    const toolbar = prep.tasks.find((t) => t.file === "src/Toolbar.tsx")!.strings[0];
    expect(toolbar.sameSourceElsewhere).toEqual([{ key: "btnSave", target: "Speichern", file: "src/Panel.tsx" }]);
    expect(fs.existsSync(path.join(dir, ".wraith/qe-tasks.json"))).toBe(true);
    expect(summarizeQe({ rootDir: dir, locales: ["de"] }).outcome).toBe("INCONCLUSIVE");

    const sub = submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "btnSave", verdict: "ok" },
        { locale: "de", key: "items", verdict: "ok" },
        { locale: "de", key: "rich", verdict: "ok" },
        { locale: "de", key: "toolbarSave", verdict: "flag", reason: "'Sparen' means saving money; this button saves the document", suggestedFix: "Speichern" },
        { locale: "de", key: "items", verdict: "flag" }, // flag without reason → rejected
        { locale: "de", key: "nope", verdict: "ok" }, // unknown key → rejected
      ],
    });
    expect(sub.accepted).toBe(4);
    expect(sub.rejected.map((r) => r.key).sort()).toEqual(["items", "nope"]);
    const status = summarizeQe({ rootDir: dir, locales: ["de"] });
    expect(status.outcome).toBe("FAIL");
    expect(status.summary).toMatchObject({ ok: 3, flagged: 1, unreviewed: 1 });
    expect(status.flagged[0]).toMatchObject({ key: "toolbarSave", suggestedFix: "Speichern" });

    // Second run reviews only what changed: fixing the flagged string resets just that one
    de.toolbarSave = "Speichern";
    fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify(de, null, 2));
    const again = prepareQeReview({ rootDir: dir, locales: ["de"], write: false });
    expect(again.tasks.flatMap((t) => t.strings.map((x) => x.key))).toEqual(["toolbarSave"]);
    expect(again.alreadyReviewed).toBe(3);
    expect(qeIndex(dir).get("de\0toolbarSave")?.verdict).toBe("flag"); // stale record kept, but no longer current
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
    // One string flagged in review, the rest ok
    submitQeVerdicts({
      rootDir: dir,
      verdicts: [
        { locale: "de", key: "btnSave", verdict: "ok" },
        { locale: "de", key: "greeting", verdict: "ok" },
        { locale: "de", key: "items", verdict: "ok" },
        { locale: "de", key: "rich", verdict: "flag", reason: "Dropped 'now'" },
      ],
    });

    const all = runTmsExport({ rootDir: dir, outDir: "out/all", includeTm: true, includeGlossary: true, bundleScreenshots: true });
    expect(all.unitsByLocale.de).toBe(4);
    const xml = fs.readFileSync(path.join(dir, "out/all/de.xliff"), "utf8");
    expect(xml).toContain('<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0"');
    expect(xml).toContain('version="2.0" srcLang="en" trgLang="de"');
    expect(xml).toContain('<unit id="btnSave">');
    expect(xml).toContain('<mda:meta type="file">src/Panel.tsx</mda:meta>');
    expect(xml).toContain('<mda:meta type="max_chars">12</mda:meta>');
    expect(xml).toContain('<mda:meta type="max_width_px">80</mda:meta>');
    expect(xml).toContain('<mda:meta type="qe_status">flagged</mda:meta>');
    expect(xml).not.toContain("qe_risk_score");
    expect(xml).toContain("Flagged in review: Dropped &apos;now&apos;");
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
    const qe = summarizeQe({ rootDir: dir, locales: ["de"] });
    expect(qe.summary.humanVerified).toBeGreaterThanOrEqual(1);
    expect(qeIndex(dir).get("de\0rich")?.verdict).toBe("human-verified");
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
