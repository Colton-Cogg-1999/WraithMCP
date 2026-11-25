import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, zipSync } from "fflate";
import { applyTranslations } from "./apply.js";
import { parseCsv } from "./importers.js";
import { generateReport } from "./report.js";
import {
  atomicWriteFileSync,
  isValidLocaleTag,
  resolveConfinedPath,
  safeUnzipSync,
  validateLocaleTag,
} from "./security.js";
import { PolyglotStore } from "./store.js";

export interface EscalationRow {
  locale: string;
  key: string;
  source: string;
  translation: string;
  context: string;
  reason: string;
  suggestion: string;
  corrected_translation: string;
  reviewer_notes: string;
}

const HEADERS: (keyof EscalationRow)[] = [
  "locale",
  "key",
  "source",
  "translation",
  "context",
  "reason",
  "suggestion",
  "corrected_translation",
  "reviewer_notes",
];

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function htmlEscape(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colLetter(colIdx: number): string {
  let n = colIdx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Generate a minimal, standards-compliant OOXML .xlsx workbook using fflate (pure MIT).
 * Uses inline strings so it requires no sharedStrings table and round-trips cleanly.
 */
export function buildXlsxBuffer(rows: EscalationRow[]): Uint8Array {
  const sheetRows: string[] = [];

  // Header row (row 1)
  const headerCells = HEADERS.map(
    (h, c) =>
      `<c r="${colLetter(c)}1" t="inlineStr" s="1"><is><t>${xmlEscape(h)}</t></is></c>`
  ).join("");
  sheetRows.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, idx) => {
    const rNum = idx + 2;
    const cells = HEADERS.map((h, c) => {
      const val = row[h] ?? "";
      return `<c r="${colLetter(c)}${rNum}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(val)}</t></is></c>`;
    }).join("");
    sheetRows.push(`<row r="${rNum}">${cells}</row>`);
  });

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows.join("")}</sheetData>
</worksheet>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Review" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypesXml),
      "_rels/.rels": strToU8(rootRelsXml),
      "xl/workbook.xml": strToU8(workbookXml),
      "xl/_rels/workbook.xml.rels": strToU8(wbRelsXml),
      "xl/styles.xml": strToU8(stylesXml),
      "xl/worksheets/sheet1.xml": strToU8(sheetXml),
    },
    { level: 6 }
  );
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function colRefToIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, "");
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/** Parse rows back out of an .xlsx file (supports both inlineStr and sharedStrings). */
export function parseXlsxBuffer(buf: Uint8Array): string[][] {
  const files = safeUnzipSync(buf);
  const sharedStrings: string[] = [];
  if (files["xl/sharedStrings.xml"]) {
    const ssXml = strFromU8(files["xl/sharedStrings.xml"]);
    for (const m of ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
      sharedStrings.push(parts.join(""));
    }
  }

  const sheetBytes = files["xl/worksheets/sheet1.xml"];
  if (!sheetBytes) return [];
  const sheetXml = strFromU8(sheetBytes);

  const table: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowArr: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const rAttr = /\br="([A-Z]+\d+)"/.exec(attrs);
      const tAttr = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
      const colIdx = rAttr ? colRefToIndex(rAttr[1]) : rowArr.length;

      let value = "";
      if (tAttr === "s") {
        const vMatch = /<v>(\d+)<\/v>/.exec(body);
        value = vMatch ? (sharedStrings[Number.parseInt(vMatch[1], 10)] ?? "") : "";
      } else if (tAttr === "inlineStr") {
        const parts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
        value = parts.join("");
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vMatch ? decodeXml(vMatch[1]) : "";
      }
      rowArr[colIdx] = value;
    }
    table.push(rowArr.map((v) => v ?? ""));
  }
  return table;
}

