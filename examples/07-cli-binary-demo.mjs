#!/usr/bin/env node
/**
 * Milestone 7 Demo: Run the compiled standalone executable against fixtures/nextjs-app.
 * Run with: node examples/07-cli-binary-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ext = process.platform === "win32" ? ".exe" : "";
const binPath = path.resolve("release", `polyglot-${process.platform}-${process.arch}${ext}`);
const target = fs.existsSync(binPath) ? binPath : process.execPath;
const baseArgs = fs.existsSync(binPath) ? [] : [path.resolve("dist/bin.js")];

console.log(`=== Milestone 7: Packaged Binary Demo (${path.basename(binPath)}) ===\n`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-demo-07-"));
try {
  fs.cpSync(path.resolve("fixtures/nextjs-app"), tmp, { recursive: true });
  const scanOut = execFileSync(target, [...baseArgs, "-C", tmp, "scan"], { encoding: "utf8" });
  console.log(scanOut.trim());

  const statusOut = execFileSync(target, [...baseArgs, "-C", tmp, "status"], { encoding: "utf8" });
  console.log("\n" + statusOut.trim());
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
