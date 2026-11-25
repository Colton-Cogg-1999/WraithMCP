import fs from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { extractInlineTags } from "../core/placeholders.js";
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
 *    into the exact character ranges of `<w:t>` elements inside the original XML string.
 * 2. Preserves untouched ZIP entries and exact XML bytes outside modified text spans.
 *    Reinserting unchanged segments produces a byte-identical XML & DOCX output.
 * 3. Merges adjacent `<w:r>` runs with identical `<w:rPr>` formatting before extraction
 *    so Word's spellcheck / rsid run fragmentation does not create tag soup.
 * 4. Handles body, tables (`w:tbl`), headers/footers, footnotes/endnotes, comments,
 *    and text boxes (`w:txbxContent`).
 * 5. Explicitly protects tracked changes (`w:ins`, `w:del`, `w:moveFrom`, `w:moveTo`).
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
  /** Start of `<w:t ...>` opening tag in part XML */
  openStart: number;
  /** End of `<w:t ...>` opening tag (start of inner text) */
  textStart: number;
  /** Start of `</w:t>` closing tag (end of inner text) */
  textEnd: number;
  /** End of `</w:t>` closing tag */
  closeEnd: number;
  rawOpenTag: string;
  decodedText: string;
}

interface TextGroupSlot {
  id: string;
  /** Whether wrapped in `<g id="...">...</g>` or direct ungrouped paragraph text */
  wrapped: boolean;
  type: string;
  wtSpans: WtSpan[];
  originalText: string;
}

interface ExtractedDocxParagraph {
  segment: DocumentSegment;
  partName: string;
  slots: TextGroupSlot[];
  /** True if paragraph contains tracked changes that were protected */
  hasProtectedTrackedChanges: boolean;
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

function encodeXmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Scan direct child elements of a parent XML range (startOffset..endOffset),
 * accurately skipping comments, CDATA, processing instructions, and nested tags.
 */
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
      // Unexpected closing tag
      const gt = xml.indexOf(">", lt + 2);
      i = gt === -1 ? endOffset : gt + 1;
      continue;
    }

    // Parse opening tag name and find matching '>'
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

    // Find matching closing </tagName> respecting nesting of same tagName
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

/**
 * Find ALL `<w:p>` elements anywhere in an XML part (including inside `<w:tbl>` tables
 * and nested `<w:txbxContent>` text boxes inside drawings).
 */
function findAllParagraphs(xml: string): XmlRange[] {
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
    paragraphs.push({
      tag: "w:p",
      start: lt,
      end: close.closeEnd,
      openEnd: gt + 1,
      closeStart: close.closeStart,
      selfClosing: false,
    });
    // Advance only past opening tag so nested <w:p> inside <w:txbxContent> are ALSO visited!
    i = gt + 1;
  }
  return paragraphs;
}

function normalizeRpr(rXml: string, rStart: number, rOpenEnd: number, rCloseStart: number): string {
  const children = scanDirectChildren(rXml, rOpenEnd, rCloseStart);
  const rPr = children.find((c) => c.tag === "w:rPr");
  if (!rPr) return "";
  // Normalize whitespace & ignore rsid attributes inside rPr so equivalent runs merge cleanly
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
  isInstrText: boolean;
} {
  const children = scanDirectChildren(xml, runRange.openEnd, runRange.closeStart);
  const wtSpans: WtSpan[] = [];
  const nonTextTokens: string[] = [];
  let hasFieldChar: "begin" | "separate" | "end" | null = null;
  let isInstrText = false;

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
      isInstrText = true;
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

  return { wtSpans, nonTextTokens, hasFieldChar, isInstrText };
}

const TRACKED_CHANGE_TAGS = new Set(["w:ins", "w:del", "w:moveFrom", "w:moveTo"]);
const IGNORABLE_BETWEEN_RUNS = new Set([
  "w:proofErr",
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
]);

