import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { EVAL_ROOT } from "../config.mjs";
import { buildPilotDocx, PILOT_DOCX_DIR, PILOT_DOCX_PATH } from "./build-pilot-docx.mjs";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const WPS = 'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';

function makePackage({ docXml, headerXml, footerXml, commentsXml, footnotesXml, extraRels = "" }) {
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}
  ${footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ""}
  ${commentsXml ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ""}
  ${footnotesXml ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ""}
</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${headerXml ? '<Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ""}
  ${footerXml ? '<Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ""}
  ${commentsXml ? '<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ""}
  ${footnotesXml ? '<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>' : ""}
  ${extraRels}
</Relationships>`),
    "word/document.xml": strToU8(docXml),
  };
  if (headerXml) files["word/header1.xml"] = strToU8(headerXml);
  if (footerXml) files["word/footer1.xml"] = strToU8(footerXml);
  if (commentsXml) files["word/comments.xml"] = strToU8(commentsXml);
  if (footnotesXml) files["word/footnotes.xml"] = strToU8(footnotesXml);
  return zipSync(files);
}

/**
 * Doc 2 (-> ja): Public-domain-style Government Grant Application Form (SF-424 style)
 * Contains tables, inline content controls (w:sdt), checkboxes, headers/footers with PAGE field.
 */
function buildGovGrantForm() {
  const outPath = path.join(PILOT_DOCX_DIR, "gov-grant-form.docx");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${R}>
  <w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Public Research Grant Application — Form SF-424</w:t></w:r></w:p>
    <w:p><w:r><w:t>Complete all required sections in plain language and submit through GrantsPortal before the published federal deadline.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Section A: Applicant Organization Details</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Field Name</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Filing Instruction</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Legal Entity Name</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:sdt><w:sdtContent><w:r><w:t>Enter the registered legal name matching tax records.</w:t></w:r></w:sdtContent></w:sdt></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Requested Federal Funding</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Round all direct and indirect costs to the nearest whole dollar.</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Project Performance Period</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Specify start and end dates spanning up to thirty-six months.</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Section B: Compliance Certification</w:t></w:r></w:p>
    <w:p><w:r><w:t>By signing this form, the authorized representative certifies that all financial disclosures are true, complete, and accurate.</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Late or incomplete applications will </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>not</w:t></w:r><w:r><w:t xml:space="preserve"> be forwarded for peer review.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Applicants must retain supporting payroll and equipment receipts for three years after final closeout.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Questions regarding eligibility may be directed to the Office of Sponsored Programs during regular business hours.</w:t></w:r></w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/></w:sectPr>
  </w:body>
</w:document>`;
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p><w:r><w:t>OMB Approved Form SF-424 — Public Domain Template</w:t></w:r></w:p></w:hdr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">Public Notice Form — Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, makePackage({ docXml, headerXml, footerXml }));
  return {
    id: "gov-grant-form",
    path: outPath,
    targetLocale: "ja",
    dntTerms: ["Form SF-424", "GrantsPortal", "OMB"],
    glossary: [
      { term: "Form SF-424", doNotTranslate: true, caseSensitive: true, translations: {} },
      { term: "GrantsPortal", doNotTranslate: true, caseSensitive: true, translations: {} },
    ],
  };
}

/**
 * Doc 3 (-> ar, RTL!): Open-licensed Sustainability & Infrastructure Report
 * Contains bold/italic/colored callouts, table, hyperlink, bookmark, footnote, and text box.
 */
function buildOpenAnnualReport() {
  const outPath = path.join(PILOT_DOCX_DIR, "open-sustainability-report.docx");
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${R} ${WP} ${A} ${WPS}>
  <w:body>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="065F46"/></w:rPr><w:t>2026 Open Climate and Data Center Efficiency Report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Published under Creative Commons Attribution 4.0 International by the OpenGrid Consortium.</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Executive Summary</w:t></w:r></w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Regional compute clusters reduced average water consumption by </w:t></w:r>
      <w:bookmarkStart w:id="2" w:name="WaterReduction"/>
      <w:r><w:rPr><w:b/><w:color w:val="047857"/></w:rPr><w:t>twenty-eight percent</w:t></w:r>
      <w:bookmarkEnd w:id="2"/>
      <w:r><w:t xml:space="preserve"> compared to the previous baseline year.</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Raw telemetry datasets remain freely downloadable from the </w:t></w:r>
      <w:hyperlink r:id="rIdOpen"><w:r><w:rPr><w:color w:val="1D4ED8"/><w:u w:val="single"/></w:rPr><w:t>OpenGrid Data Archive</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> for independent verification.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Region</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Renewable Share</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Annual PUE</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Northern Europe Hub</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Ninety-four percent hydro and wind</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>1.14 measured average</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Middle East Solar Cluster</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Seventy-six percent utility solar</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>1.26 measured average</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r>
        <w:drawing>
          <wp:inline>
            <a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent>
              <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Key Takeaway: Heat recovery loops supplied warm water to three municipal buildings throughout winter.</w:t></w:r></w:p>
            </w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p><w:r><w:t>Quarterly third-party audits confirm zero unverified carbon offsets were included in operational totals.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W}>
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>Baseline measurements reflect metered municipal intake across all twelve calendar months.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  const extraRels = `<Relationship Id="rIdOpen" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://opengrid.example/data" TargetMode="External"/>`;
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, makePackage({ docXml, footnotesXml, extraRels }));
  return {
    id: "open-sustainability-report",
    path: outPath,
    targetLocale: "ar",
    dntTerms: ["OpenGrid", "Creative Commons", "PUE"],
    glossary: [
      { term: "OpenGrid", doNotTranslate: true, caseSensitive: true, translations: {} },
    ],
  };
}

