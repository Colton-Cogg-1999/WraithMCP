import { isCjkText } from "./locales.js";
import { canonicalizeLocaleTag } from "./security.js";
import { MemoryEntry } from "./types.js";

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

const PLACEHOLDER_NORM_RE =
  /\{\{[^}]+\}\}|%\{[^}]+\}|%\([^)]+\)[a-zA-Z]|%<[^>]+>[.0-9]*[a-zA-Z]|\{[a-zA-Z0-9_.-]+\}/g;

function normalizePlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_NORM_RE, " __ph__ ");
}

function tokenizeForMatch(text: string, locale?: string): string[] {
  const cleaned = normalizePlaceholders(text).normalize("NFKC").toLowerCase().trim();
  if (!cleaned) return [];

  if (isCjkText(cleaned) || (locale && /^(zh|ja|ko|th|lo|km)\b/i.test(locale))) {
    const seg = new Intl.Segmenter(locale ?? "zh", { granularity: "grapheme" });
    const out: string[] = [];
    for (const part of seg.segment(cleaned)) {
      if (!/^\s+$/.test(part.segment) && !/^[\p{P}\p{S}]$/u.test(part.segment)) {
        out.push(part.segment);
      }
    }
    return out;
  }

  const seg = new Intl.Segmenter(locale ?? "en", { granularity: "word" });
  const words: string[] = [];
  for (const part of seg.segment(cleaned)) {
    if (part.isWordLike) {
      words.push(part.segment);
    }
  }
  return words.length > 0 ? words : cleaned.split(/\s+/).filter(Boolean);
}

/**
 * Deterministic lexical fuzzy similarity score in [0..100].
 * Uses word-level Levenshtein for space-delimited languages and
 * grapheme-level Levenshtein (via Intl.Segmenter) for CJK/scriptio continua.
 * Placeholder-only renames ({name} -> {firstName}) score high (95) rather than low.
 */
export function lexicalSimilarity(a: string, b: string, locale?: string): number {
  if (a === b) return 100;
  const normA = a.normalize("NFKC").trim();
  const normB = b.normalize("NFKC").trim();
  if (normA === normB) return 100;
  if (normA.toLowerCase() === normB.toLowerCase()) return 98;
  if (normalizePlaceholders(normA).toLowerCase() === normalizePlaceholders(normB).toLowerCase()) {
    return 92;
  }

  const tokA = tokenizeForMatch(normA, locale);
  const tokB = tokenizeForMatch(normB, locale);
  const maxLen = Math.max(tokA.length, tokB.length);
  if (maxLen === 0) return 0;

  const dist = levenshtein(tokA, tokB);
  const score = Math.round(((maxLen - dist) / maxLen) * 100);
  return Math.max(0, Math.min(100, score));
}

function localeMatches(entryLocale: string, requestedLocale: string): boolean {
  const a = canonicalizeLocaleTag(entryLocale).toLowerCase();
  const b = canonicalizeLocaleTag(requestedLocale).toLowerCase();
  if (a === b) return true;
  // Base-language fallback (e.g. TMX "DE-DE" matches "de", "EN-US" matches "en")
  const baseA = a.split("-")[0];
  const baseB = b.split("-")[0];
  return baseA === baseB;
}

export interface FuzzyMatch {
  source: string;
  target: string;
  score: number;
  context?: string;
  origin: string;
}

export function findFuzzyMatches(
  query: string,
  entries: readonly MemoryEntry[],
  options: {
    sourceLocale?: string;
    targetLocale: string;
    minScore?: number;
    limit?: number;
  }
): FuzzyMatch[] {
  const minScore = options.minScore ?? 55;
  const limit = options.limit ?? 5;
  const matches: FuzzyMatch[] = [];

  for (const entry of entries) {
    if (!localeMatches(entry.targetLocale, options.targetLocale)) continue;
    if (options.sourceLocale && !localeMatches(entry.sourceLocale, options.sourceLocale)) continue;

    const score = lexicalSimilarity(query, entry.source, options.sourceLocale);
    if (score >= minScore) {
      matches.push({
        source: entry.source,
        target: entry.target,
        score,
        context: entry.context,
        origin: entry.origin,
      });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
    .slice(0, limit);
}
