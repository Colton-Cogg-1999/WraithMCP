import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject, withWorkspaceLock } from "../src/index.js";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-lock-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Workspace exclusive lock (N1)", () => {
  it("supports same-process re-entrancy and releases lock file cleanly", () => {
    const dir = mkTmp();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const lockFile = path.join(dir, ".polyglot", ".lock");

    const val = withWorkspaceLock(dir, () => {
      expect(fs.existsSync(lockFile)).toBe(true);
      return withWorkspaceLock(dir, () => 42);
    });
    expect(val).toBe(42);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("recovers stale locks left behind by crashed processes (dead PID or old mtime)", () => {
    const dir = mkTmp();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const lockFile = path.join(dir, ".polyglot", ".lock");

    // Simulate crashed process lock with an old timestamp and nonexistent PID
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 10_000 }) + "\n");
    const past = new Date(Date.now() - 2000);
    fs.utimesSync(lockFile, past, past);

    const recovered = withWorkspaceLock(dir, () => "acquired", { timeoutMs: 2000, staleMs: 30_000 });
    expect(recovered).toBe("acquired");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("times out with an actionable error when a fresh live lock is held", () => {
    const dir = mkTmp();
    initProject({ rootDir: dir, sourceLocale: "en", targetLocales: ["de"], writeAgentRule: false });
    const lockFile = path.join(dir, ".polyglot", ".lock");

    // Simulate active lock held by current live PID (different process simulation via file)
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n");
    expect(() =>
      withWorkspaceLock(dir, () => "never", { timeoutMs: 120, staleMs: 60_000 })
    ).toThrow(/Timed out.*lock/i);
    fs.unlinkSync(lockFile);
  });
});
