import { parse as parseIcu, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { PlaceholderSyntax } from "../formats/types.js";

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

function accentAndExpandLiteral(text: string): string {
  let out = "";
  let letters = 0;
  for (const ch of text) {
    const mapped = ACCENT_MAP[ch] ?? ch;
    out += mapped;
    if (/[a-zA-Z]/.test(ch)) {
      letters++;
      // ~35% length expansion by doubling vowels periodically
      if (VOWELS.has(ch) && letters % 2 === 1) {
        out += mapped;
      }
    }
  }
  return out;
}

// Protected token patterns that must NEVER be pseudo-localized
const PROTECTED_TOKEN_RE =
  /(<x\b[^>]*\/>|<\/?g\b[^>]*>|\{\{[^}]+\}\}|%\{[^}]+\}|%\([^)]+\)[#0\- +]*\d*(?:\.\d+)?[diouxXeEfFgGcrsa%]|@(?:\.[a-zA-Z]+)?:[a-zA-Z0-9_.-]+|\{[a-zA-Z0-9_.-]+\})/g;

function pseudoLiteralWithProtectedTokens(text: string): string {
  let out = "";
  let lastIdx = 0;
  for (const match of text.matchAll(PROTECTED_TOKEN_RE)) {
    const idx = match.index ?? 0;
    if (idx > lastIdx) {
      out += accentAndExpandLiteral(text.slice(lastIdx, idx));
    }
    out += match[0];
    lastIdx = idx + match[0].length;
  }
  if (lastIdx < text.length) {
    out += accentAndExpandLiteral(text.slice(lastIdx));
  }
  return out;
}

/** Re-escape literal braces and apostrophes when serializing back into ICU MessageFormat. */
function escapeIcuLiteral(text: string): string {
  const doubledQuotes = text.replace(/'/g, "''");
  // Wrap literal { and } characters in ICU single quotes so ICU doesn't treat them as placeholders
  return doubledQuotes.replace(/[{}]+/g, (m) => `'${m}'`);
}

function pseudoIcuElements(elements: MessageFormatElement[]): string {
  let out = "";
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        out += escapeIcuLiteral(pseudoLiteralWithProtectedTokens(el.value));
        break;
      case TYPE.argument:
        out += `{${el.value}}`;
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
          .map(([k, v]) => `${k} {${pseudoIcuElements(v.value)}}`)
          .join(" ");
        out += `{${el.value}, ${kind},${offset} ${branches}}`;
        break;
      }
      case TYPE.select: {
        const branches = Object.entries(el.options)
          .map(([k, v]) => `${k} {${pseudoIcuElements(v.value)}}`)
          .join(" ");
        out += `{${el.value}, select, ${branches}}`;
        break;
      }
      case TYPE.tag:
        out += `<${el.value}>${pseudoIcuElements(el.children)}</${el.value}>`;
        break;
    }
  }
  return out;
}

/**
 * Generate a pseudo-localized string with accented characters, ~30-40% length expansion,
 * and bracket markers (`[...]`) while strictly preserving placeholders, ICU syntax, and inline tags.
 */
export function pseudoLocalizeString(
  source: string,
  syntaxes: readonly PlaceholderSyntax[] = ["icu", "double-mustache"]
): string {
  if (!source.trim()) return source;

  let transformed: string;
  if (
    syntaxes.includes("icu") &&
    /[{}]/.test(source) &&
    !/\{\{[^}]+\}\}/.test(source) &&
    !/<x\b|<\/?g\b/.test(source)
  ) {
    try {
      const ast = parseIcu(source, { ignoreTag: false, requiresOtherClause: false });
      transformed = pseudoIcuElements(ast);
    } catch {
      transformed = pseudoLiteralWithProtectedTokens(source);
    }
  } else {
    transformed = pseudoLiteralWithProtectedTokens(source);
  }

  // Ensure ~30-40% expansion on short strings too
  const plainLen = source.replace(PROTECTED_TOKEN_RE, "").trim().length;
  const targetMinLen = Math.ceil(plainLen * 1.3);
  const currentPlainLen = transformed.replace(PROTECTED_TOKEN_RE, "").trim().length;
  const padNeeded = Math.max(0, Math.min(8, targetMinLen - currentPlainLen));
  const pad = padNeeded > 0 ? " " + "·".repeat(padNeeded) : "";

  return `[${transformed}${pad}]`;
}
