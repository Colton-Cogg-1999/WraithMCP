import { GlossaryEntry } from "./types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiWord(term: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9\s'-]*[a-zA-Z0-9]$/.test(term) || /^[a-zA-Z0-9]$/.test(term);
}

export function textContainsTerm(
  text: string,
  term: string,
  caseSensitive = false
): boolean {
  if (!term) return false;
  const flags = caseSensitive ? "u" : "iu";
  if (isAsciiWord(term)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, flags);
    return re.test(text);
  }
  const re = new RegExp(escapeRegExp(term), flags);
  return re.test(text);
}

export interface GlossaryHit {
  term: string;
  doNotTranslate: boolean;
  preferredTranslation?: string;
  notes?: string;
  origin: GlossaryEntry["origin"];
}

export function matchGlossaryTerms(
  sourceText: string,
  entries: readonly GlossaryEntry[],
  targetLocale?: string
): GlossaryHit[] {
  const hits: GlossaryHit[] = [];
  for (const entry of entries) {
    if (textContainsTerm(sourceText, entry.term, entry.caseSensitive)) {
      hits.push({
        term: entry.term,
        doNotTranslate: entry.doNotTranslate,
        preferredTranslation: targetLocale ? entry.translations[targetLocale] : undefined,
        notes: entry.notes,
        origin: entry.origin,
      });
    }
  }
  return hits.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
}

/** Strip combining diacritics (e.g. German Beiträge -> beitrage) for inflection-tolerant stem matching. */
function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Light inflection-tolerant term matching (handles plurals/case endings like
 * English post/posts, German Beitrag/Beiträge, French/Spanish -s/-es) while still
 * requiring whole-word stem alignment so unrelated words never match.
 */
