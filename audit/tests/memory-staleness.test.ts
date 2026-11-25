import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyTranslations,
  importAsset,
  lexicalSimilarity,
  lookupMemory,
  PolyglotStore,
  prepareBatch,
  recordGlossaryTerm,
  runCheck,
  scanProject,
} from "../../src/index.js";
import { init, nextIntlPkg, project, writeFiles } from "../helpers.js";

function nextApp(en: Record<string, unknown>, extra: Record<string, string> = {}) {
  const dir = project({
    "package.json": nextIntlPkg,
    "messages/en.json": JSON.stringify(en, null, 2) + "\n",
    ...extra,
  });
  init(dir, ["de"]);
  return dir;
}

describe("L. Staleness & manual edits", () => {
  it("L1 source change after a MANUAL (non-apply) translation is detected as stale", () => {
    // Very common: translations exist before Polyglot is adopted, or a translator edits de.json directly.
    const dir = nextApp({ cta: "Start free trial" }, { "messages/de.json": JSON.stringify({ cta: "Kostenlos testen" }, null, 2) + "\n" });
    runCheck({ rootDir: dir }); // first run
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ cta: "Start your 30-day free trial" }, null, 2) + "\n");
    const res = runCheck({ rootDir: dir, code: "stale_source" });
    expect(res.issues.total).toBe(1);
  });

  it("L2 a manual edit of the target file after apply() is noticed (record vs file divergence)", () => {
    const dir = nextApp({ cta: "Buy now" });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "cta", value: "Jetzt kaufen" }] });
    fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify({ cta: "Jetzt kaufen!!! {oops}" }, null, 2) + "\n");
    const store = new PolyglotStore(dir);
    const rec = store.readRecords().records.cta.de;
    const res = runCheck({ rootDir: dir });
    // The placeholder will be caught, but provenance must not still claim the agent's text:
    const memory = lookupMemory(dir, { query: "Buy now", targetLocale: "de" });
    console.log(`[L2] record.translation=${rec.translation}; memory suggests=${memory.fuzzyMatches.map((m) => m.target)}; check codes=${JSON.stringify(res.countsByCode)}`);
    expect(memory.fuzzyMatches.every((m) => m.target !== "Jetzt kaufen") || rec.translation !== "Jetzt kaufen").toBe(true);
  });

  it("L3 `import` (locales) must not silently clear staleness of an outdated translation", () => {
    const dir = nextApp({ cta: "Buy now" });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "cta", value: "Jetzt kaufen" }] });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ cta: "Buy now and save 20%" }, null, 2) + "\n");
    expect(runCheck({ rootDir: dir, code: "stale_source" }).issues.total).toBe(1);
    importAsset(dir, { format: "locales" });
    expect(runCheck({ rootDir: dir, code: "stale_source" }).issues.total).toBe(1);
  });

  it("L4 import(locales) must not downgrade an 'approved' human review status", () => {
    const dir = nextApp({ cta: "Buy now" });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "cta", value: "Jetzt kaufen" }], origin: "human" });
    const store = new PolyglotStore(dir);
    const f = store.readRecords();
    f.records.cta.de.reviewStatus = "approved";
    store.writeRecords(f);
    importAsset(dir, { format: "locales" });
    expect(store.readRecords().records.cta.de.reviewStatus).toBe("approved");
  });
});

