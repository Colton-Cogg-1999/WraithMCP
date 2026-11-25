import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";

/**
 * Inspect OOXML structural element counts directly from a .docx ZIP archive.
 */
export function inspectDocxStructure(docxPath) {
  const files = unzipSync(fs.readFileSync(docxPath));
  const xmlParts = Object.entries(files)
    .filter(([name]) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name))
    .map(([name, bytes]) => ({ name, xml: strFromU8(bytes) }));

  const count = (re) => xmlParts.reduce((sum, p) => sum + (p.xml.match(re)?.length ?? 0), 0);
  const docXml = xmlParts.find((p) => p.name === "word/document.xml")?.xml ?? "";

  const rPrSet = new Set(
    [...docXml.matchAll(/<w:rPr>[\s\S]*?<\/w:rPr>/g)].map((m) => m[0])
  );

  // Extract visible paragraphs from document.xml (excluding w:delText)
  const visibleParagraphs = [...docXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
    .map((m) =>
      [...m[0].replace(/<w:del\b[\s\S]*?<\/w:del>/g, "").matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((x) => x[1])
        .join("")
        .trim()
    )
    .filter(Boolean);

  return {
    paragraphs: count(/<w:p\b/g),
    tables: count(/<w:tbl\b/g),
    hyperlinks: count(/<w:hyperlink\b/g),
    fields: count(/<w:fldSimple\b|<w:fldChar\b[^>]*w:fldCharType="begin"/g),
    bookmarks: count(/<w:bookmarkStart\b/g),
    comments: count(/<w:comment\b/g),
    trackedInsertions: count(/<w:ins\b/g),
    trackedDeletions: count(/<w:del\b/g),
    footnotes: count(/<w:footnote\b[^>]*w:id="(?!-1|0)\d+"/g),
    textBoxes: count(/<w:txbxContent\b/g),
    uniqueFormattingRuns: rPrSet.size,
    visibleParagraphs,
  };
}

/**
 * Convert a .docx file to PDF, plain UTF-8 text, and per-page PNG images using LibreOffice + pdftoppm.
 */
export function renderDocxWithLibreOffice(docxPath, outDir, prefix) {
  fs.mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: "/tmp",
    XDG_CONFIG_HOME: "/tmp/lo-eval-cfg",
    XDG_CACHE_HOME: "/tmp/lo-eval-cache",
  };

  let openedCleanly = true;
  let error = null;
  let pdfPath = null;
  let txtPath = null;
  let pngPaths = [];

  try {
    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outDir, docxPath], {
      env,
      stdio: "pipe",
      timeout: 60_000,
    });
    const stem = path.basename(docxPath, path.extname(docxPath));
    pdfPath = path.join(outDir, `${stem}.pdf`);

    execFileSync(
      "soffice",
      ["--headless", "--convert-to", "txt:Text (encoded):UTF8", "--outdir", outDir, docxPath],
      { env, stdio: "pipe", timeout: 60_000 }
    );
    txtPath = path.join(outDir, `${stem}.txt`);

    if (fs.existsSync(pdfPath)) {
      const pngPrefix = path.join(outDir, `${prefix}-page`);
      execFileSync("pdftoppm", ["-png", "-r", "150", pdfPath, pngPrefix], {
        stdio: "pipe",
        timeout: 60_000,
      });
      pngPaths = fs
        .readdirSync(outDir)
        .filter((f) => f.startsWith(`${prefix}-page`) && f.endsWith(".png"))
        .sort()
        .map((f) => path.join(outDir, f));
    }
  } catch (err) {
    openedCleanly = false;
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    openedCleanly,
    error,
    pdfPath,
    txtPath,
    plainText: txtPath && fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8") : "",
    pngPaths,
  };
}

/**
 * Measure source-language text leakage on translated DOCX paragraphs (excluding DNT terms & short tokens).
 */
export function measureDocxSourceLeakage(sourceParagraphs, targetParagraphs, dntTerms = []) {
  const srcSet = new Set(sourceParagraphs.map((s) => s.trim()).filter((s) => s.length >= 12));
  const leaked = [];
  for (const tp of targetParagraphs) {
    const t = tp.trim();
    if (!srcSet.has(t)) continue;
    let stripped = t;
    for (const d of dntTerms) stripped = stripped.replaceAll(d, "").trim();
    if (/[a-zA-Z]{4,}/.test(stripped)) {
      leaked.push(t);
    }
  }
  return {
    totalSourceParagraphs: sourceParagraphs.length,
    totalTargetParagraphs: targetParagraphs.length,
    leakedCount: leaked.length,
    leakedSamples: leaked.slice(0, 10),
  };
}
