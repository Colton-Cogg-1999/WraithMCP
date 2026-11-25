import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  initProject,
  prepareDocument,
  runCheck,
} from "../src/index.js";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-doc-id-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`
    ),
  });
}

function readDocxParagraphs(file: string): string[] {
  const xml = strFromU8(unzipSync(fs.readFileSync(file))["word/document.xml"]);
  return [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("")
  );
}

describe("Document content-derived segment identity (B1, B2, N5)", () => {
  it("keeps DOCX translations attached to their source content after deletion and reordering between batches", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "guide.docx"),
      makeDocx([
        "First chapter overview.",
        "Second chapter installation.",
        "Third chapter configuration.",
        "Fourth chapter troubleshooting.",
      ])
    );
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"] });

    // Batch 1: translate paragraphs 1, 2, 3
    const p1 = prepareDocument(dir, { documentPath: "guide.docx", targetLocale: "fr", limit: 3 });
    const res1 = applyDocumentTranslations(dir, {
      sourceFile: "guide.docx",
      targetFile: "guide.fr.docx",
      targetLocale: "fr",
      updates: [
        { id: p1.segments[0].id, text: "Aperçu du premier chapitre." },
        { id: p1.segments[1].id, text: "Installation du deuxième chapitre." },
        { id: p1.segments[2].id, text: "Configuration du troisième chapitre." },
      ],
    });
    expect(res1.ok).toBe(true);

    // Author DELETES paragraph 2 ("Second chapter...") and REORDERS paragraph 3 before paragraph 1!
    fs.writeFileSync(
      path.join(dir, "guide.docx"),
      makeDocx([
        "Third chapter configuration.",
        "First chapter overview.",
        "Fourth chapter troubleshooting.",
      ])
    );

    const p2 = prepareDocument(dir, { documentPath: "guide.docx", targetLocale: "fr", limit: 10 });
    expect(p2.translatedSegments).toBe(2);
    expect(p2.untranslatedSegments).toBe(1);
    expect(p2.segments[0].status).toBe("translated");
    expect(p2.segments[1].status).toBe("translated");
    expect(p2.segments[2].status).toBe("untranslated");

    // Batch 2: translate only the remaining paragraph 4
    const res2 = applyDocumentTranslations(dir, {
      sourceFile: "guide.docx",
      targetFile: "guide.fr.docx",
      targetLocale: "fr",
      updates: [{ id: p2.segments[2].id, text: "Dépannage du quatrième chapitre." }],
    });
    expect(res2.ok).toBe(true);

    expect(readDocxParagraphs(path.join(dir, "guide.fr.docx"))).toEqual([
      "Configuration du troisième chapitre.",
      "Aperçu du premier chapitre.",
      "Dépannage du quatrième chapitre.",
    ]);
  });

  it("handles Markdown deletion, reordering, source edits (stale in prepare/check), and manual target edits", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "handbook.md"),
      "# Onboarding\n\nWelcome to the engineering team.\n\nSet up your local workspace.\n\nShip your first patch.\n"
    );
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es"] });
    const cfgPath = path.join(dir, ".wraith/config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.paths.documents = ["handbook.md"];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    // Batch 1: translate first 3 segments
    const batch1 = prepareDocument(dir, { documentPath: "handbook.md", targetLocale: "es", limit: 3 });
    expect(
      applyDocumentTranslations(dir, {
        sourceFile: "handbook.md",
        targetFile: "handbook.es.md",
        targetLocale: "es",
        updates: [
          { id: batch1.segments[0].id, text: "Incorporación" },
          { id: batch1.segments[1].id, text: "Bienvenido al equipo de ingeniería." },
          { id: batch1.segments[2].id, text: "Configura tu espacio de trabajo local." },
        ],
      }).ok
    ).toBe(true);

    // Human reviewer polishes paragraph 2 directly in handbook.es.md
    const esPath = path.join(dir, "handbook.es.md");
    fs.writeFileSync(
      esPath,
      fs.readFileSync(esPath, "utf8").replace(
        "Bienvenido al equipo de ingeniería.",
        "Te damos la bienvenida al equipo de ingeniería."
      )
    );

    // Author deletes paragraph 3, edits paragraph 4, and moves heading after paragraph 2
    fs.writeFileSync(
      path.join(dir, "handbook.md"),
      "# Onboarding\n\nWelcome to the engineering team.\n\nShip your first verified patch.\n"
    );

    // Batch 2: translate the last paragraph
    const batch2 = prepareDocument(dir, { documentPath: "handbook.md", targetLocale: "es", limit: 10 });
    expect(batch2.segments[1].manuallyEdited).toBe(true);
    expect(batch2.segments[1].currentTranslation).toBe("Te damos la bienvenida al equipo de ingeniería.");

    expect(
      applyDocumentTranslations(dir, {
        sourceFile: "handbook.md",
        targetFile: "handbook.es.md",
        targetLocale: "es",
        updates: [{ id: batch2.segments[2].id, text: "Envía tu primer parche verificado." }],
      }).ok
    ).toBe(true);

    const esContent = fs.readFileSync(esPath, "utf8");
    expect(esContent).toContain("# Incorporación");
    expect(esContent).toContain("Te damos la bienvenida al equipo de ingeniería.");
    expect(esContent).toContain("Envía tu primer parche verificado.");
    expect(runCheck({ rootDir: dir }).outcome).toBe("PASS");

    // Now edit a previously translated source paragraph in-place
    fs.writeFileSync(
      path.join(dir, "handbook.md"),
      "# Onboarding\n\nWelcome to the platform engineering team.\n\nShip your first verified patch.\n"
    );

    const afterEditPrep = prepareDocument(dir, { documentPath: "handbook.md", targetLocale: "es", limit: 10 });
    expect(afterEditPrep.staleSegments).toBe(1);
    expect(afterEditPrep.segments[1].status).toBe("stale");
    expect(afterEditPrep.segments[1].previousSource).toBe("Welcome to the engineering team.");

    const chkStale = runCheck({ rootDir: dir });
    expect(chkStale.outcome).toBe("FAIL");
    expect(chkStale.countsByCode["stale_source"]).toBe(1);

    // Re-translating resolves staleness and restores PASS
    expect(
      applyDocumentTranslations(dir, {
        sourceFile: "handbook.md",
        targetFile: "handbook.es.md",
        targetLocale: "es",
        updates: [
          {
            id: afterEditPrep.segments[1].id,
            text: "Te damos la bienvenida al equipo de ingeniería de plataforma.",
          },
        ],
      }).ok
    ).toBe(true);
    expect(runCheck({ rootDir: dir }).outcome).toBe("PASS");
  });
});
