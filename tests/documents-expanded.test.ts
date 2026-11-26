import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../src/core/init.js";
import { runCheck } from "../src/core/check.js";
import { safeUnzipSync } from "../src/core/security.js";
import { PptxDocumentAdapter } from "../src/documents/pptx.js";
import { applyDocumentTranslations, prepareDocument, scanDocumentsInProject } from "../src/documents/registry.js";
import { SubtitleDocumentAdapter } from "../src/documents/subtitles.js";
import { XlsxDocumentAdapter } from "../src/documents/xlsx.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMinimalPptx(filePath: string): void {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`
    ),
    "ppt/slides/slide1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:rPr b="1"/><a:t>Quarterly Launch</a:t></a:r></a:p>
    <a:p><a:r><a:t>Welcome to </a:t></a:r><a:r><a:rPr b="1"/><a:t>Northstar</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
    ),
    "ppt/slides/slide2.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Revenue &amp; Growth</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`
    ),
    "ppt/notesSlides/notesSlide1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Mention the Q4 roadmap.</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:notes>`
    ),
  };
  fs.writeFileSync(filePath, zipSync(entries, { level: 6 }));
}

function createMinimalXlsx(filePath: string): void {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    ),
    "xl/sharedStrings.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
  <si><t>Monthly Revenue</t></si>
  <si><r><t xml:space="preserve">Total </t></r><r><rPr><b/></rPr><t>USD</t></r></si>
</sst>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="inlineStr"><is><t>Region Note</t></is></c>
    </row>
    <row r="2">
      <c r="A2"><f>SUM(C2:C10)</f><v>420</v></c>
      <c r="B2" t="s"><v>1</v></c>
    </row>
  </sheetData>
</worksheet>`
    ),
  };
  fs.writeFileSync(filePath, zipSync(entries, { level: 6 }));
}

describe("Expanded document adapters (VTT, SRT, PPTX, XLSX)", () => {
  it("extracts and byte-preservingly translates WebVTT (.vtt) with CPS constraints and inline tags", () => {
    const dir = mkTmp("wraith-vtt-");
    const src = path.join(dir, "demo.vtt");
    const dst = path.join(dir, "demo.de.vtt");
    const content = `WEBVTT - Product Demo

NOTE Translator keep concise

00:00:01.000 --> 00:00:03.500 align:start position:10%
<v Host>Welcome to <i>Northstar</i>!</v>

