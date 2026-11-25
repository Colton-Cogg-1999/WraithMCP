import fs from "node:fs";
import path from "node:path";
import { getPluralCategories } from "../core/locales.js";
import { atomicWriteFileSync } from "../core/security.js";
import {
  FormatAdapter,
  FormatWriteUpdate,
  LocaleEntry,
  LocaleFileData,
} from "./types.js";

interface PoBlock {
  rawLines: string[];
  msgctxt?: string;
  msgid?: string;
  msgidPlural?: string;
  msgstr?: string;
  msgstrPlurals: Record<number, string>;
  fuzzy: boolean;
  comment?: string;
  isHeader: boolean;
}

function unescapePoString(quoted: string): string {
  const inner = quoted.slice(1, -1);
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapePoString(raw: string): string {
  return (
    '"' +
    raw
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\n/g, "\\n") +
    '"'
  );
}

/**
 * Parse `Plural-Forms: nplurals=N; plural=...;` from the PO file header msgstr.
 */
export function parsePoPluralForms(headerStr?: string): { nplurals: number; pluralExpr?: string } | undefined {
  if (!headerStr) return undefined;
  const m = /Plural-Forms:\s*nplurals\s*=\s*(\d+)\s*;\s*plural\s*=\s*([^;\n]+)/i.exec(headerStr);
  if (!m) return undefined;
  const nplurals = Number.parseInt(m[1], 10);
  if (!Number.isFinite(nplurals) || nplurals < 1) return undefined;
  return { nplurals, pluralExpr: m[2].trim() };
}

/**
 * Map GNU gettext `nplurals` count to canonical plural slot names.
 */
export function gettextSlotNames(nplurals: number, locale: string): string[] {
  if (nplurals === 1) return ["other"];
  if (nplurals === 2) return ["one", "other"];
  if (nplurals === 3) {
    const lang = locale.split(/[-_]/)[0].toLowerCase();
    if (["ru", "uk", "be", "sr", "hr", "bs", "pl", "cs", "sk", "lt"].includes(lang)) {
      return ["one", "few", "many"];
    }
    return ["one", "few", "other"];
  }
  if (nplurals === 4) return ["one", "few", "many", "other"];
  if (nplurals === 6) return ["zero", "one", "two", "few", "many", "other"];
  const cats = getPluralCategories(locale, "cardinal");
  const out: string[] = [];
  for (let i = 0; i < nplurals; i++) {
    out.push(cats[i] ?? `form_${i}`);
  }
  return out;
}

function parsePoBlocks(content: string): {
  blocks: PoBlock[];
  trailingNewline: boolean;
  pluralForms?: { nplurals: number; pluralExpr?: string };
} {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const rawGroups: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        rawGroups.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) rawGroups.push(current);

  let pluralForms: { nplurals: number; pluralExpr?: string } | undefined;

  const blocks: PoBlock[] = rawGroups.map((group) => {
    const block: PoBlock = {
      rawLines: group,
      msgstrPlurals: {},
      fuzzy: false,
      isHeader: false,
    };

    const comments: string[] = [];
    let activeField: "msgctxt" | "msgid" | "msgid_plural" | "msgstr" | `msgstr[${number}]` | null = null;

    for (const line of group) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        if (trimmed.startsWith("#.")) comments.push(trimmed.slice(2).trim());
        if (trimmed.startsWith("#,")) {
          const flags = trimmed
            .slice(2)
            .split(",")
            .map((f) => f.trim().toLowerCase());
          if (flags.includes("fuzzy")) block.fuzzy = true;
        }
        continue;
      }

      const mCtx = /^msgctxt\s+(".*")$/.exec(trimmed);
      if (mCtx) {
        activeField = "msgctxt";
        block.msgctxt = unescapePoString(mCtx[1]);
        continue;
      }
      const mId = /^msgid\s+(".*")$/.exec(trimmed);
      if (mId) {
        activeField = "msgid";
        block.msgid = unescapePoString(mId[1]);
        continue;
      }
      const mIdP = /^msgid_plural\s+(".*")$/.exec(trimmed);
      if (mIdP) {
        activeField = "msgid_plural";
        block.msgidPlural = unescapePoString(mIdP[1]);
        continue;
      }
      const mStrP = /^msgstr\[(\d+)\]\s+(".*")$/.exec(trimmed);
      if (mStrP) {
        const idx = Number.parseInt(mStrP[1], 10);
        activeField = `msgstr[${idx}]`;
        block.msgstrPlurals[idx] = unescapePoString(mStrP[2]);
        continue;
      }
      const mStr = /^msgstr\s+(".*")$/.exec(trimmed);
      if (mStr) {
        activeField = "msgstr";
        block.msgstr = unescapePoString(mStr[1]);
        continue;
      }

      const mCont = /^(".*")$/.exec(trimmed);
      if (mCont && activeField) {
        const piece = unescapePoString(mCont[1]);
        if (activeField === "msgctxt") block.msgctxt = (block.msgctxt ?? "") + piece;
        else if (activeField === "msgid") block.msgid = (block.msgid ?? "") + piece;
        else if (activeField === "msgid_plural") block.msgidPlural = (block.msgidPlural ?? "") + piece;
        else if (activeField === "msgstr") block.msgstr = (block.msgstr ?? "") + piece;
        else if (activeField.startsWith("msgstr[")) {
          const idx = Number.parseInt(activeField.slice(7, -1), 10);
          block.msgstrPlurals[idx] = (block.msgstrPlurals[idx] ?? "") + piece;
        }
      }
    }

    if (comments.length > 0) block.comment = comments.join(" ");
    if (block.msgid === "" && block.msgctxt === undefined) {
      block.isHeader = true;
      pluralForms = parsePoPluralForms(block.msgstr);
    }
    return block;
  });

  return { blocks, trailingNewline, pluralForms };
}