describe("M. Context-change detection", () => {
  const comp = (label: string, wrapper: string) => `import { useTranslations } from "next-intl";
export function ${wrapper}() { const t = useTranslations(); return <div><button>{t("open")}</button><span>${label}</span></div>; }`;

  it("M1 apply() immediately after extraction (without a prior scan) still records a context fingerprint", () => {
    const dir = nextApp({ open: "Open" }, { "src/FileMenu.tsx": comp("File", "FileMenu") });
    // Agent extracts and applies straight away — the documented flow never requires `scan` between.
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "open", value: "Öffnen" }] });
    const rec = new PolyglotStore(dir).readRecords().records.open.de;
    expect(rec.contextFingerprint).not.toBe("");
  });

  it("M2 renaming a sibling label in the same component must not mark every key context_changed", () => {
    const dir = nextApp({ open: "Open" }, { "src/FileMenu.tsx": comp("File", "FileMenu") });
    scanProject({ rootDir: dir });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "open", value: "Öffnen" }] });
    writeFiles(dir, { "src/FileMenu.tsx": comp("Files", "FileMenu") }); // copy tweak "File" -> "Files"
    const res = runCheck({ rootDir: dir, code: "context_changed" });
    console.log(`[M2] context_changed after sibling copy tweak: ${res.issues.total}`);
    expect(res.issues.total).toBe(0);
  });

  it("M3 moving a file (pure refactor: same component, same element) does not trigger context_changed", () => {
    const dir = nextApp({ open: "Open" }, { "src/FileMenu.tsx": comp("File", "FileMenu") });
    scanProject({ rootDir: dir });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "open", value: "Öffnen" }] });
    fs.mkdirSync(path.join(dir, "src/menus"));
    fs.renameSync(path.join(dir, "src/FileMenu.tsx"), path.join(dir, "src/menus/FileMenu.tsx"));
    const res = runCheck({ rootDir: dir, code: "context_changed" });
    console.log(`[M3] context_changed after file move: ${res.issues.total}`);
    expect(res.issues.total).toBe(0);
  });

  it("M4 adding a SECOND usage of a key in a different component is surfaced as context change", () => {
    const dir = nextApp({ open: "Open" }, { "src/FileMenu.tsx": comp("File", "FileMenu") });
    scanProject({ rootDir: dir });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "open", value: "Öffnen" }] });
    writeFiles(dir, { "src/StoreHours.tsx": comp("Mon–Fri 9–5", "StoreHours") });
    expect(runCheck({ rootDir: dir, code: "context_changed" }).issues.total).toBe(1);
  });

  it("M5 check is read-only: running check must not rewrite .polyglot/usage.json", () => {
    const dir = nextApp({ open: "Open" }, { "src/FileMenu.tsx": comp("File", "FileMenu") });
    const p = path.join(dir, ".polyglot/usage.json");
    const before = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    runCheck({ rootDir: dir });
    const after = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    expect(after).toBe(before);
  });
});

describe("N. Translation memory matching", () => {
  it("N1 fuzzy: a one-word change in a 2-word UI string is still a usable match (>=50)", () => {
    expect(lexicalSimilarity("Save changes", "Save draft")).toBeGreaterThanOrEqual(50);
  });

  it("N2 fuzzy: placeholder-only difference scores high", () => {
    expect(lexicalSimilarity("Welcome back, {name}!", "Welcome back, {firstName}!")).toBeGreaterThanOrEqual(75);
  });

  it("N3 fuzzy: unrelated strings with the same function words score low", () => {
    expect(lexicalSimilarity("Delete the file", "Rename the folder")).toBeLessThan(50);
  });

  it("N4 TMX with uppercase / region language codes (EN-US, DE-DE) is usable for a 'de' project", () => {
    const dir = nextApp({ save: "Save changes" });
    writeFiles(dir, {
      "tm.tmx": `<?xml version="1.0"?><tmx version="1.4"><header srclang="EN-US" segtype="sentence" o-tmf="x" adminlang="en" datatype="plaintext" creationtool="t" creationtoolversion="1"/><body>
<tu><tuv xml:lang="EN-US"><seg>Save changes</seg></tuv><tuv xml:lang="DE-DE"><seg>Änderungen speichern</seg></tuv></tu></body></tmx>`,
    });
    importAsset(dir, { file: "tm.tmx" });
    const prep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    console.log(`[N4] memory entries=${JSON.stringify(new PolyglotStore(dir).readMemory().map((m) => `${m.sourceLocale}->${m.targetLocale}`))} matches=${prep.items[0]?.fuzzyMatches.length}`);
    expect(prep.items[0].fuzzyMatches.length).toBeGreaterThan(0);
  });

  it("N5 TMX inline markup (<bpt>/<ept>) is not leaked into memory text", () => {
    const dir = nextApp({ a: "x" });
    writeFiles(dir, {
      "tm.tmx": `<tmx version="1.4"><header srclang="en"/><body><tu><tuv xml:lang="en"><seg>Click <bpt i="1">&lt;b&gt;</bpt>here<ept i="1">&lt;/b&gt;</ept></seg></tuv><tuv xml:lang="de"><seg>Klicken Sie <bpt i="1">&lt;b&gt;</bpt>hier<ept i="1">&lt;/b&gt;</ept></seg></tuv></tu></body></tmx>`,
    });
    importAsset(dir, { file: "tm.tmx" });
    const mem = new PolyglotStore(dir).readMemory();
    console.log(`[N5] ${JSON.stringify(mem.map((m) => m.source))}`);
    expect(mem[0].source).toBe("Click here");
  });

  it("N6 a single corrupt line in memory.jsonl does not disable every tool", () => {
    const dir = nextApp({ a: "Save" });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Speichern" }] });
    fs.appendFileSync(path.join(dir, ".polyglot/memory.jsonl"), "{not json\n");
    expect(() => prepareBatch({ rootDir: dir, targetLocale: "de" })).not.toThrow();
  });

  it("N7 TMX with an out-of-range numeric entity does not crash import", () => {
    const dir = nextApp({ a: "x" });
    writeFiles(dir, { "bad.tmx": `<tmx><header srclang="en"/><body><tu><tuv xml:lang="en"><seg>A &#x110000; B</seg></tuv><tuv xml:lang="de"><seg>C</seg></tuv></tu></body></tmx>` });
    expect(() => importAsset(dir, { file: "bad.tmx" })).not.toThrow();
  });
});

