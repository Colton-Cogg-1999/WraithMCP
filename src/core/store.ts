import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AssumptionsFile,
  AssumptionsFileSchema,
  ConfigSchema,
  GlossaryEntry,
  GlossaryFile,
  GlossaryFileSchema,
  MemoryEntry,
  MemoryEntrySchema,
  PolyglotConfig,
  RecordsFile,
  RecordsFileSchema,
  ReviewsFile,
  ReviewsFileSchema,
  TranslationRecord,
  UsageFile,
  UsageFileSchema,
  UsageSite,
} from "./types.js";

export const POLYGLOT_DIR = ".polyglot";

export function sha256Short(input: string, len = 16): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, len);
}

/**
 * Deterministic context fingerprint for a key's usage sites.
 * Excludes line numbers so unrelated edits elsewhere in a file do not trigger
 * false-positive context_changed warnings.
 */
export function computeContextFingerprint(sites: UsageSite[]): string {
  if (sites.length === 0) return "";
  const canonical = sites
    .map((s) => ({
      file: s.file.replace(/\\/g, "/"),
      component: s.component ?? "",
      element: s.element ?? "",
      surrounding: [...s.surrounding].sort(),
    }))
    .sort((a, b) =>
      `${a.file}|${a.component}|${a.element}|${a.surrounding.join(",")}`.localeCompare(
        `${b.file}|${b.component}|${b.element}|${b.surrounding.join(",")}`
      )
    );
  return sha256Short(JSON.stringify(canonical), 16);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sortRecordKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key];
  }
  return out;
}

