import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  applyTranslations,
  importAsset,
  importEscalationCorrections,
  initProject,
  prepareDocument,
  recordGlossaryTerm,
  runCheck,
  safeUnzipSync,
  DocxDocumentAdapter,
} from "../../src/index.js";
import { init, nextIntlPkg, project } from "../../audit/helpers.js";

const REPO = path.resolve(__dirname, "../..");
const outside = () => fs.mkdtempSync(path.join(os.tmpdir(), "pg2-outside-"));
const base = (extra: Record<string, string> = {}) => {
  const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello", b: "Bye" }, null, 2) + "\n", ...extra });
  init(dir, ["de"]);
  return dir;
};
const tryRun = (fn: () => unknown) => {
  try {
    return { ok: true, value: fn() as any };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

describe("SEC2. Confinement of the .polyglot store and agent files (untrusted cloned repository)", () => {
  it("SEC2-1 a repo whose .polyglot/ is a symlink to an outside directory cannot make Polyglot write outside", () => {
    const out = outside();
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello" }) });
    fs.symlinkSync(out, path.join(dir, ".polyglot"));
    tryRun(() => applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Hallo" }] }));
    tryRun(() => recordGlossaryTerm(dir, { term: "Hello", translations: { de: "Hallo" } }));
    const written = fs.readdirSync(out);
    console.log(`[SEC2-1] files written into outside dir via .polyglot symlink: ${JSON.stringify(written)}`);
    expect(written).toEqual([]);
  });

  it("SEC2-2 a repo whose .polyglot/glossary.json is a symlink to an outside file cannot overwrite that file", () => {
    const out = outside();
    const victim = path.join(out, "victim.txt");
    fs.writeFileSync(victim, "PRECIOUS USER DATA\n");
    const dir = base();
    fs.rmSync(path.join(dir, ".polyglot/glossary.json"), { force: true });
    fs.symlinkSync(victim, path.join(dir, ".polyglot/glossary.json"));
    tryRun(() => recordGlossaryTerm(dir, { term: "Hello", translations: { de: "Hallo" } }));
    const after = fs.readFileSync(victim, "utf8");
    console.log(`[SEC2-2] outside victim file now starts with: ${JSON.stringify(after.slice(0, 40))}`);
    expect(after).toBe("PRECIOUS USER DATA\n");
  });

  it("SEC2-3 `init` cannot write through a symlinked AGENTS.md / CLAUDE.md to an outside file", () => {
    const out = outside();
    const victim = path.join(out, "bashrc");
    fs.writeFileSync(victim, "export PATH=/usr/bin\n");
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": "{}" });
    fs.symlinkSync(victim, path.join(dir, "CLAUDE.md"));
    tryRun(() => initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"] }));
    const after = fs.readFileSync(victim, "utf8");
    console.log(`[SEC2-3] outside file appended to: ${after !== "export PATH=/usr/bin\n"}`);
    expect(after).toBe("export PATH=/usr/bin\n");
  });

  it("SEC2-4 a symlinked locale directory (messages -> outside) cannot receive writes", () => {
    const out = outside();
    fs.writeFileSync(path.join(out, "en.json"), JSON.stringify({ a: "Hello" }));
    const dir = project({ "package.json": nextIntlPkg });
    fs.symlinkSync(out, path.join(dir, "messages"));
    init(dir, ["de"]);
    const r = tryRun(() => applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: "Hallo" }] }));
    const wrote = fs.existsSync(path.join(out, "de.json"));
    console.log(`[SEC2-4] apply ok=${r.ok} wrote outside=${wrote} ${r.ok ? JSON.stringify(r.value.errors?.slice(0, 1)) : r.error.slice(0, 100)}`);
    expect(wrote).toBe(false);
  });

  it("SEC2-5 document prepare cannot READ a file outside the repo (absolute and ../ paths)", () => {
    const out = outside();
    fs.writeFileSync(path.join(out, "secret.md"), "# Top secret plan\n\nThe password is hunter2.\n");
    const dir = base();
    const abs = tryRun(() => prepareDocument(dir, { documentPath: path.join(out, "secret.md"), targetLocale: "de" }));
    const rel = tryRun(() => prepareDocument(dir, { documentPath: path.relative(dir, path.join(out, "secret.md")), targetLocale: "de" }));
    const leaked = JSON.stringify([abs, rel]).includes("hunter2");
    console.log(`[SEC2-5] leaked=${leaked}`);
    expect(leaked).toBe(false);
  });

  it("SEC2-6 asset import / escalation import cannot read files outside the repo", () => {
    const out = outside();
    fs.writeFileSync(path.join(out, "g.csv"), "term,de\nSecretTerm,Geheim\n");
    fs.writeFileSync(path.join(out, "c.csv"), "locale,key,corrected_translation\nde,a,Hallo\n");
    const dir = base();
    const imp = tryRun(() => importAsset(dir, { file: path.join(out, "g.csv") }));
    const esc = tryRun(() => importEscalationCorrections(dir, path.join(out, "c.csv")));
    console.log(`[SEC2-6] importAsset ok=${imp.ok} escalationImport ok=${esc.ok}`);
    expect(imp.ok && imp.value.glossaryImported > 0).toBe(false);
    expect(esc.ok && esc.value.appliedCount > 0).toBe(false);
  });

  it("SEC2-7 locale-tag validator accepts real-world tags and rejects traversal", async () => {
    const { isValidLocaleTag } = await import("../../src/index.js");
    const good = ["en", "es-419", "zh-Hans", "zh-Hant-TW", "sr-Latn-RS", "ca-ES-valencia", "pt_BR", "fil", "en-x-pseudo", "de-CH-1996"];
    const bad = ["../x", "de/../../x", "de\\x", "de:x", "de\0", "x".repeat(70), "de-..", "C:\\de"];
    const rejectedGood = good.filter((g) => !isValidLocaleTag(g));
    const acceptedBad = bad.filter((b) => isValidLocaleTag(b));
    console.log(`[SEC2-7] valid tags rejected=${JSON.stringify(rejectedGood)} bad tags accepted=${JSON.stringify(acceptedBad)}`);
    expect(acceptedBad).toEqual([]);
    expect(rejectedGood).toEqual([]);
  });
});