cue-2
00:00:04.000 --> 00:00:06.000
Click <b>Save</b> to continue.
`;
    fs.writeFileSync(src, content, "utf8");

    const adapter = new SubtitleDocumentAdapter("vtt");
    const extracted = adapter.extract(src);
    expect(extracted.format).toBe("vtt");
    expect(extracted.segments).toHaveLength(2);
    expect(extracted.segments[0].constraints?.durationSec).toBe(2.5);
    expect(extracted.segments[0].constraints?.maxChars).toBe(50);
    expect(extracted.segments[0].text).toContain('<x id="t1"/>');

    // Byte-identical when untouched
    const sameRes = adapter.apply(src, dst, []);
    expect(sameRes.ok).toBe(true);
    expect(sameRes.byteIdentical).toBe(true);
    expect(fs.readFileSync(dst, "utf8")).toBe(content);

    // Rejects blank line or timestamp injection
    const badRes = adapter.apply(src, dst, [
      { id: "cue:2", text: "Line 1\n\nLine 2" },
    ]);
    expect(badRes.ok).toBe(false);
    expect(badRes.errors[0].code).toBe("subtitle_blank_line");

    // Valid translation preserves header, NOTE, timestamps, cue settings, and inline tags
    const applyRes = adapter.apply(src, dst, [
      { id: "cue:1", text: '<x id="t1"/>Willkommen bei <x id="t2"/>Northstar<x id="t3"/>!<x id="t4"/>' },
      { id: "cue:2", text: 'Klicken Sie auf <x id="t1"/>Speichern<x id="t2"/>.' },
    ]);
    expect(applyRes.ok).toBe(true);
    expect(applyRes.segmentsUpdated).toBe(2);
    const out = fs.readFileSync(dst, "utf8");
    expect(out).toContain("WEBVTT - Product Demo");
    expect(out).toContain("NOTE Translator keep concise");
    expect(out).toContain("00:00:01.000 --> 00:00:03.500 align:start position:10%");
    expect(out).toContain("<v Host>Willkommen bei <i>Northstar</i>!</v>");
    expect(out).toContain("Klicken Sie auf <b>Speichern</b>.");
  });

  it("extracts and translates SubRip (.srt) preserving CRLF line endings and cue IDs", () => {
    const dir = mkTmp("wraith-srt-");
    const src = path.join(dir, "captions.srt");
    const dst = path.join(dir, "captions.es.srt");
    const content = "1\r\n00:00:00,500 --> 00:00:02,500\r\nHello world\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\n<i>Good</i> morning\r\n";
    fs.writeFileSync(src, content, "utf8");

    const adapter = new SubtitleDocumentAdapter("srt");
    const extracted = adapter.extract(src);
    expect(extracted.segments).toHaveLength(2);

    const res = adapter.apply(src, dst, [
      { id: "cue:1", text: "Hola mundo" },
      { id: "cue:2", text: '<x id="t1"/>Buenos<x id="t2"/> días' },
    ]);
    expect(res.ok).toBe(true);
    const out = fs.readFileSync(dst, "utf8");
    expect(out).toContain("1\r\n00:00:00,500 --> 00:00:02,500\r\nHola mundo\r\n\r\n");
    expect(out).toContain("<i>Buenos</i> días");
  });

  it("extracts and byte-preservingly translates PPTX slides & speaker notes preserving rich runs", () => {
    const dir = mkTmp("wraith-pptx-");
    const src = path.join(dir, "deck.pptx");
    const dst = path.join(dir, "deck.de.pptx");
    createMinimalPptx(src);

    const adapter = new PptxDocumentAdapter();
    const extracted = adapter.extract(src);
    expect(extracted.format).toBe("pptx");
    expect(extracted.segments.map((s) => s.id)).toEqual([
      "slides/slide1:p1",
      "slides/slide1:p2",
      "slides/slide2:p1",
      "notesSlides/notesSlide1:p1",
    ]);
    expect(extracted.segments[1].text).toBe('<g id="1">Welcome to </g><g id="2">Northstar</g>');
    expect(extracted.segments[2].text).toBe("Revenue & Growth");

    // Byte-identical when untouched
    const sameRes = adapter.apply(src, dst, []);
    expect(sameRes.ok).toBe(true);
    expect(sameRes.byteIdentical).toBe(true);
    expect(fs.readFileSync(dst).equals(fs.readFileSync(src))).toBe(true);

    // Rejects broken <g> tags
    const badRes = adapter.apply(src, dst, [
      { id: "slides/slide1:p2", text: '<g id="1">Willkommen bei </g>Northstar' },
    ]);
    expect(badRes.ok).toBe(false);
    expect(badRes.errors[0].code).toBe("inline_tag_mismatch");

    // Valid translation preserves <a:rPr b="1"/> and escapes XML entities
    const res = adapter.apply(src, dst, [
      { id: "slides/slide1:p1", text: "Quartalsstart" },
      { id: "slides/slide1:p2", text: '<g id="1">Willkommen bei </g><g id="2">Northstar</g>' },
      { id: "slides/slide2:p1", text: "Umsatz & Wachstum" },
      { id: "notesSlides/notesSlide1:p1", text: "Q4-Roadmap erwähnen." },
    ]);
    expect(res.ok).toBe(true);
    expect(res.segmentsUpdated).toBe(4);

    const outEntries = safeUnzipSync(fs.readFileSync(dst));
    const slide1Xml = strFromU8(outEntries["ppt/slides/slide1.xml"]);
    const slide2Xml = strFromU8(outEntries["ppt/slides/slide2.xml"]);
    expect(slide1Xml).toContain('<a:rPr b="1"/><a:t>Quartalsstart</a:t>');
    expect(slide1Xml).toContain('<a:rPr b="1"/><a:t>Northstar</a:t>');
    expect(slide2Xml).toContain("Umsatz &amp; Wachstum");
  });

  it("extracts and translates XLSX sharedStrings & inline strings while preserving formulas", () => {
    const dir = mkTmp("wraith-xlsx-");
    const src = path.join(dir, "budget.xlsx");
    const dst = path.join(dir, "budget.de.xlsx");
    createMinimalXlsx(src);

    const adapter = new XlsxDocumentAdapter();
    const extracted = adapter.extract(src);
    expect(extracted.format).toBe("xlsx");
    expect(extracted.segments.map((s) => s.id)).toEqual([
      "sharedStrings:si0",
      "sharedStrings:si1",
      "sheet1:is1",
    ]);
    expect(extracted.segments[1].text).toBe('<g id="1">Total </g><g id="2">USD</g>');

    const res = adapter.apply(src, dst, [
      { id: "sharedStrings:si0", text: "Monatsumsatz" },
      { id: "sharedStrings:si1", text: '<g id="1">Gesamt </g><g id="2">USD</g>' },
      { id: "sheet1:is1", text: "Regionshinweis" },
    ]);
    expect(res.ok).toBe(true);
    expect(res.segmentsUpdated).toBe(3);

    const outEntries = safeUnzipSync(fs.readFileSync(dst));
    const ssXml = strFromU8(outEntries["xl/sharedStrings.xml"]);
    const sheetXml = strFromU8(outEntries["xl/worksheets/sheet1.xml"]);
    expect(ssXml).toContain("<t>Monatsumsatz</t>");
    expect(ssXml).toContain('<rPr><b/></rPr><t>USD</t>');
    expect(sheetXml).toContain("<t>Regionshinweis</t>");
    // Formula and numeric value must be untouched
    expect(sheetXml).toContain("<f>SUM(C2:C10)</f><v>420</v>");
  });

  it("integrates VTT, PPTX, and XLSX into scanDocumentsInProject, prepareDocument, applyDocument, and check", () => {
    const dir = mkTmp("wraith-docs-e2e-");
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    createMinimalPptx(path.join(dir, "docs/deck.pptx"));
    createMinimalXlsx(path.join(dir, "docs/budget.xlsx"));
    fs.writeFileSync(
      path.join(dir, "docs/intro.vtt"),
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello team\n",
      "utf8"
    );

    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["de"],
      documents: ["docs"],
      writeAgentRule: false,
    });

    const scanned = scanDocumentsInProject(dir, ["docs"]);
    expect(scanned.map((d) => d.format).sort()).toEqual(["pptx", "vtt", "xlsx"]);

    const prep = prepareDocument(dir, { documentPath: "docs/intro.vtt", targetLocale: "de" });
    expect(prep.format).toBe("vtt");
    expect(prep.segments[0].constraints?.maxChars).toBe(40);

    const applied = applyDocumentTranslations(dir, {
      sourceFile: "docs/intro.vtt",
      targetFile: "docs/intro.de.vtt",
      targetLocale: "de",
      updates: [{ id: "cue:1", text: "Hallo Team" }],
    });
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "docs/intro.de.vtt"), "utf8")).toContain("Hallo Team");

    // Before translating deck.pptx and budget.xlsx, check flags the 2 remaining untranslated documents
    const checkPartial = runCheck({ rootDir: dir, locale: "de" });
    expect(checkPartial.errorCount).toBe(2);

    // Translate deck.pptx and budget.xlsx as well -> check returns PASS with 0 errors
    const pptxApplied = applyDocumentTranslations(dir, {
      sourceFile: "docs/deck.pptx",
      targetFile: "docs/deck.de.pptx",
      targetLocale: "de",
      updates: [
        { id: "slides/slide1:p1", text: "Quartalsstart" },
        { id: "slides/slide1:p2", text: '<g id="1">Willkommen bei </g><g id="2">Northstar</g>' },
        { id: "slides/slide2:p1", text: "Umsatz & Wachstum" },
        { id: "notesSlides/notesSlide1:p1", text: "Q4-Roadmap erwähnen." },
      ],
    });
    expect(pptxApplied.ok).toBe(true);

    const xlsxApplied = applyDocumentTranslations(dir, {
      sourceFile: "docs/budget.xlsx",
      targetFile: "docs/budget.de.xlsx",
      targetLocale: "de",
      updates: [
        { id: "sharedStrings:si0", text: "Monatsumsatz" },
        { id: "sharedStrings:si1", text: '<g id="1">Gesamt </g><g id="2">USD</g>' },
        { id: "sheet1:is1", text: "Regionshinweis" },
      ],
    });
    expect(xlsxApplied.ok).toBe(true);

    const check = runCheck({ rootDir: dir, locale: "de" });
    expect(check.outcome).toBe("PASS");
    expect(check.errorCount).toBe(0);
  });

  it("does not emit false length_expansion_risk warnings on 6-form Arabic ICU plurals", () => {
    const dir = mkTmp("wraith-icu-len-");
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" } })
    );
    fs.writeFileSync(
      path.join(dir, "src/Cart.tsx"),
      `import { useTranslations } from "next-intl";\nexport function Cart({ count }: { count: number }) {\n  const t = useTranslations();\n  return <p>{t("cartItems", { count })}</p>;\n}\n`
    );
    fs.writeFileSync(
      path.join(dir, "messages/en.json"),
      JSON.stringify({
        cartItems: "{count, plural, one {# item in cart} other {# items in cart}}",
      })
    );
    fs.writeFileSync(
      path.join(dir, "messages/ar.json"),
      JSON.stringify({
        cartItems:
          "{count, plural, zero {لا توجد عناصر في السلة} one {عنصر واحد في السلة} two {عنصران في السلة} few {# عناصر في السلة} many {# عنصرًا في السلة} other {# عنصر في السلة}}",
      })
    );
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["ar"], writeAgentRule: false });
    const check = runCheck({ rootDir: dir, locale: "ar" });
    expect(check.outcome).toBe("PASS");
    expect(check.countsByCode["length_expansion_risk"] ?? 0).toBe(0);
  });
});
