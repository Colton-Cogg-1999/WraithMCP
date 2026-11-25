import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  DocxDocumentAdapter,
  ensureBootstrapped,
  initProject,
  MarkdownDocumentAdapter,
  PolyglotStore,
  prepareDocument,
  scanProject,
} from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-docs-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** Build a valid real-world OOXML DOCX buffer with rich Word features for corpus round-trip testing. */
function buildCorpusDocx(parts: {
  documentBody: string;
  header1?: string;
  footer1?: string;
  footnotes?: string;
  comments?: string;
}): Uint8Array {
  const wNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${wNs}><w:body>${parts.documentBody}</w:body></w:document>`
    ),
  };

  if (parts.header1) {
    files["word/header1.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${wNs}>${parts.header1}</w:hdr>`
    );
  }
  if (parts.footer1) {
    files["word/footer1.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${wNs}>${parts.footer1}</w:ftr>`
    );
  }
  if (parts.footnotes) {
    files["word/footnotes.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${wNs}>${parts.footnotes}</w:footnotes>`
    );
  }
  if (parts.comments) {
    files["word/comments.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${wNs}>${parts.comments}</w:comments>`
    );
  }

  return zipSync(files, { level: 6 });
}

describe("Milestone 5: Markdown/MDX & Byte-Preserving DOCX Adapters", () => {
  it("extracts and byte-identically round-trips Markdown/MDX with frontmatter, code fences, links, bold, and JSX", () => {
    const dir = makeTempDir();
    const mdxPath = path.join(dir, "guide.mdx");
    const original = `---
title: "Getting Started with Acme Pulse"
description: "Deploy fast with confidence."
author: "Colton"
---

import { Callout } from "./Callout";

# Welcome to **Acme Pulse**

Run \`npx polyglot check\` or read the [documentation](https://example.com/docs) carefully.

<Callout type="info">
  This line has *italic* emphasis and \`inline_code\`.
</Callout>

\`\`\`ts
// Code block must NEVER be extracted
const greeting = "Hello world";
\`\`\`
`;
    fs.writeFileSync(mdxPath, original, "utf8");

    const adapter = new MarkdownDocumentAdapter("mdx");
    const doc = adapter.extract(mdxPath);
    expect(doc.format).toBe("mdx");
    expect(doc.segments.some((s) => s.text.includes('type="code"'))).toBe(true);
    expect(doc.segments.some((s) => s.text.includes('type="link"'))).toBe(true);
    expect(doc.segments.some((s) => s.text.includes("const greeting"))).toBe(false);

    // 1. Unchanged round-trip -> 100% byte-identical
    const unchangedPath = path.join(dir, "guide.roundtrip.mdx");
    const rt = adapter.apply(
      mdxPath,
      unchangedPath,
      doc.segments.map((s) => ({ id: s.id, text: s.text }))
    );
    expect(rt.ok).toBe(true);
    expect(rt.byteIdentical).toBe(true);
    expect(fs.readFileSync(unchangedPath, "utf8")).toBe(original);

    // 2. Reject broken inline tag
    const linkSeg = doc.segments.find((s) => s.text.includes('type="link"'))!;
    const bad = adapter.apply(mdxPath, path.join(dir, "bad.mdx"), [
      { id: linkSeg.id, text: "Ejecuta el comando sin etiquetas" },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].code).toBe("inline_tag_mismatch");

    // 3. Valid translation preserves URLs, code blocks, frontmatter, and inline code verbatim
    const translatedPath = path.join(dir, "guide.es-MX.mdx");
    const ok = adapter.apply(mdxPath, translatedPath, [
      {
        id: linkSeg.id,
        text: linkSeg.text
          .replace("Run ", "Ejecuta ")
          .replace(" or read the ", " o lee la ")
          .replace(">documentation<", ">documentación<")
          .replace(" carefully.", " con cuidado."),
      },
    ]);
    expect(ok.ok).toBe(true);
    const out = fs.readFileSync(translatedPath, "utf8");
    expect(out).toContain("`npx polyglot check`");
    expect(out).toContain("[documentación](https://example.com/docs)");
    expect(out).toContain('const greeting = "Hello world";');
  });

  it("handles full DOCX corpus: fragmented runs, mixed formatting, tables, headers/footers, footnotes, comments, hyperlinks, fields, text boxes, and tracked changes", () => {
    const dir = makeTempDir();
    const docxPath = path.join(dir, "contract.docx");
    const docxBytes = buildCorpusDocx({
      documentBody: `
        <!-- 1. Fragmented runs with identical rPr + spellcheck proofErr (must merge into 1 clean run) -->
        <w:p>
          <w:r w:rsidR="001"><w:rPr><w:b/></w:rPr><w:t>Hel</w:t></w:r>
          <w:proofErr w:type="spellStart"/>
          <w:r w:rsidR="002"><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">lo </w:t></w:r>
          <w:proofErr w:type="spellEnd"/>
          <w:r w:rsidR="003"><w:rPr><w:b/></w:rPr><w:t>Acme Pulse</w:t></w:r>
        </w:p>
        <!-- 2. Mixed formatting + hyperlink -->
        <w:p>
          <w:r><w:t xml:space="preserve">Please read </w:t></w:r>
          <w:r><w:rPr><w:b/></w:rPr><w:t>important terms</w:t></w:r>
          <w:r><w:t xml:space="preserve"> on </w:t></w:r>
          <w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>our website</w:t></w:r></w:hyperlink>
          <w:r><w:t>.</w:t></w:r>
        </w:p>
        <!-- 3. Table with cells -->
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plan Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Monthly Price</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <!-- 4. Complex field (PAGE) + simple field -->
        <w:p>
          <w:r><w:t xml:space="preserve">Generated on </w:t></w:r>
          <w:fldSimple w:instr=" DATE "><w:r><w:t>2026-01-01</w:t></w:r></w:fldSimple>
          <w:r><w:t xml:space="preserve"> — Page </w:t></w:r>
          <w:r><w:fldChar w:fldCharType="begin"/></w:r>
          <w:r><w:instrText> PAGE </w:instrText></w:r>
          <w:r><w:fldChar w:fldCharType="separate"/></w:r>
          <w:r><w:t>1</w:t></w:r>
          <w:r><w:fldChar w:fldCharType="end"/></w:r>
        </w:p>
        <!-- 5. Text box inside drawing -->
        <w:p>
          <w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>Callout inside text box</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>
        </w:p>
        <!-- 6. Tracked changes explicitly protected -->
        <w:p>
          <w:r><w:t xml:space="preserve">Approved clause </w:t></w:r>
          <w:ins w:id="10" w:author="Legal"><w:r><w:t>inserted revision</w:t></w:r></w:ins>
          <w:del w:id="11" w:author="Legal"><w:r><w:delText>deleted revision</w:delText></w:r></w:del>
        </w:p>
      `,
      header1: `<w:p><w:r><w:t>Confidential Header</w:t></w:r></w:p>`,
      footer1: `<w:p><w:r><w:t>Copyright Acme Pulse</w:t></w:r></w:p>`,
      footnotes: `<w:footnote w:id="1"><w:p><w:r><w:t>Footnote legal disclaimer.</w:t></w:r></w:p></w:footnote>`,
      comments: `<w:comment w:id="1" w:author="Reviewer"><w:p><w:r><w:t>Check this section carefully.</w:t></w:r></w:p></w:comment>`,
    });
    fs.writeFileSync(docxPath, docxBytes);

    const adapter = new DocxDocumentAdapter();
    const doc = adapter.extract(docxPath);

    // Verify all parts extracted
    expect(doc.stats.parts).toEqual([
      "word/document.xml",
      "word/comments.xml",
      "word/footer1.xml",
      "word/footnotes.xml",
      "word/header1.xml",
    ]);
    expect(doc.stats.protectedTrackedChanges).toBe(1);

    // 1. Fragmented runs merged cleanly into plain text without tag soup!
    const p1 = doc.segments.find((s) => s.plainText === "Hello Acme Pulse");
    expect(p1).toBeDefined();
    expect(p1!.text).toBe("Hello Acme Pulse");

    // 2. Mixed formatting + hyperlink encoded with <g> tags
    const p2 = doc.segments.find((s) => s.plainText.includes("important terms"))!;
    expect(p2.text).toContain('type="hyperlink">our website</g>');

    // 3. Table cells, text box, header, footer, footnote, comment all extracted
    const allPlain = doc.segments.map((s) => s.plainText);
    expect(allPlain).toContain("Plan Name");
    expect(allPlain).toContain("Monthly Price");
    expect(allPlain).toContain("Callout inside text box");
    expect(allPlain).toContain("Confidential Header");
    expect(allPlain).toContain("Copyright Acme Pulse");
    expect(allPlain).toContain("Footnote legal disclaimer.");
    expect(allPlain).toContain("Check this section carefully.");

    // 4. Fields & tracked changes protected as <x .../>
    const fieldSeg = doc.segments.find((s) => s.plainText.includes("Generated on"))!;
    expect(fieldSeg.tags.filter((t) => t.type === "field")).toHaveLength(2);
    const trackedSeg = doc.segments.find((s) => s.plainText.includes("Approved clause"))!;
    expect(trackedSeg.tags.filter((t) => t.type === "tracked-change")).toHaveLength(2);

    // MANDATORY ROUND-TRIP TEST: extract -> reinsert unchanged -> 100% BYTE-IDENTICAL DOCX!
    const rtPath = path.join(dir, "contract.roundtrip.docx");
    const rtRes = adapter.apply(
      docxPath,
      rtPath,
      doc.segments.map((s) => ({ id: s.id, text: s.text }))
    );
    expect(rtRes.ok).toBe(true);
    expect(rtRes.byteIdentical).toBe(true);
    expect(Buffer.compare(fs.readFileSync(docxPath), fs.readFileSync(rtPath))).toBe(0);

    // Reject missing inline tag on apply
    const badPath = path.join(dir, "contract.bad.docx");
    const badRes = adapter.apply(docxPath, badPath, [
      { id: p2.id, text: "Por favor lee los términos sin etiquetas." },
    ]);
    expect(badRes.ok).toBe(false);
    expect(badRes.errors[0].code).toBe("inline_tag_mismatch");

    // Real translation across body, hyperlink, table, header, footnote, tracked-change paragraph
    const esPath = path.join(dir, "contract.es-MX.docx");
    const headerSeg = doc.segments.find((s) => s.plainText === "Confidential Header")!;
    const tableSeg = doc.segments.find((s) => s.plainText === "Plan Name")!;
    const boxSeg = doc.segments.find((s) => s.plainText === "Callout inside text box")!;
    const transRes = adapter.apply(docxPath, esPath, [
      { id: p1!.id, text: "Hola Acme Pulse" },
      {
        id: p2.id,
        text: p2.text
          .replace("Please read ", "Por favor lee ")
          .replace("important terms", "términos importantes")
          .replace(" on ", " en ")
          .replace("our website", "nuestro sitio web"),
      },
      { id: tableSeg.id, text: "Nombre del plan" },
      { id: boxSeg.id, text: "Aviso dentro del cuadro de texto" },
      { id: headerSeg.id, text: "Encabezado confidencial" },
      { id: trackedSeg.id, text: trackedSeg.text.replace("Approved clause ", "Cláusula aprobada ") },
    ]);
    expect(transRes.ok).toBe(true);
    expect(transRes.segmentsUpdated).toBe(6);

    // Verify translated DOCX XML preserves hyperlink r:id, tracked changes <w:ins>/<w:del>, and fields verbatim!
    const outZip = unzipSync(fs.readFileSync(esPath));
    const outDocXml = strFromU8(outZip["word/document.xml"]);
    expect(outDocXml).toContain("Hola Acme Pulse");
    expect(outDocXml).toContain('<w:hyperlink r:id="rId5" w:history="1">');
    expect(outDocXml).toContain("nuestro sitio web");
    expect(outDocXml).toContain("Nombre del plan");
    expect(outDocXml).toContain("Aviso dentro del cuadro de texto");
    expect(outDocXml).toContain('<w:ins w:id="10" w:author="Legal"><w:r><w:t>inserted revision</w:t></w:r></w:ins>');
    expect(outDocXml).toContain('<w:del w:id="11" w:author="Legal"><w:r><w:delText>deleted revision</w:delText></w:r></w:del>');
    expect(strFromU8(outZip["word/header1.xml"])).toContain("Encabezado confidencial");
  });

  it("integrates documents with scan(), prepareDocument() (whole-document context), and memory recording", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "README.md"), "# Acme Pulse\n\nShip faster with **Polyglot**.\n", "utf8");
    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["fr"],
      documents: ["README.md"],
      writeAgentRule: false,
    });

    const scan = scanProject({ rootDir: dir });
    expect(scan.counts.documents).toBe(1);
    expect(scan.documents[0].file).toBe("README.md");

    const prep = prepareDocument(dir, { documentPath: "README.md", targetLocale: "fr" });
    expect(prep.fullDocumentContext).toContain("Acme Pulse");
    expect(prep.fullDocumentContext).toContain("Polyglot");
    expect(prep.documentGuidance).toContain("document-level");

    const applyRes = applyDocumentTranslations(dir, {
      sourceFile: "README.md",
      targetFile: "README.fr.md",
      targetLocale: "fr",
      updates: [{ id: prep.segments[1].id, text: 'Livrez plus vite avec <g id="1" type="bold">Polyglot</g>.' }],
    });
    expect(applyRes.ok).toBe(true);
    const store = new PolyglotStore(dir);
    expect(store.readMemory().length).toBe(1);
  });
});