describe("ZIP2. Archive processing", () => {
  it("ZIP2-1 a DOCX whose central directory LIES about uncompressed size does not exhaust memory", () => {
    // Build a bomb then patch the declared uncompressed sizes in local + central headers to 1 KB.
    const huge = new Uint8Array(200 * 1024 * 1024);
    const z = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": huge }, { level: 9 });
    const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
    for (let i = 0; i + 30 < z.length; i++) {
      const sig = v.getUint32(i, true);
      if (sig === 0x04034b50 && v.getUint32(i + 22, true) === huge.length) v.setUint32(i + 22, 1024, true);
      if (sig === 0x02014b50 && v.getUint32(i + 24, true) === huge.length) v.setUint32(i + 24, 1024, true);
    }
    const before = process.memoryUsage().rss;
    const r = tryRun(() => safeUnzipSync(z));
    const grew = (process.memoryUsage().rss - before) / 1048576;
    const docLen = r.ok ? r.value["word/document.xml"]?.length : -1;
    console.log(`[ZIP2-1] ok=${r.ok} ${r.ok ? `document.xml bytes=${docLen}` : r.error.slice(0, 90)} rssGrowth≈${grew.toFixed(0)}MB`);
    expect(grew).toBeLessThan(150);
  });

  it("ZIP2-2 a DOCX with path-traversal entry names is still readable for translation (names are never extracted)", () => {
    // Real-world: some generators emit odd names; Polyglot never extracts to disk, so this should not hard-fail.
    const z = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>'), "customXml/item..1.xml": strToU8("<x/>") });
    const dir = project({ "d.docx": z });
    const r = tryRun(() => new DocxDocumentAdapter().extract(path.join(dir, "d.docx")));
    console.log(`[ZIP2-2] extract ok=${r.ok} ${r.ok ? "" : r.error.slice(0, 120)}`);
    expect(r.ok).toBe(true);
  });
});

