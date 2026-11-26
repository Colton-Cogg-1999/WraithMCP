import fs from "node:fs";
import { atomicWriteFileSync } from "../core/security.js";
import {
  FormatAdapter,
  FormatWriteUpdate,
  LocaleEntry,
  LocaleFileData,
  PlaceholderSyntax,
} from "./types.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function detectIndent(raw: string): string {
  const match = raw.match(/\n([ \t]+)"/);
  return match ? match[1] : "  ";
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix: string,
  filePath: string,
  out: Map<string, LocaleEntry>,
  unsupported?: Array<{ key?: string; description: string }>
): void {
  for (const [k, v] of Object.entries(obj)) {
    // Skip standard JSON Schema meta key ($schema in Paraglide/inlang message files)
    if (!prefix && k === "$schema") continue;
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out.set(fullKey, { key: fullKey, value: v, file: filePath });
    } else if (
      Array.isArray(v) &&
      v.length > 0 &&
      isPlainObject(v[0]) &&
      isPlainObject((v[0] as Record<string, unknown>).match)
    ) {
      const variantObj = v[0] as { match: Record<string, unknown> };
      const plurals: Record<string, string> = {};
      for (const [mk, mv] of Object.entries(variantObj.match)) {
        if (typeof mv !== "string") continue;
        const cat = mk.includes("=") ? mk.split("=").pop()!.trim() : mk;
        plurals[cat] = mv;
      }
      if (Object.keys(plurals).length > 0) {
        out.set(fullKey, {
          key: fullKey,
          value: plurals.other ?? Object.values(plurals)[0] ?? "",
          plurals,
          file: filePath,
        });
      } else {
        unsupported?.push({
          key: fullKey,
          description: "Unsupported Paraglide 2 variant message structure.",
        });
      }
    } else if (isPlainObject(v)) {
      flattenObject(v, fullKey, filePath, out, unsupported);
    }
  }
}

function isFlatJson(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.some((k) => k.includes(".")) && keys.every((k) => typeof obj[k] === "string");
}

/* -------------------------------------------------------------------------- */
/* Lossless Splice-Based JSON CST Parser                                      */
/* Preserves exact integer-like key ordering ("generic" before "404"),        */
/* Unicode escape style ("\u00e9"), UTF-8 BOM, indentation, and formatting!   */
/* -------------------------------------------------------------------------- */

interface JsonCstNode {
  kind: "object" | "array" | "string" | "primitive";
  start: number;
  end: number;
  properties?: Array<{
    key: string;
    keyStart: number;
    keyEnd: number;
    value: JsonCstNode;
  }>;
}

function parseJsonCst(text: string): JsonCstNode {
  let i = 0;
  const len = text.length;

  function skipWs() {
    while (i < len && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) {
      i++;
    }
  }

  function parseString(): { start: number; end: number; value: string } {
    const start = i;
    if (text[i] !== '"') throw new Error(`Expected '"' at offset ${i}`);
    i++;
    while (i < len) {
      if (text[i] === "\\") {
        i += 2;
      } else if (text[i] === '"') {
        i++;
        const end = i;
        return { start, end, value: JSON.parse(text.slice(start, end)) as string };
      } else {
        i++;
      }
    }
    throw new Error(`Unterminated JSON string starting at offset ${start}`);
  }

  function parseValue(): JsonCstNode {
    skipWs();
    if (i >= len) throw new Error("Unexpected end of JSON");
    const ch = text[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') {
      const s = parseString();
      return { kind: "string", start: s.start, end: s.end };
    }
    const start = i;
    while (i < len && !/[\s,\]}]/.test(text[i])) i++;
    return { kind: "primitive", start, end: i };
  }

  function parseArray(): JsonCstNode {
    const start = i;
    i++; // '['
    skipWs();
    if (text[i] === "]") {
      i++;
      return { kind: "array", start, end: i };
    }
    while (i < len) {
      parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
      } else if (text[i] === "]") {
        i++;
        return { kind: "array", start, end: i };
      } else {
        throw new Error(`Expected ',' or ']' at offset ${i}`);
      }
    }
    throw new Error(`Unterminated array at offset ${start}`);
  }

  function parseObject(): JsonCstNode {
    const start = i;
    i++; // '{'
    const properties: NonNullable<JsonCstNode["properties"]> = [];
    skipWs();
    if (text[i] === "}") {
      i++;
      return { kind: "object", start, end: i, properties };
    }
    while (i < len) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ":") throw new Error(`Expected ':' at offset ${i}`);
      i++;
      const value = parseValue();
      properties.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value });
      skipWs();
      if (text[i] === ",") {
        i++;
      } else if (text[i] === "}") {
        i++;
        return { kind: "object", start, end: i, properties };
      } else {
        throw new Error(`Expected ',' or '}' at offset ${i}`);
      }
    }
    throw new Error(`Unterminated object at offset ${start}`);
  }

  const root = parseValue();
  return root;
}

