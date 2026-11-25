#!/usr/bin/env node
/**
 * Milestone 5 Demo: Byte-preserving DOCX & Markdown/MDX extraction, round-trip, and translation.
 * Run with: npx tsx examples/05-documents-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { DocxDocumentAdapter, MarkdownDocumentAdapter } from "../src/index.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-demo-05-"));
try {
  console.log("=== Milestone 5: Documents (Markdown/MDX & Byte-Preserving DOCX) Demo ===\n");

  const mdFile = path.join(tmp, "release-notes.md");
  fs.writeFileSync(
    mdFile,
    `---\ntitle: "Release 1.0"\n---\n\n# Welcome to **Acme Pulse**\n\nRun \`npx polyglot check\` and visit [our docs](https://example.com).\n`,
    "utf8"
  );
  const md = new MarkdownDocumentAdapter("markdown");
  const mdDoc = md.extract(mdFile);
  console.log("Markdown segments:", mdDoc.segments.map((s) => `${s.id}: ${s.text}`));
  const mdRt = md.apply(mdFile, path.join(tmp, "release-notes.rt.md"), mdDoc.segments.map((s) => ({ id: s.id, text: s.text })));
  console.log("Markdown unchanged round-trip byte-identical:", mdRt.byteIdentical);

  const wNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const docxFile = path.join(tmp, "handbook.docx");
  fs.writeFileSync(
    docxFile,
    zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document ${wNs}><w:body><w:p><w:r><w:t>Wel</w:t></w:r><w:r><w:t>come to </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>Acme Pulse</w:t></w:r></w:p></w:body></w:document>`
      ),
    })
  );
  const docx = new DocxDocumentAdapter();
  const docExtracted = docx.extract(docxFile);
  console.log("DOCX segments:", docExtracted.segments.map((s) => `${s.id}: ${s.text}`));
  const docxRt = docx.apply(docxFile, path.join(tmp, "handbook.rt.docx"), docExtracted.segments.map((s) => ({ id: s.id, text: s.text })));
  console.log("DOCX unchanged round-trip byte-identical:", docxRt.byteIdentical);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
