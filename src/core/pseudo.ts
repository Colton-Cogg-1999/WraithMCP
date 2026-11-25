import { parse as parseIcu, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { PlaceholderSyntax } from "../formats/types.js";

export type PseudoMode = "expand" | "rtl" | "cjk" | "tall" | "long-word" | "format";

export const PSEUDO_MODE_LOCALE_TAG: Record<PseudoMode, string> = {
  expand: "en-XA",
  rtl: "ar-XB",
  cjk: "ja-XC",
  tall: "th-XD",
  "long-word": "de-XE",
  format: "en-XF",
};

export interface PseudoOptions {
  mode?: PseudoMode;
  /** Also apply format pseudo-transformation (Arabic-Indic digits, comma decimals, D/M/Y dates, non-$ currency) */
  formatOverlay?: boolean;
  /** Key ID to embed via invisible zero-width characters so rendered DOM text traces back to its key */
  keyId?: string;
  /** Optional do-not-translate terms (e.g. Latin brand names) isolated in RTL mode */
  dntTerms?: readonly string[];
}

const ACCENT_MAP: Record<string, string> = {
  a: "à", A: "À",
  b: "ƀ", B: "Ɓ",
  c: "ç", C: "Ç",
  d: "ð", D: "Ð",
  e: "é", E: "É",
  f: "ƒ", F: "Ƒ",
  g: "ĝ", G: "Ĝ",
  h: "ĥ", H: "Ĥ",
  i: "î", I: "Î",
  j: "ĵ", J: "Ĵ",
  k: "ķ", K: "Ķ",
  l: "ļ", L: "Ļ",
  m: "ɱ", M: "Ɱ",
  n: "ñ", N: "Ñ",
  o: "ô", O: "Ô",
  p: "þ", P: "Þ",
  q: "ǫ", Q: "Ǫ",
  r: "ŕ", R: "Ŕ",
  s: "š", S: "Š",
  t: "ţ", T: "Ţ",
  u: "û", U: "Û",
  v: "ṽ", V: "Ṽ",
  w: "ŵ", W: "Ŵ",
  x: "ẋ", X: "Ẋ",
  y: "ÿ", Y: "Ÿ",
  z: "ž", Z: "Ž",
};

const VOWELS = new Set(["a", "e", "i", "o", "u", "A", "E", "I", "O", "U"]);
const ARABIC_INDIC_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];

// Invisible zero-width base-4 alphabet (avoids ZWJ/ZWNJ so Arabic cursive shaping & line wrapping stay untouched)
const ZW_SENTINEL = "\u2064"; // Invisible Plus
const ZW_DIGITS = ["\u200B", "\u2060", "\u2062", "\u2063"] as const;
const ZW_DIGIT_INDEX = new Map<string, number>([
  ["\u200B", 0],
  ["\u2060", 1],
  ["\u2062", 2],
  ["\u2063", 3],
]);
const ZW_BLOCK_RE = /\u2064([\u200B\u2060\u2062\u2063]+)\u2064/g;

/**
 * Encode a translation key ID into invisible zero-width characters so a rendered browser DOM
 * element can be traced directly back to its exact catalog key.
 */
export function encodeZeroWidthKeyId(key: string): string {
  const bytes = Buffer.from(key, "utf8");
  let body = "";
  for (const b of bytes) {
    body +=
      ZW_DIGITS[(b >> 6) & 3] +
      ZW_DIGITS[(b >> 4) & 3] +
      ZW_DIGITS[(b >> 2) & 3] +
      ZW_DIGITS[b & 3];
  }
  return `${ZW_SENTINEL}${body}${ZW_SENTINEL}`;
}

/**
 * Decode all embedded invisible zero-width key IDs found inside rendered DOM text.
 */
export function decodeZeroWidthKeyIds(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(ZW_BLOCK_RE)) {
    const payload = match[1];
    if (payload.length === 0 || payload.length % 4 !== 0) continue;
    const bytes: number[] = [];
    let valid = true;
    for (let i = 0; i < payload.length; i += 4) {
      const d0 = ZW_DIGIT_INDEX.get(payload[i]);
      const d1 = ZW_DIGIT_INDEX.get(payload[i + 1]);
      const d2 = ZW_DIGIT_INDEX.get(payload[i + 2]);
      const d3 = ZW_DIGIT_INDEX.get(payload[i + 3]);
      if (d0 === undefined || d1 === undefined || d2 === undefined || d3 === undefined) {
        valid = false;
        break;
      }
      bytes.push((d0 << 6) | (d1 << 4) | (d2 << 2) | d3);
    }
    if (valid && bytes.length > 0) {
      const decoded = Buffer.from(bytes).toString("utf8");
      if (!keys.includes(decoded)) keys.push(decoded);
    }
  }
  return keys;
}

