import { describe, expect, it } from "vitest";
import { applyTranslations, runCheck, validateTranslationString } from "../../src/index.js";
import { init, nextIntlPkg, project, i18nextPkg, read } from "../helpers.js";

const codes = (src: string, tgt: string, loc: string, syn: any[]) =>
  validateTranslationString(src, tgt, loc, syn).map((p) => p.code);

describe("A. ICU / placeholder validation (next-intl, ICU)", () => {
  it("A1 accepts a standard, correct French plural (one/other) — CLDR 'many' must not be mandatory", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const fr = "{count, plural, one {# élément} other {# éléments}}";
    expect(codes(src, fr, "fr", ["icu"])).toEqual([]);
  });

  it("A2 accepts a standard Spanish plural (one/other)", () => {
    const src = "{count, plural, one {# file} other {# files}}";
    expect(codes(src, "{count, plural, one {# archivo} other {# archivos}}", "es-MX", ["icu"])).toEqual([]);
  });

  it("A3 selectordinal is validated against ORDINAL categories (fr ordinal = one, other)", () => {
    const src = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    const fr = "{n, selectordinal, one {#er} other {#e}}";
    expect(codes(src, fr, "fr", ["icu"])).toEqual([]);
  });

  it("A4 selectordinal for en-GB must require two/few (ordinal categories)", () => {
    const src = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    const enGB = "{n, selectordinal, one {#st} other {#th}}";
    expect(codes(src, enGB, "en-GB", ["icu"])).toContain("missing_plural_category");
  });

  it("A5 dropping the # count from the 'other' branch is flagged", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const de = "{count, plural, one {# Artikel} other {Artikel}}";
    expect(codes(src, de, "de", ["icu"]).length).toBeGreaterThan(0);
  });

  it("A6 apostrophe escaping that swallows a placeholder is flagged (French l'{x})", () => {
    const src = "Delete {item}?";
    const fr = "Supprimer l'{item} ?"; // ICU: '{item} starts a quoted literal -> placeholder lost
    expect(codes(src, fr, "fr", ["icu"])).toContain("placeholder_mismatch");
  });

  it("A7 a translated plural *variable name* is flagged", () => {
    const src = "{count, plural, one {# item} other {# items}}";
    const tgt = "{nombre, plural, one {# élément} many {# éléments} other {# éléments}}";
    expect(codes(src, tgt, "fr", ["icu"])).toContain("placeholder_mismatch");
  });

  it("A8 nested select-in-plural with a missing select branch is flagged", () => {
    const src = "{g, select, female {{n, plural, one {she has # cat} other {she has # cats}}} other {{n, plural, one {they have # cat} other {they have # cats}}}}";
    const de = "{g, select, other {{n, plural, one {hat # Katze} other {hat # Katzen}}}}";
    expect(codes(src, de, "de", ["icu"])).toContain("missing_plural_category");
  });

  it("A9 rich-text tag renamed (<b> -> <strong>) is flagged", () => {
    expect(codes("Click <b>here</b>", "Cliquez <strong>ici</strong>", "fr", ["icu"])).toContain("inline_tag_mismatch");
  });

  it("A10 ICU argument type changed (number -> plain) is flagged", () => {
    const issues = codes("Total: {amount, number, ::currency/USD}", "Total : {amount}", "fr", ["icu"]);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("B. i18next (double-mustache) specifics", () => {
  it("B1 i18next key-suffix plurals: ru target must require _few/_many keys", () => {
    const dir = project({
      "package.json": i18nextPkg,
      "public/locales/en/common.json": JSON.stringify({ items_one: "{{count}} item", items_other: "{{count}} items" }, null, 2),
      "public/locales/ru/common.json": JSON.stringify({ items_one: "{{count}} элемент", items_other: "{{count}} элементов" }, null, 2),
    });
    init(dir, ["ru"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 100 });
    // A correct checker must notice ru lacks items_few / items_many.
    expect(res.issues.items.some((i) => /few|many/.test(i.message))).toBe(true);
  });

  it("B2 i18next nesting $t(key) reference removed is flagged", () => {
    expect(codes("See $t(common.terms)", "Voir les conditions", "fr", ["double-mustache", "icu"]).length).toBeGreaterThan(0);
  });

  it("B3 i18next {{x, formatter}} placeholder name is preserved check", () => {
    expect(codes("Due {{date, datetime}}", "Échéance {{datum, datetime}}", "fr", ["double-mustache", "icu"])).toContain("placeholder_mismatch");
  });
});

describe("C. vue-i18n specifics", () => {
  it("C1 pipe-plural branch count is validated (source 3 branches, target collapses to 1)", () => {
    expect(codes("no apples | one apple | {count} apples", "{count} pommes", "fr", ["single-brace"]).length).toBeGreaterThan(0);
  });

  it("C2 a stray '|' introduced by the translator (accidental plural) is flagged", () => {
    expect(codes("Home", "Accueil | Maison", "fr", ["single-brace"]).length).toBeGreaterThan(0);
  });

  it("C3 a raw '@' in a translation (vue-i18n linked-message syntax error) is flagged", () => {
    expect(codes("Contact us", "Contactez-nous @ support", "fr", ["single-brace"]).length).toBeGreaterThan(0);
  });
});

describe("D. Python / gettext / Rails specifics", () => {
  it("D1 '50% off' with a literal percent is NOT treated as a printf conversion", () => {
    expect(codes("50% off", "50 % de réduction", "fr", ["python-printf", "single-brace"])).toEqual([]);
  });

  it("D2 positional %s/%d reordering is flagged (Python cannot reorder positional args)", () => {
    expect(codes("%s has %d items", "%d éléments pour %s", "fr", ["python-printf", "single-brace"]).length).toBeGreaterThan(0);
  });

  it("D3 Rails %<count>d formatted placeholder dropped is flagged", () => {
    expect(codes("Total %<amount>.2f", "Total", "fr", ["percent-brace"]).length).toBeGreaterThan(0);
  });

  it("D4 Python brace-format {0} vs {1} swap is NOT a mismatch but a renamed one is", () => {
    expect(codes("{name} likes {thing}", "{thing} plaît à {name}", "fr", ["python-printf", "single-brace"])).toEqual([]);
    expect(codes("{name} likes {thing}", "{nom} aime {thing}", "fr", ["python-printf", "single-brace"])).toContain("placeholder_mismatch");
  });
});

describe("E. Escaping and locale behaviour end-to-end through apply()", () => {
  it("E1 apply() accepts a correct French plural for next-intl", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ cart: { items: "{count, plural, one {# item} other {# items}}" } }, null, 2) + "\n",
    });
    init(dir, ["fr"]);
    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [{ key: "cart.items", value: "{count, plural, one {# article} other {# articles}}" }],
    });
    expect(res.errors).toEqual([]);
    expect(res.appliedCount).toBe(1);
  });

  it("E2 check() passes on a correct, idiomatic fr/es/it/pt-BR catalog", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ n: "{count, plural, one {# file} other {# files}}" }),
      "messages/fr.json": JSON.stringify({ n: "{count, plural, one {# fichier} other {# fichiers}}" }),
      "messages/es.json": JSON.stringify({ n: "{count, plural, one {# archivo} other {# archivos}}" }),
      "messages/it.json": JSON.stringify({ n: "{count, plural, one {# file} other {# file}}" }),
      "messages/pt-BR.json": JSON.stringify({ n: "{count, plural, one {# arquivo} other {# arquivos}}" }),
    });
    init(dir, ["fr", "es", "it", "pt-BR"]);
    const res = runCheck({ rootDir: dir, skipScan: true, severity: "error", limit: 100 });
    expect(res.issues.items.map((i) => `${i.locale}:${i.code}`)).toEqual([]);
  });

  it("E3 translator-supplied literal braces survive validation when ICU-escaped", () => {
    const src = "Use '{name}' syntax"; // literal {name} in ICU
    expect(codes(src, "Utilisez la syntaxe '{name}'", "fr", ["icu"])).toEqual([]);
  });

  it("E4 JSON writer keeps integer-like key order (\"lossless\" claim)", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ errors: { generic: "Error", "404": "Not found", "500": "Server error" } }, null, 2) + "\n",
      "messages/fr.json": JSON.stringify({ errors: { generic: "Erreur", "404": "Introuvable" } }, null, 2) + "\n",
    });
    init(dir, ["fr"]);
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "errors.500", value: "Erreur serveur" }] });
    const fr = read(dir, "messages/fr.json");
    expect(fr.indexOf('"generic"')).toBeLessThan(fr.indexOf('"404"'));
  });

  it("E5 JSON writer tolerates a UTF-8 BOM in an existing target file", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ a: "Save", b: "Cancel" }, null, 2) + "\n",
      "messages/fr.json": "﻿" + JSON.stringify({ a: "Enregistrer" }, null, 2) + "\n",
    });
    init(dir, ["fr"]);
    expect(() =>
      applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "b", value: "Annuler" }] })
    ).not.toThrow();
  });

  it("E6 JSON writer preserves unicode escape style (no whole-file re-serialisation)", () => {
    const original = '{\n  "a": "Caf\\u00e9",\n  "b": "x"\n}\n';
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ a: "Coffee", b: "x", c: "New" }, null, 2) + "\n",
      "messages/fr.json": original,
    });
    init(dir, ["fr"]);
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "c", value: "Nouveau" }] });
    expect(read(dir, "messages/fr.json")).toContain("Caf\\u00e9");
  });
});
