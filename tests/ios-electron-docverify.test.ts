import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { runCheck } from "../src/core/check.js";
import { initProject } from "../src/core/init.js";
import { prepareBatch } from "../src/core/prepare.js";
import { scanProject } from "../src/core/scan.js";
import { countPdfPages, verifyDocumentFormatting } from "../src/documents/verify.js";

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

function createValidDocx(filePath: string, paragraphs: string[]): void {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`
    ),
  };
  fs.writeFileSync(filePath, zipSync(entries, { level: 6 }));
}

function createXlsxWithFormula(filePath: string, formula: string): void {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData><row r="1"><c r="A1"><f>${formula}</f><v>10</v></c></row></sheetData>
</worksheet>`
    ),
  };
  fs.writeFileSync(filePath, zipSync(entries, { level: 6 }));
}

describe("iOS .xcstrings, Electron, and Nuanced Document Formatting Verification", () => {
  it("supports iOS/macOS Localizable.xcstrings multi-locale catalogs losslessly", () => {
    const dir = mkTmp("wraith-ios-");
    fs.mkdirSync(path.join(dir, "Sources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Package.swift"), `// swift-tools-version: 5.9\n`);
    fs.writeFileSync(
      path.join(dir, "Sources/Localizable.xcstrings"),
      JSON.stringify(
        {
          sourceLanguage: "en",
          version: "1.0",
          strings: {
            "Northstar": { shouldTranslate: false },
            "Save": {
              comment: "Saves document changes, not money",
              localizations: {
                fr: { stringUnit: { state: "translated", value: "Enregistrer" } },
              },
            },
            "Hello, %@!": {
              comment: "Greeting with user name",
            },
          },
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(dir, "Sources/ContentView.swift"),
      `import SwiftUI
struct ContentView: View {
  var body: some View {
    VStack {
      Text("Hello, %@!")
      Button(String(localized: "Save")) {}
    }
  }
}
`
    );

    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("ios");
    expect(scan.counts.trackedKeys).toBe(2);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    // `shouldTranslate: false` key "Northstar" must be excluded
    expect(prep.items.map((i) => i.key).sort()).toEqual(["Hello, %@!", "Save"]);
    expect(prep.items.find((i) => i.key === "Save")?.comment).toBe("Saves document changes, not money");

    const apply = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "Save", value: "Speichern" },
        { key: "Hello, %@!", value: "Hallo, %@!" },
      ],
    });
    expect(apply.appliedCount).toBe(2);

    // Existing French localization and shouldTranslate: false must be preserved losslessly
    const catalog = JSON.parse(fs.readFileSync(path.join(dir, "Sources/Localizable.xcstrings"), "utf8"));
    expect(catalog.strings["Northstar"].shouldTranslate).toBe(false);
    expect(catalog.strings["Save"].localizations.fr.stringUnit.value).toBe("Enregistrer");
    expect(catalog.strings["Save"].localizations.de.stringUnit.value).toBe("Speichern");

    const check = runCheck({ rootDir: dir, locale: "de" });
    expect(check.outcome).toBe("PASS");
    expect(check.errorCount).toBe(0);
  });

  it("detects, scans, prepares, applies, and checks an Electron desktop app", () => {
    const dir = mkTmp("wraith-electron-");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "desktop-app", devDependencies: { electron: "^33.0.0" }, dependencies: { i18next: "^23.0.0" } })
    );
    fs.writeFileSync(
      path.join(dir, "locales/en.json"),
      JSON.stringify({ menu: { quit: "Quit" } }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(dir, "src/main.ts"),
      `import i18next from "i18next";\nexport function quitLabel() { return i18next.t("menu.quit"); }\n`
    );

    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("electron");
    expect(scan.counts.trackedKeys).toBe(1);

    const apply = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "menu.quit", value: "Beenden" }],
    });
    expect(apply.appliedCount).toBe(1);

    const check = runCheck({ rootDir: dir, locale: "de" });
    expect(check.outcome).toBe("PASS");
  });

  it("verifies DOCX reflow nuance (page growth is info, not error, unless maxPages is set) and XLSX formula integrity", () => {
    const dir = mkTmp("wraith-doc-verify-");
    expect(countPdfPages(Buffer.from("%PDF-1.4\n/Type /Pages /Count 2\n/Type /Page\n/Type /Page\n"))).toBe(2);

    // 1. XLSX formula mismatch fails loudly even without LibreOffice
    const xlsxSrc = path.join(dir, "src.xlsx");
    const xlsxBad = path.join(dir, "bad.xlsx");
    createXlsxWithFormula(xlsxSrc, "SUM(A2:A10)");
    createXlsxWithFormula(xlsxBad, "SUM(A2:A9)");
    const xlsxRes = verifyDocumentFormatting({ sourceFile: xlsxSrc, targetFile: xlsxBad });
    expect(xlsxRes.outcome).toBe("FAIL");
    expect(xlsxRes.findings.some((f) => f.code === "xlsx_formula_mismatch")).toBe(true);

    // 2. DOCX reflow nuance: 1-page English letter expanding to 2-page German letter PASSES by default,
    //    and FAILS only when an explicit maxPages: 1 budget is opted into!
    const docxEn = path.join(dir, "letter-en.docx");
    const docxDe = path.join(dir, "letter-de.docx");
    createValidDocx(docxEn, ["Dear Patient, your appointment is confirmed."]);
    createValidDocx(
      docxDe,
      Array.from({ length: 75 }, (_, i) => `Absatz ${i + 1}: Sehr geehrte Patientin, sehr geehrter Patient, Ihr Termin wurde bestätigt.`)
    );

    const reflowRes = verifyDocumentFormatting({ sourceFile: docxEn, targetFile: docxDe });
    if (reflowRes.libreOfficeAvailable) {
      expect(reflowRes.sourcePages).toBe(1);
      expect((reflowRes.targetPages ?? 0) > 1).toBe(true);
      expect(reflowRes.outcome).toBe("PASS");
      expect(reflowRes.findings.some((f) => f.code === "doc_reflow_info" && f.severity === "info")).toBe(true);

      // Explicit fixed-page flyer budget fails when exceeded
      const fixedRes = verifyDocumentFormatting({ sourceFile: docxEn, targetFile: docxDe, maxPages: 1 });
      expect(fixedRes.outcome).toBe("FAIL");
      expect(fixedRes.findings.some((f) => f.code === "doc_page_budget_exceeded")).toBe(true);
    } else {
      expect(reflowRes.outcome).toBe("INCONCLUSIVE");
    }
  }, 60_000);
});