export function stripZeroWidthKeyIds(text: string): string {
  return text.replace(ZW_BLOCK_RE, "");
}

/**
 * IBM National Language Design Guide expansion curve:
 * short labels expand dramatically more than long sentences.
 */
export function ibmExpansionFactor(plainLength: number): number {
  if (plainLength <= 10) return 2.0; // +100%
  if (plainLength <= 20) return 1.8; // +80%
  if (plainLength <= 30) return 1.6; // +60%
  if (plainLength <= 50) return 1.4; // +40%
  if (plainLength <= 70) return 1.3; // +30%
  return 1.25; // +25%
}

// Protected token patterns that must NEVER be pseudo-localized
const PROTECTED_TOKEN_RE =
  /(<x\b[^>]*\/>|<\/?g\b[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s+[^>]*)?\/?>|\{\{[^}]+\}\}|%\{[^}]+\}|%<[^>]+>[.0-9]*[a-zA-Z]|%\([^)]+\)[#0\- +]*\d*(?:\.\d+)?[diouxXeEfFgGcrsa%]|@(?:\.[a-zA-Z]+)?:[a-zA-Z0-9_.-]+|\{[a-zA-Z0-9_.-]+\})/g;

function toArabicIndicDigits(str: string): string {
  return str.replace(/[0-9]/g, (d) => ARABIC_INDIC_DIGITS[Number(d)] ?? d);
}

/**
 * Format pseudo-transformation: converts literal US dates (MM/DD/YYYY -> D.M.YYYY),
 * `$` currency -> `¤`, decimal `.` -> `,`, and ASCII digits -> Arabic-Indic digits.
 */
export function transformFormatLiteral(text: string): string {
  let out = text;
  // Convert MM/DD/YYYY or MM/DD to DD.MM.YYYY / DD.MM
  out = out.replace(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12][0-9]|3[01])(?:\/(\d{2,4}))?\b/g, (_m, mm, dd, yy) =>
    yy ? `${dd}.${mm}.${yy}` : `${dd}.${mm}`
  );
  // Currency symbol `$1,234.56` -> `1.234,56 ¤`
  out = out.replace(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g, (_m, num: string) => {
    const swapped = num.replace(/,/g, "\u00A0").replace(/\./g, ",");
    return `${swapped}\u00A0¤`;
  });
  // Standalone decimal numbers `12.34` -> `12,34`
  out = out.replace(/\b(\d+)\.(\d+)\b/g, "$1,$2");
  // Convert remaining ASCII digits to Arabic-Indic digits
  out = toArabicIndicDigits(out);
  return out;
}

function accentAndExpandLiteral(text: string, targetFactor: number): string {
  let out = "";
  let letters = 0;
  const doubleEvery = targetFactor >= 1.8 ? 1 : targetFactor >= 1.5 ? 2 : 3;
  for (const ch of text) {
    const mapped = ACCENT_MAP[ch] ?? ch;
    out += mapped;
    if (/[a-zA-Z]/.test(ch)) {
      letters++;
      if (VOWELS.has(ch) && letters % doubleEvery === 0) {
        out += mapped;
        if (targetFactor >= 1.9) out += mapped;
      }
    }
  }
  return out;
}

const CJK_SYLLABLES = ["漢", "字", "表", "示", "検", "証", "文", "列", "設", "定", "画", "面", "確", "認", "項", "目"];

function transformCjkLiteral(text: string): string {
  let out = "";
  let idx = 0;
  for (const ch of text) {
    if (ch === " ") {
      // Drop spaces so CJK line-breaking without spaces and nowrap elements are stressed
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x21 && code <= 0x7e) {
      // Alternate fullwidth ASCII and CJK ideographs so both font coverage & wide glyphs are tested
      if (idx % 3 === 0 && /[a-zA-Z]/.test(ch)) {
        out += CJK_SYLLABLES[code % CJK_SYLLABLES.length];
      } else {
        out += String.fromCharCode(code + 0xfee0);
      }
      idx++;
    } else {
      out += ch;
    }
  }
  return out;
}

