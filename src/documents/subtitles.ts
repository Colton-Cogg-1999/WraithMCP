import fs from "node:fs";
import { atomicWriteFileSync } from "../core/security.js";
import {
  DocumentAdapter,
  DocumentApplyResult,
  DocumentInlineTagMeta,
  DocumentSegment,
  DocumentTranslationUpdate,
  ExtractedDocument,
} from "./types.js";

/**
 * Byte-preserving WebVTT (.vtt) and SubRip (.srt) subtitle adapter.
 *
 * Principles:
 * 1. Preserves exact headers (`WEBVTT`, `NOTE`, `STYLE`, `REGION`), cue identifiers,
 *    timestamps, cue settings (`align:start position:10%`), blank lines, and line endings
 *    outside modified cue text ranges.
 * 2. Untouched cues produce a byte-identical output file.
 * 3. Protects inline cue markup (`<i>`, `<b>`, `<u>`, `<c.class>`, `<v Speaker>`, `<font ...>`)
 *    and computes deterministic reading-speed budgets (`durationSec`, `maxChars` at 20 CPS,
 *    `maxLines: 2`, `maxCharsPerLine: 42`) so translating agents respect subtitle timing.
 */

interface ParsedCue {
  id: string;
  cueIndex: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Exact byte/char range of the cue payload text in the raw file string */
  payloadStart: number;
  payloadEnd: number;
  rawPayload: string;
  taggedText: string;
  plainText: string;
  tags: DocumentInlineTagMeta[];
  rawTagMap: Map<string, string>;
}

const VTT_TIME_RE =
  /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})(?:\s+.*)?$/;
const SRT_TIME_RE =
  /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2}),(\d{3})(?:\s+.*)?$/;

function parseTimestampToSec(h: string | undefined, m: string, s: string, ms: string): number {
  return (
    (h ? Number.parseInt(h, 10) : 0) * 3600 +
    Number.parseInt(m, 10) * 60 +
    Number.parseInt(s, 10) +
    Number.parseInt(ms, 10) / 1000
  );
}

const INLINE_CUE_TAG_RE = /<\/?(?:i|b|u|c(?:\.[^>\s]+)?|v(?:\s+[^>]+)?|lang(?:\s+[^>]+)?|ruby|rt|font(?:\s+[^>]+)?)>/gi;

function encodeInlineTags(raw: string): {
  taggedText: string;
  plainText: string;
  tags: DocumentInlineTagMeta[];
  rawTagMap: Map<string, string>;
} {
  const tags: DocumentInlineTagMeta[] = [];
  const rawTagMap = new Map<string, string>();
  let idx = 0;

  const taggedText = raw.replace(INLINE_CUE_TAG_RE, (match) => {
    idx++;
    const id = `t${idx}`;
    rawTagMap.set(id, match);
    tags.push({ id, kind: "x", type: "cue-tag" });
    return `<x id="${id}"/>`;
  });

  const plainText = raw.replace(INLINE_CUE_TAG_RE, "").trim();
  return { taggedText, plainText, tags, rawTagMap };
}

function decodeInlineTags(
  translated: string,
  rawTagMap: Map<string, string>
): { ok: true; text: string } | { ok: false; message: string } {
  const seen = new Set<string>();
  const unknown: string[] = [];

  const restored = translated.replace(/<x\s+id="([^"]+)"\s*\/>/g, (full, id: string) => {
    const orig = rawTagMap.get(id);
    if (!orig) {
      unknown.push(id);
      return full;
    }
    seen.add(id);
    return orig;
  });

  if (unknown.length > 0) {
    return { ok: false, message: `Unknown inline cue tag(s): ${unknown.join(", ")}` };
  }
  const missing = [...rawTagMap.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return { ok: false, message: `Missing inline cue tag(s): ${missing.join(", ")}` };
  }
  return { ok: true, text: restored };
}