function makePoKey(block: PoBlock): string {
  const id = block.msgid ?? "";
  return block.msgctxt ? `${block.msgctxt}::${id}` : id;
}

function stripFuzzyFlagLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#,")) return line;
  const flags = trimmed
    .slice(2)
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && f.toLowerCase() !== "fuzzy");
  if (flags.length === 0) return null;
  return `#, ${flags.join(", ")}`;
}

function updateBlockLines(
  block: PoBlock,
  update: FormatWriteUpdate,
  targetLocale: string,
  pluralForms?: { nplurals: number; pluralExpr?: string }
): string[] {
  const preserved: string[] = [];
  let skipContinuation = false;

  for (const line of block.rawLines) {
    const trimmed = line.trim();
    if (/^msgstr(\[\d+\])?\s+/.test(trimmed)) {
      skipContinuation = true;
      continue;
    }
    if (skipContinuation && trimmed.startsWith('"')) {
      continue;
    }
    skipContinuation = false;
    // Clear `#, fuzzy` flag on apply so gettext/Django actually uses the new translation at runtime!
    if (trimmed.startsWith("#,")) {
      const cleaned = stripFuzzyFlagLine(line);
      if (cleaned !== null) preserved.push(cleaned);
      continue;
    }
    preserved.push(line);
  }

  if (block.msgidPlural !== undefined || (update.plurals && Object.keys(update.plurals).length > 0)) {
    const pluralVals = update.plurals ?? { other: update.value };
    // Respect Plural-Forms header nplurals strictly so msgfmt --check ALWAYS succeeds!
    const existingCount = Object.keys(block.msgstrPlurals).length;
    const nplurals =
      pluralForms?.nplurals ??
      (existingCount > 0 ? existingCount : getPluralCategories(targetLocale, "cardinal").length);
    const slotNames = gettextSlotNames(nplurals, targetLocale);

    slotNames.forEach((slotName, idx) => {
      const val =
        pluralVals[slotName] ??
        pluralVals[`form_${idx}`] ??
        (idx === 0 ? pluralVals.one : undefined) ??
        pluralVals.other ??
        update.value;
      preserved.push(`msgstr[${idx}] ${escapePoString(val)}`);
    });
  } else {
    preserved.push(`msgstr ${escapePoString(update.value)}`);
  }

  return preserved;
}

export class GettextPoFormatAdapter implements FormatAdapter {
  readonly id = "django-po";
  readonly extensions = [".po", ".pot"] as const;
  readonly placeholderSyntaxes = ["python-printf", "single-brace"] as const;

