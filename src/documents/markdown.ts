import fs from "node:fs";
import path from "node:path";
import { extractInlineTags } from "../core/placeholders.js";
import { atomicWriteFileSync } from "../core/security.js";
import {
  DocumentAdapter,
  DocumentApplyResult,
  DocumentInlineTagMeta,
  DocumentSegment,
  DocumentTranslationUpdate,
  ExtractedDocument,
} from "./types.js";

interface InlinePlaceholder {
  id: string;
  kind: "x" | "g";
  type: string;
  originalRaw: string;
  prefix?: string;
  suffix?: string;
}

interface MarkdownSpanSegment {
  segment: DocumentSegment;
  start: number;
  end: number;
  placeholders: Map<string, InlinePlaceholder>;
}

function encodeMarkdownInline(
  raw: string,
  isMdx: boolean
): {
  encoded: string;
  placeholders: Map<string, InlinePlaceholder>;
  tags: DocumentInlineTagMeta[];
} {
  const placeholders = new Map<string, InlinePlaceholder>();
  const tags: DocumentInlineTagMeta[] = [];
  let nextId = 1;

  // Order matters: inline code, images, inline links, reference links, bold, italic, MDX {expressions}, inline HTML/JSX tags
  const tokenRe = isMdx
    ? /(`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[([^\]]+)\]\(([^)]+)\)|\[([^\]]+)\]\[([^\]]*)\]|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|\{[^{}\n]+\}|<[^>]+>)/g
    : /(`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[([^\]]+)\]\(([^)]+)\)|\[([^\]]+)\]\[([^\]]*)\]|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|<[^>]+>)/g;

  const encoded = raw.replace(
    tokenRe,
    (match, _full, linkLabel, linkHref, refLabel, refId, boldInner, italicInner) => {
      const id = String(nextId++);
      if (match.startsWith("`")) {
        placeholders.set(id, { id, kind: "x", type: "code", originalRaw: match });
        tags.push({ id, kind: "x", type: "code" });
        return `<x id="${id}" type="code"/>`;
      }
      if (match.startsWith("![")) {
        placeholders.set(id, { id, kind: "x", type: "image", originalRaw: match });
        tags.push({ id, kind: "x", type: "image" });
        return `<x id="${id}" type="image"/>`;
      }
      if (linkLabel !== undefined && linkHref !== undefined) {
        placeholders.set(id, {
          id,
          kind: "g",
          type: "link",
          originalRaw: match,
          prefix: "[",
          suffix: `](${linkHref})`,
        });
        tags.push({ id, kind: "g", type: "link" });
        return `<g id="${id}" type="link">${linkLabel}</g>`;
      }
      if (refLabel !== undefined && refId !== undefined) {
        placeholders.set(id, {
          id,
          kind: "g",
          type: "link",
          originalRaw: match,
          prefix: "[",
          suffix: `][${refId}]`,
        });
        tags.push({ id, kind: "g", type: "link" });
        return `<g id="${id}" type="link">${refLabel}</g>`;
      }
      if (boldInner !== undefined) {
        placeholders.set(id, {
          id,
          kind: "g",
          type: "bold",
          originalRaw: match,
          prefix: "**",
          suffix: "**",
        });
        tags.push({ id, kind: "g", type: "bold" });
        return `<g id="${id}" type="bold">${boldInner}</g>`;
      }
      if (italicInner !== undefined) {
        placeholders.set(id, {
          id,
          kind: "g",
          type: "italic",
          originalRaw: match,
          prefix: "*",
          suffix: "*",
        });
        tags.push({ id, kind: "g", type: "italic" });
        return `<g id="${id}" type="italic">${italicInner}</g>`;
      }
      if (isMdx && match.startsWith("{") && match.endsWith("}")) {
        placeholders.set(id, { id, kind: "x", type: "expression", originalRaw: match });
        tags.push({ id, kind: "x", type: "expression" });
        return `<x id="${id}" type="expression"/>`;
      }
      placeholders.set(id, { id, kind: "x", type: "markup", originalRaw: match });
      tags.push({ id, kind: "x", type: "markup" });
      return `<x id="${id}" type="markup"/>`;
    }
  );

  return { encoded, placeholders, tags };
}

function decodeMarkdownInline(
  translated: string,
  placeholders: Map<string, InlinePlaceholder>
): string {
  let out = translated.replace(/<x\b[^>]*\bid=["']([^"']+)["'][^>]*\/>/g, (full, id) => {
    const p = placeholders.get(id);
    return p ? p.originalRaw : full;
  });

  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(
      /<g\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/g>/g,
      (full, id, inner) => {
        const p = placeholders.get(id);
        if (!p || p.kind !== "g") return full;
        return `${p.prefix ?? ""}${inner}${p.suffix ?? ""}`;
      }
    );
  }
  return out;
}

