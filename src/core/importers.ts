import fs from "node:fs";
import path from "node:path";
import { detectProjectAdapter, loadLocaleCatalog } from "../adapters/registry.js";
import { resolveConfinedPath } from "./security.js";
import { PolyglotStore, sha256Short } from "./store.js";
import { MemoryEntry } from "./types.js";

/** RFC 4180 CSV parser supporting quoted fields, embedded commas, escaped quotes, and CRLF. */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip UTF-8 BOM if present
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        if (row.some((c) => c.trim().length > 0)) {
          rows.push(row);
        }
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim().length > 0)) {
      rows.push(row);
    }
  }
  return rows;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

function stripXmlTags(s: string): string {
  return decodeXmlEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

export interface ImportResult {
  format: "csv" | "tbx" | "tmx" | "locales";
  file: string;
  glossaryImported: number;
  memoryImported: number;
  recordsImported: number;
  localesDetected: string[];
}

export function importGlossaryCsv(rootDir: string, filePath: string): ImportResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const abs = resolveConfinedPath(rootDir, filePath, { label: "glossary CSV file" });
  const rows = parseCsv(fs.readFileSync(abs, "utf8"));
  if (rows.length < 2) {
    return {
      format: "csv",
      file: filePath,
      glossaryImported: 0,
      memoryImported: 0,
      recordsImported: 0,
      localesDetected: [],
    };
  }

  const headers = rows[0].map((h) => h.trim());
  const termIdx = headers.findIndex((h) =>
    ["term", "source", config.sourceLocale.toLowerCase()].includes(h.toLowerCase())
  );
  const notesIdx = headers.findIndex((h) =>
    ["notes", "note", "description", "context"].includes(h.toLowerCase())
  );
  const dntIdx = headers.findIndex((h) =>
    ["donottranslate", "dnt", "do_not_translate"].includes(h.toLowerCase())
  );

  const resolvedTermIdx = termIdx >= 0 ? termIdx : 0;
  const metaIndices = new Set([resolvedTermIdx, notesIdx, dntIdx]);
  const localeColumns: Array<{ idx: number; locale: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    if (metaIndices.has(i) || !headers[i]) continue;
    localeColumns.push({ idx: i, locale: headers[i] });
  }

  let count = 0;
  const locales = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const term = (row[resolvedTermIdx] ?? "").trim();
    if (!term) continue;

    const dntRaw = dntIdx >= 0 ? (row[dntIdx] ?? "").trim().toLowerCase() : "";
    const doNotTranslate = ["true", "yes", "1", "dnt"].includes(dntRaw);
    const notes = notesIdx >= 0 ? (row[notesIdx] ?? "").trim() || undefined : undefined;

    const translations: Record<string, string> = {};
    for (const col of localeColumns) {
      const val = (row[col.idx] ?? "").trim();
      if (val) {
        translations[col.locale] = val;
        locales.add(col.locale);
      }
    }

    store.upsertGlossaryEntry({
      term,
      doNotTranslate,
      caseSensitive: doNotTranslate,
      translations,
      notes,
      origin: "imported",
    });
    count++;
  }

  return {
    format: "csv",
    file: filePath,
    glossaryImported: count,
    memoryImported: 0,
    recordsImported: 0,
    localesDetected: [...locales].sort(),
  };
}

/**
 * Import a TBX (TermBase eXchange, TBX-Basic / TBX-Core v2/v3) XML glossary file.
 */