function buildNestedJsonSnippet(parts: string[], value: string, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  if (parts.length === 1) {
    return `${pad}${JSON.stringify(parts[0])}: ${JSON.stringify(value)}`;
  }
  const inner = buildNestedJsonSnippet(parts.slice(1), value, indent, depth + 1);
  return `${pad}${JSON.stringify(parts[0])}: {\n${inner}\n${pad}}`;
}

/**
 * Apply a single key update to a JSON string by splicing ONLY the affected value or
 * inserting ONLY the new property, preserving all untouched bytes verbatim!
 */
function spliceJsonUpdate(
  rawJson: string,
  keyParts: string[],
  value: string,
  indent: string,
  eol: string,
  sourceKeyOrder?: Map<string, string[]>
): string {
  const root = parseJsonCst(rawJson);
  if (root.kind !== "object") {
    throw new Error("Root JSON value must be an object.");
  }

  let currObj = root;
  let depth = 0;

  for (let idx = 0; idx < keyParts.length; idx++) {
    const part = keyParts[idx];
    const isLast = idx === keyParts.length - 1;
    const existingProp = currObj.properties?.find((p) => p.key === part);

    if (existingProp) {
      if (isLast) {
        // Splice ONLY this property's value span!
        return (
          rawJson.slice(0, existingProp.value.start) +
          JSON.stringify(value) +
          rawJson.slice(existingProp.value.end)
        );
      }
      if (existingProp.value.kind === "object") {
        currObj = existingProp.value;
        depth++;
        continue;
      }
      // Replacing a non-object value with a nested object
      const remaining = keyParts.slice(idx + 1);
      const inner = buildNestedJsonSnippet(remaining, value, indent, depth + 2).replace(/\n/g, eol);
      const pad = indent.repeat(depth + 1);
      return (
        rawJson.slice(0, existingProp.value.start) +
        `{${eol}${inner}${eol}${pad}}` +
        rawJson.slice(existingProp.value.end)
      );
    }

    // Key does not exist in currObj -> insert according to source CST sibling order when available,
    // otherwise append before currObj's closing '}'
    const remaining = keyParts.slice(idx);
    const props = currObj.properties ?? [];
    const entryText = buildNestedJsonSnippet(remaining, value, indent, depth + 1).replace(/\n/g, eol);
    const closeBraceIdx = currObj.end - 1;

    if (props.length === 0) {
      const outerPad = indent.repeat(depth);
      return (
        rawJson.slice(0, currObj.start + 1) +
        `${eol}${entryText}${eol}${outerPad}` +
        rawJson.slice(closeBraceIdx)
      );
    }

    const parentPath = keyParts.slice(0, idx).join(".");
    const srcSiblings = sourceKeyOrder?.get(parentPath);
    if (srcSiblings) {
      const targetSrcIdx = srcSiblings.indexOf(part);
      if (targetSrcIdx !== -1) {
        // Find the first existing property in currObj that appears AFTER `part` in source CST
        const nextExisting = props.find((p) => {
          const pIdx = srcSiblings.indexOf(p.key);
          return pIdx !== -1 && pIdx > targetSrcIdx;
        });
        if (nextExisting) {
          // Insert right before nextExisting's line/keyStart
          let insertAt = nextExisting.keyStart;
          while (insertAt > currObj.start + 1 && (rawJson[insertAt - 1] === " " || rawJson[insertAt - 1] === "\t")) {
            insertAt--;
          }
          const trimmedEntry = entryText.replace(/^[ \t]+/, "");
          const leadingPad = rawJson.slice(insertAt, nextExisting.keyStart);
          return (
            rawJson.slice(0, insertAt) +
            `${leadingPad}${trimmedEntry},${eol}` +
            rawJson.slice(insertAt)
          );
        }
      }
    }

    const lastProp = props[props.length - 1];
    // Insert `,` right after the last property's value end, then newline + new property
    return (
      rawJson.slice(0, lastProp.value.end) +
      `,${eol}${entryText}` +
      rawJson.slice(lastProp.value.end)
    );
  }

  return rawJson;
}

export class JsonFormatAdapter implements FormatAdapter {
  readonly id: string;
  readonly extensions = [".json"] as const;
  readonly placeholderSyntaxes: readonly PlaceholderSyntax[];

