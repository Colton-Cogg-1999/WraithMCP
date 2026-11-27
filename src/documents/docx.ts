import fs from "node:fs";
import path from "node:path";
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
 * Byte-preserving OOXML DOCX engine.
 *
 * Principles:
 * 1. NEVER loads XML into a DOM and re-serializes it. Every edit splices strictly
 *    into exact character ranges inside the original XML string.
 * 2. Preserves untouched ZIP entries and exact XML bytes outside modified text spans.
 *    Reinserting unchanged segments produces a byte-identical DOCX output.
 * 3. Merges adjacent `<w:r>` runs with identical `<w:rPr>` formatting while preserving
 *    bookmark and comment-range anchors via word-boundary proportional distribution.
 * 4. Handles body, tables (`w:tbl`), headers/footers, footnotes/endnotes, comments,
 *    text boxes (`w:txbxContent`, deduplicating `mc:Fallback`), inline content controls
 *    (`w:sdt`), smart tags (`w:smartTag`/`w:customXml`), hyperlinks (both `w:hyperlink`
 *    and `HYPERLINK` complex fields), and tracked insertions (`w:ins`) while protecting
 *    tracked deletions (`w:del`).
 * 5. Honors `<g>` span reordering and rejects unexpected text placed outside `<g>` tags
 *    rather than silently discarding translator text.
 */

interface XmlRange {
  tag: string;
  start: number;
  end: number;
  openEnd: number;
  closeStart: number;
  selfClosing: boolean;
}

interface WtSpan {
  openStart: number;
  textStart: number;
  textEnd: number;
  closeEnd: number;
  rawOpenTag: string;
  decodedText: string;
}

interface TextGroupSlot {
  id: string;
  wrapped: boolean;
  type: string;
  wtSpans: WtSpan[];
  originalText: string;
  /** Exact character range in part XML covering this slot's enclosing run/wrapper elements */
  xmlStart: number;
  xmlEnd: number;
  /** True if bookmark/comment-range boundaries exist between wtSpans inside this slot */
  hasInternalAnchor: boolean;
}

interface ExtractedDocxParagraph {
  segment: DocumentSegment;
  partName: string;
  slots: TextGroupSlot[];
  hasProtectedTrackedChanges: boolean;
}

const XML_INVALID_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

/** Single-pass XML entity decoder (prevents double-decoding `&amp;#65;` into `A`). */
function decodeXmlText(s: string): string {
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
    if (dec) return safeFromCodePoint(Number.parseInt(dec, 10));
    if (hex) return safeFromCodePoint(Number.parseInt(hex, 16));
    return full;
  });
}

