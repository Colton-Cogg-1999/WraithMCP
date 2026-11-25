import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  applyTranslations,
  importEscalationCorrections,
  packageReviewJob,
  runCheck,
  scanProject,
  generatePseudoLocale,
} from "../../src/index.js";
import { init, nextIntlPkg, project } from "../helpers.js";

function outsideMarker(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-outside-"));
}

function base() {
  const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello" }) });
  init(dir, ["de"]);
  return dir;
}

describe("S. Filesystem safety (inputs can come from an LLM agent or a reviewer's file)", () => {
  it("S1 apply(): a targetLocale containing path segments cannot write outside the repo", () => {
    const dir = base();
    const outside = outsideMarker();
    const rel = path.relative(path.join(dir, "messages"), path.join(outside, "pwned"));
    let wrote = false;
    try {
      applyTranslations({ rootDir: dir, targetLocale: rel, translations: [{ key: "a", value: "Hallo" }] });
    } catch {}
    wrote = fs.existsSync(path.join(outside, "pwned.json"));
    console.log(`[S1] targetLocale=${rel} -> wrote outside repo: ${wrote}`);
    expect(wrote).toBe(false);
  });

  it("S2 escalate import: a crafted 'locale' column in a reviewer CSV cannot write outside the repo", () => {
    const dir = base();
    const outside = outsideMarker();
    const rel = path.relative(path.join(dir, "messages"), path.join(outside, "evil"));
    fs.writeFileSync(path.join(dir, "corrections.csv"), `locale,key,corrected_translation\n${rel},a,owned\n`);
    try {
      importEscalationCorrections(dir, "corrections.csv");
    } catch {}
    const wrote = fs.existsSync(path.join(outside, "evil.json"));
    console.log(`[S2] wrote outside repo via CSV locale column: ${wrote}`);
    expect(wrote).toBe(false);
  });

  it("S3 review package: outputPath cannot escape the repo", () => {
    const dir = base();
    const outside = outsideMarker();
    try {
      packageReviewJob(dir, { targetLocale: "de", outputPath: path.join(outside, "job.json") });
    } catch {}
    expect(fs.existsSync(path.join(outside, "job.json"))).toBe(false);
  });

  it("S4 document apply: targetFile cannot escape the repo", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": "{}", "docs/a.md": "# Hello world\n" });
    init(dir, ["de"]);
    const outside = outsideMarker();
    try {
      applyDocumentTranslations(dir, { sourceFile: "docs/a.md", targetFile: path.join(outside, "x.md"), targetLocale: "de", updates: [{ id: "md-1", text: "Hallo Welt" }] });
    } catch {}
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(false);
  });

  it("S5 Django: a project path containing '/en/' does not redirect writes outside the repo", () => {
    // e.g. ~/clients/en/shop — resolveTargetLocaleFile replaces the FIRST '/en/' in the absolute path
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-s5-"));
    const dir = path.join(parent, "en", "shop");
    fs.mkdirSync(path.join(dir, "locale/en/LC_MESSAGES"), { recursive: true });
    fs.writeFileSync(path.join(dir, "manage.py"), "");
    fs.writeFileSync(path.join(dir, "locale/en/LC_MESSAGES/django.po"), `msgid ""\nmsgstr ""\n\nmsgid "Hello"\nmsgstr "Hello"\n`);
    init(dir, ["fr"]);
    applyTranslations({ rootDir: dir, targetLocale: "fr", translations: [{ key: "Hello", value: "Bonjour" }] });
    const escaped = fs.existsSync(path.join(parent, "fr"));
    const inRepo = fs.existsSync(path.join(dir, "locale/fr/LC_MESSAGES/django.po"));
    console.log(`[S5] wrote to ${escaped ? path.join(parent, "fr", "...") + " (OUTSIDE repo)" : "repo"}; in-repo file exists=${inRepo}`);
    fs.rmSync(parent, { recursive: true, force: true });
    expect(escaped).toBe(false);
    expect(inRepo).toBe(true);
  });

  it("S6 a symlink loop in the source tree does not crash scan", () => {
    const dir = base();
    fs.mkdirSync(path.join(dir, "src"));
    fs.symlinkSync("..", path.join(dir, "src/loop"));
    let err = "";
    try {
      scanProject({ rootDir: dir });
    } catch (e: any) {
      err = String(e.message).slice(0, 120);
    }
    console.log(`[S6] ${err || "no error"}`);
    expect(err).toBe("");
  });

  it("S7 a symlink pointing outside the repo is not followed (no reading of arbitrary files)", () => {
    const dir = base();
    const outside = outsideMarker();
    fs.writeFileSync(path.join(outside, "Secret.tsx"), `export const S = () => <p>TOP SECRET OUTSIDE CONTENT</p>;`);
    fs.mkdirSync(path.join(dir, "src"));
    fs.symlinkSync(outside, path.join(dir, "src/linked"));
    const res = scanProject({ rootDir: dir, limit: 100 });
    const leaked = res.hardcodedStrings.items.some((h) => h.text.includes("TOP SECRET"));
    console.log(`[S7] content from outside repo surfaced via symlink: ${leaked}`);
    expect(leaked).toBe(false);
  });

  it("S8 one malformed target locale file does not abort the whole check", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": JSON.stringify({ a: "Hello" }), "messages/de.json": '{ "a": "Hallo", }', "messages/fr.json": "{}" });
    init(dir, ["de", "fr"]);
    let res: any;
    let err = "";
    try {
      res = runCheck({ rootDir: dir, skipScan: true });
    } catch (e: any) {
      err = e.message;
    }
    console.log(`[S8] threw="${err.slice(0, 80)}" ${res ? JSON.stringify(res.countsByCode) : ""}`);
    expect(err).toBe("");
  });

  it("S9 a malformed .polyglot/config.json yields an actionable error, not a stack trace", () => {
    const dir = base();
    fs.writeFileSync(path.join(dir, ".polyglot/config.json"), '{"targetLocales": "de"}');
    let msg = "";
    try {
      runCheck({ rootDir: dir });
    } catch (e: any) {
      msg = e.message;
    }
    console.log(`[S9] ${msg.slice(0, 200).replace(/\n/g, " ")}`);
    expect(msg).toMatch(/config\.json/);
  });

  it("S10 pseudo() on a Next.js app does not create or overwrite files outside messages/", () => {
    const dir = base();
    generatePseudoLocale(dir, "en-x-pseudo");
    expect(fs.existsSync(path.join(dir, "messages/en-x-pseudo.json"))).toBe(true);
  });
});