  constructor(
    id = "json-icu",
    placeholderSyntaxes: readonly PlaceholderSyntax[] = ["icu", "double-mustache"]
  ) {
    this.id = id;
    this.placeholderSyntaxes = placeholderSyntaxes;
  }

  readFile(filePath: string, locale: string): LocaleFileData {
    const entries = new Map<string, LocaleEntry>();
    const unsupportedConstructs: Array<{ key?: string; description: string }> = [];
    if (!fs.existsSync(filePath)) {
      return { locale, filePath, entries };
    }
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) return { locale, filePath, entries };
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`Locale JSON file must contain a top-level object: ${filePath}`);
    }
    flattenObject(parsed, "", filePath, entries, unsupportedConstructs);
    return {
      locale,
      filePath,
      entries,
      ...(unsupportedConstructs.length > 0 ? { unsupportedConstructs } : {}),
    };
  }

  applyUpdates(
    filePath: string,
    _locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    const existed = fs.existsSync(filePath);
    const existingRawFull = existed ? fs.readFileSync(filePath, "utf8") : "";
    const hasBom = existingRawFull.startsWith("\uFEFF");
    const existingBody = hasBom ? existingRawFull.slice(1) : existingRawFull;

    const sourceRawFull =
      options?.sourceFilePath && fs.existsSync(options.sourceFilePath)
        ? fs.readFileSync(options.sourceFilePath, "utf8")
        : "";
    const sourceBody = sourceRawFull.startsWith("\uFEFF") ? sourceRawFull.slice(1) : sourceRawFull;

    const indent = existingBody
      ? detectIndent(existingBody)
      : sourceBody
        ? detectIndent(sourceBody)
        : "  ";
    const eol = (existingBody || sourceBody).includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = existingBody
      ? existingBody.endsWith("\n")
      : sourceBody
        ? sourceBody.endsWith("\n")
        : true;

    const existingObj: Record<string, unknown> = existingBody.trim()
      ? (JSON.parse(existingBody) as Record<string, unknown>)
      : {};
    const sourceObj: Record<string, unknown> | null = sourceBody.trim()
      ? (JSON.parse(sourceBody) as Record<string, unknown>)
      : null;

    const flat =
      (existed && isFlatJson(existingObj)) ||
      (!existed && sourceObj !== null && isFlatJson(sourceObj));

    // When target already exists, map each object path + key to its exact source CST sibling order
    // so newly inserted keys land next to their source-order neighbors instead of after integer keys
    // that JSON.parse() hoisted to the front in memory.
    let sourceKeyOrder: Map<string, string[]> | undefined;
    if (sourceBody.trim()) {
      sourceKeyOrder = new Map<string, string[]>();
      const recordOrder = (node: JsonCstNode, prefix: string) => {
        if (node.kind !== "object" || !node.properties) return;
        sourceKeyOrder!.set(prefix, node.properties.map((p) => p.key));
        for (const p of node.properties) {
          if (p.value.kind === "object") {
            recordOrder(p.value, prefix ? `${prefix}.${p.key}` : p.key);
          }
        }
      };
      try {
        recordOrder(parseJsonCst(sourceBody), "");
      } catch {
        sourceKeyOrder = undefined;
      }
    }

    // Start from exact existing file bytes if present (lossless splice!), or `{}` for brand-new target file
    let serialized = existingBody.trim() ? existingBody : `{}${trailingNewline ? eol : ""}`;

    // Sort updates by source CST key order when available so multi-key inserts preserve source ordering
    const orderedUpdates = [...updates];
    if (sourceBody.trim()) {
      const orderIndex = new Map<string, number>();
      let idx = 0;
      const walkCst = (node: JsonCstNode, prefix: string) => {
        if (node.kind !== "object" || !node.properties) return;
        for (const p of node.properties) {
          const full = prefix ? `${prefix}.${p.key}` : p.key;
          orderIndex.set(full, idx++);
          if (p.value.kind === "object") walkCst(p.value, full);
        }
      };
      try {
        walkCst(parseJsonCst(sourceBody), "");
      } catch {
        // ignore
      }
      orderedUpdates.sort(
        (a, b) => (orderIndex.get(a.key) ?? 1e9) - (orderIndex.get(b.key) ?? 1e9)
      );
    }

    for (const u of orderedUpdates) {
      const parts = flat ? [u.key] : u.key.split(".");
      serialized = spliceJsonUpdate(serialized, parts, u.value, indent, eol, sourceKeyOrder);
    }

    const finalContent = (hasBom ? "\uFEFF" : "") + serialized;
    if (options?.write !== false) {
      atomicWriteFileSync(filePath, finalContent);
    }
    return finalContent;
  }
}
