import fs from "node:fs";
import path from "node:path";
import { getPluralCategories } from "../core/locales.js";
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

function parsePoBlocks(content: string): { blocks: PoBlock[]; trailingNewline: boolean } {
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

  const blocks: PoBlock[] = rawGroups.map((group) => {
    const block: PoBlock = {
      rawLines: group,
      msgstrPlurals: {},
      isHeader: false,
    };

    const comments: string[] = [];
    let activeField: "msgctxt" | "msgid" | "msgid_plural" | "msgstr" | `msgstr[${number}]` | null = null;

    for (const line of group) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) {
        if (trimmed.startsWith("#.")) comments.push(trimmed.slice(2).trim());
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
    }
    return block;
  });

  return { blocks, trailingNewline };
}

function makePoKey(block: PoBlock): string {
  const id = block.msgid ?? "";
  return block.msgctxt ? `${block.msgctxt}::${id}` : id;
}

function updateBlockLines(block: PoBlock, update: FormatWriteUpdate, targetLocale: string): string[] {
  // Keep all header/comment/msgctxt/msgid/msgid_plural lines verbatim!
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
    preserved.push(line);
  }

  if (block.msgidPlural !== undefined || (update.plurals && Object.keys(update.plurals).length > 0)) {
    const cats = getPluralCategories(targetLocale);
    const pluralVals = update.plurals ?? { other: update.value };
    cats.forEach((cat, idx) => {
      const val = pluralVals[cat] ?? pluralVals.other ?? update.value;
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
    const { blocks } = parsePoBlocks(raw);
    const cats = getPluralCategories(locale);

    for (const block of blocks) {
      if (block.isHeader || !block.msgid) continue;
      const key = makePoKey(block);

      if (block.msgidPlural !== undefined) {
        const plurals: Record<string, string> = {};
        const indices = Object.keys(block.msgstrPlurals)
          .map((n) => Number.parseInt(n, 10))
          .sort((a, b) => a - b);

        // If msgstr[n] are empty (e.g. source template), fall back to msgid / msgid_plural
        const hasAny = indices.some((i) => (block.msgstrPlurals[i] ?? "").trim().length > 0);
        if (hasAny) {
          indices.forEach((idx) => {
            const cat = cats[idx] ?? `form_${idx}`;
            plurals[cat] = block.msgstrPlurals[idx];
          });
        } else {
          plurals.one = block.msgid;
          plurals.other = block.msgidPlural;
        }
        entries.set(key, {
          key,
          value: plurals.other ?? block.msgidPlural,
          plurals,
          comment: block.comment,
          file: filePath,
        });
      } else {
        // For source `.po` where `msgstr` is empty, use `msgid` as the source string
        const value =
          block.msgstr && block.msgstr.trim().length > 0
            ? block.msgstr
            : filePath.endsWith(".pot")
              ? block.msgid
              : block.msgstr ?? "";
        entries.set(key, {
          key,
          value,
          comment: block.comment,
          file: filePath,
        });
      }
    }

    return { locale, filePath, entries };
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

    const { blocks, trailingNewline } = parsePoBlocks(baseRaw);
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
        outBlocks.push(updateBlockLines(block, upd, locale).join("\n"));
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
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, serialized, "utf8");
    }
    return serialized;
  }
}
