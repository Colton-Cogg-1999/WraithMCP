import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  ensureBootstrapped,
  initProject,
  prepareDocument,
  runCheck,
} from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-docbatch-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P0 Document Batch Safety & Pre-Commit Hook", () => {
  it("preserves all earlier batches when translating a DOCX incrementally and marks document check PASS", () => {
    const dir = makeDir();
    const wNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const paras = Array.from({ length: 40 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i + 1}</w:t></w:r></w:p>`).join("");
    const docx = zipSync({
      "[Content_Types].xml": strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
      "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${wNs}><w:body>${paras}</w:body></w:document>`),
    });
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/manual.docx"), docx);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], documents: ["docs"], writeAgentRule: false });

    // Before translating: check fails (missing_document_translation)
    expect(runCheck({ rootDir: dir }).passed).toBe(false);

    // Batch 1 (first 30 segments)
    const p1 = prepareDocument(dir, { documentPath: "docs/manual.docx", targetLocale: "de", offset: 0 });
    const r1 = applyDocumentTranslations(dir, {
      sourceFile: "docs/manual.docx",
      targetFile: "docs/manual.de.docx",
      targetLocale: "de",
      updates: p1.segments.map((s) => ({ id: s.id, text: s.source.replace("Paragraph", "Absatz") })),
    });
    expect(r1.ok).toBe(true);

    // After batch 1 (30/40): check still fails because 10 segments remain untranslated!
    expect(runCheck({ rootDir: dir }).passed).toBe(false);

    // Batch 2 (remaining 10 segments)
    const p2 = prepareDocument(dir, { documentPath: "docs/manual.docx", targetLocale: "de", offset: 30 });
    const r2 = applyDocumentTranslations(dir, {
      sourceFile: "docs/manual.docx",
      targetFile: "docs/manual.de.docx",
      targetLocale: "de",
      updates: p2.segments.map((s) => ({ id: s.id, text: s.source.replace("Paragraph", "Absatz") })),
    });
    expect(r2.ok).toBe(true);

    const xml = strFromU8(unzipSync(fs.readFileSync(path.join(dir, "docs/manual.de.docx")))["word/document.xml"]);
    expect((xml.match(/Absatz \d+/g) ?? []).length).toBe(40);

    // After batch 2 (40/40): check PASSES!
    const chk = runCheck({ rootDir: dir });
    expect(chk.outcome).toBe("PASS");
    expect(chk.passed).toBe(true);
  });

  it("pre-commit hook executes cleanly in a fresh git repo using POLYGLOT_BIN and omits unsafe fallbacks", () => {
    const dir = makeDir();
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ hi: "Hello" }));
    fs.writeFileSync(path.join(dir, "messages/de.json"), JSON.stringify({ hi: "Hallo" }));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src/App.tsx"),
      `import { useTranslations } from "next-intl"; export function App(){ const t = useTranslations(); return <h1>{t("hi")}</h1>; }\n`
    );
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], installHook: true, writeAgentRule: false });

    const hookText = fs.readFileSync(path.join(dir, ".git/hooks/pre-commit"), "utf8");
    expect(hookText).not.toContain("./dist/bin.js");
    expect(hookText).not.toContain("polyglot-mcp");

    // Create a clean wrapper executable pointing to local dist/bin.js (built in repo)
    const wrapper = path.join(dir, "polyglot-wrapper.sh");
    fs.writeFileSync(wrapper, `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.resolve("dist/bin.js")}" "$@"\n`, { mode: 0o755 });
    fs.chmodSync(wrapper, 0o755);

    execFileSync("git", ["add", "package.json", "messages", "src", ".polyglot"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "test clean commit"], {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, POLYGLOT_BIN: wrapper },
    });
  });
});