export function importGlossaryTbx(rootDir: string, filePath: string): ImportResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const abs = resolveConfinedPath(rootDir, filePath, { label: "TBX file" });
  const xml = fs.readFileSync(abs, "utf8");

  const entryRe = /<(?:termEntry|conceptEntry)\b[^>]*>([\s\S]*?)<\/(?:termEntry|conceptEntry)>/gi;
  const langSetRe = /<langSet\b[^>]*xml:lang=["']([^"']+)["'][^>]*>([\s\S]*?)<\/langSet>/gi;
  const termRe = /<term\b[^>]*>([\s\S]*?)<\/term>/i;
  const noteRe = /<(?:note|descrip)\b[^>]*>([\s\S]*?)<\/(?:note|descrip)>/i;

  let imported = 0;
  const locales = new Set<string>();
  const srcBase = config.sourceLocale.split("-")[0].toLowerCase();

  for (const entryMatch of xml.matchAll(entryRe)) {
    const body = entryMatch[1];
    const termsByLang = new Map<string, string>();
    const entryNoteMatch = noteRe.exec(body);
    const note = entryNoteMatch ? stripXmlTags(entryNoteMatch[1]) : undefined;

    for (const langMatch of body.matchAll(langSetRe)) {
      const lang = langMatch[1].trim();
      const langBody = langMatch[2];
      const tMatch = termRe.exec(langBody);
      if (tMatch) {
        const term = stripXmlTags(tMatch[1]);
        if (term) termsByLang.set(lang, term);
      }
    }

    // Find source term
    let sourceTerm: string | undefined = termsByLang.get(config.sourceLocale);
    if (!sourceTerm) {
      for (const [lang, val] of termsByLang) {
        if (lang.split("-")[0].toLowerCase() === srcBase) {
          sourceTerm = val;
          break;
        }
      }
    }
    if (!sourceTerm) continue;

    const translations: Record<string, string> = {};
    for (const [lang, val] of termsByLang) {
      if (lang === config.sourceLocale || lang.split("-")[0].toLowerCase() === srcBase) continue;
      translations[lang] = val;
      locales.add(lang);
    }

    store.upsertGlossaryEntry({
      term: sourceTerm,
      doNotTranslate: Object.keys(translations).length === 0,
      caseSensitive: false,
      translations,
      notes: note,
      origin: "imported",
    });
    imported++;
  }

  return {
    format: "tbx",
    file: filePath,
    glossaryImported: imported,
    memoryImported: 0,
    recordsImported: 0,
    localesDetected: [...locales].sort(),
  };
}

/**
 * Import a TMX (Translation Memory eXchange v1.4) XML file into .polyglot/memory.jsonl.
 */
export function importMemoryTmx(rootDir: string, filePath: string): ImportResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const abs = resolveConfinedPath(rootDir, filePath, { label: "TMX file" });
  const xml = fs.readFileSync(abs, "utf8");

  const headerSrcMatch = /srclang=["']([^"']+)["']/i.exec(xml);
  const headerSrc =
    headerSrcMatch && headerSrcMatch[1] !== "*all*"
      ? headerSrcMatch[1]
      : config.sourceLocale;
  const srcBase = headerSrc.split("-")[0].toLowerCase();

  const tuRe = /<tu\b[^>]*>([\s\S]*?)<\/tu>/gi;
  const tuvRe = /<tuv\b[^>]*(?:xml:lang|lang)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tuv>/gi;
  const segRe = /<seg\b[^>]*>([\s\S]*?)<\/seg>/i;
  const now = new Date().toISOString();

  const additions: MemoryEntry[] = [];
  const locales = new Set<string>();

  for (const tuMatch of xml.matchAll(tuRe)) {
    const tuBody = tuMatch[1];
    const segments = new Map<string, string>();
    for (const tuvMatch of tuBody.matchAll(tuvRe)) {
      const lang = tuvMatch[1].trim();
      const segMatch = segRe.exec(tuvMatch[2]);
      if (segMatch) {
        const text = stripXmlTags(segMatch[1]);
        if (text) segments.set(lang, text);
      }
    }

    let sourceSeg: string | undefined = segments.get(headerSrc) ?? segments.get(config.sourceLocale);
    let resolvedSrcLang = headerSrc;
    if (!sourceSeg) {
      for (const [lang, seg] of segments) {
        if (lang.split("-")[0].toLowerCase() === srcBase) {
          sourceSeg = seg;
          resolvedSrcLang = lang;
          break;
        }
      }
    }
    if (!sourceSeg) continue;

    for (const [lang, seg] of segments) {
      if (lang === resolvedSrcLang) continue;
      locales.add(lang);
      additions.push({
        sourceLocale: config.sourceLocale,
        targetLocale: lang,
        source: sourceSeg,
        target: seg,
        origin: `tmx:${path.basename(filePath)}`,
        updatedAt: now,
      });
    }
  }

  const added = additions.length > 0 ? store.appendMemory(additions) : 0;

  return {
    format: "tmx",
    file: filePath,
    glossaryImported: 0,
    memoryImported: added || additions.length,
    recordsImported: 0,
    localesDetected: [...locales].sort(),
  };
}

