import { describe, expect, it } from "vitest";
import { getLocaleConventions, runCheck, validateTranslationString } from "../../src/index.js";
import { init, project } from "../../audit/helpers.js";

const v = (src: string, tgt: string, loc: string, syn: any[] = ["icu"]) =>
  validateTranslationString(src, tgt, loc, syn).map((p) => `${p.code}: ${p.message}`);

describe("PL. Plural strategy: fractions, large numbers, ordinals, framework semantics", () => {
  it("PL1 conventions expose required vs advisory categories as documented (fr: one/other required, many advisory)", () => {
    const fr = getLocaleConventions("fr") as any;
    console.log(`[PL1] fr required=${fr.pluralCategories} advisory=${fr.advisoryPluralCategories} ordinal=${fr.ordinalCategories}`);
    expect(fr.pluralCategories).toEqual(["one", "other"]);
    expect(fr.advisoryPluralCategories).toContain("many");
  });

  it("PL2 Russian ICU plural without 'other' (needed for fractions like 1.5) is rejected", () => {
    const src = "{n, plural, one {# file} other {# files}}";
    expect(v(src, "{n, plural, one {# файл} few {# файла} many {# файлов}}", "ru").length).toBeGreaterThan(0);
  });

  it("PL3 Czech: 'many' (decimals, e.g. 1,5 souboru) is at least surfaced, not silently ignored", () => {
    const src = "{n, plural, one {# file} other {# files}}";
    const res = runCheckFor("cs", src, "{n, plural, one {# soubor} few {# soubory} other {# souborů}}");
    console.log(`[PL3] cs ${JSON.stringify(res)}`);
    expect(JSON.stringify(res)).toMatch(/many/);
  });

  it("PL4 Lithuanian 'many' (fractions only) is surfaced, not silently dropped", () => {
    const src = "{n, plural, one {# file} other {# files}}";
    const res = runCheckFor("lt", src, "{n, plural, one {# failas} few {# failai} other {# failų}}");
    console.log(`[PL4] lt ${JSON.stringify(res)}`);
    expect(JSON.stringify(res)).toMatch(/many/);
  });

  it("PL5 French 'many' (millions: '1 000 000 d'abonnés') is surfaced as advisory when absent", () => {
    const src = "{n, plural, one {# follower} other {# followers}}";
    const res = runCheckFor("fr", src, "{n, plural, one {# abonné} other {# abonnés}}");
    console.log(`[PL5] fr ${JSON.stringify(res)}`);
    expect(res.outcome).toBe("PASS");
    expect(JSON.stringify(res)).toMatch(/many/);
  });

  it("PL6 ordinal: en-GB selectordinal must have one/two/few/other; fr ordinal one/other is accepted", () => {
    const src = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect(v(src, "{n, selectordinal, one {#st} other {#th}}", "en-GB").length).toBeGreaterThan(0);
    expect(v(src, "{n, selectordinal, one {#er} other {#e}}", "fr")).toEqual([]);
  });

  it("PL7 explicit =0/=1 selectors do not satisfy the CLDR 'one' requirement for ru (=1 ≠ 21, 31…)", () => {
    const src = "{n, plural, =0 {no files} one {# file} other {# files}}";
    expect(v(src, "{n, plural, =0 {нет файлов} =1 {# файл} few {# файла} many {# файлов} other {# файла}}", "ru").length).toBeGreaterThan(0);
  });

  it("PL8 vue-i18n: a correct 4-form Russian pipe message (custom pluralRules) is accepted", () => {
    // vue-i18n docs: Russian needs 4 choices: 0 | 1 | 2-4 | 5+
    const out = v("no apples | one apple | {count} apples", "нет бананов | {n} банан | {n} банана | {n} бананов".replace(/\{n\}/g, "{count}"), "ru", ["single-brace"]);
    console.log(`[PL8] ${JSON.stringify(out)}`);
    expect(out).toEqual([]);
  });

  it("PL9 gettext: Russian with Plural-Forms nplurals=3 and 3 forms passes; Arabic nplurals=6 with 6 forms passes", () => {
    const ru = poProject("ru", "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);", ["%(n)d файл", "%(n)d файла", "%(n)d файлов"]);
    const ar = poProject("ar", "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);", ["لا ملفات %(n)d", "ملف %(n)d", "ملفان %(n)d", "%(n)d ملفات", "%(n)d ملفًا", "%(n)d ملف"]);
    console.log(`[PL9] ru=${ru.outcome} ${JSON.stringify(ru.codes)} ar=${ar.outcome} ${JSON.stringify(ar.codes)}`);
    expect(ru.outcome).toBe("PASS");
    expect(ar.outcome).toBe("PASS");
  });

  it("PL10 gettext: a target PO with nplurals=2 but only msgstr[0] filled is FAIL", () => {
    const fr = poProject("fr", "nplurals=2; plural=(n > 1);", ["%(n)d fichier", ""]);
    expect(fr.outcome).toBe("FAIL");
  });
});

function runCheckFor(locale: string, src: string, tgt: string) {
  const dir = project({
    "package.json": JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }),
    "messages/en.json": JSON.stringify({ n: src }),
    [`messages/${locale}.json`]: JSON.stringify({ n: tgt }),
  });
  init(dir, [locale]);
  const r = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
  return { outcome: r.outcome, issues: r.issues.items.map((i) => `${i.severity}:${i.code}:${i.message}`) };
}

function poProject(locale: string, pluralForms: string, forms: string[]) {
  const dir = project({
    "manage.py": "",
    [`locale/${locale}/LC_MESSAGES/django.po`]:
      `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: ${pluralForms}\\n"\n\n` +
      `msgid "%(n)d file"\nmsgid_plural "%(n)d files"\n` +
      forms.map((f, i) => `msgstr[${i}] "${f}"`).join("\n") +
      "\n",
  });
  init(dir, [locale]);
  const r = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
  return { outcome: r.outcome, codes: r.countsByCode };
}
