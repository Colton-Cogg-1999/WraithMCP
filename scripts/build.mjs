import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";

const distDir = path.resolve("dist");
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// 1. Emit TypeScript declaration files (.d.ts)
execFileSync(path.resolve("node_modules/.bin/tsc"), ["--emitDeclarationOnly"], {
  stdio: "inherit",
});

// 2. Bundle ESM library + CLI entrypoint for npm distribution
await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
});

await esbuild.build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/bin.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
});

fs.chmodSync(path.join(distDir, "bin.js"), 0o755);
console.log("Built dist/index.js, dist/bin.js, and TypeScript declarations.");