/**
 * Import existing locale files already present in the repository into .polyglot/records.json
 * and .polyglot/memory.jsonl.
 */
export function importExistingLocales(rootDir: string): ImportResult {
  const store = new PolyglotStore(rootDir);
  const config = store.readConfig();
  const usage = store.readUsage();
  const records = store.readRecords();

  const { adapter, detection } = detectProjectAdapter(
    store.rootDir,
    config.framework,
    config.paths.locales
  );
  if (!adapter) {
    return {
      format: "locales",
      file: config.paths.locales ?? ".",
      glossaryImported: 0,
      memoryImported: 0,
      recordsImported: 0,
      localesDetected: [],
    };
  }

  const srcFiles = detection.localeFiles[config.sourceLocale] ?? [];
  const srcCatalog = loadLocaleCatalog(adapter, srcFiles, config.sourceLocale);
  const now = new Date().toISOString();

  const memoryEntries: MemoryEntry[] = [];
  let recordsImported = 0;
  const localesDetected: string[] = [];

  for (const [locale, files] of Object.entries(detection.localeFiles)) {
    if (locale === config.sourceLocale || locale.startsWith("en-x-pseudo") || locale === "pseudo") {
      continue;
    }
    localesDetected.push(locale);
    const tgtCatalog = loadLocaleCatalog(adapter, files, locale);

    for (const [key, tgtEntry] of tgtCatalog.entries) {
      const srcEntry = srcCatalog.entries.get(key);
      if (!srcEntry || !tgtEntry.value.trim()) continue;

      const sourceHash = sha256Short(
        srcEntry.plurals ? JSON.stringify(srcEntry.plurals) : srcEntry.value
      );
      const contextFingerprint = usage.keys[key]?.fingerprint ?? "";

      if (!records.records[key]) records.records[key] = {};
      records.records[key][locale] = {
        sourceHash,
        contextFingerprint,
        translation: tgtEntry.plurals ? JSON.stringify(tgtEntry.plurals) : tgtEntry.value,
        updatedAt: now,
        origin: "imported",
        reviewStatus: "unreviewed",
      };
      recordsImported++;

      memoryEntries.push({
        sourceLocale: config.sourceLocale,
        targetLocale: locale,
        source: srcEntry.value,
        target: tgtEntry.value,
        origin: "import-locales",
        updatedAt: now,
      });
    }
  }

  if (recordsImported > 0) {
    store.writeRecords(records);
  }
  const memoryImported = memoryEntries.length > 0 ? store.appendMemory(memoryEntries) : 0;

  return {
    format: "locales",
    file: detection.localesDir ?? ".",
    glossaryImported: 0,
    memoryImported: memoryImported || memoryEntries.length,
    recordsImported,
    localesDetected: localesDetected.sort(),
  };
}

export function importAsset(
  rootDir: string,
  options: { file?: string; format?: "auto" | "csv" | "tbx" | "tmx" | "locales" }
): ImportResult {
  const fmt = options.format ?? "auto";
  if (fmt === "locales" || (!options.file && fmt === "auto")) {
    return importExistingLocales(rootDir);
  }
  if (!options.file) {
    throw new Error("Please provide a file path for CSV, TBX, or TMX import.");
  }

  const ext = path.extname(options.file).toLowerCase();
  const resolved =
    fmt !== "auto"
      ? fmt
      : ext === ".tmx"
        ? "tmx"
        : ext === ".tbx"
          ? "tbx"
          : ext === ".csv"
            ? "csv"
            : "locales";

  switch (resolved) {
    case "csv":
      return importGlossaryCsv(rootDir, options.file);
    case "tbx":
      return importGlossaryTbx(rootDir, options.file);
    case "tmx":
      return importMemoryTmx(rootDir, options.file);
    case "locales":
      return importExistingLocales(rootDir);
  }
}