function buildReviewHtml(rows: EscalationRow[]): string {
  const payloadJson = JSON.stringify(rows).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polyglot Localization Review</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 1.35rem; }
  .meta { color: #475569; font-size: 0.9rem; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; }
  button, select { padding: 8px 14px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; font-size: 0.9rem; }
  button.primary { background: #0f172a; color: #fff; border-color: #0f172a; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  th, td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; font-size: 0.9rem; }
  th { background: #f1f5f9; font-weight: 600; color: #334155; }
  code { font-family: ui-monospace, monospace; font-size: 0.82rem; background: #f1f5f9; padding: 2px 5px; border-radius: 4px; }
  .reason { color: #b45309; font-size: 0.85rem; }
  .context { color: #64748b; font-size: 0.82rem; }
  textarea { width: 100%; min-height: 44px; padding: 6px; border: 1px solid #cbd5e1; border-radius: 4px; font-family: inherit; font-size: 0.9rem; box-sizing: border-box; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Polyglot Native-Speaker Review</h1>
    <div class="meta">${rows.length} flagged string(s) · Edit any correction below, then download JSON or CSV and send it back to the developer.</div>
  </div>
  <div class="controls">
    <select id="localeFilter"><option value="">All locales</option></select>
    <button onclick="downloadCsv()">Export Corrections CSV</button>
    <button class="primary" onclick="downloadJson()">Export Corrections JSON</button>
  </div>
</header>
<table>
  <thead>
    <tr><th>Locale / Key</th><th>Source</th><th>Current Translation</th><th>Why Flagged &amp; Context</th><th>Your Correction</th><th>Notes</th></tr>
  </thead>
  <tbody id="tbody"></tbody>
</table>
<script>
const ROWS = ${payloadJson};
const locales = [...new Set(ROWS.map(r => r.locale))].sort();
const sel = document.getElementById('localeFilter');
locales.forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); });
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function render() {
  const f = sel.value;
  const tb = document.getElementById('tbody');
  tb.innerHTML = '';
  ROWS.forEach((r, i) => {
    if (f && r.locale !== f) return;
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td><strong>\${esc(r.locale)}</strong><br><code>\${esc(r.key)}</code></td>
      <td>\${esc(r.source)}</td>
      <td>\${esc(r.translation)}</td>
      <td><div class="reason">\${esc(r.reason)}</div><div class="context">\${esc(r.context)}</div></td>
      <td><textarea data-idx="\${i}" data-field="corrected_translation" placeholder="Leave blank if current is OK">\${esc(r.corrected_translation || r.suggestion)}</textarea></td>
      <td><textarea data-idx="\${i}" data-field="reviewer_notes" placeholder="Optional note">\${esc(r.reviewer_notes)}</textarea></td>\`;
    tb.appendChild(tr);
  });
  tb.querySelectorAll('textarea').forEach(el => {
    el.addEventListener('input', e => {
      const idx = Number(e.target.dataset.idx);
      ROWS[idx][e.target.dataset.field] = e.target.value;
    });
  });
}
sel.addEventListener('change', render);
render();
function saveFile(name, mime, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = name;
  a.click();
}
function downloadJson() { saveFile('polyglot-corrections.json', 'application/json', JSON.stringify(ROWS, null, 2)); }
function downloadCsv() {
  const cols = ${JSON.stringify(HEADERS)};
  const escCsv = v => /[",\\r\\n]/.test(v||'') ? '"' + String(v).replace(/"/g,'""') + '"' : String(v||'');
  const lines = [cols.join(','), ...ROWS.map(r => cols.map(c => escCsv(r[c])).join(','))];
  saveFile('polyglot-corrections.csv', 'text/csv;charset=utf-8', '\\uFEFF' + lines.join('\\n'));
}
</script>
</body>
</html>
`;
}

export interface EscalateExportResult {
  flaggedCount: number;
  filesWritten: string[];
  rows: EscalationRow[];
}

export function exportEscalation(
  rootDir: string,
  options?: {
    outputDir?: string;
    locale?: string;
    formats?: Array<"csv" | "xlsx" | "html">;
  }
): EscalateExportResult {
  const store = new PolyglotStore(rootDir);
  const report = generateReport(store.rootDir);
  const reviews = store.readReviews();
  const suggestionMap = new Map<string, string>();
  for (const r of reviews.reviews) {
    if (r.status === "open" && r.suggestion) {
      suggestionMap.set(`${r.locale}|${r.key}`, r.suggestion);
    }
  }

  let rows: EscalationRow[] = report.reviewList.map((item) => ({
    locale: item.locale,
    key: item.key,
    source: item.source,
    translation: item.translation,
    context: item.context ?? "",
    reason: item.reason,
    suggestion: suggestionMap.get(`${item.locale}|${item.key}`) ?? "",
    corrected_translation: "",
    reviewer_notes: "",
  }));

  if (options?.locale) {
    validateLocaleTag(options.locale, "locale");
    rows = rows.filter((r) => r.locale === options.locale);
  }

  const outDir = resolveConfinedPath(
    store.rootDir,
    options?.outputDir ?? ".polyglot/escalations",
    { label: "escalate outputDir" }
  );
  fs.mkdirSync(outDir, { recursive: true });
  const formats = options?.formats ?? ["csv", "xlsx", "html"];
  const filesWritten: string[] = [];

  if (formats.includes("csv")) {
    const lines = [
      HEADERS.join(","),
      ...rows.map((r) => HEADERS.map((h) => csvEscape(r[h])).join(",")),
    ];
    const csvPath = resolveConfinedPath(store.rootDir, path.join(outDir, "polyglot-review.csv"), {
      label: "csv export",
    });
    atomicWriteFileSync(csvPath, "\uFEFF" + lines.join("\n") + "\n");
    filesWritten.push(path.relative(store.rootDir, csvPath).replace(/\\/g, "/"));
  }

  if (formats.includes("xlsx")) {
    const xlsxPath = resolveConfinedPath(store.rootDir, path.join(outDir, "polyglot-review.xlsx"), {
      label: "xlsx export",
    });
    atomicWriteFileSync(xlsxPath, buildXlsxBuffer(rows));
    filesWritten.push(path.relative(store.rootDir, xlsxPath).replace(/\\/g, "/"));
  }

  if (formats.includes("html")) {
    const htmlPath = resolveConfinedPath(store.rootDir, path.join(outDir, "polyglot-review.html"), {
      label: "html export",
    });
    atomicWriteFileSync(htmlPath, buildReviewHtml(rows));
    filesWritten.push(path.relative(store.rootDir, htmlPath).replace(/\\/g, "/"));
  }

  return {
    flaggedCount: rows.length,
    filesWritten,
    rows,
  };
}

export interface ImportCorrectionsResult {
  file: string;
  appliedCount: number;
  rejectedCount: number;
  resolvedReviews: number;
  localesUpdated: string[];
  errors: Array<{ key: string; locale: string; message: string }>;
}

export function importEscalationCorrections(
  rootDir: string,
  filePath: string
): ImportCorrectionsResult {
  const store = new PolyglotStore(rootDir);
  const abs = resolveConfinedPath(store.rootDir, filePath, { label: "corrections file" });
  const ext = path.extname(abs).toLowerCase();

  let rawObjects: Array<Record<string, string>> = [];
  if (ext === ".json") {
    rawObjects = JSON.parse(fs.readFileSync(abs, "utf8")) as Array<Record<string, string>>;
  } else if (ext === ".xlsx") {
    const table = parseXlsxBuffer(fs.readFileSync(abs));
    if (table.length >= 2) {
      const hdrs = table[0].map((h) => h.trim());
      for (let i = 1; i < table.length; i++) {
        const obj: Record<string, string> = {};
        hdrs.forEach((h, idx) => {
          obj[h] = table[i][idx] ?? "";
        });
        rawObjects.push(obj);
      }
    }
  } else {
    const table = parseCsv(fs.readFileSync(abs, "utf8"));
    if (table.length >= 2) {
      const hdrs = table[0].map((h) => h.trim());
      for (let i = 1; i < table.length; i++) {
        const obj: Record<string, string> = {};
        hdrs.forEach((h, idx) => {
          obj[h] = table[i][idx] ?? "";
        });
        rawObjects.push(obj);
      }
    }
  }

  // Group non-empty corrections by locale; reject untrusted invalid locale values immediately
  const byLocale = new Map<
    string,
    Array<{ key: string; value: string; notes?: string }>
  >();
  const errors: Array<{ key: string; locale: string; message: string }> = [];
  let rejectedCount = 0;

  for (const row of rawObjects) {
    const locale = (row.locale ?? "").trim();
    const key = (row.key ?? "").trim();
    const corrected = (row.corrected_translation ?? row.correction ?? "").trim();
    const notes = (row.reviewer_notes ?? row.notes ?? "").trim() || undefined;
    if (!locale || !key || !corrected) continue;
    if (!isValidLocaleTag(locale)) {
      rejectedCount++;
      errors.push({
        key,
        locale,
        message: `Rejected untrusted invalid locale "${locale}" in reviewer file.`,
      });
      continue;
    }
    const list = byLocale.get(locale) ?? [];
    list.push({ key, value: corrected, notes });
    byLocale.set(locale, list);
  }

  let appliedCount = 0;
  let resolvedReviews = 0;
  const localesUpdated: string[] = [];

  const reviewsFile = store.readReviews();
  const recordsFile = store.readRecords();

  for (const [locale, items] of byLocale) {
    const res = applyTranslations({
      rootDir: store.rootDir,
      targetLocale: locale,
      translations: items,
      origin: "human",
      strictGlossary: false,
    });
    appliedCount += res.appliedCount;
    rejectedCount += res.rejectedCount;
    if (res.appliedCount > 0) localesUpdated.push(locale);
    for (const err of res.errors) {
      errors.push({ key: err.key, locale, message: err.message });
    }

    const rejectedKeys = new Set(res.errors.map((e) => e.key));
    const freshRecords = store.readRecords();
    for (const item of items) {
      if (rejectedKeys.has(item.key)) continue;
      if (freshRecords.records[item.key]?.[locale]) {
        freshRecords.records[item.key][locale].reviewStatus = "approved";
      }
      for (const rev of reviewsFile.reviews) {
        if (rev.key === item.key && rev.locale === locale && rev.status === "open") {
          rev.status = "resolved";
          resolvedReviews++;
        }
      }
    }
    Object.assign(recordsFile.records, freshRecords.records);
  }

  store.writeRecords(recordsFile);
  store.writeReviews(reviewsFile);

  return {
    file: filePath,
    appliedCount,
    rejectedCount,
    resolvedReviews,
    localesUpdated: localesUpdated.sort(),
    errors,
  };
}
