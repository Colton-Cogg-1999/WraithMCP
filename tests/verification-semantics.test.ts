import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBootstrapped, initProject, runCheck, getProjectStatus } from "../src/index.js";

ensureBootstrapped();

const tmpDirs: string[] = [];
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-verif-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("P0 Verification Semantics (PASS / FAIL / INCONCLUSIVE & Read-Only)", () => {
  it("returns INCONCLUSIVE (passed=false) for unsupported/empty project and exits non-zero from CLI", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello world</h1>");
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const res = runCheck({ rootDir: dir });
    expect(res.outcome).toBe("INCONCLUSIVE");
    expect(res.passed).toBe(false);
    expect(res.inconclusiveReasons.length).toBeGreaterThan(0);
    expect(res.disclaimer).toContain("do not guarantee linguistic accuracy");

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/bin.ts"), "-C", dir, "check"], {
        stdio: "pipe",
      });
    } catch (e: any) {
      exitCode = e.status ?? 1;
    }
    expect(exitCode).toBe(2);
  });

  it("isolates malformed locale files without aborting check on sibling locales", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ a: "Hello" }));
    fs.writeFileSync(path.join(dir, "messages/de.json"), '{ "a": "Hallo", }');
    fs.writeFileSync(path.join(dir, "messages/fr.json"), JSON.stringify({ a: "Bonjour" }));
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de", "fr"], writeAgentRule: false });

    const res = runCheck({ rootDir: dir, skipScan: true });
    expect(res.outcome).toBe("FAIL");
    expect(res.countsByCode["locale_parse_error"]).toBe(1);
    expect(res.coverage.parseFailures.length).toBe(1);
    expect(res.countsByLocale["fr"]).toBeUndefined();
  });

  it("keeps check() and status() 100% side-effect free (never creates/modifies .polyglot/usage.json)", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15", react: "19", "next-intl": "4" } }));
    fs.mkdirSync(path.join(dir, "messages"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "messages/en.json"), JSON.stringify({ a: "Hello" }));
    fs.writeFileSync(path.join(dir, "src/App.tsx"), `import { useTranslations } from "next-intl"; export function A(){ const t = useTranslations(); return <p>{t("a")}</p>; }`);
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["fr"], writeAgentRule: false });

    const usagePath = path.join(dir, ".polyglot/usage.json");
    expect(fs.existsSync(usagePath)).toBe(false);
    runCheck({ rootDir: dir });
    getProjectStatus(dir);
    expect(fs.existsSync(usagePath)).toBe(false);
  });
});