/**
 * Doc 4 (-> pl): Complex Revisions & Incremental Edit Document
 * Has tracked changes (w:ins + w:del), reviewer comments, footnotes, tables, fields, hyperlinks,
 * PLUS a v2 edited source variant to test Polyglot's mid-batch incremental update!
 */
function buildRevisionsDoc({ editedVariant = false } = {}) {
  const outPath = path.join(
    PILOT_DOCX_DIR,
    editedVariant ? "libreoffice-revisions-v2.docx" : "libreoffice-revisions.docx"
  );
  const topInsertion = editedVariant
    ? `<w:p><w:r><w:rPr><w:b/><w:color w:val="991B1B"/></w:rPr><w:t>URGENT AMENDMENT: Emergency maintenance windows require forty-eight hours of advance notice.</w:t></w:r></w:p>`
    : "";
  const para2Text = editedVariant
    ? "All production clusters must complete encrypted off-site backups every six hours without interruption."
    : "All production clusters must complete encrypted off-site backups every twelve hours without interruption.";

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${R}>
  <w:body>
    ${topInsertion}
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Platform Security and Incident Response Standard</w:t></w:r></w:p>
    <w:p><w:r><w:t>${para2Text}</w:t></w:r></w:p>
    <w:p>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t xml:space="preserve">On-call engineers must acknowledge Severity 1 incidents within </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>fifteen minutes</w:t></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:commentReference w:id="1"/></w:r>
      <w:r><w:t xml:space="preserve"> and publish a customer status update.</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">The security board </w:t></w:r>
      <w:ins w:id="20" w:author="Security Lead" w:date="2026-07-01T08:00:00Z"><w:r><w:t xml:space="preserve">unanimously </w:t></w:r></w:ins>
      <w:del w:id="21" w:author="Security Lead" w:date="2026-07-01T08:02:00Z"><w:r><w:delText xml:space="preserve">temporarily </w:delText></w:r></w:del>
      <w:r><w:t>mandated hardware security keys for all production SSH sessions.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Severity Level</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Customer Communication Cadence</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Severity 1 — Critical Outage</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Every thirty minutes until mitigated</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Severity 2 — Degraded Service</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Every two hours until resolved</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r><w:t xml:space="preserve">Post-incident root-cause reports are archived in </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>LedgerVault</w:t></w:r>
      <w:r><w:t xml:space="preserve"> and linked from the </w:t></w:r>
      <w:hyperlink r:id="rIdSec"><w:r><w:rPr><w:color w:val="2563EB"/><w:u w:val="single"/></w:rPr><w:t>Northstar Trust Portal</w:t></w:r></w:hyperlink>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t>Unresolved action items are reviewed weekly by engineering leadership.</w:t></w:r></w:p>
    <w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:footerReference w:type="default" r:id="rIdFtr"/></w:sectPr>
  </w:body>
</w:document>`;
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p><w:r><w:t>Northstar Security Standard — Internal &amp; Auditor Copy</w:t></w:r></w:p></w:hdr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">Controlled Revision — Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="1" w:author="SRE Manager" w:date="2026-07-02T12:00:00Z" w:initials="SM"><w:p><w:r><w:t>Verify whether pager escalation includes secondary European rotations.</w:t></w:r></w:p></w:comment></w:comments>`;
  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Clock starts when automated monitoring opens the incident ticket.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const extraRels = `<Relationship Id="rIdSec" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://trust.northstar.example" TargetMode="External"/>`;
  if (!fs.existsSync(outPath)) {
    fs.writeFileSync(outPath, makePackage({ docXml, headerXml, footerXml, commentsXml, footnotesXml, extraRels }));
  }
  return outPath;
}

export function buildAllDocxCorpus() {
  if (!fs.existsSync(PILOT_DOCX_PATH)) buildPilotDocx();
  const doc2 = buildGovGrantForm();
  const doc3 = buildOpenAnnualReport();
  const doc4Path = buildRevisionsDoc({ editedVariant: false });
  const doc4v2Path = buildRevisionsDoc({ editedVariant: true });

  return [
    {
      id: "northstar-policy",
      path: PILOT_DOCX_PATH,
      targetLocale: "de",
      alreadyInPilot: true,
      dntTerms: ["Northstar", "Northstar Pay", "PulseGrid", "LedgerVault"],
      glossary: [
        { term: "Northstar", doNotTranslate: true, caseSensitive: true, translations: {} },
        { term: "Northstar Pay", doNotTranslate: true, caseSensitive: true, translations: {} },
        { term: "PulseGrid", doNotTranslate: true, caseSensitive: true, translations: {} },
        { term: "LedgerVault", doNotTranslate: true, caseSensitive: true, translations: {} },
        { term: "Workspace", doNotTranslate: false, caseSensitive: false, translations: { de: "Arbeitsbereich" } },
        { term: "Invoice", doNotTranslate: false, caseSensitive: false, translations: { de: "Rechnung" } },
      ],
    },
    doc2,
    doc3,
    {
      id: "libreoffice-revisions",
      path: doc4Path,
      v2Path: doc4v2Path,
      targetLocale: "pl",
      dntTerms: ["Northstar", "LedgerVault", "SSH"],
      glossary: [
        { term: "Northstar", doNotTranslate: true, caseSensitive: true, translations: {} },
        { term: "LedgerVault", doNotTranslate: true, caseSensitive: true, translations: {} },
      ],
    },
  ];
}