function transformTallLiteral(text: string): string {
  // Stacked vertical diacritics (combining marks + Thai-height stacked vowels/tones) to trigger line-height clipping
  let out = "";
  let i = 0;
  for (const ch of text) {
    if (/[a-zA-Z]/.test(ch)) {
      const mapped = ACCENT_MAP[ch] ?? ch;
      if (i % 3 === 0) {
        out += `${mapped}\u0308\u0301\u0323`; // stacked above + below marks
      } else if (i % 3 === 1) {
        out += `${mapped}\u0E35\u0E49`; // Thai upper vowel + tone mark stack
      } else {
        out += mapped;
      }
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function transformLongWordLiteral(text: string): string {
  // Join adjacent words into unbreakable German-style compound words
  const tokens = text.split(/(\s+)/);
  const words = tokens.filter((t) => t.trim().length > 0);
  if (words.length === 0) return text;
  const accented = words.map((w) => accentAndExpandLiteral(w, 1.35));
  if (accented.length === 1) {
    return `${accented[0]}verschreibungspflichtig`;
  }
  // Fuse runs of 2-3 words without spaces so narrow mobile cards must wrap/hyphenate
  const fused: string[] = [];
  for (let i = 0; i < accented.length; i += 3) {
    fused.push(accented.slice(i, i + 3).join(""));
  }
  return fused.join(" ");
}

const RLO = "\u202E";
const PDF = "\u202C";
const LRI = "\u2066";
const PDI = "\u2069";

function transformRtlLiteral(text: string, dntTerms: readonly string[] = []): string {
  // Isolate DNT brand names in LRI..PDI so Latin brand order stays intact inside RTL text
  if (dntTerms.length > 0) {
    const escaped = dntTerms
      .filter((t) => t.trim().length > 0)
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (escaped.length > 0) {
      const brandRe = new RegExp(`(${escaped.join("|")})`, "g");
      return text
        .split(brandRe)
        .map((part) => {
          if (!part) return "";
          if (dntTerms.includes(part)) return `${LRI}${part}${PDI}`;
          return wrapRtlWords(part);
        })
        .join("");
    }
  }
  return wrapRtlWords(text);
}

function wrapRtlWords(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word) => {
    const accented = [...word].map((c) => ACCENT_MAP[c] ?? c).join("");
    return `${RLO}${accented}${PDF}`;
  });
}

function transformLiteralSegment(
  text: string,
  mode: PseudoMode,
  targetFactor: number,
  formatOverlay: boolean,
  dntTerms: readonly string[]
): string {
  let current = text;
  if (mode === "format" || formatOverlay) {
    current = transformFormatLiteral(current);
  }
  switch (mode) {
    case "expand":
      return accentAndExpandLiteral(current, targetFactor);
    case "rtl":
      return transformRtlLiteral(current, dntTerms);
    case "cjk":
      return transformCjkLiteral(current);
    case "tall":
      return transformTallLiteral(current);
    case "long-word":
      return transformLongWordLiteral(current);
    case "format":
      return accentAndExpandLiteral(current, 1.15);
  }
}

function pseudoLiteralWithProtectedTokens(
  text: string,
  mode: PseudoMode,
  targetFactor: number,
  formatOverlay: boolean,
  dntTerms: readonly string[]
): string {
  let out = "";
  let lastIdx = 0;
  for (const match of text.matchAll(PROTECTED_TOKEN_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIdx) {
      out += transformLiteralSegment(text.slice(lastIdx, idx), mode, targetFactor, formatOverlay, dntTerms);
    }
    const token = match[0];
    // Isolate placeholders in LTR inside RTL mode so `{count}` / `{{name}}` don't scramble visually
    out += mode === "rtl" && !token.startsWith("<") ? `${LRI}${token}${PDI}` : token;
    lastIdx = idx + token.length;
  }
  if (lastIdx < text.length) {
    out += transformLiteralSegment(text.slice(lastIdx), mode, targetFactor, formatOverlay, dntTerms);
  }
  return out;
}

/** Re-escape literal braces and apostrophes when serializing back into ICU MessageFormat. */
function escapeIcuLiteral(text: string): string {
  const doubledQuotes = text.replace(/'/g, "''");
  return doubledQuotes.replace(/[{}]+/g, (m) => `'${m}'`);
}

function pseudoIcuElements(
  elements: MessageFormatElement[],
  mode: PseudoMode,
  targetFactor: number,
  formatOverlay: boolean,
  dntTerms: readonly string[]
): string {
  let out = "";
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        out += escapeIcuLiteral(
          pseudoLiteralWithProtectedTokens(el.value, mode, targetFactor, formatOverlay, dntTerms)
        );
        break;
      case TYPE.argument:
        out += mode === "rtl" ? `${LRI}{${el.value}}${PDI}` : `{${el.value}}`;
        break;
      case TYPE.pound:
        out += "#";
        break;
      case TYPE.number:
        out += el.style && typeof el.style === "string"
          ? `{${el.value}, number, ${el.style}}`
          : `{${el.value}, number}`;
        break;
      case TYPE.date:
        out += el.style && typeof el.style === "string"
          ? `{${el.value}, date, ${el.style}}`
          : `{${el.value}, date}`;
        break;
      case TYPE.time:
        out += el.style && typeof el.style === "string"
          ? `{${el.value}, time, ${el.style}}`
          : `{${el.value}, time}`;
        break;
      case TYPE.plural: {
        const offset = el.offset ? ` offset:${el.offset}` : "";
        const kind = el.pluralType === "ordinal" ? "selectordinal" : "plural";
        const branches = Object.entries(el.options)
          .map(([k, v]) => `${k} {${pseudoIcuElements(v.value, mode, targetFactor, formatOverlay, dntTerms)}}`)
          .join(" ");
        out += `{${el.value}, ${kind},${offset} ${branches}}`;
        break;
      }
      case TYPE.select: {
        const branches = Object.entries(el.options)
          .map(([k, v]) => `${k} {${pseudoIcuElements(v.value, mode, targetFactor, formatOverlay, dntTerms)}}`)
          .join(" ");
        out += `{${el.value}, select, ${branches}}`;
        break;
      }
      case TYPE.tag:
        out += `<${el.value}>${pseudoIcuElements(el.children, mode, targetFactor, formatOverlay, dntTerms)}</${el.value}>`;
        break;
    }
  }
  return out;
}

