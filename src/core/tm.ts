import fs from "node:fs";
import { z } from "zod";
import { lexicalSimilarity } from "./fuzzy.js";
import { atomicWriteFileSync, canonicalizeLocaleTag } from "./security.js";
import { PolyglotStore } from "./store.js";

/**
 * `.polyglot/tm.json` — provenance-aware translation memory.
 *
 * Complements the legacy `.polyglot/memory.jsonl` (written by `apply`). Entries imported from a
 * human TMS round-trip carry `provenance: "human-reviewed"` and outrank `llm-generated` entries
 * in fuzzy retrieval at equal-or-near similarity.
 */
export const TmProvenanceSchema = z.enum(["human-reviewed", "llm-generated", "imported"]);
export type TmProvenance = z.infer<typeof TmProvenanceSchema>;

export const TmEntrySchema = z.object({
  source: z.string(),
  target: z.string(),
  sourceLocale: z.string(),
  targetLocale: z.string(),
  key: z.string().optional(),
  provenance: TmProvenanceSchema.default("llm-generated"),
  verifiedAt: z.string().optional(),
  updatedAt: z.string(),
});
export type TmEntry = z.infer<typeof TmEntrySchema>;

export const TmFileSchema = z.object({
  version: z.literal(1).default(1),
  entries: z.array(TmEntrySchema).default([]),
});
export type TmFile = z.infer<typeof TmFileSchema>;

export function readTm(rootDir: string): TmFile {
  const store = new PolyglotStore(rootDir);
  const p = store.filePath("tm.json");
  if (!fs.existsSync(p)) return TmFileSchema.parse({});
  try {
    return TmFileSchema.parse(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return TmFileSchema.parse({});
  }
}

export function writeTm(rootDir: string, file: TmFile): void {
  const store = new PolyglotStore(rootDir);
  store.ensureDir();
  const parsed = TmFileSchema.parse(file);
  const entries = [...parsed.entries].sort((a, b) =>
    `${a.targetLocale}|${a.key ?? ""}|${a.source}|${a.target}`.localeCompare(
      `${b.targetLocale}|${b.key ?? ""}|${b.source}|${b.target}`
    )
  );
  atomicWriteFileSync(store.filePath("tm.json"), JSON.stringify({ version: 1, entries }, null, 2) + "\n");
}

/**
 * Upsert entries. Identity = (targetLocale, key ?? source). A human-reviewed entry replaces any
 * prior entry for the same identity; an llm-generated entry never overwrites a human-reviewed one.
 */
export function upsertTmEntries(rootDir: string, additions: TmEntry[]): { added: number; updated: number } {
  const file = readTm(rootDir);
  const id = (e: TmEntry) => `${canonicalizeLocaleTag(e.targetLocale).toLowerCase()}\0${e.key ?? `src:${e.source}`}`;
  const map = new Map<string, TmEntry>();
  for (const e of file.entries) map.set(id(e), e);
  let added = 0;
  let updated = 0;
  for (const raw of additions) {
    const e = TmEntrySchema.parse(raw);
    const prev = map.get(id(e));
    if (prev && prev.provenance === "human-reviewed" && e.provenance !== "human-reviewed") continue;
    if (prev) updated++;
    else added++;
    map.set(id(e), e);
  }
  writeTm(rootDir, { version: 1, entries: [...map.values()] });
  return { added, updated };
}

export interface TmMatch {
  source: string;
  target: string;
  key?: string;
  /** 0..1 */
  similarity: number;
  provenance: TmProvenance;
}

function provenanceRank(p: TmProvenance): number {
  return p === "human-reviewed" ? 0 : p === "imported" ? 1 : 2;
}

function baseLang(tag: string): string {
  return canonicalizeLocaleTag(tag).toLowerCase().split("-")[0];
}

/**
 * Fuzzy TM retrieval over `.polyglot/tm.json` + legacy `memory.jsonl`.
 * Human-reviewed entries win ties and any comparison within 5 similarity points.
 */
export function findTmMatches(
  rootDir: string,
  query: string,
  targetLocale: string,
  options: {
    minSimilarity?: number;
    limit?: number;
    /** Exclude tm.json entries recorded for this key (the segment's own translation). */
    excludeKey?: string;
    /** Exclude non-human memory.jsonl pairs identical to the segment itself (an LLM output cannot confirm itself). */
    excludeSelf?: { source: string; target: string };
  } = {}
): TmMatch[] {
  const minSim = options.minSimilarity ?? 0.5;
  const limit = options.limit ?? 3;
  const store = new PolyglotStore(rootDir);
  const sourceLocale = store.readConfig().sourceLocale;
  const pool: Array<Omit<TmMatch, "similarity">> = [];
  for (const e of readTm(rootDir).entries) {
    if (baseLang(e.targetLocale) !== baseLang(targetLocale)) continue;
    if (options.excludeKey !== undefined && e.key === options.excludeKey) continue;
    pool.push({ source: e.source, target: e.target, key: e.key, provenance: e.provenance });
  }
  for (const m of store.readMemory()) {
    if (baseLang(m.targetLocale) !== baseLang(targetLocale)) continue;
    const o = m.origin.toLowerCase();
    const provenance: TmProvenance =
      o === "human" || o === "manual" || o === "correction" || o === "human-reviewed"
        ? "human-reviewed"
        : o.startsWith("tmx:") || o.startsWith("import")
          ? "imported"
          : "llm-generated";
    if (
      options.excludeSelf &&
      provenance !== "human-reviewed" &&
      m.source === options.excludeSelf.source &&
      m.target === options.excludeSelf.target
    ) {
      continue;
    }
    pool.push({ source: m.source, target: m.target, provenance });
  }
  const scored: TmMatch[] = [];
  const seen = new Set<string>();
  for (const p of pool) {
    const dedupe = `${p.source}\0${p.target}\0${p.provenance}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const similarity = lexicalSimilarity(query, p.source, sourceLocale) / 100;
    if (similarity >= minSim) scored.push({ ...p, similarity });
  }
  scored.sort((a, b) => {
    const diff = b.similarity - a.similarity;
    if (Math.abs(diff) <= 0.05 && a.provenance !== b.provenance) {
      return provenanceRank(a.provenance) - provenanceRank(b.provenance);
    }
    return diff || provenanceRank(a.provenance) - provenanceRank(b.provenance) || a.source.localeCompare(b.source);
  });
  return scored.slice(0, limit);
}