function stripInlineTags(text: string): string {
  return text.replace(/<x\b[^>]*\/>/g, " ").replace(/<\/?g\b[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

interface LineMeta {
  /** Line content WITHOUT trailing \r or \n */
  text: string;
  /** Exact start offset in original content */
  start: number;
  /** Exact end offset of line content (excluding \r\n or \n) */
  end: number;
}

function splitLinesWithOffsets(content: string): LineMeta[] {
  const out: LineMeta[] = [];
  let pos = 0;
  while (pos <= content.length) {
    const nlIdx = content.indexOf("\n", pos);
    if (nlIdx === -1) {
      const end = content.endsWith("\r") ? content.length - 1 : content.length;
      out.push({ text: content.slice(pos, end), start: pos, end });
      break;
    }
    const end = nlIdx > pos && content[nlIdx - 1] === "\r" ? nlIdx - 1 : nlIdx;
    out.push({ text: content.slice(pos, end), start: pos, end });
    pos = nlIdx + 1;
    if (pos === content.length) break;
  }
  return out;
}

function countBraceDelta(line: string): number {
  let delta = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      delta++;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      delta--;
    }
  }
  return delta;
}

function isLinkRefDefinition(trimmed: string): boolean {
  // CommonMark link reference definition: `[label]: <url> "optional title"`
  return /^\[[^\]]+\]:\s*\S+/.test(trimmed);
}

function isBlockBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^(`{3,}|~{3,})/.test(trimmed)) return true;
  if (/^#{1,6}\s+/.test(trimmed)) return true;
  if (/^(?:[-*+]|\d+\.)\s+/.test(trimmed)) return true;
  if (/^>\s*/.test(trimmed)) return true;
  if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) return true;
  if (/^\|/.test(trimmed)) return true;
  if (/^<\/?[A-Z][A-Za-z0-9.]*\b[^>]*\/?>$/.test(trimmed)) return true;
  if (isLinkRefDefinition(trimmed)) return true;
  return false;
}

function parseMarkdownSpans(content: string, relFile: string, isMdx: boolean): MarkdownSpanSegment[] {
  const spans: MarkdownSpanSegment[] = [];
  const lines = splitLinesWithOffsets(content);

  let idx = 0;
  let segNum = 1;

  // 1. YAML frontmatter at top of file
  if (lines[0]?.text.trim() === "---") {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].text.trim() === "---") {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd > 0) {
      for (let i = 1; i < fmEnd; i++) {
        const line = lines[i];
        const m = /^(\s*(?:title|description|summary|subtitle)\s*:\s*)(["']?)(.+?)\2(\s*)$/.exec(
          line.text
        );
        if (m && m[3].trim()) {
          const valStart = line.start + m[1].length + m[2].length;
          const valEnd = valStart + m[3].length;
          const rawVal = content.slice(valStart, valEnd);
          const { encoded, placeholders, tags } = encodeMarkdownInline(rawVal, isMdx);
          spans.push({
            segment: {
              id: `md-${segNum++}`,
              part: "frontmatter",
              location: `${relFile}:${i + 1}`,
              text: encoded,
              plainText: stripInlineTags(encoded),
              tags,
            },
            start: valStart,
            end: valEnd,
            placeholders,
          });
        }
      }
      idx = fmEnd + 1;
    }
  }

  let inFence = false;
  let fenceChar = "";
  let prevWasBlank = true;
  let inIndentedCode = false;

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.text.trim();

    // Fenced code blocks
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (trimmed.startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      prevWasBlank = false;
      inIndentedCode = false;
      idx++;
      continue;
    }
    if (inFence) {
      idx++;
      continue;
    }

    if (!trimmed) {
      prevWasBlank = true;
      inIndentedCode = false;
      idx++;
      continue;
    }

    // U2: Indented code blocks (4+ spaces or leading tab following a blank line or another indented code line)
    if ((prevWasBlank || inIndentedCode) && /^(?: {4,}|\t)/.test(line.text)) {
      inIndentedCode = true;
      prevWasBlank = false;
      idx++;
      continue;
    }
    inIndentedCode = false;

    // U6: MDX multi-line import/export ESM blocks
    if (isMdx && /^(?:import|export)\s+/.test(trimmed)) {
      let depth = countBraceDelta(line.text);
      idx++;
      while (idx < lines.length && depth > 0) {
        depth += countBraceDelta(lines[idx].text);
        idx++;
      }
      prevWasBlank = false;
      continue;
    }

    // U3: CommonMark link reference definitions (`[d]: https://example.com "Title"`) — never expose URL
    if (isLinkRefDefinition(trimmed)) {
      prevWasBlank = false;
      idx++;
      continue;
    }

    // Thematic breaks, table separator rows, standalone JSX block tags
    if (
      /^(?:[-*_]\s*){3,}$/.test(trimmed) ||
      /^<\/?[A-Z][A-Za-z0-9.]*\b[^>]*\/?>$/.test(trimmed) ||
      /^\|?[\s:-]+\|[\s|:-]*$/.test(trimmed)
    ) {
      prevWasBlank = false;
      idx++;
      continue;
    }

    // Heading, list item, or blockquote line (single block)
    const prefixMatch = /^(\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+|>\s+))(.*)$/.exec(line.text);
    if (prefixMatch) {
      const prefixLen = prefixMatch[1].length;
      const textPart = prefixMatch[2];
      if (/\p{L}/u.test(textPart)) {
        const start = line.start + prefixLen;
        const end = line.end;
        const rawSpan = content.slice(start, end);
        const { encoded, placeholders, tags } = encodeMarkdownInline(rawSpan, isMdx);
        spans.push({
          segment: {
            id: `md-${segNum++}`,
            part: "body",
            location: `${relFile}:${idx + 1}`,
            text: encoded,
            plainText: stripInlineTags(encoded),
            tags,
          },
          start,
          end,
          placeholders,
        });
      }
      prevWasBlank = false;
      idx++;
      continue;
    }

    // U1: Paragraph-level segmentation — join consecutive hard-wrapped prose lines into ONE segment!
    const startLineIdx = idx;
    const paraStart = line.start;
    let paraEnd = line.end;
    const joinedParts: string[] = [line.text];
    idx++;
    while (idx < lines.length && !isBlockBoundaryLine(lines[idx].text)) {
      if (isMdx && /^(?:import|export)\s+/.test(lines[idx].text.trim())) break;
      joinedParts.push(lines[idx].text.trim());
      paraEnd = lines[idx].end;
      idx++;
    }
    prevWasBlank = false;

    const rawParagraph = joinedParts.join(" ");
    if (!/\p{L}/u.test(rawParagraph)) continue;

    const { encoded, placeholders, tags } = encodeMarkdownInline(rawParagraph, isMdx);
    spans.push({
      segment: {
        id: `md-${segNum++}`,
        part: "body",
        location: `${relFile}:${startLineIdx + 1}`,
        text: encoded,
        plainText: stripInlineTags(encoded),
        tags,
      },
      start: paraStart,
      end: paraEnd,
      placeholders,
    });
  }

  return spans;
}

