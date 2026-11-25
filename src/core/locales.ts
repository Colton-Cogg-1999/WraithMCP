export interface LocaleConventions {
  locale: string;
  displayName: string;
  language: string;
  region?: string;
  direction: "ltr" | "rtl";
  /** Required everyday integer cardinal plural categories (0..100 via Intl.PluralRules) */
  pluralCategories: Intl.LDMLPluralRule[];
  /** Optional/advisory CLDR cardinal categories (e.g. 'many' for fr/es/it/pt millions) */
  advisoryPluralCategories: Intl.LDMLPluralRule[];
  /** Required ordinal plural categories (0..100 via Intl.PluralRules type='ordinal') */
  ordinalCategories: Intl.LDMLPluralRule[];
  isCjk: boolean;
  formalityDefault: string;
  punctuationNorms: string[];
  expectedExpansionRatio: number;
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "yi", "ps", "sd", "ug", "dv"]);
const CJK_LANGUAGES = new Set(["zh", "ja", "ko", "th", "lo", "km"]);

const FORMALITY_DEFAULTS: Record<string, string> = {
  "es-MX": "Informal 'tú' for consumer/developer apps; formal 'usted' for banking/legal.",
  "es": "Informal 'tú' for consumer/developer apps; 'usted' for formal enterprise.",
  "fr": "Polite 'vous' is standard for software UIs; use 'tu' only for casual consumer brands.",
  "de": "Polite 'Sie' is default for business/SaaS; 'du' for modern consumer/dev tools (be consistent).",
  "ja": "Polite desu/masu (です/ます) form for UI copy; avoid casual plain form.",
  "ko": "Polite haeyoche/hamnidache (해요체/합니다체) consistently across UI.",
  "zh-Hans": "Natural Simplified Chinese (Mainland phrasing, e.g. '登录', '设置'); polite '您' sparingly.",
  "zh-Hant": "Natural Traditional Chinese (Taiwan/HK phrasing, e.g. '登入', '設定').",
  "pt-BR": "Natural Brazilian Portuguese ('você'); avoid European Portuguese vocabulary.",
  "nl": "Informal 'je/jij' for modern apps; 'u' for formal services.",
  "it": "Informal 'tu' for consumer apps; 'Lei' for formal enterprise.",
  "pl": "Polite or imperative forms; watch grammatical gender and 4 plural categories.",
  "ru": "Polite 'вы' for software UI; handle one/few/many plural categories accurately.",
  "ar": "Modern Standard Arabic (MSA); ensure RTL layout and 6 CLDR plural categories.",
};

const PUNCTUATION_NORMS: Record<string, string[]> = {
  fr: [
    "Use narrow no-break space (\\u202F) or non-breaking space (\\u00A0) before ':', ';', '!', '?'.",
    "Use French guillemets « ... » for quotation marks.",
  ],
  "zh-Hans": [
    "Use full-width punctuation (，。！？：；（）) without trailing ASCII spaces.",
    "No spaces needed between Chinese characters; optional thin/single space around Latin/numbers.",
  ],
  "zh-Hant": [
    "Use full-width Traditional punctuation (，。！？：；「」).",
  ],
  ja: [
    "Use full-width Japanese punctuation (、。！？「」) without ASCII spaces.",
  ],
  es: [
    "Include opening inverted punctuation (¿...? and ¡...!) for questions and exclamations.",
  ],
  de: [
    "Capitalize all nouns; watch compound noun length in tight buttons/headers.",
  ],
  ar: [
    "Use Arabic comma (،) and Arabic question mark (؟); preserve LTR isolation around Latin/numbers.",
  ],
};

const EXPANSION_RATIOS: Record<string, number> = {
  de: 1.35,
  fr: 1.25,
  es: 1.25,
  pt: 1.25,
  it: 1.2,
  ru: 1.3,
  pl: 1.25,
  fi: 1.35,
  nl: 1.2,
  ja: 0.85,
  zh: 0.7,
  ko: 0.85,
  ar: 1.2,
};