describe("O. Glossary propagation & terminology", () => {
  it("O1 updating notes on a DNT brand term does not silently turn DNT off", () => {
    const dir = nextApp({ a: "Welcome to Acme Pulse" });
    recordGlossaryTerm(dir, { term: "Acme Pulse", doNotTranslate: true, caseSensitive: true });
    recordGlossaryTerm(dir, { term: "Acme Pulse", notes: "Product name" });
    const e = new PolyglotStore(dir).readGlossary().entries.find((x) => x.term === "Acme Pulse")!;
    expect(e.doNotTranslate).toBe(true);
    expect(e.caseSensitive).toBe(true);
  });

  it("O2 glossary propagation also flags keys translated outside apply() (no record)", () => {
    const dir = nextApp({ a: "New post", b: "Edit post" }, { "messages/de.json": JSON.stringify({ a: "Neuer Beitrag", b: "Beitrag bearbeiten" }) });
    const res = recordGlossaryTerm(dir, { term: "post", translations: { de: "Eintrag" } });
    console.log(`[O2] affected=${res.affectedKeys.length} flagged=${res.flaggedRecords}`);
    const check = runCheck({ rootDir: dir, skipScan: true, code: "glossary_inconsistency" });
    expect(res.flaggedRecords + check.issues.total).toBeGreaterThanOrEqual(2);
  });

  it("O3 glossary preferred term matches inflected forms without false 'inconsistency' (de plural)", () => {
    const dir = nextApp({ a: "Delete posts" }, { "messages/de.json": JSON.stringify({ a: "Beiträge löschen" }) });
    recordGlossaryTerm(dir, { term: "post", translations: { de: "Beitrag" } });
    const res = runCheck({ rootDir: dir, skipScan: true, code: "glossary_inconsistency" });
    console.log(`[O3] ${JSON.stringify(res.issues.items.map((i) => i.message))}`);
    expect(res.issues.total).toBe(0);
  });

  it("O4 a glossary decision is enforced by check() after it is made (flagged records surface as issues)", () => {
    const dir = nextApp({ a: "New post" });
    applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Neuer Post" }] });
    recordGlossaryTerm(dir, { term: "post", translations: { de: "Beitrag" } });
    const res = runCheck({ rootDir: dir, skipScan: true });
    console.log(`[O4] passed=${res.passed} codes=${JSON.stringify(res.countsByCode)}`);
    expect(res.passed).toBe(false);
  });
});
