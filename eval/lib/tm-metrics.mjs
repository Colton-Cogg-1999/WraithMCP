/**
 * Stage 4 (TM Context Ablation) metrics — pure, dependency-free, deterministic.
 *
 * - computeTCR / aggregateTCR: Translation Consistency Rate per recurring source group.
 *     TCR(group) = 1 - (uniqueVariants - 1) / (N - 1); N = 1 -> 1.0. Aggregate = unweighted mean over groups.
 * - extractStructure / structuralParity: exact structural match of {var} names, ICU plural/select
 *     branch keys and inline markup tags (<b>, </b>, <0>, <link/> ...).
 * - chrF2: character n-gram F-beta (n = 1..6 averaged, beta = 2, whitespace stripped), scale 0..100.
 * - TER: PLAIN word-level edit distance (insert/delete/substitute, NO block shifts) divided by the
 *     reference token count, x100. This is an upper bound on true TER (shifts would only lower it).
 *     Tokens = whitespace-separated words for space-delimited scripts; graphemes (non-space,
 *     non-punctuation) for CJK/Thai text so Japanese is not scored as a single "word".
 * - lexicalSimilarity: local port of src/core/fuzzy.ts lexicalSimilarity (0..100) so the eval
 *     harness does not couple to a dist/ build.
 */

// ---------------------------------------------------------------------------
// Lexical similarity (port of src/core/fuzzy.ts)
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
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
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;

function normalizePlaceholders(text) {
  return text.replace(PLACEHOLDER_NORM_RE, " __ph__ ");
}

function isCjkLike(text, locale) {
  return CJK_RE.test(text) || Boolean(locale && /^(zh|ja|ko|th|lo|km)\b/i.test(locale));
}

function graphemeTokens(text, locale) {
  const seg = new Intl.Segmenter(locale ?? "zh", { granularity: "grapheme" });
  const out = [];
  for (const part of seg.segment(text)) {
    if (!/^\s+$/.test(part.segment) && !/^[\p{P}\p{S}]$/u.test(part.segment)) out.push(part.segment);
  }
  return out;
}

function tokenizeForMatch(text, locale) {
  const cleaned = normalizePlaceholders(text).normalize("NFKC").toLowerCase().trim();
  if (!cleaned) return [];
  if (isCjkLike(cleaned, locale)) return graphemeTokens(cleaned, locale);
  const seg = new Intl.Segmenter(locale ?? "en", { granularity: "word" });
  const words = [];
  for (const part of seg.segment(cleaned)) if (part.isWordLike) words.push(part.segment);
  return words.length > 0 ? words : cleaned.split(/\s+/).filter(Boolean);
}

export function lexicalSimilarity(a, b, locale) {
  if (a === b) return 100;
  const normA = String(a ?? "").normalize("NFKC").trim();
  const normB = String(b ?? "").normalize("NFKC").trim();
  if (normA === normB) return 100;
  if (normA.toLowerCase() === normB.toLowerCase()) return 98;
  if (normalizePlaceholders(normA).toLowerCase() === normalizePlaceholders(normB).toLowerCase()) return 92;
  const tokA = tokenizeForMatch(normA, locale);
  const tokB = tokenizeForMatch(normB, locale);
  const maxLen = Math.max(tokA.length, tokB.length);
  if (maxLen === 0) return 0;
  const dist = levenshtein(tokA, tokB);
  return Math.max(0, Math.min(100, Math.round(((maxLen - dist) / maxLen) * 100)));
}

/**
 * Top-k fuzzy TM lookup. `minSimilarity` is a 0..1 fraction (0.70 = 70).
 */
export function fuzzyTmLookup(tmEntries, source, targetLocale, { k = 3, minSimilarity = 0.7 } = {}) {
  const base = (l) => String(l ?? "").toLowerCase().split("-")[0];
  const hits = [];
  for (const e of tmEntries ?? []) {
    if (base(e.targetLocale) !== base(targetLocale)) continue;
    const score = lexicalSimilarity(source, e.source, "en");
    if (score >= minSimilarity * 100) hits.push({ ...e, score });
  }
  hits.sort((x, y) => y.score - x.score || String(x.source).localeCompare(String(y.source)));
  return hits.slice(0, k);
}

