import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { ensureBootstrapped, initProject } from "../src/index.js";

ensureBootstrapped();

const created: string[] = [];
afterAll(() => {
  if (process.env.AUDIT_KEEP) return;
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

/** Create an isolated temp project from a map of relative path -> contents. */
export function project(files: Record<string, string | Uint8Array>, opts?: { prefix?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), opts?.prefix ?? "wraith-audit-"));
  created.push(dir);
  writeFiles(dir, files);
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string | Uint8Array>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export function read(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

export function init(dir: string, targets: string[], source = "en"): void {
  initProject({ rootDir: dir, sourceLocale: source, targetLocales: targets, writeAgentRule: false });
}

export const nextIntlPkg = JSON.stringify({
  name: "app",
  dependencies: { next: "15.0.0", react: "19.0.0", "next-intl": "4.0.0" },
});
export const i18nextPkg = JSON.stringify({
  name: "app",
  dependencies: { react: "19.0.0", "react-i18next": "15.0.0", i18next: "24.0.0" },
});