/**
 * Generate a pseudo-localized string in the chosen mode (default: `expand` with IBM length-scaled expansion),
 * optionally embedding an invisible zero-width key ID for DOM-to-key tracing while strictly preserving
 * placeholders, ICU syntax, inline tags, and DNT brands.
 */
export function pseudoLocalizeString(
  source: string,
  syntaxes: readonly PlaceholderSyntax[] = ["icu", "double-mustache"],
  options: PseudoOptions = {}
): string {
  if (!source.trim()) return source;

  const mode: PseudoMode = options.mode ?? "expand";
  const formatOverlay = options.formatOverlay ?? false;
  const dntTerms = options.dntTerms ?? [];
  const plainLen = source.replace(PROTECTED_TOKEN_RE, "").trim().length;
  const targetFactor = mode === "expand" ? ibmExpansionFactor(plainLen) : 1.0;

  let transformed: string;
  if (
    syntaxes.includes("icu") &&
    /[{}]/.test(source) &&
    !/\{\{[^}]+\}\}/.test(source) &&
    !/<x\b|<\/?g\b/.test(source)
  ) {
    try {
      const ast = parseIcu(source, { ignoreTag: false, requiresOtherClause: false });
      transformed = pseudoIcuElements(ast, mode, targetFactor, formatOverlay, dntTerms);
    } catch {
      transformed = pseudoLiteralWithProtectedTokens(source, mode, targetFactor, formatOverlay, dntTerms);
    }
  } else {
    transformed = pseudoLiteralWithProtectedTokens(source, mode, targetFactor, formatOverlay, dntTerms);
  }

  let pad = "";
  if (mode === "expand") {
    const targetMinLen = Math.ceil(plainLen * targetFactor);
    const currentPlainLen = transformed.replace(PROTECTED_TOKEN_RE, "").trim().length;
    const padNeeded = Math.max(0, Math.min(16, targetMinLen - currentPlainLen));
    if (padNeeded > 0) {
      pad = " " + "·".repeat(padNeeded);
    }
  }

  const keyMarker = options.keyId ? encodeZeroWidthKeyId(options.keyId) : "";
  if (mode === "cjk") {
    return `「${keyMarker}${transformed}」`;
  }
  return `[${keyMarker}${transformed}${pad}]`;
}