export class MarkdownDocumentAdapter implements DocumentAdapter {
  readonly format: "markdown" | "mdx";
  readonly extensions: readonly string[];

  constructor(format: "markdown" | "mdx" = "markdown") {
    this.format = format;
    this.extensions = format === "mdx" ? [".mdx"] : [".md", ".markdown"];
  }

  extract(filePath: string): ExtractedDocument {
    const content = fs.readFileSync(filePath, "utf8");
    const rel = path.basename(filePath);
    const isMdx = this.format === "mdx" || filePath.toLowerCase().endsWith(".mdx");
    const spans = parseMarkdownSpans(content, rel, isMdx);
    const segments = spans.map((s) => s.segment);
    const wordCount = segments.reduce(
      (sum, s) => sum + (s.plainText.match(/\S+/g)?.length ?? 0),
      0
    );
    const parts = [...new Set(segments.map((s) => s.part))];

    return {
      file: filePath,
      format: isMdx ? "mdx" : "markdown",
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
    const original = fs.readFileSync(sourcePath, "utf8");
    const isMdx = this.format === "mdx" || sourcePath.toLowerCase().endsWith(".mdx");
    const spans = parseMarkdownSpans(original, path.basename(sourcePath), isMdx);
    const spanById = new Map(spans.map((s) => [s.segment.id, s]));

    const errors: Array<{ id: string; code: string; message: string }> = [];
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    let updatedCount = 0;

    for (const u of updates) {
      const span = spanById.get(u.id);
      if (!span) {
        errors.push({ id: u.id, code: "unknown_segment", message: `Unknown segment id "${u.id}".` });
        continue;
      }

      const srcTags = extractInlineTags(span.segment.text);
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

      if (u.text === span.segment.text) {
        continue;
      }

      const decoded = decodeMarkdownInline(u.text, span.placeholders);
      replacements.push({ start: span.start, end: span.end, text: decoded });
      updatedCount++;
    }

    if (errors.length > 0) {
      return {
        ok: false,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: spans.length,
        segmentsUpdated: 0,
        byteIdentical: false,
        errors,
      };
    }

    let output = original;
    for (const rep of replacements.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, rep.start) + rep.text + output.slice(rep.end);
    }

    atomicWriteFileSync(targetPath, output);

    return {
      ok: true,
      sourceFile: sourcePath,
      targetFile: targetPath,
      segmentsTotal: spans.length,
      segmentsUpdated: updatedCount,
      byteIdentical: output === original,
      errors: [],
    };
  }
}