const PLURAL_ORDER: Intl.LDMLPluralRule[] = ["zero", "one", "two", "few", "many", "other"];

/**
 * Full CLDR plural categories reported by Intl.PluralRules (including compact/million-scale
 * categories such as 'many' in fr/es/it/pt).
 */
export function getCldrPluralCategories(
  locale: string,
  type: "cardinal" | "ordinal" = "cardinal"
): Intl.LDMLPluralRule[] {
  try {
    const pr = new Intl.PluralRules(locale, { type });
    const cats = pr.resolvedOptions().pluralCategories;
    return cats.length > 0 ? cats : ["one", "other"];
  } catch {
    return ["one", "other"];
  }
}

/**
 * Everyday integer plural categories required in software UIs (probed over integers 0..100
 * via Intl.PluralRules, always including 'other' as ICU requires).
 *
 * For fr/es/it/pt, CLDR 42+ defines 'many' only for exact millions (1_000_000+),
 * so probing 0..100 naturally yields ["one", "other"] while Slavic (ru/pl/uk/cs)
 * and Arabic (ar) retain their full everyday categories (one/few/many/other, zero/one/two/few/many/other).
 */
export function getPluralCategories(
  locale: string,
  type: "cardinal" | "ordinal" = "cardinal"
): Intl.LDMLPluralRule[] {
  try {
    const pr = new Intl.PluralRules(locale, { type });
    const seen = new Set<Intl.LDMLPluralRule>(["other"]);
    for (let n = 0; n <= 100; n++) {
      seen.add(pr.select(n));
    }
    return PLURAL_ORDER.filter((c) => seen.has(c));
  } catch {
    return ["one", "other"];
  }
}

export function getAdvisoryPluralCategories(locale: string): Intl.LDMLPluralRule[] {
  const full = getCldrPluralCategories(locale, "cardinal");
  const required = new Set(getPluralCategories(locale, "cardinal"));
  return full.filter((c) => !required.has(c));
}

export function getLocaleConventions(locale: string): LocaleConventions {
  let language = locale.split(/[-_]/)[0].toLowerCase();
  let region: string | undefined;
  let canonical = locale;
  try {
    const loc = new Intl.Locale(locale);
    language = loc.language.toLowerCase();
    region = loc.region;
    canonical = loc.toString();
  } catch {
    // keep fallback
  }

  let displayName = canonical;
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    displayName = dn.of(canonical) ?? canonical;
  } catch {
    // keep canonical
  }

  const pluralCategories = getPluralCategories(canonical, "cardinal");
  const advisoryPluralCategories = getAdvisoryPluralCategories(canonical);
  const ordinalCategories = getPluralCategories(canonical, "ordinal");
  const direction: "ltr" | "rtl" = RTL_LANGUAGES.has(language) ? "rtl" : "ltr";
  const isCjk = CJK_LANGUAGES.has(language);

  const formalityDefault =
    FORMALITY_DEFAULTS[canonical] ??
    FORMALITY_DEFAULTS[language] ??
    "Match the source product's tone and stay consistent across the UI.";

  const punctuationNorms =
    PUNCTUATION_NORMS[canonical] ??
    PUNCTUATION_NORMS[language] ?? [
      "Follow standard target-locale punctuation, quoting, and capitalization rules.",
    ];

  const expectedExpansionRatio = EXPANSION_RATIOS[language] ?? 1.2;

  return {
    locale: canonical,
    displayName,
    language,
    region,
    direction,
    pluralCategories,
    advisoryPluralCategories,
    ordinalCategories,
    isCjk,
    formalityDefault,
    punctuationNorms,
    expectedExpansionRatio,
  };
}

export function isCjkText(text: string): boolean {
  const cjkChars = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/gu);
  if (!cjkChars) return false;
  const nonSpace = text.replace(/\s+/g, "").length;
  return nonSpace > 0 && cjkChars.length / nonSpace >= 0.3;
}