export function textContainsTermInflected(
  text: string,
  term: string,
  caseSensitive = false
): boolean {
  if (textContainsTerm(text, term, caseSensitive)) return true;
  if (caseSensitive || term.includes(" ") || term.length < 3) return false;

  const foldedTerm = foldDiacritics(term);
  const foldedText = foldDiacritics(text);
  // Allow common Latin inflection suffixes (s, es, e, en, er, n, a, o, i, y) on the folded word stem
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(foldedTerm)}(?:s|es|e|en|er|n|a|o|i)?(?![\\p{L}\\p{N}_])`,
    "u"
  );
  return re.test(foldedText);
}

export interface GlossaryViolation {
  code: "dnt_violation" | "glossary_inconsistency";
  term: string;
  expected: string;
  origin: GlossaryEntry["origin"];
  message: string;
}

export function checkGlossaryCompliance(
  sourceText: string,
  targetText: string,
  targetLocale: string,
  entries: readonly GlossaryEntry[]
): GlossaryViolation[] {
  const violations: GlossaryViolation[] = [];
  for (const entry of entries) {
    const matchesSource = entry.doNotTranslate
      ? textContainsTerm(sourceText, entry.term, entry.caseSensitive)
      : textContainsTermInflected(sourceText, entry.term, entry.caseSensitive);
    if (!matchesSource) continue;

    if (entry.doNotTranslate) {
      if (!textContainsTerm(targetText, entry.term, entry.caseSensitive)) {
        violations.push({
          code: "dnt_violation",
          term: entry.term,
          expected: entry.term,
          origin: entry.origin,
          message: `Do-not-translate term "${entry.term}" is missing or altered in ${targetLocale} translation.`,
        });
      }
      continue;
    }

    const preferred = entry.translations[targetLocale];
    if (preferred && !textContainsTermInflected(targetText, preferred, false)) {
      violations.push({
        code: "glossary_inconsistency",
        term: entry.term,
        expected: preferred,
        origin: entry.origin,
        message: `Glossary prefers "${preferred}" for "${entry.term}" in ${targetLocale}.`,
      });
    }
  }
  return violations;
}

export interface AffectedKeyInfo {
  key: string;
  source: string;
  locales: string[];
}

/**
 * Glossary change propagation: given a glossary term that changed, find every
 * source key containing that term so the agent can re-translate them.
 */
export function findAffectedKeysForTerm(
  term: string,
  caseSensitive: boolean,
  sourceEntries: Map<string, { value: string }>,
  targetLocales: string[]
): AffectedKeyInfo[] {
  const affected: AffectedKeyInfo[] = [];
  for (const [key, entry] of sourceEntries) {
    if (textContainsTerm(entry.value, term, caseSensitive)) {
      affected.push({
        key,
        source: entry.value,
        locales: [...targetLocales],
      });
    }
  }
  return affected.sort((a, b) => a.key.localeCompare(b.key));
}

export interface InferredGlossaryCandidate {
  term: string;
  doNotTranslate: boolean;
  reason: string;
  occurrences: number;
}

/**
 * Deterministic glossary inference helper: identifies likely brand names
 * (multi-word TitleCase or CamelCase terms appearing across keys) and
 * repeated short UI terms that benefit from consistent translation.
 */
export function inferGlossaryCandidates(
  sourceStrings: string[]
): InferredGlossaryCandidate[] {
  const brandCounts = new Map<string, number>();
  const shortTermCounts = new Map<string, number>();

  const commonUiWords = new Set([
    "The", "This", "That", "Your", "Our", "New", "All", "Get", "Set", "Add", "Are",
    "You", "Please", "Welcome", "Sign", "Log", "Create", "Delete", "Save", "Cancel",
    "Back", "Next", "Done", "Error", "Success", "Warning", "Loading",
    // Generic Title-Case UI nouns that must NOT be proposed as do-not-translate brands
    "Account", "Settings", "Team", "Members", "User", "Users", "Profile", "Billing",
    "History", "Privacy", "Policy", "Terms", "Service", "Help", "Center", "Support",
    "Contact", "Dashboard", "Home", "Overview", "Projects", "Project", "Workspace",
    "Notifications", "Security", "Password", "Email", "Address", "Payment", "Method",
    "Plan", "Plans", "Pricing", "Admin", "Panel", "Order", "Orders", "Cart", "Checkout",
  ]);

  for (const raw of sourceStrings) {
    const text = raw
      .replace(/\{\{[^}]+\}\}/g, " ")
      .replace(/\{[^}]+\}/g, " ")
      .replace(/<[^>]+>/g, " ");

    // Multi-word Proper Nouns (only when not composed solely of ordinary UI labels)
    for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)+)\b/g)) {
      const phrase = m[1].trim();
      const words = phrase.split(/\s+/);
      if (words.every((w) => commonUiWords.has(w))) continue;
      if (commonUiWords.has(words[0])) continue;
      brandCounts.set(phrase, (brandCounts.get(phrase) ?? 0) + 1);
    }

    // Repeated short 1-2 word UI labels (e.g. "Post", "Open", "Workspace")
    const trimmed = text.trim();
    if (trimmed.length >= 3 && trimmed.length <= 24 && /^[A-Za-z][a-zA-Z\s-]*$/.test(trimmed)) {
      const words = trimmed.split(/\s+/);
      if (words.length <= 2) {
        shortTermCounts.set(trimmed, (shortTermCounts.get(trimmed) ?? 0) + 1);
      }
    }
  }

  const out: InferredGlossaryCandidate[] = [];
  for (const [term, count] of brandCounts) {
    if (count >= 1) {
      out.push({
        term,
        doNotTranslate: true,
        reason: "Proper-noun / brand name pattern",
        occurrences: count,
      });
    }
  }
  for (const [term, count] of shortTermCounts) {
    if (count >= 2 && !brandCounts.has(term)) {
      out.push({
        term,
        doNotTranslate: false,
        reason: "Repeated short UI term (high ambiguity risk)",
        occurrences: count,
      });
    }
  }

  return out.sort((a, b) => b.occurrences - a.occurrences || a.term.localeCompare(b.term));
}