export class PolyglotStore {
  readonly rootDir: string;
  readonly dir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.dir = path.join(this.rootDir, POLYGLOT_DIR);
  }

  exists(): boolean {
    return fs.existsSync(this.filePath("config.json"));
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  filePath(name: string): string {
    return path.join(this.dir, name);
  }

  readConfig(): PolyglotConfig {
    const p = this.filePath("config.json");
    if (!fs.existsSync(p)) {
      return ConfigSchema.parse({});
    }
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return ConfigSchema.parse(raw);
  }

  writeConfig(config: PolyglotConfig): void {
    this.ensureDir();
    const parsed = ConfigSchema.parse(config);
    fs.writeFileSync(this.filePath("config.json"), stableJson(parsed), "utf8");
  }

  readGlossary(): GlossaryFile {
    const p = this.filePath("glossary.json");
    if (!fs.existsSync(p)) {
      return GlossaryFileSchema.parse({});
    }
    return GlossaryFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeGlossary(file: GlossaryFile): void {
    this.ensureDir();
    const parsed = GlossaryFileSchema.parse(file);
    parsed.entries = [...parsed.entries]
      .map((entry) => ({
        ...entry,
        translations: sortRecordKeys(entry.translations),
      }))
      .sort((a, b) => a.term.localeCompare(b.term));
    fs.writeFileSync(this.filePath("glossary.json"), stableJson(parsed), "utf8");
  }

  upsertGlossaryEntry(entry: Omit<GlossaryEntry, "updatedAt"> & { updatedAt?: string }): {
    glossary: GlossaryFile;
    previous?: GlossaryEntry;
    changed: boolean;
  } {
    const glossary = this.readGlossary();
    const now = entry.updatedAt ?? new Date().toISOString();
    const idx = glossary.entries.findIndex(
      (e) => e.term.toLowerCase() === entry.term.toLowerCase()
    );
    const previous = idx >= 0 ? glossary.entries[idx] : undefined;
    const next: GlossaryEntry = {
      term: entry.term,
      doNotTranslate: entry.doNotTranslate ?? false,
      caseSensitive: entry.caseSensitive ?? false,
      translations: sortRecordKeys({
        ...(previous?.translations ?? {}),
        ...(entry.translations ?? {}),
      }),
      notes: entry.notes ?? previous?.notes,
      origin: entry.origin ?? previous?.origin ?? "user",
      updatedAt: now,
    };

    const changed =
      !previous ||
      previous.doNotTranslate !== next.doNotTranslate ||
      JSON.stringify(sortRecordKeys(previous.translations)) !==
        JSON.stringify(next.translations);

    if (idx >= 0) {
      glossary.entries[idx] = next;
    } else {
      glossary.entries.push(next);
    }
    this.writeGlossary(glossary);
    return { glossary, previous, changed };
  }

  readUsage(): UsageFile {
    const p = this.filePath("usage.json");
    if (!fs.existsSync(p)) {
      return UsageFileSchema.parse({});
    }
    return UsageFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeUsage(file: UsageFile): void {
    this.ensureDir();
    const parsed = UsageFileSchema.parse(file);
    const sortedKeys: UsageFile["keys"] = {};
    for (const k of Object.keys(parsed.keys).sort()) {
      const entry = parsed.keys[k];
      sortedKeys[k] = {
        fingerprint: entry.fingerprint,
        sites: [...entry.sites].sort((a, b) =>
          a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)
        ),
      };
    }
    fs.writeFileSync(
      this.filePath("usage.json"),
      stableJson({ version: 1, keys: sortedKeys }),
      "utf8"
    );
  }

  readRecords(): RecordsFile {
    const p = this.filePath("records.json");
    if (!fs.existsSync(p)) {
      return RecordsFileSchema.parse({});
    }
    return RecordsFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeRecords(file: RecordsFile): void {
    this.ensureDir();
    const parsed = RecordsFileSchema.parse(file);
    const sorted: RecordsFile["records"] = {};
    for (const key of Object.keys(parsed.records).sort()) {
      sorted[key] = sortRecordKeys(parsed.records[key]);
    }
    fs.writeFileSync(
      this.filePath("records.json"),
      stableJson({ version: 1, records: sorted }),
      "utf8"
    );
  }

  setRecord(key: string, locale: string, record: TranslationRecord): void {
    const file = this.readRecords();
    if (!file.records[key]) {
      file.records[key] = {};
    }
    file.records[key][locale] = record;
    this.writeRecords(file);
  }

  readMemory(): MemoryEntry[] {
    const p = this.filePath("memory.jsonl");
    if (!fs.existsSync(p)) return [];
    const lines = fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out: MemoryEntry[] = [];
    for (const line of lines) {
      out.push(MemoryEntrySchema.parse(JSON.parse(line)));
    }
    return out;
  }

  writeMemory(entries: MemoryEntry[]): void {
    this.ensureDir();
    // Deduplicate by (sourceLocale, targetLocale, source, target) keeping newest
    const map = new Map<string, MemoryEntry>();
    for (const raw of entries) {
      const e = MemoryEntrySchema.parse(raw);
      const k = `${e.sourceLocale}\0${e.targetLocale}\0${e.source}\0${e.target}`;
      map.set(k, e);
    }
    const sorted = [...map.values()].sort((a, b) =>
      `${a.sourceLocale}|${a.targetLocale}|${a.source}|${a.target}`.localeCompare(
        `${b.sourceLocale}|${b.targetLocale}|${b.source}|${b.target}`
      )
    );
    const body = sorted.map((e) => JSON.stringify(e)).join("\n") + (sorted.length ? "\n" : "");
    fs.writeFileSync(this.filePath("memory.jsonl"), body, "utf8");
  }

  appendMemory(newEntries: MemoryEntry[]): number {
    const existing = this.readMemory();
    const before = existing.length;
    this.writeMemory([...existing, ...newEntries]);
    return this.readMemory().length - before;
  }

  readAssumptions(): AssumptionsFile {
    const p = this.filePath("assumptions.json");
    if (!fs.existsSync(p)) {
      return AssumptionsFileSchema.parse({});
    }
    return AssumptionsFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeAssumptions(file: AssumptionsFile): void {
    this.ensureDir();
    const parsed = AssumptionsFileSchema.parse(file);
    fs.writeFileSync(this.filePath("assumptions.json"), stableJson(parsed), "utf8");
  }

  addAssumption(input: {
    category: AssumptionsFile["assumptions"][number]["category"];
    locale?: string;
    summary: string;
    rationale?: string;
  }): AssumptionsFile["assumptions"][number] {
    const file = this.readAssumptions();
    const id = sha256Short(`${input.category}|${input.locale ?? ""}|${input.summary}`, 8);
    const existing = file.assumptions.find((a) => a.id === id);
    if (existing) return existing;
    const item = {
      id,
      category: input.category,
      locale: input.locale,
      summary: input.summary,
      rationale: input.rationale,
      createdAt: new Date().toISOString(),
    };
    file.assumptions.push(item);
    this.writeAssumptions(file);
    return item;
  }

  readReviews(): ReviewsFile {
    const p = this.filePath("reviews.json");
    if (!fs.existsSync(p)) {
      return ReviewsFileSchema.parse({});
    }
    return ReviewsFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeReviews(file: ReviewsFile): void {
    this.ensureDir();
    const parsed = ReviewsFileSchema.parse(file);
    fs.writeFileSync(this.filePath("reviews.json"), stableJson(parsed), "utf8");
  }
}
