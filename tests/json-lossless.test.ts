import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyTranslations, ensureBootstrapped, initProject } from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-json-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P2 Lossless JSON CST Writer Regression Suite", () => {
  it("preserves exact integer-like key order ('generic' before '404') from raw JSON files", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    // Raw JSON text written with "generic" before "404" (not passed through JS JSON.stringify which reorders integer keys)
    fs.writeFileSync(
      path.join(dir, "messages/en.json"),
      '{\n  "errors": {\n    "generic": "Error",\n    "404": "Not found",\n    "500": "Server error"\n  }\n}\n',
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "messages/fr.json"),
      '{\n  "errors": {\n    "generic": "Erreur",\n    "404": "Introuvable"\n  }\n}\n',
      "utf8"
    );
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [{ key: "errors.500", value: "Erreur serveur" }],
    });
    expect(res.ok).toBe(true);
    const out = fs.readFileSync(path.join(dir, "messages/fr.json"), "utf8");
    expect(out.indexOf('"generic"')).toBeLessThan(out.indexOf('"404"'));
    expect(out.indexOf('"404"')).toBeLessThan(out.indexOf('"500"'));
  });

  it("preserves UTF-8 BOM, unicode escapes (\\u00e9), and existing indentation verbatim", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ a: "Coffee", b: "Tea", c: "Water" }, null, 4) + "\n");
    fs.writeFileSync(path.join(dir, "messages/fr.json"), '\uFEFF{\n    "a": "Caf\\u00e9",\n    "b": "Th\\u00e9"\n}\n');
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const res = applyTranslations({
      rootDir: dir,
      targetLocale: "fr",
      translations: [{ key: "c", value: "Eau" }],
    });
    expect(res.ok).toBe(true);
    const out = fs.readFileSync(path.join(dir, "messages/fr.json"), "utf8");
    expect(out.startsWith("\uFEFF")).toBe(true);
    expect(out).toContain("Caf\\u00e9");
    expect(out).toContain("Th\\u00e9");
    expect(out).toContain('    "c": "Eau"');
  });
});
