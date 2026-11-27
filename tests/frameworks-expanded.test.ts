import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations } from "../src/core/apply.js";
import { runCheck } from "../src/core/check.js";
import { initProject } from "../src/core/init.js";
import { prepareBatch } from "../src/core/prepare.js";
import { scanProject } from "../src/core/scan.js";

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Expanded framework adapters (Astro, Flutter ARB, Android strings.xml)", () => {
  it("detects, scans, prepares, applies, and checks an Astro project", () => {
    const dir = mkTmp("wraith-astro-");
    fs.mkdirSync(path.join(dir, "src/pages"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src/i18n"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "astro-site", dependencies: { astro: "^5.0.0", i18next: "^23.0.0" } })
    );
    fs.writeFileSync(
      path.join(dir, "src/i18n/en.json"),
      JSON.stringify({ hero: { title: "Welcome to Northstar", cta: "Get started" } }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(dir, "src/pages/index.astro"),
      `---
import { t } from "i18next";
const heading = t("hero.title");
---
<main>
  <h1>{heading}</h1>
  <button class="w-24 truncate whitespace-nowrap">{t("hero.cta")}</button>
  <p>Hardcoded footer note</p>
</main>
`
    );

    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("astro");
    expect(scan.counts.trackedKeys).toBeGreaterThanOrEqual(2);
    expect(scan.hardcodedStrings.items.some((h) => h.text === "Hardcoded footer note")).toBe(true);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    expect(prep.items.map((i) => i.key).sort()).toEqual(["hero.cta", "hero.title"]);

    const apply = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "hero.title", value: "Willkommen bei Northstar" },
        { key: "hero.cta", value: "Starten" },
      ],
    });
    expect(apply.appliedCount).toBe(2);

    const check = runCheck({ rootDir: dir, locale: "de" });
    // Only error should be the intentional hardcoded footer note; 0 translation/catalog errors
    expect(check.countsByCode["hardcoded_string"]).toBe(1);
    expect(check.countsByCode["missing_translation"] ?? 0).toBe(0);
    expect(check.errorCount).toBe(1);
  });

  it("detects, scans, prepares, applies, and checks a Flutter ARB project preserving @key metadata", () => {
    const dir = mkTmp("wraith-flutter-");
    fs.mkdirSync(path.join(dir, "lib/l10n"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "pubspec.yaml"),
      `name: northstar_mobile\ndependencies:\n  flutter:\n    sdk: flutter\n  flutter_localizations:\n    sdk: flutter\n`
    );
    fs.writeFileSync(
      path.join(dir, "lib/l10n/app_en.arb"),
      JSON.stringify(
        {
          "@@locale": "en",
          saveButton: "Save",
          "@saveButton": { description: "Saves profile changes, not money" },
          itemsCount: "{count, plural, one {# item} other {# items}}",
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(dir, "lib/home.dart"),
      `import 'package:flutter/material.dart';
class HomeScreen extends StatelessWidget {
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Column(children: [
      Text(l10n.saveButton),
      Text(l10n.itemsCount),
      Text('Untranslated Banner'),
    ]);
  }
}
`
    );

    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("flutter");
    expect(scan.counts.trackedKeys).toBe(2);
    expect(scan.hardcodedStrings.items.some((h) => h.text === "Untranslated Banner")).toBe(true);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "de" });
    expect(prep.items).toHaveLength(2);
    const saveItem = prep.items.find((i) => i.key === "saveButton");
    expect(saveItem?.comment).toBe("Saves profile changes, not money");

    const apply = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "saveButton", value: "Speichern" },
        { key: "itemsCount", value: "{count, plural, one {# Element} other {# Elemente}}" },
      ],
    });
    expect(apply.appliedCount).toBe(2);

    const writtenArb = JSON.parse(fs.readFileSync(path.join(dir, "lib/l10n/app_de.arb"), "utf8"));
    expect(writtenArb["@@locale"]).toBe("de");
    expect(writtenArb.saveButton).toBe("Speichern");

    const check = runCheck({ rootDir: dir, locale: "de" });
    // Only error should be the intentional hardcoded footer note; 0 translation/catalog errors
    expect(check.countsByCode["hardcoded_string"]).toBe(1);
    expect(check.countsByCode["missing_translation"] ?? 0).toBe(0);
    expect(check.errorCount).toBe(1);
  });

  it("detects, scans, prepares, applies, and checks an Android strings.xml project respecting translatable=false", () => {
    const dir = mkTmp("wraith-android-");
    fs.mkdirSync(path.join(dir, "app/src/main/res/values"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/src/main/res/layout"), { recursive: true });
    fs.mkdirSync(path.join(dir, "app/src/main/java/com/acme"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app/src/main/AndroidManifest.xml"), `<manifest package="com.acme"/>\n`);
    fs.writeFileSync(
      path.join(dir, "app/src/main/res/values/strings.xml"),
      `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name" translatable="false">Northstar</string>
    <string name="greeting">Hello, %1$s!</string>
    <string name="save_btn">Save</string>
</resources>
`
    );
    fs.writeFileSync(
      path.join(dir, "app/src/main/res/layout/activity_main.xml"),
      `<LinearLayout>
  <TextView android:text="@string/greeting" />
  <Button android:text="Hardcoded Action" />
</LinearLayout>
`
    );
    fs.writeFileSync(
      path.join(dir, "app/src/main/java/com/acme/MainActivity.kt"),
      `class MainActivity { fun render() = getString(R.string.save_btn) }\n`
    );

    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("android");
    expect(scan.counts.trackedKeys).toBe(2);
    expect(scan.hardcodedStrings.items.some((h) => h.text === "Hardcoded Action")).toBe(true);

    const prep = prepareBatch({ rootDir: dir, targetLocale: "es-MX" });
    // translatable="false" key `app_name` must NOT be sent for translation
    expect(prep.items.map((i) => i.key).sort()).toEqual(["greeting", "save_btn"]);

    const apply = applyTranslations({
      rootDir: dir,
      targetLocale: "es-MX",
      translations: [
        { key: "greeting", value: "¡Hola, %1$s!" },
        { key: "save_btn", value: "Guardar" },
      ],
    });
    expect(apply.appliedCount).toBe(2);

    const targetXmlPath = path.join(dir, "app/src/main/res/values-es-rMX/strings.xml");
    expect(fs.existsSync(targetXmlPath)).toBe(true);
    const targetXml = fs.readFileSync(targetXmlPath, "utf8");
    expect(targetXml).toContain('<string name="greeting">¡Hola, %1$s!</string>');
    expect(targetXml).toContain('<string name="save_btn">Guardar</string>');

    const check = runCheck({ rootDir: dir, locale: "es-MX" });
    expect(check.countsByCode["hardcoded_string"]).toBe(1);
    expect(check.countsByCode["missing_translation"] ?? 0).toBe(0);
    expect(check.countsByCode["placeholder_mismatch"] ?? 0).toBe(0);
    expect(check.errorCount).toBe(1);

    // Script subtags (e.g. zh-Hans) must use Android BCP-47 values-b+zh+Hans/strings.xml
    const applyZh = applyTranslations({
      rootDir: dir,
      targetLocale: "zh-Hans",
      translations: [
        { key: "greeting", value: "你好，%1$s！" },
        { key: "save_btn", value: "保存" },
      ],
    });
    expect(applyZh.appliedCount).toBe(2);
    const zhXmlPath = path.join(dir, "app/src/main/res/values-b+zh+Hans/strings.xml");
    expect(fs.existsSync(zhXmlPath)).toBe(true);
    const checkZh = runCheck({ rootDir: dir, locale: "zh-Hans" });
    expect(checkZh.countsByCode["missing_translation"] ?? 0).toBe(0);
    expect(checkZh.countsByCode["placeholder_mismatch"] ?? 0).toBe(0);
  });
});
