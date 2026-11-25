import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { EVAL_ROOT } from "../config.mjs";

export const PILOT_DOCX_DIR = path.join(EVAL_ROOT, "docx");
export const PILOT_DOCX_PATH = path.join(PILOT_DOCX_DIR, "northstar-policy.docx");

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/**
 * Build a realistic, valid OOXML DOCX document containing:
 * - Styled title & headings, bold/italic/colored inline runs
 * - Body paragraphs with DNT brands (Northstar, Northstar Pay, LedgerVault)
 * - 3x3 pricing & SLA table
 * - Hyperlink (<w:hyperlink>)
 * - Bookmark (<w:bookmarkStart>/<w:bookmarkEnd>)
 * - Reviewer comment (word/comments.xml)
 * - Footnote (word/footnotes.xml)
 * - Tracked changes (<w:ins> visible insertion + <w:del> protected deletion with author/date)
 * - Header & footer with dynamic PAGE field
 */
export function buildPilotDocx({ editedVariant = false } = {}) {
  fs.mkdirSync(PILOT_DOCX_DIR, { recursive: true });

  const extraTopPara = editedVariant
    ? `<w:p><w:r><w:rPr><w:b/><w:color w:val="B91C1C"/></w:rPr><w:t>IMPORTANT UPDATE: Effective next quarter, all Workspace owners must verify billing contacts.</w:t></w:r></w:p>`
    : "";

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${R}>
  <w:body>
    ${extraTopPara}
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1E3A8A"/></w:rPr><w:t>Northstar Billing and Data Retention Policy</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">This policy explains how </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Northstar</w:t></w:r>
      <w:r><w:t xml:space="preserve"> processes subscription payments through </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>Northstar Pay</w:t></w:r>
      <w:r><w:t xml:space="preserve"> and archives compliance records in </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>LedgerVault</w:t></w:r>
      <w:r><w:t>.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>1. Subscription Invoices and Grace Periods</w:t></w:r>
    </w:p>
    <w:p>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t xml:space="preserve">Every Workspace receives an itemized monthly Invoice on the first business day of the billing cycle.</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      <w:r><w:commentReference w:id="0"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">If a payment fails, we retry automatically for </w:t></w:r>
      <w:bookmarkStart w:id="1" w:name="GraceWindow"/>
      <w:r><w:rPr><w:b/></w:rPr><w:t>fourteen calendar days</w:t></w:r>
      <w:bookmarkEnd w:id="1"/>
      <w:r><w:t xml:space="preserve"> before pausing non-essential analytics exports.</w:t></w:r>
      <w:r><w:footnoteReference w:id="1"/></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">Review full tax documentation on the </w:t></w:r>
      <w:hyperlink r:id="rIdHelp"><w:r><w:rPr><w:color w:val="2563EB"/><w:u w:val="single"/></w:rPr><w:t>Northstar Help Center</w:t></w:r></w:hyperlink>
      <w:r><w:t xml:space="preserve"> before submitting an exemption certificate.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>2. Service Tiers and Retention Schedule</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Plan Tier</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Audit Log Retention</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Support Response Target</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Starter Workspace</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Ninety days of searchable activity</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Two business days via email</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Enterprise Workspace</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Seven years in LedgerVault</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Four hours with priority escalation</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>3. Approved Legal Revisions</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t xml:space="preserve">The compliance committee </w:t></w:r>
      <w:ins w:id="10" w:author="Legal Team" w:date="2026-06-15T10:00:00Z"><w:r><w:t xml:space="preserve">formally </w:t></w:r></w:ins>
      <w:del w:id="11" w:author="Legal Team" w:date="2026-06-15T10:05:00Z"><w:r><w:delText xml:space="preserve">provisionally </w:delText></w:r></w:del>
      <w:r><w:t>approved quarterly deletion audits for inactive merchant accounts.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Account owners may request immediate deletion of archived exports after settling every open Invoice.</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Security notifications are delivered to the primary administrator and recorded in PulseGrid.</w:t></w:r>
    </w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHdr"/>
      <w:footerReference w:type="default" r:id="rIdFtr"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${W}>
  <w:p><w:r><w:t>Northstar Commerce — Customer Billing Policy</w:t></w:r></w:p>
</w:hdr>`;

  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr ${W}>
  <w:p>
    <w:r><w:t xml:space="preserve">Confidential policy summary — Page </w:t></w:r>
    <w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>
  </w:p>
</w:ftr>`;

  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>
  <w:comment w:id="0" w:author="Finance Reviewer" w:date="2026-06-12T09:00:00Z" w:initials="FR">
    <w:p><w:r><w:t>Confirm whether annual invoices follow the same first-business-day schedule.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;

  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${W}>
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1">
    <w:p><w:r><w:t>Grace period reminders are sent automatically on day three, day seven, and day twelve.</w:t></w:r></w:p>
  </w:footnote>
</w:footnotes>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rIdFtr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
  <Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdHelp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://help.northstar.example/taxes" TargetMode="External"/>
</Relationships>`;

  const bytes = zipSync({
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(rootRelsXml),
    "word/_rels/document.xml.rels": strToU8(docRelsXml),
    "word/document.xml": strToU8(docXml),
    "word/header1.xml": strToU8(headerXml),
    "word/footer1.xml": strToU8(footerXml),
    "word/comments.xml": strToU8(commentsXml),
    "word/footnotes.xml": strToU8(footnotesXml),
  });

  const outPath = editedVariant
    ? path.join(PILOT_DOCX_DIR, "northstar-policy-v2.docx")
    : PILOT_DOCX_PATH;
  fs.writeFileSync(outPath, bytes);
  return outPath;
}