function encodeXmlText(s: string): string {
  return s
    .replace(XML_INVALID_CTRL_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function findTagEnd(xml: string, lt: number): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function findMatchingCloseTag(
  xml: string,
  tagName: string,
  searchFrom: number,
  limit: number
): { closeStart: number; closeEnd: number } | null {
  let depth = 1;
  let i = searchFrom;
  while (i < limit) {
    const lt = xml.indexOf("<", i);
    if (lt === -1 || lt >= limit) return null;

    if (xml.startsWith("<!--", lt)) {
      const endC = xml.indexOf("-->", lt + 4);
      i = endC === -1 ? limit : endC + 3;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    if (gt === -1 || gt >= limit) return null;

    if (xml[lt + 1] === "/") {
      const closingName = xml.slice(lt + 2, gt).trim();
      if (closingName === tagName) {
        depth--;
        if (depth === 0) {
          return { closeStart: lt, closeEnd: gt + 1 };
        }
      }
    } else if (xml[lt + 1] !== "!" && xml[lt + 1] !== "?") {
      const header = xml.slice(lt + 1, gt);
      const isSelf = header.endsWith("/");
      const nm = /^([^\s/>]+)/.exec(header)?.[1];
      if (!isSelf && nm === tagName) {
        depth++;
      }
    }
    i = gt + 1;
  }
  return null;
}

function scanDirectChildren(xml: string, startOffset: number, endOffset: number): XmlRange[] {
  const children: XmlRange[] = [];
  let i = startOffset;

  while (i < endOffset) {
    const lt = xml.indexOf("<", i);
    if (lt === -1 || lt >= endOffset) break;

    if (xml.startsWith("<!--", lt)) {
      const endComment = xml.indexOf("-->", lt + 4);
      i = endComment === -1 ? endOffset : endComment + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const endCdata = xml.indexOf("]]>", lt + 9);
      i = endCdata === -1 ? endOffset : endCdata + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const endPi = xml.indexOf("?>", lt + 2);
      i = endPi === -1 ? endOffset : endPi + 2;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const gt = xml.indexOf(">", lt + 2);
      i = gt === -1 ? endOffset : gt + 1;
      continue;
    }

    const gt = findTagEnd(xml, lt);
    if (gt === -1 || gt >= endOffset) break;

    const tagHeader = xml.slice(lt + 1, gt);
    const selfClosing = tagHeader.endsWith("/");
    const nameMatch = /^([^\s/>]+)/.exec(tagHeader);
    if (!nameMatch) {
      i = gt + 1;
      continue;
    }
    const tagName = nameMatch[1];

    if (selfClosing) {
      children.push({
        tag: tagName,
        start: lt,
        end: gt + 1,
        openEnd: gt + 1,
        closeStart: gt + 1,
        selfClosing: true,
      });
      i = gt + 1;
      continue;
    }

    const closeInfo = findMatchingCloseTag(xml, tagName, gt + 1, endOffset);
    if (!closeInfo) {
      i = gt + 1;
      continue;
    }

    children.push({
      tag: tagName,
      start: lt,
      end: closeInfo.closeEnd,
      openEnd: gt + 1,
      closeStart: closeInfo.closeStart,
      selfClosing: false,
    });
    i = closeInfo.closeEnd;
  }

  return children;
}

/**
 * Find ranges of `<mc:Fallback>...</mc:Fallback>` blocks so duplicated VML fallback
 * text boxes inside `<mc:AlternateContent>` are NOT extracted twice (Q11).
 */
function findFallbackRanges(xml: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<mc:Fallback", i);
    if (lt === -1) break;
    const next = xml[lt + 12];
    if (next !== ">" && next !== " " && next !== "\t" && next !== "/") {
      i = lt + 12;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt === -1) break;
    if (xml[gt - 1] === "/") {
      i = gt + 1;
      continue;
    }
    const close = findMatchingCloseTag(xml, "mc:Fallback", gt + 1, xml.length);
    if (!close) {
      i = gt + 1;
      continue;
    }
    ranges.push({ start: lt, end: close.closeEnd });
    i = close.closeEnd;
  }
  return ranges;
}

function findAllParagraphs(xml: string): XmlRange[] {
  const fallbackRanges = findFallbackRanges(xml);
  const inFallback = (pos: number) =>
    fallbackRanges.some((r) => pos >= r.start && pos < r.end);

  const paragraphs: XmlRange[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<w:p", i);
    if (lt === -1) break;
    const nextChar = xml[lt + 4];
    if (nextChar !== ">" && nextChar !== " " && nextChar !== "\t" && nextChar !== "\r" && nextChar !== "\n" && nextChar !== "/") {
      i = lt + 4;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    if (gt === -1) break;
    const isSelf = xml[gt - 1] === "/";
    if (isSelf) {
      i = gt + 1;
      continue;
    }
    const close = findMatchingCloseTag(xml, "w:p", gt + 1, xml.length);
    if (!close) {
      i = gt + 1;
      continue;
    }
    if (!inFallback(lt)) {
      paragraphs.push({
        tag: "w:p",
        start: lt,
        end: close.closeEnd,
        openEnd: gt + 1,
        closeStart: close.closeStart,
        selfClosing: false,
      });
    }
    i = gt + 1;
  }
  return paragraphs;
}

function normalizeRpr(rXml: string, rOpenEnd: number, rCloseStart: number): string {
  const children = scanDirectChildren(rXml, rOpenEnd, rCloseStart);
  const rPr = children.find((c) => c.tag === "w:rPr");
  if (!rPr) return "";
  return rXml
    .slice(rPr.openEnd, rPr.closeStart)
    .replace(/\s+w:rsid[A-Za-z]+="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWtSpansInRun(xml: string, runRange: XmlRange): {
  wtSpans: WtSpan[];
  nonTextTokens: string[];
  hasFieldChar: "begin" | "separate" | "end" | null;
  instrText: string;
} {
  const children = scanDirectChildren(xml, runRange.openEnd, runRange.closeStart);
  const wtSpans: WtSpan[] = [];
  const nonTextTokens: string[] = [];
  let hasFieldChar: "begin" | "separate" | "end" | null = null;
  let instrText = "";

  for (const child of children) {
    if (child.tag === "w:rPr") continue;
    if (child.tag === "w:t") {
      if (!child.selfClosing) {
        const rawOpenTag = xml.slice(child.start, child.openEnd);
        const decodedText = decodeXmlText(xml.slice(child.openEnd, child.closeStart));
        wtSpans.push({
          openStart: child.start,
          textStart: child.openEnd,
          textEnd: child.closeStart,
          closeEnd: child.end,
          rawOpenTag,
          decodedText,
        });
      }
    } else if (child.tag === "w:fldChar") {
      const open = xml.slice(child.start, child.end);
      const m = /w:fldCharType=["'](begin|separate|end)["']/.exec(open);
      if (m) hasFieldChar = m[1] as "begin" | "separate" | "end";
    } else if (child.tag === "w:instrText") {
      instrText += decodeXmlText(xml.slice(child.openEnd, child.closeStart));
    } else if (child.tag === "w:tab") {
      nonTextTokens.push("tab");
    } else if (child.tag === "w:br" || child.tag === "w:cr") {
      nonTextTokens.push("break");
    } else if (child.tag === "w:drawing" || child.tag === "w:pict" || child.tag === "mc:AlternateContent") {
      nonTextTokens.push("drawing");
    } else if (
      child.tag === "w:footnoteReference" ||
      child.tag === "w:endnoteReference" ||
      child.tag === "w:commentReference"
    ) {
      nonTextTokens.push("ref");
    }
  }

  return { wtSpans, nonTextTokens, hasFieldChar, instrText };
}

const OPAQUE_TRACKED_TAGS = new Set(["w:del", "w:moveFrom"]);
const INLINE_RECURSIVE_WRAPPERS = new Set(["w:smartTag", "w:customXml", "w:ins", "w:moveTo"]);
const ANCHOR_TAGS = new Set([
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
]);
const IGNORABLE_BETWEEN_RUNS = new Set(["w:proofErr"]);

type ParagraphToken =
  | {
      kind: "runGroup";
      rPr: string;
      wtSpans: WtSpan[];
      text: string;
      xmlStart: number;
      xmlEnd: number;
      hasInternalAnchor: boolean;
    }
  | {
      kind: "hyperlink";
      wtSpans: WtSpan[];
      text: string;
      xmlStart: number;
      xmlEnd: number;
      hasInternalAnchor: boolean;
    }
  | { kind: "placeholder"; type: string };

function collectWtSpansRecursively(xml: string, start: number, end: number): WtSpan[] {
  const out: WtSpan[] = [];
  const children = scanDirectChildren(xml, start, end);
  for (const ch of children) {
    if (ch.tag === "w:r") {
      out.push(...extractWtSpansInRun(xml, ch).wtSpans);
    } else if (
      ch.tag === "w:sdtContent" ||
      ch.tag === "w:sdt" ||
      ch.tag === "w:smartTag" ||
      ch.tag === "w:customXml" ||
      ch.tag === "w:ins" ||
      ch.tag === "w:moveTo"
    ) {
      out.push(...collectWtSpansRecursively(xml, ch.openEnd, ch.closeStart));
    }
  }
  return out;
}

function extractParagraph(
  xml: string,
  pRange: XmlRange,
  partName: string,
  segId: string
): ExtractedDocxParagraph | null {
  const tokens: ParagraphToken[] = [];
  let hasProtectedTrackedChanges = false;
  let anchorSeenSinceLastRun = false;
  let preventNextMerge = false;

  // Complex field state stack (supports HYPERLINK complex fields whose display text IS translatable!)
  interface FieldFrame {
    phase: "instr" | "display";
    instr: string;
    isHyperlink: boolean;
    displayWts: WtSpan[];
    displayStart: number;
    displayEnd: number;
  }
  const fieldStack: FieldFrame[] = [];

  function processChildren(startOffset: number, endOffset: number) {
    const children = scanDirectChildren(xml, startOffset, endOffset);
    for (const child of children) {
      if (child.tag === "w:pPr" || child.tag === "w:sdtPr" || child.tag === "w:sdtEndPr") continue;
      if (IGNORABLE_BETWEEN_RUNS.has(child.tag)) continue;

      if (ANCHOR_TAGS.has(child.tag)) {
        anchorSeenSinceLastRun = true;
        continue;
      }

      if (OPAQUE_TRACKED_TAGS.has(child.tag)) {
        hasProtectedTrackedChanges = true;
        tokens.push({ kind: "placeholder", type: "tracked-change" });
        continue;
      }

      // Inline content controls (<w:sdt><w:sdtContent>...</w:sdtContent></w:sdt>) -> Q1
      if (child.tag === "w:sdt") {
        const sdtChildren = scanDirectChildren(xml, child.openEnd, child.closeStart);
        const content = sdtChildren.find((c) => c.tag === "w:sdtContent");
        if (content) {
          preventNextMerge = true;
          processChildren(content.openEnd, content.closeStart);
          preventNextMerge = true;
        }
        continue;
      }

      // Inline transparent wrappers: <w:smartTag>, <w:customXml>, <w:ins>, <w:moveTo> -> Q2 & Q4
      // Keep wrapper boundary intact so runs inside <w:ins>/<w:smartTag> are NEVER emptied into outer runs!
      if (INLINE_RECURSIVE_WRAPPERS.has(child.tag)) {
        if (child.tag === "w:ins" || child.tag === "w:moveTo") {
          hasProtectedTrackedChanges = true;
        }
        preventNextMerge = true;
        processChildren(child.openEnd, child.closeStart);
        preventNextMerge = true;
        continue;
      }

      if (child.tag === "w:fldSimple") {
        tokens.push({ kind: "placeholder", type: "field" });
        continue;
      }

      if (child.tag === "w:hyperlink") {
        const hWts = collectWtSpansRecursively(xml, child.openEnd, child.closeStart);
        const hText = hWts.map((w) => w.decodedText).join("");
        if (hText.length > 0) {
          tokens.push({
            kind: "hyperlink",
            wtSpans: hWts,
            text: hText,
            xmlStart: child.start,
            xmlEnd: child.end,
            hasInternalAnchor: false,
          });
        }
        anchorSeenSinceLastRun = false;
        continue;
      }

      if (child.tag === "w:r") {
        const info = extractWtSpansInRun(xml, child);

        if (info.hasFieldChar === "begin") {
          fieldStack.push({
            phase: "instr",
            instr: "",
            isHyperlink: false,
            displayWts: [],
            displayStart: -1,
            displayEnd: -1,
          });
          continue;
        }

        if (info.hasFieldChar === "separate") {
          const top = fieldStack[fieldStack.length - 1];
          if (top) {
            top.phase = "display";
            top.isHyperlink = /\bHYPERLINK\b/i.test(top.instr);
          }
          continue;
        }

        if (info.hasFieldChar === "end") {
          const finished = fieldStack.pop();
          if (finished && fieldStack.length === 0) {
            if (finished.isHyperlink && finished.displayWts.length > 0) {
              const hText = finished.displayWts.map((w) => w.decodedText).join("");
              tokens.push({
                kind: "hyperlink",
                wtSpans: finished.displayWts,
                text: hText,
                xmlStart: finished.displayStart,
                xmlEnd: finished.displayEnd,
                hasInternalAnchor: false,
              });
            } else {
              tokens.push({ kind: "placeholder", type: "field" });
            }
          }
          continue;
        }

        if (fieldStack.length > 0) {
          const top = fieldStack[fieldStack.length - 1];
          if (top.phase === "instr" || info.instrText) {
            top.instr += info.instrText;
          } else if (top.phase === "display" && top.isHyperlink && info.wtSpans.length > 0) {
            if (top.displayStart === -1) top.displayStart = child.start;
            top.displayEnd = child.end;
            top.displayWts.push(...info.wtSpans);
          }
          continue;
        }

        const rPr = normalizeRpr(xml, child.openEnd, child.closeStart);

        if (info.wtSpans.length > 0) {
          const text = info.wtSpans.map((w) => w.decodedText).join("");
          const prev = tokens[tokens.length - 1];
          if (
            !preventNextMerge &&
            prev &&
            prev.kind === "runGroup" &&
            prev.rPr === rPr &&
            info.nonTextTokens.length === 0
          ) {
            prev.wtSpans.push(...info.wtSpans);
            prev.text += text;
            prev.xmlEnd = child.end;
            if (anchorSeenSinceLastRun) prev.hasInternalAnchor = true;
          } else {
            tokens.push({
              kind: "runGroup",
              rPr,
              wtSpans: [...info.wtSpans],
              text,
              xmlStart: child.start,
              xmlEnd: child.end,
              hasInternalAnchor: false,
            });
          }
          preventNextMerge = false;
          anchorSeenSinceLastRun = false;
        }

        for (const nt of info.nonTextTokens) {
          tokens.push({ kind: "placeholder", type: nt });
        }
      }
    }
  }

  processChildren(pRange.openEnd, pRange.closeStart);

  const textTokens = tokens.filter((t) => t.kind === "runGroup" || t.kind === "hyperlink");
  const combinedPlain = textTokens.map((t) => t.text).join("").trim();
  if (!combinedPlain) {
    if (hasProtectedTrackedChanges) {
      return {
        segment: {
          id: segId,
          part: partName,
          location: partName,
          text: "",
          plainText: "",
          tags: [],
        },
        partName,
        slots: [],
        hasProtectedTrackedChanges: true,
      };
    }
    return null;
  }

  const distinctStyles = new Set(
    tokens
      .filter((t): t is Extract<ParagraphToken, { kind: "runGroup" }> => t.kind === "runGroup")
      .map((t) => t.rPr)
  );
  const singleUniformRun = tokens.length === 1 && tokens[0].kind === "runGroup";
  const wrapStyledRuns = distinctStyles.size > 1;

  const tags: DocumentInlineTagMeta[] = [];
  const slots: TextGroupSlot[] = [];
  let nextTagId = 1;
  let segmentText = "";

  for (const tok of tokens) {
    if (tok.kind === "placeholder") {
      const id = String(nextTagId++);
      tags.push({ id, kind: "x", type: tok.type });
      segmentText += `<x id="${id}" type="${tok.type}"/>`;
    } else if (tok.kind === "hyperlink") {
      const id = String(nextTagId++);
      tags.push({ id, kind: "g", type: "hyperlink" });
      slots.push({
        id,
        wrapped: true,
        type: "hyperlink",
        wtSpans: tok.wtSpans,
        originalText: tok.text,
        xmlStart: tok.xmlStart,
        xmlEnd: tok.xmlEnd,
        hasInternalAnchor: tok.hasInternalAnchor,
      });
      segmentText += `<g id="${id}" type="hyperlink">${tok.text}</g>`;
    } else {
      if (!singleUniformRun && (wrapStyledRuns || tokens.some((t) => t.kind !== "runGroup"))) {
        const id = String(nextTagId++);
        tags.push({ id, kind: "g", type: "format" });
        slots.push({
          id,
          wrapped: true,
          type: "format",
          wtSpans: tok.wtSpans,
          originalText: tok.text,
          xmlStart: tok.xmlStart,
          xmlEnd: tok.xmlEnd,
          hasInternalAnchor: tok.hasInternalAnchor,
        });
        segmentText += `<g id="${id}" type="format">${tok.text}</g>`;
      } else {
        slots.push({
          id: "plain",
          wrapped: false,
          type: "plain",
          wtSpans: tok.wtSpans,
          originalText: tok.text,
          xmlStart: tok.xmlStart,
          xmlEnd: tok.xmlEnd,
          hasInternalAnchor: tok.hasInternalAnchor,
        });
        segmentText += tok.text;
      }
    }
  }

  return {
    segment: {
      id: segId,
      part: partName,
      location: `${partName}#${segId}`,
      text: segmentText,
      plainText: combinedPlain,
      tags,
    },
    partName,
    slots,
    hasProtectedTrackedChanges,
  };
}

function discoverDocxXmlParts(entryNames: string[]): string[] {
  const wanted: string[] = [];
  if (entryNames.includes("word/document.xml")) wanted.push("word/document.xml");
  const extras = entryNames
    .filter(
      (n) =>
        /^word\/header\d*\.xml$/.test(n) ||
        /^word\/footer\d*\.xml$/.test(n) ||
        n === "word/footnotes.xml" ||
        n === "word/endnotes.xml" ||
        n === "word/comments.xml"
    )
    .sort();
  wanted.push(...extras);
  return wanted;
}

function parseDocxInternal(filePath: string): {
  rawZipBytes: Uint8Array;
  entries: Record<string, Uint8Array>;
  xmlStrings: Map<string, string>;
  paragraphs: ExtractedDocxParagraph[];
  protectedTrackedChanges: number;
  parts: string[];
  unsupportedParts: string[];
} {
  const rawZipBytes = fs.readFileSync(filePath);
  const entries = safeUnzipSync(rawZipBytes);
  const allEntryNames = Object.keys(entries);
  const parts = discoverDocxXmlParts(allEntryNames);
  const unsupportedParts = allEntryNames
    .filter((n) => /^word\/charts\/chart\d+\.xml$/.test(n) || /^word\/diagrams\/data\d+\.xml$/.test(n))
    .sort();
  const xmlStrings = new Map<string, string>();
  const paragraphs: ExtractedDocxParagraph[] = [];
  let protectedTrackedChanges = 0;

  let seq = 1;
  for (const partName of parts) {
    const xml = strFromU8(entries[partName]);
    xmlStrings.set(partName, xml);
    const pRanges = findAllParagraphs(xml);

    for (const pRange of pRanges) {
      const partShort = path.basename(partName, ".xml");
      const extracted = extractParagraph(xml, pRange, partName, `${partShort}-p${seq}`);
      if (!extracted) continue;
      if (extracted.hasProtectedTrackedChanges) {
        protectedTrackedChanges++;
      }
      if (extracted.segment.text.length > 0) {
        seq++;
        paragraphs.push(extracted);
      }
    }
  }

  return {
    rawZipBytes,
    entries,
    xmlStrings,
    paragraphs,
    protectedTrackedChanges,
    parts,
    unsupportedParts,
  };
}

type TranslatedPiece =
  | { kind: "slot"; id: string; text: string }
  | { kind: "outside"; text: string };

interface ParsedSlotTranslation {
  slotMap: Map<string, string>;
  order: string[];
  pieces: TranslatedPiece[];
  hasOutsideText: boolean;
}

function parseTranslatedSlots(
  translated: string,
  slots: TextGroupSlot[]
): ParsedSlotTranslation | null {
  const slotMap = new Map<string, string>();
  const order: string[] = [];
  const pieces: TranslatedPiece[] = [];

  if (slots.length === 1 && !slots[0].wrapped) {
    slotMap.set("plain", translated);
    order.push("plain");
    pieces.push({ kind: "slot", id: "plain", text: translated });
    return { slotMap, order, pieces, hasOutsideText: false };
  }

  let hasOutsideText = false;
  const tokenRe = /<g\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/g>|<x\b[^>]*\/>/g;
  let lastIdx = 0;
  for (const m of translated.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) {
      const between = translated.slice(lastIdx, idx);
      if (between.length > 0) {
        if (between.trim().length > 0) hasOutsideText = true;
        pieces.push({ kind: "outside", text: between });
      }
    }
    if (m[1] !== undefined) {
      slotMap.set(m[1], m[2]);
      order.push(m[1]);
      pieces.push({ kind: "slot", id: m[1], text: m[2] });
    }
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < translated.length) {
    const tail = translated.slice(lastIdx);
    if (tail.length > 0) {
      if (tail.trim().length > 0) hasOutsideText = true;
      pieces.push({ kind: "outside", text: tail });
    }
  }

  for (const slot of slots) {
    if (slot.wrapped && !slotMap.has(slot.id)) {
      return null;
    }
  }
  return {
    slotMap,
    order,
    pieces,
    hasOutsideText,
  };
}

function buildWtReplacement(
  wt: WtSpan,
  newText: string
): { start: number; end: number; replacement: string } {
  const encoded = encodeXmlText(newText);
  const needsPreserve = /^\s|\s$/.test(newText);
  if (needsPreserve && !wt.rawOpenTag.includes("xml:space")) {
    const updatedOpen = wt.rawOpenTag.replace(/>$/, ' xml:space="preserve">');
    return {
      start: wt.openStart,
      end: wt.textEnd,
      replacement: updatedOpen + encoded,
    };
  }
  return {
    start: wt.textStart,
    end: wt.textEnd,
    replacement: encoded,
  };
}

/**
 * Distribute translated text across anchored `<w:t>` spans (separated by bookmark or
 * comment-range markers) on word boundaries proportional to original span lengths,
 * so bookmarks and comment ranges continue to wrap the translated target words (Q5, Q6).
 */
function distributeTextAcrossAnchoredSpans(
  wtSpans: WtSpan[],
  newText: string
): string[] {
  const n = wtSpans.length;
  if (n <= 1) return [newText];

  const origLens = wtSpans.map((w) => Math.max(1, w.decodedText.length));
  const totalOrig = origLens.reduce((a, b) => a + b, 0);

  // Split translated text into space-preserving tokens (e.g. ["Siehe", " ", "Tabelle", " ", "3", ...])
  const pieces = newText.match(/\s+|\S+/g) ?? [newText];
  const out = new Array<string>(n).fill("");

  // Compute cumulative target char boundaries for each span
  const boundaries: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (origLens[i] / totalOrig) * newText.length;
    boundaries.push(acc);
  }

  let curSpan = 0;
  let charPos = 0;
  for (const piece of pieces) {
    const mid = charPos + piece.length / 2;
    while (curSpan < n - 1 && mid > boundaries[curSpan]) {
      // Ensure we don't leave a span completely empty if there are remaining pieces
      curSpan++;
    }
    out[curSpan] += piece;
    charPos += piece.length;
  }

  // Fallback: if any internal anchored span ended up empty while an adjacent span has multiple words, steal one word
  for (let i = 0; i < n; i++) {
    if (out[i].trim().length > 0) continue;
    const donor = i > 0 && out[i - 1].trim().includes(" ")
      ? i - 1
      : i + 1 < n && out[i + 1].trim().includes(" ")
        ? i + 1
        : -1;
    if (donor === -1) continue;
    if (donor < i) {
      const m = /^([\s\S]*?\s)(\S+\s*)$/.exec(out[donor]);
      if (m) {
        out[donor] = m[1];
        out[i] = m[2];
      }
    } else {
      const m = /^(\s*\S+)(\s[\s\S]*)$/.exec(out[donor]);
      if (m) {
        out[i] = m[1];
        out[donor] = m[2];
      }
    }
  }

  return out;
}

function spliceSlotXmlChunk(
  partXml: string,
  slot: TextGroupSlot,
  newText: string
): string {
  const chunk = partXml.slice(slot.xmlStart, slot.xmlEnd);
  const localSplices: Array<{ start: number; end: number; replacement: string }> = [];

  if (slot.hasInternalAnchor && slot.wtSpans.length > 1) {
    const parts = distributeTextAcrossAnchoredSpans(slot.wtSpans, newText);
    for (let k = 0; k < slot.wtSpans.length; k++) {
      const rep = buildWtReplacement(slot.wtSpans[k], parts[k]);
      localSplices.push({
        start: rep.start - slot.xmlStart,
        end: rep.end - slot.xmlStart,
        replacement: rep.replacement,
      });
    }
  } else if (slot.wtSpans.length > 0) {
    const firstRep = buildWtReplacement(slot.wtSpans[0], newText);
    localSplices.push({
      start: firstRep.start - slot.xmlStart,
      end: firstRep.end - slot.xmlStart,
      replacement: firstRep.replacement,
    });
    for (let k = 1; k < slot.wtSpans.length; k++) {
      localSplices.push({
        start: slot.wtSpans[k].textStart - slot.xmlStart,
        end: slot.wtSpans[k].textEnd - slot.xmlStart,
        replacement: "",
      });
    }
  }

  let out = chunk;
  for (const sp of localSplices.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, sp.start) + sp.replacement + out.slice(sp.end);
  }
  return out;
}

export class DocxDocumentAdapter implements DocumentAdapter {
  readonly format = "docx" as const;
  readonly extensions = [".docx"] as const;

  extract(filePath: string): ExtractedDocument {
    const parsed = parseDocxInternal(filePath);
    const segments = parsed.paragraphs.map((p) => p.segment);
    const wordCount = segments.reduce(
      (sum, s) => sum + (s.plainText.match(/\S+/g)?.length ?? 0),
      0
    );

    return {
      file: filePath,
      format: "docx",
      fullDocumentContext: segments.map((s) => `[${s.id}] ${s.text}`).join("\n"),
      segments,
      stats: {
        segmentCount: segments.length,
        wordCount,
        parts: parsed.parts,
        protectedTrackedChanges: parsed.protectedTrackedChanges,
        ...(parsed.unsupportedParts.length > 0 ? { unsupportedParts: parsed.unsupportedParts } : {}),
      },
    };
  }

  apply(
    sourcePath: string,
    targetPath: string,
    updates: DocumentTranslationUpdate[]
  ): DocumentApplyResult {
    const parsed = parseDocxInternal(sourcePath);
    const paraById = new Map(parsed.paragraphs.map((p) => [p.segment.id, p]));
    const errors: Array<{ id: string; code: string; message: string }> = [];

    const splicesByPart = new Map<
      string,
      Array<{ start: number; end: number; replacement: string }>
    >();
    let segmentsUpdated = 0;

    for (const u of updates) {
      const para = paraById.get(u.id);
      if (!para) {
        errors.push({ id: u.id, code: "unknown_segment", message: `Unknown DOCX segment "${u.id}".` });
        continue;
      }

      const srcTags = extractInlineTags(para.segment.text);
      const tgtTags = extractInlineTags(u.text);
      if (
        !tgtTags.balanced ||
        JSON.stringify(srcTags.selfClosing) !== JSON.stringify(tgtTags.selfClosing) ||
        JSON.stringify(srcTags.paired) !== JSON.stringify(tgtTags.paired)
      ) {
        errors.push({
          id: u.id,
          code: "inline_tag_mismatch",
          message: `Inline tags in segment "${u.id}" do not match source (${tgtTags.error ?? "tag mismatch"}).`,
        });
        continue;
      }

      if (u.text === para.segment.text) {
        continue;
      }

      const parsedSlots = parseTranslatedSlots(u.text, para.slots);
      if (!parsedSlots) {
        errors.push({
          id: u.id,
          code: "inline_tag_mismatch",
          message: `Could not map translated <g> tags back to OOXML runs for segment "${u.id}".`,
        });
        continue;
      }

      const partXml = parsed.xmlStrings.get(para.partName)!;
      const partSplices = splicesByPart.get(para.partName) ?? [];

      // Q7 & Q8: If translator reordered <g> spans OR placed plain text outside <g> tags,
      // rebuild the contiguous run sequence preserving exact order and inserting plain <w:r><w:t> runs!
      const origOrder = para.slots.map((s) => s.id);
      const reordered =
        para.slots.length > 1 &&
        parsedSlots.order.length === origOrder.length &&
        JSON.stringify(parsedSlots.order) !== JSON.stringify(origOrder);

      if ((reordered || parsedSlots.hasOutsideText) && para.slots.length > 0) {
        const slotById = new Map(para.slots.map((s) => [s.id, s]));
        const firstStart = Math.min(...para.slots.map((s) => s.xmlStart));
        const lastEnd = Math.max(...para.slots.map((s) => s.xmlEnd));
        const rebuiltXml = parsedSlots.pieces
          .map((piece) => {
            if (piece.kind === "outside") {
              return `<w:r><w:t xml:space="preserve">${encodeXmlText(piece.text)}</w:t></w:r>`;
            }
            const sl = slotById.get(piece.id);
            if (!sl) return "";
            return spliceSlotXmlChunk(partXml, sl, piece.text);
          })
          .join("");
        partSplices.push({ start: firstStart, end: lastEnd, replacement: rebuiltXml });
      } else {
        for (const slot of para.slots) {
          const newSlotText = parsedSlots.slotMap.get(slot.id);
          if (newSlotText === undefined || newSlotText === slot.originalText) continue;
          if (slot.wtSpans.length === 0) continue;

          if (slot.hasInternalAnchor && slot.wtSpans.length > 1) {
            const parts = distributeTextAcrossAnchoredSpans(slot.wtSpans, newSlotText);
            for (let k = 0; k < slot.wtSpans.length; k++) {
              partSplices.push(buildWtReplacement(slot.wtSpans[k], parts[k]));
            }
          } else {
            partSplices.push(buildWtReplacement(slot.wtSpans[0], newSlotText));
            for (let k = 1; k < slot.wtSpans.length; k++) {
              partSplices.push({
                start: slot.wtSpans[k].textStart,
                end: slot.wtSpans[k].textEnd,
                replacement: "",
              });
            }
          }
        }
      }

      splicesByPart.set(para.partName, partSplices);
      segmentsUpdated++;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: parsed.paragraphs.length,
        segmentsUpdated: 0,
        byteIdentical: false,
        errors,
      };
    }

    const totalSplices = [...splicesByPart.values()].reduce((acc, arr) => acc + arr.length, 0);
    if (totalSplices === 0) {
      atomicWriteFileSync(targetPath, parsed.rawZipBytes);
      return {
        ok: true,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: parsed.paragraphs.length,
        segmentsUpdated: 0,
        byteIdentical: true,
        errors: [],
      };
    }

    const updatedEntries: Record<string, Uint8Array> = { ...parsed.entries };
    for (const [partName, splices] of splicesByPart) {
      if (splices.length === 0) continue;
      let xml = parsed.xmlStrings.get(partName)!;
      for (const sp of splices.sort((a, b) => b.start - a.start)) {
        xml = xml.slice(0, sp.start) + sp.replacement + xml.slice(sp.end);
      }
      updatedEntries[partName] = strToU8(xml);
    }

    const outBytes = zipSync(updatedEntries, { level: 6 });
    atomicWriteFileSync(targetPath, outBytes);

    return {
      ok: true,
      sourceFile: sourcePath,
      targetFile: targetPath,
      segmentsTotal: parsed.paragraphs.length,
      segmentsUpdated,
      byteIdentical: false,
      errors: [],
    };
  }
}