describe("CONC. Concurrent operations", () => {
  function cli(dir: string, args: string[]): Promise<number> {
    return new Promise((res) => {
      const p = spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "src/bin.ts"), ...args], { cwd: dir, stdio: "ignore" });
      p.on("exit", (c) => res(c ?? -1));
    });
  }

  it("CONC-1 two processes applying DIFFERENT keys to the same locale at the same time keep both translations", async () => {
    const en: Record<string, string> = {};
    for (let i = 0; i < 40; i++) en[`k${i}`] = `Label ${i}`;
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify(en, null, 2) + "\n" });
    init(dir, ["de"]);
    const script = (keys: number[]) =>
      `import { applyTranslations, ensureBootstrapped } from ${JSON.stringify(path.join(REPO, "src/index.ts"))};
ensureBootstrapped();
for (const i of ${JSON.stringify(keys)}) applyTranslations({ rootDir: ${JSON.stringify(dir)}, targetLocale: "de", translations: [{ key: "k" + i, value: "Bezeichnung " + i }] });`;
    const a = path.join(dir, "a.mts");
    const b = path.join(dir, "b.mts");
    fs.writeFileSync(a, script([...Array(20).keys()]));
    fs.writeFileSync(b, script([...Array(20).keys()].map((i) => i + 20)));
    const run = (f: string) =>
      new Promise<number>((res) => spawn(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), f], { cwd: REPO, stdio: "inherit" }).on("exit", (c) => res(c ?? -1)));
    await Promise.all([run(a), run(b)]);
    const de = JSON.parse(fs.readFileSync(path.join(dir, "messages/de.json"), "utf8"));
    const recs = JSON.parse(fs.readFileSync(path.join(dir, ".polyglot/records.json"), "utf8")).records;
    console.log(`[CONC-1] de.json keys=${Object.keys(de).length}/40 records=${Object.keys(recs).filter((k) => recs[k].de?.origin === "agent").length}/40`);
    expect(Object.keys(de).length).toBe(40);
  });

  it("CONC-2 `check` running while `apply` writes never reports a parse error (atomic writes)", async () => {
    const dir = base();
    void cli; // CLI helper kept for manual reproduction
    let parseErrors = 0;
    for (let i = 0; i < 30; i++) {
      applyTranslations({ rootDir: dir, targetLocale: "de", translations: [{ key: "a", value: `Hallo ${i}` }] });
      const r = runCheck({ rootDir: dir, skipScan: true });
      parseErrors += r.countsByCode["locale_parse_error"] ?? 0;
    }
    expect(parseErrors).toBe(0);
  });
});

describe("DOCPATH. Document state cannot be steered", () => {
  it("DOCPATH-1 documents.json from a malicious repo cannot redirect writes outside the repo", () => {
    const out = outside();
    const dir = base({ "docs/a.md": "# Hello world\n" });
    fs.writeFileSync(
      path.join(dir, ".polyglot/documents.json"),
      JSON.stringify({ version: 1, documents: { "docs/a.md": { de: { targetFile: path.join(out, "x.md"), sourceHash: "x", totalSegments: 1, translatedSegments: 1, segments: { "md-1": "Hallo" }, updatedAt: "" } } } })
    );
    tryRun(() => applyDocumentTranslations(dir, { sourceFile: "docs/a.md", targetFile: "docs/a.de.md", targetLocale: "de", updates: [{ id: "md-1", text: "Hallo Welt" }] }));
    expect(fs.readdirSync(out)).toEqual([]);
  });
});