function parseSubtitleCues(raw: string, format: "vtt" | "srt"): ParsedCue[] {
  const lineInfos: Array<{ text: string; start: number; end: number }> = [];
  let pos = 0;
  while (pos <= raw.length) {
    const nl = raw.indexOf("\n", pos);
    if (nl === -1) {
      const line = raw.slice(pos).replace(/\r$/, "");
      lineInfos.push({ text: line, start: pos, end: raw.length });
      break;
    }
    const lineEnd = nl > pos && raw[nl - 1] === "\r" ? nl - 1 : nl;
    lineInfos.push({ text: raw.slice(pos, lineEnd), start: pos, end: lineEnd });
    pos = nl + 1;
  }

  const timeRe = format === "vtt" ? VTT_TIME_RE : SRT_TIME_RE;
  const cues: ParsedCue[] = [];
  let i = 0;
  let cueIndex = 0;

  while (i < lineInfos.length) {
    const line = lineInfos[i].text.trim();
    if (!line) {
      i++;
      continue;
    }

    // Skip WebVTT header / NOTE / STYLE / REGION blocks
    if (
      format === "vtt" &&
      (line.startsWith("WEBVTT") ||
        line.startsWith("NOTE") ||
        line === "STYLE" ||
        line === "REGION")
    ) {
      i++;
      while (i < lineInfos.length && lineInfos[i].text.trim() !== "") i++;
      continue;
    }

    let timeMatch = timeRe.exec(line);
    let timeLineIdx = i;
    if (!timeMatch && i + 1 < lineInfos.length) {
      const nextMatch = timeRe.exec(lineInfos[i + 1].text.trim());
      if (nextMatch) {
        timeMatch = nextMatch;
        timeLineIdx = i + 1;
      }
    }

    if (!timeMatch) {
      i++;
      continue;
    }

    const startSec = parseTimestampToSec(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const endSec = parseTimestampToSec(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);
    const durationSec = Math.max(0.1, Number((endSec - startSec).toFixed(3)));

    const payloadStartLine = timeLineIdx + 1;
    let payloadEndLine = payloadStartLine;
    while (payloadEndLine < lineInfos.length && lineInfos[payloadEndLine].text.trim() !== "") {
      payloadEndLine++;
    }

    if (payloadEndLine > payloadStartLine) {
      cueIndex++;
      const payloadStart = lineInfos[payloadStartLine].start;
      const payloadEnd = lineInfos[payloadEndLine - 1].end;
      const rawPayload = raw.slice(payloadStart, payloadEnd);
      const { taggedText, plainText, tags, rawTagMap } = encodeInlineTags(rawPayload);

      cues.push({
        id: `cue:${cueIndex}`,
        cueIndex,
        startSec,
        endSec,
        durationSec,
        payloadStart,
        payloadEnd,
        rawPayload,
        taggedText,
        plainText,
        tags,
        rawTagMap,
      });
    }

    i = payloadEndLine + 1;
  }

  return cues;
}

export class SubtitleDocumentAdapter implements DocumentAdapter {
  readonly format: "vtt" | "srt";
  readonly extensions: readonly string[];

  constructor(format: "vtt" | "srt") {
    this.format = format;
    this.extensions = format === "vtt" ? [".vtt"] : [".srt"];
  }

  extract(filePath: string): ExtractedDocument {
    const raw = fs.readFileSync(filePath, "utf8");
    const cues = parseSubtitleCues(raw, this.format);

    const segments: DocumentSegment[] = cues.map((c) => {
      // Industry-standard subtitle reading speed: ~20 chars/sec, max 2 lines, max 42 chars/line
      const maxChars = Math.max(12, Math.min(84, Math.round(c.durationSec * 20)));
      return {
        id: c.id,
        part: this.format,
        location: `${this.format}:cue:${c.cueIndex}`,
        text: c.taggedText,
        plainText: c.plainText,
        tags: c.tags,
        constraints: {
          maxChars,
          maxLines: 2,
          maxCharsPerLine: 42,
          durationSec: c.durationSec,
        },
      };
    });

    const wordCount = segments.reduce(
      (sum, s) => sum + s.plainText.split(/\s+/).filter(Boolean).length,
      0
    );

    return {
      file: filePath,
      format: this.format,
      fullDocumentContext: segments
        .map((s) => `[${s.id} (${s.constraints?.durationSec ?? 0}s, max ${s.constraints?.maxChars ?? 42} chars)] ${s.text}`)
        .join("\n"),
      segments,
      stats: {
        segmentCount: segments.length,
        wordCount,
        parts: [this.format],
        protectedTrackedChanges: 0,
      },
    };
  }

  apply(
    sourcePath: string,
    targetPath: string,
    updates: DocumentTranslationUpdate[]
  ): DocumentApplyResult {
    const raw = fs.readFileSync(sourcePath, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const cues = parseSubtitleCues(raw, this.format);
    const byId = new Map(cues.map((c) => [c.id, c]));

    const errors: Array<{ id: string; code: string; message: string }> = [];
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    let updatedCount = 0;

    for (const u of updates) {
      const cue = byId.get(u.id);
      if (!cue) {
        errors.push({ id: u.id, code: "unknown_segment", message: `Unknown subtitle cue "${u.id}"` });
        continue;
      }

      // Normalize line breaks to match source file EOL and reject blank lines inside a cue (which would break cue framing!)
      const normalized = u.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (/\n\s*\n/.test(normalized)) {
        errors.push({
          id: u.id,
          code: "subtitle_blank_line",
          message: `Subtitle cue "${u.id}" cannot contain a blank line (it would split the cue block).`,
        });
        continue;
      }
      if (normalized.includes("-->")) {
        errors.push({
          id: u.id,
          code: "subtitle_timestamp_injection",
          message: `Subtitle cue "${u.id}" must not contain timestamp separator "-->".`,
        });
        continue;
      }

      const decoded = decodeInlineTags(normalized, cue.rawTagMap);
      if (!decoded.ok) {
        errors.push({ id: u.id, code: "inline_tag_mismatch", message: decoded.message });
        continue;
      }

      const finalPayload = eol === "\r\n" ? decoded.text.replace(/\n/g, "\r\n") : decoded.text;
      if (finalPayload !== cue.rawPayload) {
        replacements.push({ start: cue.payloadStart, end: cue.payloadEnd, text: finalPayload });
        updatedCount++;
      }
    }

    if (errors.length > 0) {
      return {
        ok: false,
        sourceFile: sourcePath,
        targetFile: targetPath,
        segmentsTotal: cues.length,
        segmentsUpdated: 0,
        byteIdentical: false,
        errors,
      };
    }

    // Splice from end to start to keep offsets valid
    replacements.sort((a, b) => b.start - a.start);
    let out = raw;
    for (const r of replacements) {
      out = out.slice(0, r.start) + r.text + out.slice(r.end);
    }

    atomicWriteFileSync(targetPath, out);
    const byteIdentical = out === raw;

    return {
      ok: true,
      sourceFile: sourcePath,
      targetFile: targetPath,
      segmentsTotal: cues.length,
      segmentsUpdated: updatedCount,
      byteIdentical,
      errors: [],
    };
  }
}
