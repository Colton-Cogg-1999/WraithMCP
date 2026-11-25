import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  WraithStore,
  computeContextFingerprint,
  initProject,
  getProjectStatus,
  getLocaleConventions,
  createWraithMcpServer,
} from "../src/index.js";

const tmpDirs: string[] = [];

function makeTempDir(prefix = "wraith-test-"): string {
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

describe("Milestone 1: Skeleton, Store, Init, Status & MCP Server", () => {
  it("initializes .wraith/, AGENTS.md rule, and pre-commit hook", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });

    const res = initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "fr", "zh-Hans"],
      installHook: true,
    });

    expect(res.created).toBe(true);
    expect(fs.existsSync(path.join(dir, ".wraith", "config.json"))).toBe(true);
    expect(res.agentFilesUpdated).toContain("AGENTS.md");
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toContain(
      "Localization is not done until `wraith check` passes."
    );
    expect(res.hookInstalled).toBe(".git/hooks/pre-commit");
    expect(fs.existsSync(path.join(dir, ".git", "hooks", "pre-commit"))).toBe(true);

    // Re-running init should be idempotent for AGENTS.md
    const res2 = initProject({ rootDir: dir });
    expect(res2.created).toBe(false);
    expect(res2.agentFilesUpdated).toEqual([]);
  });

  it("reads and writes deterministic sorted .wraith/ files", () => {
    const dir = makeTempDir();
    const store = new WraithStore(dir);

    store.upsertGlossaryEntry({
      term: "Post",
      doNotTranslate: false,
      caseSensitive: false,
      translations: { "zh-Hans": "帖子", "es-MX": "publicación" },
      origin: "user",
    });
    store.upsertGlossaryEntry({
      term: "Acme Pulse",
      doNotTranslate: true,
      caseSensitive: true,
      translations: {},
      origin: "inferred",
    });

    const glossary = store.readGlossary();
    expect(glossary.entries.map((e) => e.term)).toEqual(["Acme Pulse", "Post"]);
    expect(Object.keys(glossary.entries[1].translations)).toEqual(["es-MX", "zh-Hans"]);

    const fp1 = computeContextFingerprint([
      { file: "src/Menu.tsx", line: 10, component: "Menu", element: "button", surrounding: ["File", "Save"] },
    ]);
    const fp2 = computeContextFingerprint([
      { file: "src/Menu.tsx", line: 99, component: "Menu", element: "button", surrounding: ["Save", "File"] },
    ]);
    const fp3 = computeContextFingerprint([
      { file: "src/Banner.tsx", line: 10, component: "StoreHours", element: "span", surrounding: ["9am-5pm"] },
    ]);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);

    const added = store.appendMemory([
      {
        sourceLocale: "en",
        targetLocale: "es-MX",
        source: "Save changes",
        target: "Guardar cambios",
        origin: "apply",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        sourceLocale: "en",
        targetLocale: "es-MX",
        source: "Save changes",
        target: "Guardar cambios",
        origin: "apply",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(added).toBe(1);
    expect(store.readMemory()).toHaveLength(1);
  });

  it("computes accurate locale conventions via Intl.PluralRules", () => {
    const en = getLocaleConventions("en");
    expect(en.pluralCategories).toEqual(["one", "other"]);
    expect(en.direction).toBe("ltr");

    const ru = getLocaleConventions("ru");
    expect(ru.pluralCategories).toEqual(expect.arrayContaining(["one", "few", "many"]));

    const ar = getLocaleConventions("ar");
    expect(ar.direction).toBe("rtl");
    expect(ar.pluralCategories).toEqual(
      expect.arrayContaining(["zero", "one", "two", "few", "many", "other"])
    );

    const zh = getLocaleConventions("zh-Hans");
    expect(zh.isCjk).toBe(true);
    expect(zh.pluralCategories).toEqual(["other"]);
  });

  it("reports project status and creates MCP server instance", () => {
    const dir = makeTempDir();
    initProject({
      rootDir: dir,
      sourceLocale: "en",
      targetLocales: ["es-MX", "fr"],
    });

    const st = getProjectStatus(dir);
    expect(st.initialized).toBe(true);
    expect(st.sourceLocale).toBe("en");
    expect(st.targetLocales).toEqual(["es-MX", "fr"]);
    expect(st.checkPassed).toBe(true);

    const mcp = createWraithMcpServer({ rootDir: dir });
    expect(mcp).toBeDefined();
  });
});