// ---------------------------------------------------------------------------
// TCR
// ---------------------------------------------------------------------------
export function normalizeVariant(s) {
  return String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** TCR for one recurring source group (array of target strings). */
export function computeTCR(targets) {
  const n = targets.length;
  if (n <= 1) return 1;
  const unique = new Set(targets.map(normalizeVariant)).size;
  return 1 - (unique - 1) / (n - 1);
}

/**
 * groups: { [groupId]: string[] } or Array<string[]>.
 * Returns { mean, groups, recurringGroups, perGroup }.
 */
export function aggregateTCR(groups) {
  const entries = Array.isArray(groups) ? groups.map((g, i) => [String(i), g]) : Object.entries(groups ?? {});
  const perGroup = {};
  let sum = 0;
  let recurring = 0;
  for (const [id, targets] of entries) {
    const v = computeTCR(targets);
    perGroup[id] = { n: targets.length, variants: new Set(targets.map(normalizeVariant)).size, tcr: v };
    sum += v;
    if (targets.length >= 2) recurring++;
  }
  return {
    mean: entries.length ? sum / entries.length : null,
    groups: entries.length,
    recurringGroups: recurring,
    perGroup,
  };
}

// ---------------------------------------------------------------------------
// ICU / tag structure
// ---------------------------------------------------------------------------
const CLDR_KEYWORDS = new Set(["zero", "one", "two", "few", "many", "other"]);

function readUntilTopLevel(text, start, stopChars) {
  // returns index of first char in stopChars at depth 0 (relative to start), or -1
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && (text[i + 1] === "{" || text[i + 1] === "}")) {
      const close = text.indexOf("'", i + 1);
      if (close > 0) {
        i = close;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0 && stopChars.includes("}")) return i;
      depth--;
    } else if (depth === 0 && stopChars.includes(c)) return i;
  }
  return -1;
}

function findMatchingBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseIcu(text, acc) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    // skip {{mustache}} style
    if (text[open + 1] === "{") {
      const end = text.indexOf("}}", open);
      if (end < 0) break;
      acc.vars.push(text.slice(open + 2, end).trim());
      i = end + 2;
      continue;
    }
    const close = findMatchingBrace(text, open);
    if (close < 0) {
      acc.malformed = true;
      break;
    }
    const inner = text.slice(open + 1, close);
    const comma = readUntilTopLevel(inner, 0, [","]);
    if (comma < 0) {
      const name = inner.trim();
      if (name) acc.vars.push(name);
    } else {
      const name = inner.slice(0, comma).trim();
      const rest = inner.slice(comma + 1);
      const comma2 = readUntilTopLevel(rest, 0, [","]);
      const type = (comma2 < 0 ? rest : rest.slice(0, comma2)).trim();
      acc.vars.push(name);
      if (["plural", "select", "selectordinal"].includes(type) && comma2 >= 0) {
        let body = rest.slice(comma2 + 1);
        const branches = [];
        let j = 0;
        while (j < body.length) {
          const bOpen = body.indexOf("{", j);
          if (bOpen < 0) break;
          const selector = body.slice(j, bOpen).trim();
          const bClose = findMatchingBrace(body, bOpen);
          if (bClose < 0) {
            acc.malformed = true;
            break;
          }
          const sel = selector.replace(/^offset:\s*\d+\s*/, "").trim();
          if (sel) branches.push(sel);
          parseIcu(body.slice(bOpen + 1, bClose), acc);
          j = bClose + 1;
        }
        acc.icu.push({ name, type, branches: branches.sort() });
      }
    }
    i = close + 1;
  }
}

export function extractTags(text) {
  const tags = [];
  const re = /<\s*(\/?)\s*([a-zA-Z0-9_-]+)[^<>]*?(\/?)\s*>/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    tags.push(`${m[1] ? "/" : ""}${m[2]}${m[3] ? "/" : ""}`);
  }
  return tags.sort();
}

export function extractStructure(text) {
  const t = String(text ?? "");
  const acc = { vars: [], icu: [], malformed: false };
  // Strip tags before ICU parse so `<b>{name}</b>` is parsed cleanly.
  parseIcu(t.replace(/<[^<>]*>/g, ""), acc);
  return {
    vars: [...new Set(acc.vars)].sort(),
    icu: acc.icu.sort((a, b) => `${a.name}:${a.type}`.localeCompare(`${b.name}:${b.type}`)),
    tags: extractTags(t),
    malformed: acc.malformed,
  };
}

function pluralCategories(locale) {
  try {
    return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  } catch {
    return null;
  }
}

/**
 * Structural parity of `target` against `source`.
 * Rules:
 *  - placeholder/variable name SET must match exactly (dropped or invented {var} fails);
 *  - inline tag multiset must match exactly (<b>, </b>, <0>, <link/> ...);
 *  - select: branch-key set must match exactly;
 *  - plural/selectordinal: `other` must exist; explicit `=N` keys from source must be kept;
 *    every source CLDR category that the TARGET locale also uses must be present (so dropping
 *    `one` in de fails, while ja legitimately collapses to `other` only); extra keys must be valid
 *    CLDR keywords or `=N` (so ar adding zero/two/few/many is fine). With no targetLocale the
 *    branch sets must match exactly.
 */
