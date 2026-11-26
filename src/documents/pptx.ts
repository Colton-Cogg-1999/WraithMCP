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
 * Byte-preserving OOXML PowerPoint (.pptx) adapter.
 *
 * Principles:
 * 1. Never parses/reserializes XML via DOM. Splices strictly into exact `<a:t>` character ranges.
 * 2. Untouched ZIP entries and XML bytes outside modified text spans remain byte-identical.
 * 3. Extracts paragraphs (`<a:p>`) from slides (`ppt/slides/slide*.xml`) and speaker notes
 *    (`ppt/notesSlides/notesSlide*.xml`) in numeric slide order, preserving run formatting
 *    (`<a:rPr>`) via `<g id="n">...</g>` inline tags when a paragraph has multiple formatted runs.
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

interface TextSpan {
  textStart: number;
  textEnd: number;
  decodedText: string;
}

interface ExtractedPptxParagraph {
  segment: DocumentSegment;
  partName: string;
  spans: TextSpan[];
  wrapped: boolean;
}

function numericPartSort(a: string, b: string): number {
  const num = (s: string) => {
    const m = s.match(/(\d+)\.xml$/);
    return m ? Number.parseInt(m[1], 10) : 0;
  };
  const isNoteA = a.includes("notesSlides/");
  const isNoteB = b.includes("notesSlides/");
  if (isNoteA !== isNoteB) return isNoteA ? 1 : -1;
  return num(a) - num(b) || a.localeCompare(b);
}

function extractPptxParts(entries: Record<string, Uint8Array>): {
  paragraphs: ExtractedPptxParagraph[];
  parts: string[];
} {
  const partNames = Object.keys(entries)
    .filter((k) => /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(k))
    .sort(numericPartSort);

  const paragraphs: ExtractedPptxParagraph[] = [];

  for (const partName of partNames) {
    const xml = strFromU8(entries[partName]);
    const partLabel = partName.replace(/^ppt\//, "").replace(/\.xml$/, "");
    let pIdx = 0;

    // Match each <a:p ...>...</a:p> paragraph element
    const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRe.exec(xml)) !== null) {
      const pContentStart = pMatch.index + pMatch[0].indexOf(">") + 1;
      const pInner = pMatch[1];

      const spans: TextSpan[] = [];
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let tMatch: RegExpExecArray | null;
      while ((tMatch = tRe.exec(pInner)) !== null) {
        const openEnd = tMatch.index + tMatch[0].indexOf(">") + 1;
        const textStart = pContentStart + openEnd;
        const textEnd = textStart + tMatch[1].length;
        spans.push({
          textStart,
          textEnd,
          decodedText: decodeXml(tMatch[1]),
        });
      }

      if (spans.length === 0) continue;
      const plainText = spans.map((s) => s.decodedText).join("");
      if (!plainText.trim()) continue;

      pIdx++;
      const wrapped = spans.length > 1;
      const tags: DocumentInlineTagMeta[] = [];
      let taggedText: string;

      if (!wrapped) {
        taggedText = spans[0].decodedText;
      } else {
        taggedText = spans
          .map((s, idx) => {
            const id = String(idx + 1);
            tags.push({ id, kind: "g", type: "run" });
            return `<g id="${id}">${s.decodedText}</g>`;
          })
          .join("");
      }

      paragraphs.push({
        partName,
        spans,
        wrapped,
        segment: {
          id: `${partLabel}:p${pIdx}`,
          part: partLabel,
          location: `${partName}#p${pIdx}`,
          text: taggedText,
          plainText,
          tags,
        },
      });
    }
  }

  return { paragraphs, parts: partNames };
}

function parseWrappedRuns(
  translated: string,
  expectedCount: number
): { ok: true; values: string[] } | { ok: false; message: string } {
  const tagInfo = extractInlineTags(translated);
  if (!tagInfo.balanced) {
    return { ok: false, message: "Unbalanced <g> inline formatting tags in PPTX translation." };
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
      return { ok: false, message: `Missing <g id="${i}">...</g> run tag in PPTX translation.` };
    }
    values.push(val);
  }
  return { ok: true, values };
}

export class PptxDocumentAdapter implements DocumentAdapter {
  readonly format = "pptx" as const;
  readonly extensions = [".pptx"] as const;

  extract(filePath: string): ExtractedDocument {
    const bytes = fs.readFileSync(filePath);
    const entries = safeUnzipSync(bytes);
    const { paragraphs, parts } = extractPptxParts(entries);
    const segments = paragraphs.map((p) => p.segment);
    const wordCount = segments.reduce(
      (sum, s) => sum + s.plainText.split(/\s+/).filter(Boolean).length,
      0
    );

    return {
      file: filePath,
      format: "pptx",
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
    const { paragraphs } = extractPptxParts(entries);
    const byId = new Map(paragraphs.map((p) => [p.segment.id, p]));

    const errors: Array<{ id: string; code: string; message: string }> = [];
    const editsByPart = new Map<string, Array<{ start: number; end: number; encoded: string }>>();
    let updatedCount = 0;

    for (const u of updates) {
      const para = byId.get(u.id);
      if (!para) {
        errors.push({ id: u.id, code: "unknown_segment", message: `Unknown PPTX segment "${u.id}"` });
        continue;
      }
      if (u.text === para.segment.text) continue;

      let newValues: string[];
      if (!para.wrapped) {
        newValues = [u.text];
      } else {
        const parsed = parseWrappedRuns(u.text, para.spans.length);
        if (!parsed.ok) {
          errors.push({ id: u.id, code: "inline_tag_mismatch", message: parsed.message });
          continue;
        }
        newValues = parsed.values;
      }

      const partEdits = editsByPart.get(para.partName) ?? [];
      for (let i = 0; i < para.spans.length; i++) {
        if (newValues[i] !== para.spans[i].decodedText) {
          partEdits.push({
            start: para.spans[i].textStart,
            end: para.spans[i].textEnd,
            encoded: encodeXml(newValues[i]),
          });
        }
      }
      editsByPart.set(para.partName, partEdits);
      updatedCount++;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: paragraphs.length,
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
        segmentsTotal: paragraphs.length,
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
        xml = xml.slice(0, e.start) + e.encoded + xml.slice(e.end);
      }
      outEntries[partName] = strToU8(xml);
    }

    const outZip = zipSync(outEntries, { level: 6 });
    atomicWriteFileSync(targetPath, outZip);

    return {
      ok: true,
      sourceFile: sourcePath,
      targetFile: targetPath,
      segmentsTotal: paragraphs.length,
      segmentsUpdated: updatedCount,
      byteIdentical: false,
      errors: [],
    };
  }
}
