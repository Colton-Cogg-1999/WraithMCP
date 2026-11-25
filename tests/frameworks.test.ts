import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranslations,
  ensureBootstrapped,
  GettextPoFormatAdapter,
  initProject,
  RailsYamlFormatAdapter,
  runCheck,
  scanProject,
} from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function copyFixture(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wraith-${name}-`));
  tmpDirs.push(dir);
  fs.cpSync(path.resolve("fixtures", name), dir, { recursive: true });
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Milestone 6: Vue/Nuxt, SvelteKit, Rails & Django Adapters + Lossless Writers", () => {
  it("detects, scans, and validates Vue/Nuxt (vue-i18n {x} and @:linked messages)", () => {
    const dir = copyFixture("vue-app");
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("vue");
    expect(scan.i18nLibrary).toBe("vue-i18n");
    expect(scan.counts.trackedKeys).toBe(2);
    expect(scan.hardcodedStrings.items.map((h) => h.text)).toEqual(
      expect.arrayContaining(["Close panel", "Dismiss alert"])
    );
    expect(scan.counts.concatenations).toBeGreaterThanOrEqual(1);

    // Reject broken @:brand linked message or missing {name}
    const bad = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [{ key: "welcome", value: "Bienvenue {name}" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].code).toBe("placeholder_mismatch");

    const ok = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [
        { key: "brand", value: "Acme Pulse" },
        { key: "welcome", value: "Bienvenue {name} sur @:brand" },
        { key: "post", value: "Publication" },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.appliedCount).toBe(3);
  });

  it("detects, scans, and validates SvelteKit (Paraglide m.key() + ICU-like plurals)", () => {
    const dir = copyFixture("sveltekit-app");
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("sveltekit");
    expect(scan.i18nLibrary).toBe("paraglide");
    expect(scan.counts.trackedKeys).toBe(2);
    expect(scan.hardcodedStrings.items.map((h) => h.text)).toEqual(
      expect.arrayContaining(["Filter projects", "Create project"])
    );
    expect(scan.counts.concatenations).toBeGreaterThanOrEqual(1);

    const ok = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "greeting", value: "Hallo {name}" },
        { key: "items", value: "{count, plural, one {# Projekt} other {# Projekte}}" },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(ok.appliedCount).toBe(2);
  });

  it("detects, scans, validates, and losslessly writes Rails YAML (%{x}, plural subkeys, comments preserved)", () => {
    const dir = copyFixture("rails-app");
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("rails");
    expect(scan.i18nLibrary).toBe("rails-i18n");
    expect(scan.counts.trackedKeys).toBe(3);
    expect(scan.hardcodedStrings.items.map((h) => h.text)).toEqual(
      expect.arrayContaining(["Archive now", "Archive item", "Profile updated successfully"])
    );
    expect(scan.counts.concatenations).toBeGreaterThanOrEqual(1);

    // Reject missing %{name}
    const bad = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "dashboard.welcome", value: "Willkommen zurück!" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].code).toBe("placeholder_mismatch");

    const ok = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "dashboard.welcome", value: "Willkommen zurück, %{name}" },
        {
          key: "dashboard.items",
          value: "%{count} Elemente übrig",
          plurals: { one: "1 Element übrig", other: "%{count} Elemente übrig" },
        },
        { key: "dashboard.open", value: "Öffnen" },
      ],
    });
    expect(ok.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "config/locales/de.yml"))).toBe(true);

    // Lossless YAML round-trip preserves comments!
    const yamlAdapter = new RailsYamlFormatAdapter();
    const enYml = path.join(dir, "config/locales/en.yml");
    const updated = yamlAdapter.applyUpdates(
      enYml,
      "en",
      [{ key: "dashboard.open", value: "Open" }],
      { write: false }
    );
    expect(updated).toContain("# Main English locale file (comment must be preserved!)");
  });

  it("detects, scans, validates, and losslessly writes Django Gettext PO (%(x)s, plurals, comments/refs preserved)", () => {
    const dir = copyFixture("django-app");
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

    const scan = scanProject({ rootDir: dir });
    expect(scan.framework).toBe("django");
    expect(scan.i18nLibrary).toBe("django-gettext");
    expect(scan.counts.trackedKeys).toBe(2);
    expect(scan.hardcodedStrings.items.map((h) => h.text)).toEqual(
      expect.arrayContaining(["Log out", "Sign out", "Settings updated cleanly"])
    );
    expect(scan.counts.concatenations).toBeGreaterThanOrEqual(2);

    // Reject missing %(name)s placeholder
    const bad = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [{ key: "Welcome, %(name)s", value: "Willkommen" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].code).toBe("placeholder_mismatch");

    const ok = applyTranslations({
      rootDir: dir,
      targetLocale: "de",
      translations: [
        { key: "Welcome, %(name)s", value: "Willkommen, %(name)s" },
        { key: "Account saved", value: "Konto gespeichert" },
        {
          key: "%(count)d message",
          value: "%(count)d Nachrichten",
          plurals: { one: "%(count)d Nachricht", other: "%(count)d Nachrichten" },
        },
      ],
    });
    expect(ok.ok).toBe(true);
    const dePoPath = path.join(dir, "locale/de/LC_MESSAGES/django.po");
    expect(fs.existsSync(dePoPath)).toBe(true);

    // Lossless PO preserves extracted comments (#.) and source references (#:)
    const dePo = fs.readFileSync(dePoPath, "utf8");
    expect(dePo).toContain("#. Greeting shown on dashboard");
    expect(dePo).toContain("#: templates/dashboard.html:3");
    expect(dePo).toContain('msgstr "Willkommen, %(name)s"');
    expect(dePo).toContain('msgstr[0] "%(count)d Nachricht"');
    expect(dePo).toContain('msgstr[1] "%(count)d Nachrichten"');

    // Read back via GettextPoFormatAdapter and run check
    const poAdapter = new GettextPoFormatAdapter();
    const readBack = poAdapter.readFile(dePoPath, "de");
    expect(readBack.entries.get("Account saved")?.value).toBe("Konto gespeichert");

    const chk = runCheck({ rootDir: dir, skipScan: true });
    expect(chk.passed).toBe(true);
  });
});