export function structuralParity(source, target, { targetLocale = null } = {}) {
  const s = extractStructure(source);
  const t = extractStructure(target);
  const issues = [];
  if (t.malformed && !s.malformed) issues.push("malformed_icu");
  const missingVars = s.vars.filter((v) => !t.vars.includes(v));
  const extraVars = t.vars.filter((v) => !s.vars.includes(v));
  if (missingVars.length) issues.push(`missing_vars:${missingVars.join(",")}`);
  if (extraVars.length) issues.push(`extra_vars:${extraVars.join(",")}`);
  if (s.tags.join("|") !== t.tags.join("|")) issues.push(`tag_mismatch:${s.tags.join(" ")}=>${t.tags.join(" ")}`);

  const cats = targetLocale ? pluralCategories(targetLocale) : null;
  for (const sIcu of s.icu) {
    const tIcu = t.icu.find((x) => x.name === sIcu.name && x.type === sIcu.type);
    if (!tIcu) {
      issues.push(`missing_icu:${sIcu.name}:${sIcu.type}`);
      continue;
    }
    if (sIcu.type === "select" || !cats) {
      if (sIcu.branches.join("|") !== tIcu.branches.join("|")) {
        issues.push(`branch_mismatch:${sIcu.name}:${sIcu.branches.join(",")}=>${tIcu.branches.join(",")}`);
      }
      continue;
    }
    const tb = new Set(tIcu.branches);
    if (!tb.has("other")) issues.push(`missing_branch:${sIcu.name}:other`);
    for (const k of sIcu.branches) {
      if (k.startsWith("=") && !tb.has(k)) issues.push(`missing_branch:${sIcu.name}:${k}`);
      if (CLDR_KEYWORDS.has(k) && k !== "other" && cats.has(k) && !tb.has(k)) issues.push(`missing_branch:${sIcu.name}:${k}`);
    }
    for (const k of tb) {
      if (!k.startsWith("=") && !CLDR_KEYWORDS.has(k)) issues.push(`invalid_branch:${sIcu.name}:${k}`);
    }
  }
  for (const tIcu of t.icu) {
    if (!s.icu.find((x) => x.name === tIcu.name && x.type === tIcu.type)) issues.push(`extra_icu:${tIcu.name}:${tIcu.type}`);
  }
  return { ok: issues.length === 0, issues };
}

export function parityRate(pairs) {
  // pairs: [{ source, target, targetLocale }]
  if (!pairs.length) return null;
  let ok = 0;
  for (const p of pairs) if (structuralParity(p.source, p.target, { targetLocale: p.targetLocale }).ok) ok++;
  return ok / pairs.length;
}

// ---------------------------------------------------------------------------
// chrF2
// ---------------------------------------------------------------------------
function charNgrams(str, n) {
  const counts = new Map();
  for (let i = 0; i <= str.length - n; i++) {
    const g = str.slice(i, i + n).join("");
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** Sentence chrF (default chrF2: maxN = 6, beta = 2), 0..100, whitespace stripped. */
export function chrF(hypothesis, reference, { maxN = 6, beta = 2 } = {}) {
  const hyp = [...String(hypothesis ?? "").replace(/\s+/g, "")];
  const ref = [...String(reference ?? "").replace(/\s+/g, "")];
  if (!hyp.length && !ref.length) return 100;
  if (!hyp.length || !ref.length) return 0;
  let precSum = 0;
  let recSum = 0;
  let used = 0;
  for (let n = 1; n <= maxN; n++) {
    const hT = hyp.length - n + 1;
    const rT = ref.length - n + 1;
    if (hT <= 0 || rT <= 0) continue;
    const hg = charNgrams(hyp, n);
    const rg = charNgrams(ref, n);
    let overlap = 0;
    for (const [g, c] of hg) overlap += Math.min(c, rg.get(g) ?? 0);
    precSum += overlap / hT;
    recSum += overlap / rT;
    used++;
  }
  if (!used) return 0;
  const p = precSum / used;
  const r = recSum / used;
  if (p === 0 && r === 0) return 0;
  const b2 = beta * beta;
  return Number(((((1 + b2) * p * r) / (b2 * p + r)) * 100).toFixed(2));
}

// ---------------------------------------------------------------------------
// TER (plain edit distance, no shifts)
// ---------------------------------------------------------------------------
export function terTokens(text, locale) {
  const t = String(text ?? "").normalize("NFC").trim();
  if (!t) return [];
  if (isCjkLike(t, locale)) return graphemeTokens(t, locale);
  return t.split(/\s+/).filter(Boolean);
}

export function ter(hypothesis, reference, { locale } = {}) {
  const h = terTokens(hypothesis, locale);
  const r = terTokens(reference, locale);
  if (!r.length) return h.length ? 100 : 0;
  return Number(((levenshtein(h, r) / r.length) * 100).toFixed(2));
}

export function mean(values) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Full metric bundle for a list of rows: [{ groupId, source, hyp, gold, locale }].
 */
export function computeTmMetrics(rows) {
  const groups = {};
  for (const r of rows) (groups[r.groupId] ??= []).push(r.hyp ?? "");
  const tcr = aggregateTCR(groups);
  const parity = parityRate(rows.map((r) => ({ source: r.source, target: r.hyp ?? "", targetLocale: r.locale })));
  const withGold = rows.filter((r) => typeof r.gold === "string" && r.gold.length > 0);
  return {
    n: rows.length,
    groups: tcr.groups,
    tcr: tcr.mean === null ? null : Number(tcr.mean.toFixed(4)),
    parity: parity === null ? null : Number(parity.toFixed(4)),
    chrF2: withGold.length ? Number(mean(withGold.map((r) => chrF(r.hyp, r.gold))).toFixed(2)) : null,
    ter: withGold.length ? Number(mean(withGold.map((r) => ter(r.hyp, r.gold, { locale: r.locale }))).toFixed(2)) : null,
    nWithGold: withGold.length,
  };
}
