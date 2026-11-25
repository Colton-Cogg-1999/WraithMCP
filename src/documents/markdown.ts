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

function encodeMarkdownInline(raw: string): {
  encoded: string;
  placeholders: Map<string, InlinePlaceholder>;
  tags: DocumentInlineTagMeta[];
} {
  const placeholders = new Map<string, InlinePlaceholder>();
  const tags: DocumentInlineTagMeta[] = [];
  let nextId = 1;

  // Order matters: inline code, images, links, bold, italic, inline HTML/JSX tags
  const tokenRe =
    /(`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|<[^>]+>)/g;

  const encoded = raw.replace(
    tokenRe,
    (match, _full, linkLabel, linkHref, boldInner, italicInner) => {
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
      // Inline HTML / MDX JSX element
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
  // Replace self-closing <x id="N" .../>
  let out = translated.replace(/<x\b[^>]*\bid=["']([^"']+)["'][^>]*\/>/g, (full, id) => {
    const p = placeholders.get(id);
    return p ? p.originalRaw : full;
  });

  // Replace paired <g id="N" ...>inner</g> iteratively (handles nested tags too)
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

function parseMarkdownSpans(content: string, relFile: string): MarkdownSpanSegment[] {
  const spans: MarkdownSpanSegment[] = [];
  const lines = content.split(/\n/);

  // Track exact character offsets of each line
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  let idx = 0;
  let segNum = 1;

  // Handle YAML frontmatter at top of file
  if (lines[0]?.trim() === "---") {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd > 0) {
      for (let i = 1; i < fmEnd; i++) {
        const line = lines[i];
        const m = /^(\s*(?:title|description|summary|subtitle)\s*:\s*)(["']?)(.+?)\2(\s*)$/.exec(
          line
        );
        if (m && m[3].trim()) {
          const valStart = lineOffsets[i] + m[1].length + m[2].length;
          const valEnd = valStart + m[3].length;
          const rawVal = content.slice(valStart, valEnd);
          const { encoded, placeholders, tags } = encodeMarkdownInline(rawVal);
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

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    // Fenced code blocks
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[1][0];
      } else if (trimmed.startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      idx++;
      continue;
    }
    if (inFence) {
      idx++;
      continue;
    }

    // Blank lines, thematic breaks, MDX imports/exports, standalone JSX block lines
    if (
      !trimmed ||
      /^(?:[-*_]\s*){3,}$/.test(trimmed) ||
      /^(?:import|export)\s+/.test(trimmed) ||
      /^<\/?[A-Z][A-Za-z0-9.]*\b[^>]*\/?>$/.test(trimmed) ||
      /^\|?[\s:-]+\|[\s|:-]*$/.test(trimmed)
    ) {
      idx++;
      continue;
    }

    // Extract line-level prefix (headings, list bullets, blockquotes) so formatting stays untouched
    const prefixMatch = /^(\s*(?:#{1,6}\s+|(?:[-*+]|\d+\.)\s+|>\s+))(.*)$/.exec(line);
    const prefixLen = prefixMatch ? prefixMatch[1].length : 0;
    const textPart = prefixMatch ? prefixMatch[2] : line;
    if (!/\p{L}/u.test(textPart)) {
      idx++;
      continue;
    }

    const start = lineOffsets[idx] + prefixLen;
    const end = lineOffsets[idx] + line.length;
    const rawSpan = content.slice(start, end);
    const { encoded, placeholders, tags } = encodeMarkdownInline(rawSpan);

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
    idx++;
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
    const spans = parseMarkdownSpans(content, rel);
    const segments = spans.map((s) => s.segment);
    const wordCount = segments.reduce(
      (sum, s) => sum + (s.plainText.match(/\S+/g)?.length ?? 0),
      0
    );
    const parts = [...new Set(segments.map((s) => s.part))];

    return {
      file: filePath,
      format: filePath.endsWith(".mdx") ? "mdx" : "markdown",
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
    const spans = parseMarkdownSpans(original, path.basename(sourcePath));
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

      // Validate inline tags strictly
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
          message: `Inline tags in segment "${u.id}" do not match source (${tgtTags.error ?? "tag set mismatch"}).`,
        });
        continue;
      }

      // Unchanged segment -> zero edits (guarantees byte-identical round-trip)
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

    // Apply splices from back to front so offsets never drift
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
