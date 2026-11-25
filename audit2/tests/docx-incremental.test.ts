import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { applyDocumentTranslations, DocxDocumentAdapter, prepareDocument, runCheck } from "../../src/index.js";
import { init, project } from "../../audit/helpers.js";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string) =>
  zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
  });
const p = (t: string, rpr = "") => `<w:p><w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const xmlOf = (f: string) => strFromU8(unzipSync(fs.readFileSync(f))["word/document.xml"]);
const texts = (f: string) => [...xmlOf(f).matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join(""));
const tr: Record<string, string> = { "Apples are red.": "Äpfel sind rot.", "Bananas are yellow.": "Bananen sind gelb.", "Cherries are dark.": "Kirschen sind dunkel.", "Dates are sweet.": "Datteln sind süß.", "IMPORTANT: read first.": "WICHTIG: zuerst lesen." };

function setup(paras: string[]) {
  const dir = project({ "doc.docx": docx(paras.map((t) => p(t)).join("")) });
  init(dir, ["de"]);
  return dir;
}
const apply = (dir: string, segs: any[]) =>
  applyDocumentTranslations(dir, { sourceFile: "doc.docx", targetFile: "doc.de.docx", targetLocale: "de", updates: segs.map((s) => ({ id: s.id, text: tr[s.source ?? s.text] ?? `DE(${s.source ?? s.text})` })) });

describe("DX. Incremental DOCX translation, segment identity, formatting & revisions", () => {
  it("DX1 source edited between batches (paragraph inserted at top): earlier translations stay on the RIGHT paragraphs", () => {
    const dir = setup(["Apples are red.", "Bananas are yellow.", "Cherries are dark.", "Dates are sweet."]);
    const first = prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de", limit: 2 });
    apply(dir, first.segments); // Apples, Bananas
    // Author inserts a new paragraph at the top of the SOURCE document
    fs.writeFileSync(path.join(dir, "doc.docx"), docx(["IMPORTANT: read first.", "Apples are red.", "Bananas are yellow.", "Cherries are dark.", "Dates are sweet."].map((t) => p(t)).join("")));
    const all = prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de", limit: 50 });
    const res = apply(dir, all.segments.filter((s: any) => /IMPORTANT|Cherries|Dates/.test(s.source)));
    const out = texts(path.join(dir, "doc.de.docx"));
    console.log(`[DX1] apply ok=${res.ok} errors=${JSON.stringify(res.errors?.slice(0, 2))}\n       output paragraphs: ${JSON.stringify(out)}`);
    expect(out).toEqual(["WICHTIG: zuerst lesen.", "Äpfel sind rot.", "Bananen sind gelb.", "Kirschen sind dunkel.", "Datteln sind süß."]);
  });

  it("DX2 a paragraph whose SOURCE text changed is not silently given its old translation", () => {
    const dir = setup(["Apples are red.", "Bananas are yellow."]);
    apply(dir, prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de" }).segments);
    fs.writeFileSync(path.join(dir, "doc.docx"), docx([p("Apples are green."), p("Bananas are yellow.")].join("")));
    const prep = prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de" });
    const res = applyDocumentTranslations(dir, { sourceFile: "doc.docx", targetFile: "doc.de.docx", targetLocale: "de", updates: [] as any });
    const out = fs.existsSync(path.join(dir, "doc.de.docx")) ? texts(path.join(dir, "doc.de.docx")) : [];
    const chk = runCheckDocs(dir);
    console.log(`[DX2] prepare pending=${JSON.stringify((prep as any).pendingSegments ?? (prep as any).totalPending ?? "n/a")} output=${JSON.stringify(out)} check=${chk}`);
    expect(out[0]).not.toBe("Äpfel sind rot.");
  });

  it("DX3 manual corrections made in the translated DOCX (e.g. in Word) survive the next batch apply", () => {
    const dir = setup(["Apples are red.", "Bananas are yellow.", "Cherries are dark."]);
    const segs = prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de", limit: 50 }).segments;
    apply(dir, segs.slice(0, 2));
    // A reviewer fixes paragraph 1 directly in the German file
    const target = path.join(dir, "doc.de.docx");
    const files = unzipSync(fs.readFileSync(target));
    files["word/document.xml"] = strToU8(strFromU8(files["word/document.xml"]).replace("Äpfel sind rot.", "Die Äpfel sind rot."));
    fs.writeFileSync(target, zipSync(files));
    apply(dir, segs.slice(2));
    const out = texts(target);
    console.log(`[DX3] after next batch: ${JSON.stringify(out)}`);
    expect(out[0]).toBe("Die Äpfel sind rot.");
  });

  it("DX4 formatting (bold/italic/colour) on translated runs is preserved", () => {
    const body = `<w:p><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t xml:space="preserve">Warning: </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>do not overfill.</w:t></w:r></w:p>`;
    const dir = project({ "doc.docx": docx(body) });
    init(dir, ["de"]);
    const seg = new DocxDocumentAdapter().extract(path.join(dir, "doc.docx")).segments[0];
    const ids = [...seg.text.matchAll(/<g id="(\d+)"/g)].map((m) => m[1]);
    applyDocumentTranslations(dir, { sourceFile: "doc.docx", targetFile: "doc.de.docx", targetLocale: "de", updates: [{ id: seg.id, text: `<g id="${ids[0]}" type="format">Warnung: </g><g id="${ids[1]}" type="format">nicht überfüllen.</g>` }] });
    const x = xmlOf(path.join(dir, "doc.de.docx"));
    console.log(`[DX4] ${x.slice(x.indexOf("<w:p>"), x.indexOf("</w:p>") + 6)}`);
    expect(x).toMatch(/<w:b\/><w:color w:val="FF0000"\/><\/w:rPr><w:t[^>]*>Warnung: <\/w:t>/);
    expect(x).toMatch(/<w:i\/><\/w:rPr><w:t[^>]*>nicht überfüllen\.<\/w:t>/);
  });

  it("DX5 revision history: w:del text, authors and dates are preserved byte-for-byte; w:ins keeps its author/date", () => {
    const del = `<w:del w:id="2" w:author="Legal" w:date="2026-01-02T00:00:00Z"><w:r><w:delText xml:space="preserve">old clause </w:delText></w:r></w:del>`;
    const ins = `<w:ins w:id="1" w:author="Legal" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">formally </w:t></w:r></w:ins>`;
    const body = `<w:p><w:r><w:t xml:space="preserve">The board </w:t></w:r>${ins}${del}<w:r><w:t>approved it.</w:t></w:r></w:p>`;
    const dir = project({ "doc.docx": docx(body) });
    init(dir, ["de"]);
    const seg = new DocxDocumentAdapter().extract(path.join(dir, "doc.docx")).segments[0];
    console.log(`[DX5] segment: ${seg.text}`);
    const translated = seg.text.replace("The board ", "Der Vorstand ").replace("formally ", "formell ").replace("approved it.", "hat es genehmigt.");
    const res = applyDocumentTranslations(dir, { sourceFile: "doc.docx", targetFile: "doc.de.docx", targetLocale: "de", updates: [{ id: seg.id, text: translated }] });
    const x = xmlOf(path.join(dir, "doc.de.docx"));
    console.log(`[DX5] ok=${res.ok} xml=${x.slice(x.indexOf("<w:p>"), x.indexOf("</w:p>") + 6)}`);
    expect(x).toContain(del);
    expect(x).toMatch(/<w:ins w:id="1" w:author="Legal" w:date="2026-01-01T00:00:00Z">[\s\S]*formell/);
  });

  it("DX6 LibreOffice reopens a multi-batch translated document and shows every translated paragraph", () => {
    let hasSoffice = true;
    try {
      execFileSync("soffice", ["--version"], { stdio: "pipe" });
    } catch {
      hasSoffice = false;
    }
    if (!hasSoffice) return;
    const dir = setup(["Apples are red.", "Bananas are yellow.", "Cherries are dark.", "Dates are sweet."]);
    const segs = prepareDocument(dir, { documentPath: "doc.docx", targetLocale: "de", limit: 50 }).segments;
    apply(dir, segs.slice(0, 1));
    apply(dir, segs.slice(1, 3));
    apply(dir, segs.slice(3));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "lo2-"));
    execFileSync("soffice", ["--headless", "--convert-to", "txt:Text (encoded):UTF8", "--outdir", out, path.join(dir, "doc.de.docx")], { stdio: "pipe" });
    const txt = fs.readFileSync(path.join(out, "doc.de.txt"), "utf8");
    console.log(`[DX6] ${JSON.stringify(txt.trim().split(/\r?\n/))}`);
    expect(txt).toContain("Äpfel sind rot.");
    expect(txt).toContain("Datteln sind süß.");
  });
});

function runCheckDocs(dir: string): string {
  const cfgPath = path.join(dir, ".wraith/config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.paths.documents = ["doc.docx"];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = runCheck({ rootDir: dir, limit: 20 });
  return `${r.outcome} ${JSON.stringify(r.countsByCode)}`;
}
