import fs from "node:fs";
import path from "node:path";
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
  out: Map<string, LocaleEntry>
): void {
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") {
      out.set(fullKey, { key: fullKey, value: v, file: filePath });
    } else if (isPlainObject(v)) {
      flattenObject(v, fullKey, filePath, out);
    }
  }
}

function isFlatJson(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  return keys.some((k) => k.includes(".")) && keys.every((k) => typeof obj[k] === "string");
}

function setNestedKey(obj: Record<string, unknown>, dottedKey: string, value: string): void {
  const parts = dottedKey.split(".");
  let curr: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(curr[part])) {
      curr[part] = {};
    }
    curr = curr[part] as Record<string, unknown>;
  }
  curr[parts[parts.length - 1]] = value;
}

/**
 * Reorder newly created keys to mirror source structure while preserving any
 * existing target key order untouched.
 */
function mergeOrderWithSource(
  targetObj: Record<string, unknown>,
  sourceObj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const existingKeys = new Set(Object.keys(targetObj));
  const placed = new Set<string>();

  // If target already has keys, preserve existing order first, then insert new keys in source order
  // If target was newly created (empty before updates), follow source order directly
  for (const key of Object.keys(sourceObj)) {
    if (existingKeys.has(key)) {
      const sv = sourceObj[key];
      const tv = targetObj[key];
      result[key] =
        isPlainObject(sv) && isPlainObject(tv) ? mergeOrderWithSource(tv, sv) : tv;
      placed.add(key);
    }
  }
  for (const key of Object.keys(targetObj)) {
    if (!placed.has(key)) {
      result[key] = targetObj[key];
    }
  }
  return result;
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
    if (!fs.existsSync(filePath)) {
      return { locale, filePath, entries };
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return { locale, filePath, entries };
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`Locale JSON file must contain a top-level object: ${filePath}`);
    }
    flattenObject(parsed, "", filePath, entries);
    return { locale, filePath, entries };
  }

  applyUpdates(
    filePath: string,
    _locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    const existed = fs.existsSync(filePath);
    const existingRaw = existed ? fs.readFileSync(filePath, "utf8") : "";
    const sourceRaw =
      options?.sourceFilePath && fs.existsSync(options.sourceFilePath)
        ? fs.readFileSync(options.sourceFilePath, "utf8")
        : "";

    const indent = existingRaw
      ? detectIndent(existingRaw)
      : sourceRaw
        ? detectIndent(sourceRaw)
        : "  ";
    const trailingNewline = existingRaw
      ? existingRaw.endsWith("\n")
      : sourceRaw
        ? sourceRaw.endsWith("\n")
        : true;

    const existingObj: Record<string, unknown> = existingRaw.trim()
      ? (JSON.parse(existingRaw) as Record<string, unknown>)
      : {};
    const sourceObj: Record<string, unknown> | null = sourceRaw.trim()
      ? (JSON.parse(sourceRaw) as Record<string, unknown>)
      : null;

    const flat =
      (existed && isFlatJson(existingObj)) ||
      (!existed && sourceObj !== null && isFlatJson(sourceObj));

    const nextObj: Record<string, unknown> = structuredClone(existingObj);
    for (const u of updates) {
      if (flat) {
        nextObj[u.key] = u.value;
      } else {
        setNestedKey(nextObj, u.key, u.value);
      }
    }

    // Preserve exact existing key order if file existed; otherwise match source key order
    const finalObj =
      !existed && sourceObj && !flat ? mergeOrderWithSource(nextObj, sourceObj) : nextObj;

    const serialized = JSON.stringify(finalObj, null, indent) + (trailingNewline ? "\n" : "");
    if (options?.write !== false) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, serialized, "utf8");
    }
    return serialized;
  }
}
