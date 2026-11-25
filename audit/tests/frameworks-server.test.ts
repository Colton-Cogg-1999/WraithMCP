import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyTranslations, prepareBatch, runCheck, scanProject } from "../../src/index.js";
import { init, project, read } from "../helpers.js";

function msgfmtCheck(file: string): string {
  try {
    execFileSync("msgfmt", ["--check", "-o", "/dev/null", file], { stdio: "pipe" });
    return "";
  } catch (e: any) {
    return String(e.stderr ?? e.message);
  }
}

/* ------------------------------------------------------------------ */
/* Django: modelled on the real `django-admin makemessages` workflow.  */
/* The source language has NO .po file; msgids are the source text.    */
/* ------------------------------------------------------------------ */
const FR_PO_HEADER = `msgid ""
msgstr ""
"Project-Id-Version: shop\\n"
"Language: fr\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"
`;

describe("H. Django (gettext) realism", () => {
  it("H1 a standard Django layout (no en/LC_MESSAGES) is checkable: untranslated msgids are reported", () => {
    const dir = project({
      "manage.py": "#!/usr/bin/env python\n",
      "requirements.txt": "Django==5.1\n",
      "shop/views.py": `from django.utils.translation import gettext as _\ndef v(r):\n    return _("Your cart is empty")\n`,
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `
#: shop/views.py:3
msgid "Your cart is empty"
msgstr ""
`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, limit: 50 });
    console.log(`[H1] passed=${res.passed} totalSourceKeys=${res.totalSourceKeys} codes=${JSON.stringify(res.countsByCode)}`);
    expect(res.passed).toBe(false);
  });

  it("H2 '#, fuzzy' entries are not counted as translated (Django ignores them at runtime)", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Delete account"\nmsgstr "Delete account"\n`,
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `\n#, fuzzy\nmsgid "Delete account"\nmsgstr "Supprimer le compte"\n`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
    expect(res.passed).toBe(false);
  });

  it("H3 apply() clears the '#, fuzzy' flag so Django actually uses the new translation", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "Delete account"\nmsgstr "Delete account"\n`,
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `\n#, fuzzy\nmsgid "Delete account"\nmsgstr "Suppr compte"\n`,
    });
    init(dir, ["fr"]);
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "Delete account", value: "Supprimer le compte" }] });
    expect(read(dir, "locale/fr/LC_MESSAGES/django.po")).not.toMatch(/#, fuzzy\nmsgid "Delete account"/);
  });

  it("H4 French plural written by apply() respects the file's Plural-Forms (nplurals=2) and compiles with msgfmt", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n"Language: en\\n"\n"Plural-Forms: nplurals=2; plural=(n != 1);\\n"\n\nmsgid "%(count)d item"\nmsgid_plural "%(count)d items"\nmsgstr[0] "%(count)d item"\nmsgstr[1] "%(count)d items"\n`,
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `\nmsgid "%(count)d item"\nmsgid_plural "%(count)d items"\nmsgstr[0] ""\nmsgstr[1] ""\n`,
    });
    init(dir, ["fr"]);
    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [{ key: "%(count)d item", value: "%(count)d articles", plurals: { one: "%(count)d article", other: "%(count)d articles" } }],
    });
    const po = path.join(dir, "locale/fr/LC_MESSAGES/django.po");
    const err = msgfmtCheck(po);
    console.log(`[H4] apply errors=${JSON.stringify(res.errors)}\n${read(dir, "locale/fr/LC_MESSAGES/django.po").split("\n").slice(-5).join("\n")}\nmsgfmt: ${err}`);
    expect(res.appliedCount).toBe(1);
    expect(err).toBe("");
  });

  it("H5 a correct, msgfmt-valid French plural PO entry passes check", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n"Language: en\\n"\n\nmsgid "%(count)d item"\nmsgid_plural "%(count)d items"\nmsgstr[0] "%(count)d item"\nmsgstr[1] "%(count)d items"\n`,
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `\nmsgid "%(count)d item"\nmsgid_plural "%(count)d items"\nmsgstr[0] "%(count)d article"\nmsgstr[1] "%(count)d articles"\n`,
    });
    init(dir, ["fr"]);
    expect(msgfmtCheck(path.join(dir, "locale/fr/LC_MESSAGES/django.po"))).toBe("");
    const res = runCheck({ rootDir: dir, skipScan: true, severity: "error", limit: 50 });
    console.log(`[H5] ${JSON.stringify(res.issues.items.map((i) => i.message))}`);
    expect(res.errorCount).toBe(0);
  });

  it("H6 scanner recall on common Django user-facing strings", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n`,
      "shop/forms.py": `from django import forms\nclass F(forms.Form):\n    email = forms.EmailField(label="Email address", help_text="We never share it.")\n`,
      "shop/models.py": `from django.db import models\nclass Order(models.Model):\n    class Meta:\n        verbose_name = "order"\n`,
      "shop/views.py": `from django.http import HttpResponse\nfrom django.core.exceptions import ValidationError\ndef v(r):\n    raise ValidationError("This coupon has expired.")\n`,
      "templates/cart.html": `<h1>Your cart</h1>\n<script>const msg = "do not flag script content";</script>\n<p>{% trans "Don't forget your coupon" %}</p>\n`,
    });
    init(dir, ["fr"]);
    const res = scanProject({ rootDir: dir, limit: 100 });
    const texts = res.hardcodedStrings.items.map((h) => h.text);
    console.log(`[H6] found=${JSON.stringify(texts)}`);
    for (const t of ["Email address", "We never share it.", "This coupon has expired.", "Your cart"]) {
      expect(texts).toContain(t);
    }
    expect(texts.some((t) => t.includes("do not flag script content"))).toBe(false);
  });

  it("H7 {% blocktrans %} with variables maps to the real msgid (no orphan)", () => {
    const dir = project({
      "manage.py": "",
      "locale/en/LC_MESSAGES/django.po": `msgid ""\nmsgstr ""\n\nmsgid "Hello %(name)s"\nmsgstr "Hello %(name)s"\n\nmsgid "Bye"\nmsgstr "Bye"\n`,
      "templates/a.html": `{% load i18n %}<p>{% blocktrans %}Hello {{ name }}{% endblocktrans %}</p><p>{% trans "Bye" %}</p>`,
    });
    init(dir, ["fr"]);
    const res = runCheck({ rootDir: dir, code: "orphaned_key", limit: 50 });
    console.log(`[H7] orphaned=${JSON.stringify(res.issues.items.map((i) => i.key))}`);
    expect(res.issues.total).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Rails                                                               */
/* ------------------------------------------------------------------ */
describe("I. Rails realism", () => {
  const base = {
    Gemfile: `source "https://rubygems.org"\ngem "rails", "~> 7.2"\n`,
    "config/locales/en.yml": `en:\n  users:\n    index:\n      title: "Team members"\n      count:\n        one: "%{count} member"\n        other: "%{count} members"\n`,
  };

  it("I1 lazy lookup t('.title') in app/views/users/index resolves to users.index.title (no orphan)", () => {
    const dir = project({ ...base, "app/views/users/index.html.erb": `<h1><%= t(".title") %></h1>\n<p><%= t(".count", count: @n) %></p>\n` });
    init(dir, ["ru"]);
    const res = runCheck({ rootDir: dir, code: "orphaned_key", limit: 50 });
    console.log(`[I1] orphaned=${JSON.stringify(res.issues.items.map((i) => i.key))}`);
    expect(res.issues.total).toBe(0);
  });

  it("I2 hardcoded strings inside ERB helpers (link_to, f.submit, f.label, button_to) are found", () => {
    const dir = project({
      ...base,
      "app/views/users/_form.html.erb": `<%= form_with model: @user do |f| %>\n  <%= f.label :email, "Email address" %>\n  <%= f.submit "Save user" %>\n<% end %>\n<%= link_to "Back to list", users_path %>\n<%= button_to "Delete", @user, method: :delete %>\n`,
    });
    init(dir, ["ru"]);
    const texts = scanProject({ rootDir: dir, limit: 100 }).hardcodedStrings.items.map((h) => h.text);
    console.log(`[I2] found=${JSON.stringify(texts)}`);
    for (const t of ["Email address", "Save user", "Back to list", "Delete"]) expect(texts).toContain(t);
  });

  it("I3 applying a plain string to a plural key is rejected (would destroy one/few/many/other)", () => {
    const dir = project({ ...base });
    init(dir, ["ru"]);
    const res = applyTranslations({ rootDir: dir, targetLocale: "ru", translations: [{ key: "users.index.count", value: "%{count} участников" }] });
    console.log(`[I3] applied=${res.appliedCount} ru.yml=\n${fs.existsSync(path.join(dir, "config/locales/ru.yml")) ? read(dir, "config/locales/ru.yml") : "(none)"}`);
    expect(res.appliedCount).toBe(0);
  });

  it("I4 check flags a Russian plural that is a scalar string instead of one/few/many/other", () => {
    const dir = project({ ...base, "config/locales/ru.yml": `ru:\n  users:\n    index:\n      title: "Участники"\n      count: "%{count} участников"\n` });
    init(dir, ["ru"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
    console.log(`[I4] errors=${res.errorCount} ${JSON.stringify(res.countsByCode)}`);
    expect(res.countsByCode["missing_plural_category"] ?? 0).toBeGreaterThan(0);
  });

  it("I5 each plural variant's placeholders are validated on apply", () => {
    const dir = project({ ...base });
    init(dir, ["ru"]);
    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "ru",
      translations: [{ key: "users.index.count", value: "%{count} участников", plurals: { one: "%{cnt} участник", few: "участника", many: "%{count} участников", other: "%{count} участника" } }],
    });
    expect(res.appliedCount).toBe(0);
  });

  it("I6 locale files in nested directories (config/locales/models/en.yml) are loaded", () => {
    const dir = project({ ...base, "config/locales/models/en.yml": `en:\n  activerecord:\n    models:\n      user: "User"\n` });
    init(dir, ["ru"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 1 });
    expect(res.totalSourceKeys).toBe(3);
  });

  it("I7 Rails+React (jsbundling) app is still treated as Rails for YAML locales", () => {
    const dir = project({ ...base, "package.json": JSON.stringify({ dependencies: { react: "19.0.0" } }) });
    init(dir, ["ru"]);
    expect(runCheck({ rootDir: dir, skipScan: true, limit: 1 }).framework).toBe("rails");
  });

  it("I8 YAML write keeps a long line on one line (no reflow noise in git diff)", () => {
    const long = "This is a deliberately long Rails translation string that goes well beyond eighty characters in width.";
    const dir = project({ Gemfile: base.Gemfile, "config/locales/en.yml": `en:\n  a: "${long}"\n  b: "Short"\n`, "config/locales/fr.yml": `fr:\n  a: "${long} (fr)"\n` });
    init(dir, ["fr"]);
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "b", value: "Court" }] });
    const out = read(dir, "config/locales/fr.yml");
    expect(out).toContain(`a: "${long} (fr)"`);
  });
});

/* ------------------------------------------------------------------ */
/* Vue / Svelte                                                        */
/* ------------------------------------------------------------------ */
describe("J. Vue & SvelteKit realism", () => {
  it("J1 Vue: <i18n-t keypath> and v-t usages are tracked (no orphan) and {{ 'literal' }} is flagged", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { vue: "3.5.0", "vue-i18n": "10.0.0" } }),
      "src/locales/en.json": JSON.stringify({ terms: "I accept the {link}", save: "Save", home: "Home" }),
      "src/App.vue": `<template>\n  <i18n-t keypath="terms" tag="p"><a href="/t">terms</a></i18n-t>\n  <button v-t="'save'"></button>\n  <span>{{ $t('home') }}</span>\n  <h2>{{ 'Recent activity' }}</h2>\n</template>\n`,
    });
    init(dir, ["fr"]);
    const orphans = runCheck({ rootDir: dir, code: "orphaned_key", limit: 50 }).issues.items.map((i) => i.key);
    const texts = scanProject({ rootDir: dir, limit: 50 }).hardcodedStrings.items.map((h) => h.text);
    console.log(`[J1] orphans=${JSON.stringify(orphans)} hardcoded=${JSON.stringify(texts)}`);
    expect(orphans).toEqual([]);
    expect(texts).toContain("Recent activity");
  });

  it("J2 Paraglide messages with the standard \"$schema\" key are not treated as translatable", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { "@sveltejs/kit": "2.0.0", svelte: "5.0.0", "@inlang/paraglide-js": "2.0.0" } }),
      "messages/en.json": JSON.stringify({ $schema: "https://inlang.com/schema/inlang-message-format", hello: "Hello {name}" }),
      "messages/de.json": JSON.stringify({ $schema: "https://inlang.com/schema/inlang-message-format", hello: "Hallo {name}" }),
    });
    init(dir, ["de"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
    console.log(`[J2] ${JSON.stringify(res.issues.items.map((i) => `${i.code}:${i.key}`))}`);
    expect(res.issues.items.some((i) => i.key === "$schema")).toBe(false);
  });

  it("J3 Paraglide 2 variant (plural) messages are visible to check", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { "@sveltejs/kit": "2.0.0", svelte: "5.0.0", "@inlang/paraglide-js": "2.0.0" } }),
      "messages/en.json": JSON.stringify({
        items: [{ declarations: ["input count", "local countPlural = count: plural"], selectors: ["countPlural"], match: { "countPlural=one": "{count} item", "countPlural=other": "{count} items" } }],
      }),
    });
    init(dir, ["de"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 50 });
    expect(res.totalSourceKeys).toBe(1);
  });
});

describe("K. Locale-file discovery & prepare", () => {
  it("K1 underscore locale files (pt_BR.json) are discovered", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { react: "19", "react-i18next": "15" } }),
      "src/locales/en.json": JSON.stringify({ a: "Save" }),
      "src/locales/pt_BR.json": JSON.stringify({ a: "Salvar" }),
    });
    init(dir, ["pt-BR"]);
    const res = runCheck({ rootDir: dir, skipScan: true, limit: 10 });
    expect(res.errorCount).toBe(0);
  });

  it("K2 prepare() for a Django project without a source .po still returns work to do", () => {
    const dir = project({
      "manage.py": "",
      "locale/fr/LC_MESSAGES/django.po": FR_PO_HEADER + `\nmsgid "Checkout"\nmsgstr ""\n`,
    });
    init(dir, ["fr"]);
    expect(prepareBatch({ rootDir: dir, targetLocale: "fr" }).totalPending).toBeGreaterThan(0);
  });
});
