import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDocumentTranslations,
  applyTranslations,
  createPolyglotMcpServer,
  DocxDocumentAdapter,
  ensureBootstrapped,
  exportEscalation,
  importEscalationCorrections,
  initProject,
  isValidLocaleTag,
  packageReviewJob,
  parseXlsxBuffer,
  resolveConfinedPath,
  resolveMcpRootDir,
  SecurityBoundaryError,
  validateLocaleTag,
} from "../src/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeDir(prefix = "polyglot-sec-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P0 Security Boundary Regression Suite", () => {
  it("rejects hostile locale strings across all adapters", () => {
    const hostile = [
      "../evil",
      "../../etc/passwd",
      "/tmp/pwned",
      "en/../../evil",
      "de\\evil",
      "en\0de",
      ".",
      "..",
      "C:\\Windows\\System32",
      "fr:evil",
      "not a locale",
      "",
    ];
    for (const bad of hostile) {
      expect(isValidLocaleTag(bad)).toBe(false);
      expect(() => validateLocaleTag(bad)).toThrow(SecurityBoundaryError);
    }
    for (const good of ["en", "es-MX", "zh-Hans", "pt_BR", "en-x-pseudo", "pseudo", "sr-Latn-RS"]) {
      expect(isValidLocaleTag(good)).toBe(true);
    }
  });

  it("blocks nonexistent target paths whose symlinked parent escapes workspace", () => {
    const repo = makeDir("polyglot-repo-");
    const outside = makeDir("polyglot-outside-");
    fs.symlinkSync(outside, path.join(repo, "escape-link"));

    expect(() =>
      resolveConfinedPath(repo, "escape-link/nested/new-file.json")
    ).toThrow(SecurityBoundaryError);
    expect(fs.existsSync(path.join(outside, "nested"))).toBe(false);
  });

  it("blocks MCP rootDir escapes while allowing subdirectories inside launch root", async () => {
    const repo = makeDir("polyglot-mcp-root-");
    const outside = makeDir("polyglot-mcp-outside-");
    fs.mkdirSync(path.join(repo, "sub"), { recursive: true });

    expect(() => resolveMcpRootDir(repo, outside)).toThrow(SecurityBoundaryError);
    expect(() => resolveMcpRootDir(repo, "../outside")).toThrow(SecurityBoundaryError);
    expect(resolveMcpRootDir(repo, "sub")).toBe(fs.realpathSync(path.join(repo, "sub")));

    const server = createPolyglotMcpServer({ rootDir: repo });
    const client = new Client({ name: "sec-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const res: any = await client.callTool({ name: "status", arguments: { rootDir: outside } });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("leaves zero files or state mutations on rejected apply/review/escalate/document writes", () => {
    const repo = makeDir();
    const outside = makeDir();
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(repo, "messages"), { recursive: true });
    fs.writeFileSync(path.join(repo, "messages/en.json"), JSON.stringify({ hello: "Hello" }));
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/a.md"), "# Hello\n");
    initProject({ rootDir: repo, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });

    const beforeCfg = fs.readFileSync(path.join(repo, ".polyglot/config.json"), "utf8");

    const badApply = applyTranslations({
      rootDir: repo,
      targetLocale: "../outside",
      translations: [{ key: "hello", value: "Hallo" }],
    });
    expect(badApply.ok).toBe(false);
    expect(fs.readFileSync(path.join(repo, ".polyglot/config.json"), "utf8")).toBe(beforeCfg);

    expect(() => packageReviewJob(repo, { targetLocale: "de", outputPath: path.join(outside, "x.json") })).toThrow(SecurityBoundaryError);
    expect(() => exportEscalation(repo, { outputDir: path.join(outside, "esc") })).toThrow(SecurityBoundaryError);
    expect(() => importEscalationCorrections(repo, path.join(outside, "evil.csv"))).toThrow(SecurityBoundaryError);

    const badDoc = applyDocumentTranslations(repo, {
      sourceFile: "docs/a.md",
      targetFile: path.join(outside, "a.md"),
      targetLocale: "de",
      updates: [{ id: "md-1", text: "Hallo" }],
    });
    expect(badDoc.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, "a.md"))).toBe(false);
  });

  it("rejects zip bombs in both DOCX and XLSX before allocating huge buffers", () => {
    const huge = new Uint8Array(120 * 1024 * 1024);
    const bomb = zipSync({ "word/document.xml": huge, "[Content_Types].xml": strToU8("<Types/>") }, { level: 9 });
    const repo = makeDir();
    fs.writeFileSync(path.join(repo, "bomb.docx"), bomb);

    expect(() => new DocxDocumentAdapter().extract(path.join(repo, "bomb.docx"))).toThrow(SecurityBoundaryError);
    expect(() => parseXlsxBuffer(bomb)).toThrow(SecurityBoundaryError);
  });

  it("refuses symlinked .git/hooks, dangling AGENTS.md symlinks, and symlinked .polyglot directories (B6, B7)", () => {
    // 1. Symlinked .git/hooks pointing outside workspace
    const repo1 = makeDir("polyglot-hook-sym-");
    const outsideHooks = makeDir("polyglot-outside-hooks-");
    fs.mkdirSync(path.join(repo1, ".git"), { recursive: true });
    fs.symlinkSync(outsideHooks, path.join(repo1, ".git", "hooks"));
    expect(() =>
      initProject({ rootDir: repo1, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false, installHook: true })
    ).toThrow(SecurityBoundaryError);
    expect(fs.readdirSync(outsideHooks)).toEqual([]);

    // 2. Dangling symlink AGENTS.md pointing to non-existent outside path
    const repo2 = makeDir("polyglot-dangling-");
    const outsideDir = makeDir("polyglot-outside-dangling-");
    const danglingTarget = path.join(outsideDir, "would-be-created.txt");
    fs.symlinkSync(danglingTarget, path.join(repo2, "AGENTS.md"));
    expect(() =>
      initProject({ rootDir: repo2, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: true })
    ).toThrow(SecurityBoundaryError);
    expect(fs.existsSync(danglingTarget)).toBe(false);

    // 3. Symlinked .polyglot/ pointing outside workspace
    const repo3 = makeDir("polyglot-store-sym-");
    const outsideStore = makeDir("polyglot-outside-store-");
    fs.symlinkSync(outsideStore, path.join(repo3, ".polyglot"));
    expect(() =>
      initProject({ rootDir: repo3, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false })
    ).toThrow(SecurityBoundaryError);
    expect(fs.readdirSync(outsideStore)).toEqual([]);
  });
});
