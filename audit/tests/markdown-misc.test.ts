import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  generatePseudoLocale,
  MarkdownDocumentAdapter,
  runCheck,
} from "../../src/index.js";
import { init, nextIntlPkg, project, read } from "../helpers.js";

const md = new MarkdownDocumentAdapter("markdown");

describe("U. Markdown / MDX", () => {
  it("U1 a hard-wrapped paragraph is ONE segment (sentences are not split across segments)", () => {
    const dir = project({ "a.md": "This sentence is wrapped\nacross two lines as most editors do.\n" });
    const segs = md.extract(path.join(dir, "a.md")).segments;
    console.log(`[U1] segments: ${JSON.stringify(segs.map((s) => s.text))}`);
    expect(segs.length).toBe(1);
  });

  it("U2 indented code blocks are not offered for translation", () => {
    const dir = project({ "a.md": "Run this:\n\n    npm install --save my-package\n    export const value = 1\n\nDone.\n" });
    const segs = md.extract(path.join(dir, "a.md")).segments.map((s) => s.text);
    console.log(`[U2] ${JSON.stringify(segs)}`);
    expect(segs.some((s) => s.includes("npm install"))).toBe(false);
  });

  it("U3 link reference definitions keep their URL protected", () => {
    const dir = project({ "a.md": "See the [docs][d].\n\n[d]: https://example.com/docs \"Docs title\"\n" });
    const segs = md.extract(path.join(dir, "a.md")).segments.map((s) => s.text);
    console.log(`[U3] ${JSON.stringify(segs)}`);
    expect(segs.some((s) => s.includes("https://example.com"))).toBe(false);
  });

  it("U4 CRLF files keep CRLF line endings after translation", () => {
    const dir = project({ "a.md": "# Title\r\n\r\nHello world\r\n" });
    init(dir, ["de"]);
    const segs = md.extract(path.join(dir, "a.md")).segments;
    applyDocumentTranslations(dir, { sourceFile: "a.md", targetFile: "a.de.md", targetLocale: "de", updates: segs.map((s) => ({ id: s.id, text: s.text.replace("Hello world", "Hallo Welt").replace("Title", "Titel") })) });
    const out = read(dir, "a.de.md");
    console.log(`[U4] ${JSON.stringify(out)}`);
    expect(out).toBe("# Titel\r\n\r\nHallo Welt\r\n");
  });

  it("U5 MDX: JS expressions {…} in prose are protected", () => {
    const dir = project({ "a.mdx": "You have {props.count} new messages.\n" });
    const segs = new MarkdownDocumentAdapter("mdx").extract(path.join(dir, "a.mdx")).segments.map((s) => s.text);
    console.log(`[U5] ${JSON.stringify(segs)}`);
    expect(segs[0]).not.toContain("{props.count}");
  });

  it("U6 MDX: multi-line export blocks are not translated", () => {
    const dir = project({ "a.mdx": "export const meta = {\n  title: \"Getting started\",\n  slug: \"getting-started\",\n}\n\n# Welcome\n" });
    const segs = new MarkdownDocumentAdapter("mdx").extract(path.join(dir, "a.mdx")).segments.map((s) => s.text);
    console.log(`[U6] ${JSON.stringify(segs)}`);
    expect(segs.some((s) => s.includes("slug"))).toBe(false);
  });

  it("U7 documents are covered by check (an untranslated configured document fails check)", () => {
    const dir = project({ "package.json": nextIntlPkg, "messages/en.json": "{}", "docs/guide.md": "# Guide\n\nHello world.\n" });
    init(dir, ["de"]);
    const cfg = JSON.parse(read(dir, ".polyglot/config.json"));
    cfg.paths.documents = ["docs"];
    fs.writeFileSync(path.join(dir, ".polyglot/config.json"), JSON.stringify(cfg));
    const res = runCheck({ rootDir: dir });
    console.log(`[U7] passed=${res.passed} codes=${JSON.stringify(res.countsByCode)}`);
    expect(res.passed).toBe(false);
  });
});

describe("V. Pseudo-locale", () => {
  it("V1 pseudo-localises every key including ICU-escaped literals and apostrophes", () => {
    const dir = project({
      "package.json": nextIntlPkg,
      "messages/en.json": JSON.stringify({ a: "Don't panic", b: "Use '{name}' literally", c: "{n, plural, one {# item} other {# items}}", d: "It''s {count} o''clock" }),
    });
    init(dir, ["fr"]);
    const res = generatePseudoLocale(dir);
    const out = JSON.parse(read(dir, "messages/en-x-pseudo.json"));
    console.log(`[V1] generated=${res.keysGenerated}/4 ${JSON.stringify(out)}`);
    expect(res.keysGenerated).toBe(4);
  });
});

describe("W. Scale", () => {
  it("W1 check on a 1,500-file app completes in reasonable time (<20s)", () => {
    const files: Record<string, string> = { "package.json": nextIntlPkg };
    const en: Record<string, string> = {};
    for (let i = 0; i < 1500; i++) {
      en[`p${i}.title`] = `Page ${i}`;
      files[`src/pages/P${i}.tsx`] = `import { useTranslations } from "next-intl";
export function P${i}(){ const t = useTranslations("p${i}"); return <main><h1>{t("title")}</h1><p className="truncate">Static copy ${i} here</p><button>{t("title")}</button></main>; }`;
    }
    files["messages/en.json"] = JSON.stringify(en);
    const dir = project(files);
    init(dir, ["de", "fr", "ja"]);
    const t0 = Date.now();
    const res = runCheck({ rootDir: dir });
    const ms = Date.now() - t0;
    console.log(`[W1] 1500 files, ${res.errorCount} errors, ${ms} ms`);
    expect(ms).toBeLessThan(20000);
  });
});
