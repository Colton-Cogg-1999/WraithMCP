import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { atomicWriteFileSync, resolveConfinedPath } from "./security.js";
import {
  AssumptionsFile,
  AssumptionsFileSchema,
  ConfigSchema,
  GlossaryEntry,
  GlossaryFile,
  GlossaryFileSchema,
  LayoutBudgetEntry,
  LayoutFile,
  LayoutFileSchema,
  MemoryEntry,
  MemoryEntrySchema,
  WraithConfig,
  RecordsFile,
  RecordsFileSchema,
  ReviewsFile,
  ReviewsFileSchema,
  TranslationRecord,
  UsageFile,
  UsageFileSchema,
  UsageSite,
} from "./types.js";

export const WRAITH_DIR = ".wraith";

export function sha256Short(input: string, len = 16): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, len);
}

/**
 * Deterministic semantic context fingerprint for a key's usage sites.
 * Hashes sorted unique (component, element) tuples — excluding line numbers,
 * file paths, and sibling copy text so refactoring/moving a file or tweaking a
 * neighbor's label never causes false-positive context_changed alerts, while
 * moving a key to a different component/element or adding a new usage context does.
 */
export function computeContextFingerprint(sites: UsageSite[]): string {
  if (sites.length === 0) return "";
  const tuples = new Set<string>();
  for (const s of sites) {
    const comp = (s.component ?? path.basename(s.file, path.extname(s.file))).trim();
    const elem = (s.element ?? "").trim();
    tuples.add(`${comp}|${elem}`);
  }
  const canonical = [...tuples].sort();
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

export class WraithStore {
  readonly rootDir: string;
  readonly dir: string;

  constructor(rootDir: string) {
    const resolved = path.resolve(rootDir);
    try {
      this.rootDir = fs.realpathSync(resolved);
    } catch {
      this.rootDir = resolved;
    }
    this.dir = path.join(this.rootDir, WRAITH_DIR);
  }

  exists(): boolean {
    return fs.existsSync(this.filePath("config.json"));
  }

  confinedDir(): string {
    return resolveConfinedPath(this.rootDir, WRAITH_DIR, {
      label: ".wraith directory",
    });
  }

  ensureDir(): void {
    const confined = this.confinedDir();
    fs.mkdirSync(confined, { recursive: true });
  }

  filePath(name: string): string {
    return resolveConfinedPath(this.rootDir, path.join(WRAITH_DIR, name), {
      label: `.wraith/${name}`,
    });
  }

  readConfig(): WraithConfig {
    const p = this.filePath("config.json");
    if (!fs.existsSync(p)) {
      return ConfigSchema.parse({});
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in .wraith/config.json: ${msg}`);
    }
    try {
      return ConfigSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid .wraith/config.json: ${details}`);
      }
      throw err;
    }
  }

  writeConfig(config: WraithConfig): void {
    this.ensureDir();
    const parsed = ConfigSchema.parse(config);
    atomicWriteFileSync(this.filePath("config.json"), stableJson(parsed));
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
    atomicWriteFileSync(this.filePath("glossary.json"), stableJson(parsed));
  }

  upsertGlossaryEntry(
    entry: Omit<GlossaryEntry, "updatedAt" | "doNotTranslate" | "caseSensitive" | "translations" | "origin"> & {
      doNotTranslate?: boolean;
      caseSensitive?: boolean;
      translations?: Record<string, string>;
      origin?: GlossaryEntry["origin"];
      updatedAt?: string;
    }
  ): {
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
      doNotTranslate: entry.doNotTranslate ?? previous?.doNotTranslate ?? false,
      caseSensitive: entry.caseSensitive ?? previous?.caseSensitive ?? false,
      translations: sortRecordKeys({
        ...(previous?.translations ?? {}),
        ...(entry.translations ?? {}),
      }),
      ...(previous?.abbreviations || entry.abbreviations
        ? {
            abbreviations: sortRecordKeys({
              ...(previous?.abbreviations ?? {}),
              ...(entry.abbreviations ?? {}),
            }),
          }
        : {}),
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
    atomicWriteFileSync(
      this.filePath("usage.json"),
      stableJson({ version: 1, keys: sortedKeys })
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
    const sortedBaselines = sortRecordKeys(parsed.sourceBaselines ?? {});
    atomicWriteFileSync(
      this.filePath("records.json"),
      stableJson({
        version: 1,
        records: sorted,
        ...(Object.keys(sortedBaselines).length > 0 ? { sourceBaselines: sortedBaselines } : {}),
      })
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
      try {
        out.push(MemoryEntrySchema.parse(JSON.parse(line)));
      } catch {
        // Tolerate individual corrupt lines rather than disabling all tools
      }
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
    atomicWriteFileSync(this.filePath("memory.jsonl"), body);
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
    atomicWriteFileSync(this.filePath("assumptions.json"), stableJson(parsed));
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
    atomicWriteFileSync(this.filePath("reviews.json"), stableJson(parsed));
  }

  readLayout(): LayoutFile {
    const p = this.filePath("layout.json");
    if (!fs.existsSync(p)) {
      return LayoutFileSchema.parse({});
    }
    return LayoutFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  }

  writeLayout(file: LayoutFile): void {
    this.ensureDir();
    const parsed = LayoutFileSchema.parse(file);
    const sortedBudgets: LayoutFile["budgets"] = {};
    for (const k of Object.keys(parsed.budgets).sort()) {
      sortedBudgets[k] = sortRecordKeys(parsed.budgets[k]);
    }
    atomicWriteFileSync(
      this.filePath("layout.json"),
      stableJson({
        version: 1,
        budgets: sortedBudgets,
        ...(parsed.lastRun ? { lastRun: parsed.lastRun } : {}),
      })
    );
  }

  setLayoutBudget(key: string, locale: string, entry: LayoutBudgetEntry): void {
    const layout = this.readLayout();
    if (!layout.budgets[key]) layout.budgets[key] = {};
    layout.budgets[key][locale] = entry;
    this.writeLayout(layout);
  }
}