  readFile(filePath: string, locale: string): LocaleFileData {
    const entries = new Map<string, LocaleEntry>();
    if (!fs.existsSync(filePath)) return { locale, filePath, entries };

    const raw = fs.readFileSync(filePath, "utf8");
    const { blocks, pluralForms } = parsePoBlocks(raw);

    for (const block of blocks) {
      if (block.isHeader || !block.msgid) continue;
      const key = makePoKey(block);

      if (block.msgidPlural !== undefined) {
        const indices = Object.keys(block.msgstrPlurals)
          .map((n) => Number.parseInt(n, 10))
          .sort((a, b) => a - b);
        const nplurals =
          pluralForms?.nplurals ??
          (indices.length > 0 ? indices.length : getPluralCategories(locale, "cardinal").length);
        const slotNames = gettextSlotNames(nplurals, locale);

        const plurals: Record<string, string> = {};
        const hasAny = indices.some((i) => (block.msgstrPlurals[i] ?? "").trim().length > 0);
        if (hasAny) {
          indices.forEach((idx) => {
            const cat = slotNames[idx] ?? `form_${idx}`;
            plurals[cat] = block.msgstrPlurals[idx];
          });
        } else {
          // Untranslated plural entry -> leave plurals empty so check/prepare sees it as untranslated
        }

        const otherVal = hasAny ? (plurals.other ?? plurals[slotNames[slotNames.length - 1]] ?? "") : "";
        entries.set(key, {
          key,
          value: otherVal,
          plurals: hasAny ? plurals : undefined,
          fuzzy: block.fuzzy,
          pluralForms,
          comment: block.comment,
          file: filePath,
        });
      } else {
        const value =
          block.msgstr && block.msgstr.trim().length > 0
            ? block.msgstr
            : filePath.endsWith(".pot")
              ? block.msgid
              : "";
        entries.set(key, {
          key,
          value,
          fuzzy: block.fuzzy,
          pluralForms,
          comment: block.comment,
          file: filePath,
        });
      }
    }

    return { locale, filePath, entries, pluralForms };
  }

  /**
   * Extract source entries directly from `msgid` / `msgid_plural` of any `.po` or `.pot` file.
   * This is how standard `django-admin makemessages` projects work (no English `.po` required!).
   */
  readSourceFromMsgids(filePath: string, sourceLocale: string): LocaleFileData {
    const entries = new Map<string, LocaleEntry>();
    if (!fs.existsSync(filePath)) return { locale: sourceLocale, filePath, entries };

    const raw = fs.readFileSync(filePath, "utf8");
    const { blocks } = parsePoBlocks(raw);

    for (const block of blocks) {
      if (block.isHeader || !block.msgid) continue;
      const key = makePoKey(block);
      if (block.msgidPlural !== undefined) {
        entries.set(key, {
          key,
          value: block.msgidPlural,
          plurals: { one: block.msgid, other: block.msgidPlural },
          comment: block.comment,
          file: filePath,
        });
      } else {
        entries.set(key, {
          key,
          value: block.msgid,
          comment: block.comment,
          file: filePath,
        });
      }
    }
    return { locale: sourceLocale, filePath, entries };
  }

  applyUpdates(
    filePath: string,
    locale: string,
    updates: FormatWriteUpdate[],
    options?: { sourceFilePath?: string; write?: boolean }
  ): string {
    const existed = fs.existsSync(filePath);
    const baseRaw = existed
      ? fs.readFileSync(filePath, "utf8")
      : options?.sourceFilePath && fs.existsSync(options.sourceFilePath)
        ? fs.readFileSync(options.sourceFilePath, "utf8")
        : `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n`;

    const { blocks, trailingNewline, pluralForms } = parsePoBlocks(baseRaw);
    const updateMap = new Map(updates.map((u) => [u.key, u]));
    const handled = new Set<string>();

    const outBlocks: string[] = [];
    for (const block of blocks) {
      if (block.isHeader) {
        outBlocks.push(block.rawLines.join("\n"));
        continue;
      }
      const key = makePoKey(block);
      const upd = updateMap.get(key);
      if (upd) {
        outBlocks.push(updateBlockLines(block, upd, locale, pluralForms).join("\n"));
        handled.add(key);
      } else {
        outBlocks.push(block.rawLines.join("\n"));
      }
    }

    // Append any brand-new keys
    for (const u of updates) {
      if (handled.has(u.key)) continue;
      const lines = [`msgid ${escapePoString(u.key)}`, `msgstr ${escapePoString(u.value)}`];
      outBlocks.push(lines.join("\n"));
    }

    const serialized = outBlocks.join("\n\n") + (trailingNewline ? "\n" : "");
    if (options?.write !== false) {
      atomicWriteFileSync(filePath, serialized);
    }
    return serialized;
  }
}
