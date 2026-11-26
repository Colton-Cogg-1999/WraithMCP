import fs from "node:fs";
import { strFromU8, strToU8, zipSync } from "fflate";
import { extractInlineTags } from "../core/placeholders.js";
import { atomicWriteFileSync, safeUnzipSync } from "../core/security.js";
import {
  DocumentAdapter,
  DocumentApplyResult,
  DocumentInlineTagMeta,
  DocumentSegment,
  DocumentTranslationUpdate,
  ExtractedDocument,
} from "./types.js";

/**
 * Byte-preserving OOXML Excel (.xlsx) adapter.
 *
 * Principles:
 * 1. Extracts shared string entries (`xl/sharedStrings.xml` `<si>`) and inline string cells
 *    (`xl/worksheets/sheet*.xml` `<is>`) while NEVER touching formulas (`<f>`), numbers, dates,
 *    or styles.
 * 2. Splices strictly into `<t>` character ranges (preserving `xml:space="preserve"` when leading
 *    or trailing spaces are present) and leaves untouched ZIP entries byte-identical.
 * 3. Preserves rich-text multi-run cells (`<r><rPr>...</rPr><t>...</t></r>`) via `<g id="n">...</g>`.
 */

const XML_INVALID_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function decodeXml(s: string): string {
  return s.replace(/&(?:(lt|gt|quot|apos|amp)|#(\d+)|#x([0-9a-fA-F]+));/g, (full, named, dec, hex) => {
    if (named) {
      switch (named) {
        case "lt": return "<";
        case "gt": return ">";
        case "quot": return '"';
        case "apos": return "'";
        case "amp": return "&";
      }
    }
    const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return full;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return full;
    }
  });
}

function encodeXml(s: string): string {
  return s
    .replace(XML_INVALID_CTRL_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface XlsxTextSpan {
  openStart: number;
  textStart: number;
  textEnd: number;
  rawOpenTag: string;
  decodedText: string;
}

interface ExtractedXlsxItem {
  segment: DocumentSegment;
  partName: string;
  spans: XlsxTextSpan[];
  wrapped: boolean;
}

function extractSpansInBlock(xml: string, blockStart: number, blockInner: string): XlsxTextSpan[] {
  const spans: XlsxTextSpan[] = [];
  const tRe = /<t(\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = tRe.exec(blockInner)) !== null) {
    const openStart = blockStart + m.index;
    const rawOpenTag = `<t${m[1] ?? ""}>`;
    const textStart = openStart + rawOpenTag.length;
    const textEnd = textStart + m[2].length;
    spans.push({
      openStart,
      textStart,
      textEnd,
      rawOpenTag,
      decodedText: decodeXml(m[2]),
    });
  }
  return spans;
}

function extractXlsxItems(entries: Record<string, Uint8Array>): {
  items: ExtractedXlsxItem[];
  parts: string[];
} {
  const items: ExtractedXlsxItem[] = [];
  const parts: string[] = [];

  // 1. Shared strings table (xl/sharedStrings.xml)
  if (entries["xl/sharedStrings.xml"]) {
    const partName = "xl/sharedStrings.xml";
    parts.push(partName);
    const xml = strFromU8(entries[partName]);
    const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let siIdx = 0;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml)) !== null) {
      const innerStart = m.index + m[0].indexOf(">") + 1;
      const spans = extractSpansInBlock(xml, innerStart, m[1]);
      const currentIdx = siIdx++;
      if (spans.length === 0) continue;
      const plainText = spans.map((s) => s.decodedText).join("");
      if (!plainText.trim()) continue;

      const wrapped = spans.length > 1;
      const tags: DocumentInlineTagMeta[] = [];
      const taggedText = !wrapped
        ? spans[0].decodedText
        : spans
            .map((s, idx) => {
              const id = String(idx + 1);
              tags.push({ id, kind: "g", type: "run" });
              return `<g id="${id}">${s.decodedText}</g>`;
            })
            .join("");

      items.push({
        partName,
        spans,
        wrapped,
        segment: {
          id: `sharedStrings:si${currentIdx}`,
          part: "sharedStrings",
          location: `${partName}#si[${currentIdx}]`,
          text: taggedText,
          plainText,
          tags,
        },
      });
    }
  }

  // 2. Inline strings (<is>...</is>) in worksheet XMLs (formulas <f> are never matched)
  const sheetNames = Object.keys(entries)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => {
      const n = (s: string) => Number.parseInt(s.match(/(\d+)\.xml$/)?.[1] ?? "0", 10);
      return n(a) - n(b);
    });

  for (const partName of sheetNames) {
    const xml = strFromU8(entries[partName]);
    const sheetLabel = partName.replace(/^xl\/worksheets\//, "").replace(/\.xml$/, "");
    const isRe = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/g;
    let isIdx = 0;
    let m: RegExpExecArray | null;
    let foundInSheet = false;
    while ((m = isRe.exec(xml)) !== null) {
      const innerStart = m.index + m[0].indexOf(">") + 1;
      const spans = extractSpansInBlock(xml, innerStart, m[1]);
      if (spans.length === 0) continue;
      const plainText = spans.map((s) => s.decodedText).join("");
      if (!plainText.trim()) continue;

      foundInSheet = true;
      isIdx++;
      const wrapped = spans.length > 1;
      const tags: DocumentInlineTagMeta[] = [];
      const taggedText = !wrapped
        ? spans[0].decodedText
        : spans
            .map((s, idx) => {
              const id = String(idx + 1);
              tags.push({ id, kind: "g", type: "run" });
              return `<g id="${id}">${s.decodedText}</g>`;
            })
            .join("");

      items.push({
        partName,
        spans,
        wrapped,
        segment: {
          id: `${sheetLabel}:is${isIdx}`,
          part: sheetLabel,
          location: `${partName}#is[${isIdx}]`,
          text: taggedText,
          plainText,
          tags,
        },
      });
    }
    if (foundInSheet) parts.push(partName);
  }

  return { items, parts };
}