function extractParagraph(
  xml: string,
  pRange: XmlRange,
  partName: string,
  segId: string
): ExtractedDocxParagraph | null {
  const children = scanDirectChildren(xml, pRange.openEnd, pRange.closeStart);
  const tags: DocumentInlineTagMeta[] = [];
  const slots: TextGroupSlot[] = [];

  type Token =
    | { kind: "runGroup"; rPr: string; wtSpans: WtSpan[]; text: string }
    | { kind: "hyperlink"; wtSpans: WtSpan[]; text: string }
    | { kind: "placeholder"; type: string };

  const tokens: Token[] = [];
  let inComplexFieldDepth = 0;
  let hasProtectedTrackedChanges = false;

  for (const child of children) {
    if (child.tag === "w:pPr") continue;
    if (IGNORABLE_BETWEEN_RUNS.has(child.tag)) continue;

    // Protect tracked changes explicitly so revision history is never corrupted
    if (TRACKED_CHANGE_TAGS.has(child.tag)) {
      hasProtectedTrackedChanges = true;
      tokens.push({ kind: "placeholder", type: "tracked-change" });
      continue;
    }

    if (child.tag === "w:fldSimple") {
      tokens.push({ kind: "placeholder", type: "field" });
      continue;
    }

    if (child.tag === "w:hyperlink") {
      const hChildren = scanDirectChildren(xml, child.openEnd, child.closeStart);
      const hWts: WtSpan[] = [];
      for (const hc of hChildren) {
        if (hc.tag === "w:r") {
          const info = extractWtSpansInRun(xml, hc);
          hWts.push(...info.wtSpans);
        }
      }
      const hText = hWts.map((w) => w.decodedText).join("");
      if (hText.length > 0) {
        tokens.push({ kind: "hyperlink", wtSpans: hWts, text: hText });
      }
      continue;
    }

    if (child.tag === "w:r") {
      const info = extractWtSpansInRun(xml, child);

      if (info.hasFieldChar === "begin") {
        if (inComplexFieldDepth === 0) {
          tokens.push({ kind: "placeholder", type: "field" });
        }
        inComplexFieldDepth++;
        continue;
      }
      if (info.hasFieldChar === "end") {
        inComplexFieldDepth = Math.max(0, inComplexFieldDepth - 1);
        continue;
      }
      if (inComplexFieldDepth > 0 || info.isInstrText) {
        // Inside a complex field (e.g. PAGE, DATE, HYPERLINK field code) -> already protected by <x type="field"/>
        continue;
      }

      const rPr = normalizeRpr(xml, child.start, child.openEnd, child.closeStart);

      if (info.wtSpans.length > 0) {
        const text = info.wtSpans.map((w) => w.decodedText).join("");
        const prev = tokens[tokens.length - 1];
        // Merge adjacent runs with identical <w:rPr> formatting!
        if (prev && prev.kind === "runGroup" && prev.rPr === rPr && info.nonTextTokens.length === 0) {
          prev.wtSpans.push(...info.wtSpans);
          prev.text += text;
        } else {
          tokens.push({ kind: "runGroup", rPr, wtSpans: [...info.wtSpans], text });
        }
      }

      for (const nt of info.nonTextTokens) {
        tokens.push({ kind: "placeholder", type: nt });
      }
    }
  }

  // Skip empty or pure-placeholder paragraphs (no translatable text)
  const textTokens = tokens.filter((t) => t.kind === "runGroup" || t.kind === "hyperlink");
  const combinedPlain = textTokens.map((t) => t.text).join("").trim();
  if (!combinedPlain) {
    if (hasProtectedTrackedChanges) {
      // Return sentinel with no segment text? Skip so tracked-change-only paragraphs aren't touched,
      // while caller still counts protectedTrackedChanges.
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

  // Decide whether runGroups need <g> wrappers (only when paragraph has multiple distinct formatting styles or mixed tokens)
  const distinctStyles = new Set(
    tokens.filter((t): t is Extract<Token, { kind: "runGroup" }> => t.kind === "runGroup").map((t) => t.rPr)
  );
  const singleUniformRun =
    tokens.length === 1 && tokens[0].kind === "runGroup";
  const wrapStyledRuns = distinctStyles.size > 1;

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
        });
        segmentText += `<g id="${id}" type="format">${tok.text}</g>`;
      } else {
        slots.push({
          id: "plain",
          wrapped: false,
          type: "plain",
          wtSpans: tok.wtSpans,
          originalText: tok.text,
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
} {
  const rawZipBytes = fs.readFileSync(filePath);
  const entries = unzipSync(rawZipBytes);
  const parts = discoverDocxXmlParts(Object.keys(entries));
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
  };
}

function parseTranslatedSlots(
  translated: string,
  slots: TextGroupSlot[]
): Map<string, string> | null {
  const result = new Map<string, string>();
  if (slots.length === 1 && !slots[0].wrapped) {
    result.set("plain", translated);
    return result;
  }

  for (const m of translated.matchAll(/<g\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/g>/g)) {
    result.set(m[1], m[2]);
  }
  for (const slot of slots) {
    if (slot.wrapped && !result.has(slot.id)) {
      return null;
    }
  }
  return result;
}

function buildWtReplacement(wt: WtSpan, newText: string): { start: number; end: number; replacement: string } {
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

    // Group XML splices by partName
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

      // If translation is identical to source -> zero XML edits (guarantees byte-identical round-trip!)
      if (u.text === para.segment.text) {
        continue;
      }

      const slotMap = parseTranslatedSlots(u.text, para.slots);
      if (!slotMap) {
        errors.push({
          id: u.id,
          code: "inline_tag_mismatch",
          message: `Could not map translated <g> tags back to OOXML runs for segment "${u.id}".`,
        });
        continue;
      }

      const partSplices = splicesByPart.get(para.partName) ?? [];
      for (const slot of para.slots) {
        const newSlotText = slotMap.get(slot.id);
        if (newSlotText === undefined || newSlotText === slot.originalText) continue;
        if (slot.wtSpans.length === 0) continue;

        // Place translated text into first <w:t> of the merged run group; empty trailing merged <w:t> spans
        partSplices.push(buildWtReplacement(slot.wtSpans[0], newSlotText));
        for (let k = 1; k < slot.wtSpans.length; k++) {
          partSplices.push({
            start: slot.wtSpans[k].textStart,
            end: slot.wtSpans[k].textEnd,
            replacement: "",
          });
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

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // If zero splices across all parts -> write exact original bytes (100% byte-identical DOCX!)
    const totalSplices = [...splicesByPart.values()].reduce((acc, arr) => acc + arr.length, 0);
    if (totalSplices === 0) {
      fs.writeFileSync(targetPath, parsed.rawZipBytes);
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

    // Splice ONLY modified text spans into modified XML parts; keep all other ZIP entries verbatim
    const updatedEntries: Record<string, Uint8Array> = { ...parsed.entries };
    for (const [partName, splices] of splicesByPart) {
      if (splices.length === 0) continue;
      let xml = parsed.xmlStrings.get(partName)!;
      // Sort descending by start offset so earlier offsets stay valid
      for (const sp of splices.sort((a, b) => b.start - a.start)) {
        xml = xml.slice(0, sp.start) + sp.replacement + xml.slice(sp.end);
      }
      updatedEntries[partName] = strToU8(xml);
    }

    const outBytes = zipSync(updatedEntries, { level: 6 });
    fs.writeFileSync(targetPath, outBytes);

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