function parseWrappedRuns(
  translated: string,
  expectedCount: number
): { ok: true; values: string[] } | { ok: false; message: string } {
  const tagInfo = extractInlineTags(translated);
  if (!tagInfo.balanced) {
    return { ok: false, message: "Unbalanced <g> inline formatting tags in XLSX translation." };
  }
  const byId = new Map<string, string>();
  const leftover = translated.replace(/<g\s+id="([^"]+)">([\s\S]*?)<\/g>/g, (_m, id: string, inner: string) => {
    byId.set(id, inner);
    return "";
  });
  if (leftover.trim().length > 0) {
    return {
      ok: false,
      message: `Unexpected text outside <g> tags: "${leftover.trim().slice(0, 60)}"`,
    };
  }
  const values: string[] = [];
  for (let i = 1; i <= expectedCount; i++) {
    const val = byId.get(String(i));
    if (val === undefined) {
      return { ok: false, message: `Missing <g id="${i}">...</g> run tag in XLSX translation.` };
    }
    values.push(val);
  }
  return { ok: true, values };
}

export class XlsxDocumentAdapter implements DocumentAdapter {
  readonly format = "xlsx" as const;
  readonly extensions = [".xlsx"] as const;

  extract(filePath: string): ExtractedDocument {
    const bytes = fs.readFileSync(filePath);
    const entries = safeUnzipSync(bytes);
    const { items, parts } = extractXlsxItems(entries);
    const segments = items.map((i) => i.segment);
    const wordCount = segments.reduce(
      (sum, s) => sum + s.plainText.split(/\s+/).filter(Boolean).length,
      0
    );

    return {
      file: filePath,
      format: "xlsx",
      fullDocumentContext: segments.map((s) => `[${s.id}] ${s.text}`).join("\n"),
      segments,
      stats: {
        segmentCount: segments.length,
        wordCount,
        parts,
        protectedTrackedChanges: 0,
      },
    };
  }

  apply(
    sourcePath: string,
    targetPath: string,
    updates: DocumentTranslationUpdate[]
  ): DocumentApplyResult {
    const sourceBytes = fs.readFileSync(sourcePath);
    const entries = safeUnzipSync(sourceBytes);
    const { items } = extractXlsxItems(entries);
    const byId = new Map(items.map((i) => [i.segment.id, i]));

    const errors: Array<{ id: string; code: string; message: string }> = [];
    const editsByPart = new Map<string, Array<{ start: number; end: number; replacement: string }>>();
    let updatedCount = 0;

    for (const u of updates) {
      const item = byId.get(u.id);
      if (!item) {
        errors.push({ id: u.id, code: "unknown_segment", message: `Unknown XLSX segment "${u.id}"` });
        continue;
      }
      if (u.text === item.segment.text) continue;

      let newValues: string[];
      if (!item.wrapped) {
        newValues = [u.text];
      } else {
        const parsed = parseWrappedRuns(u.text, item.spans.length);
        if (!parsed.ok) {
          errors.push({ id: u.id, code: "inline_tag_mismatch", message: parsed.message });
          continue;
        }
        newValues = parsed.values;
      }

      const partEdits = editsByPart.get(item.partName) ?? [];
      for (let i = 0; i < item.spans.length; i++) {
        const span = item.spans[i];
        const nextVal = newValues[i];
        if (nextVal !== span.decodedText) {
          const needsPreserve = /^\s|\s$/.test(nextVal) && !span.rawOpenTag.includes("xml:space");
          if (needsPreserve) {
            const openWithPreserve = span.rawOpenTag.replace(/^<t/, '<t xml:space="preserve"');
            partEdits.push({
              start: span.openStart,
              end: span.textEnd,
              replacement: `${openWithPreserve}${encodeXml(nextVal)}`,
            });
          } else {
            partEdits.push({
              start: span.textStart,
              end: span.textEnd,
              replacement: encodeXml(nextVal),
            });
          }
        }
      }
      editsByPart.set(item.partName, partEdits);
      updatedCount++;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: items.length,
        segmentsUpdated: 0,
        byteIdentical: false,
        errors,
      };
    }

    if (updatedCount === 0) {
      atomicWriteFileSync(targetPath, sourceBytes);
      return {
        ok: true,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: items.length,
        segmentsUpdated: 0,
        byteIdentical: true,
        errors: [],
      };
    }

    const outEntries: Record<string, Uint8Array> = { ...entries };
    for (const [partName, edits] of editsByPart.entries()) {
      if (edits.length === 0) continue;
      let xml = strFromU8(entries[partName]);
      edits.sort((a, b) => b.start - a.start);
      for (const e of edits) {
        xml = xml.slice(0, e.start) + e.replacement + xml.slice(e.end);
      }
      outEntries[partName] = strToU8(xml);
    }

    const outZip = zipSync(outEntries, { level: 6 });
    atomicWriteFileSync(targetPath, outZip);

    return {
      ok: true,
      sourceFile: sourcePath,
      targetFile: targetPath,
      segmentsTotal: items.length,
      segmentsUpdated: updatedCount,
      byteIdentical: false,
      errors: [],
    };
  }
}
