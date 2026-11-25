import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";

const releaseDir = path.resolve("release");
fs.mkdirSync(releaseDir, { recursive: true });

const cjsBundle = path.join(releaseDir, "polyglot.cjs");

// @vue/compiler-sfc bundles `consolidate`, which has optional require() calls for
// unused template engines (velocityjs, twig, jade, etc.). Stub those optional deps cleanly.
const optionalVuePeerPlugin = {
  name: "stub-optional-vue-peers",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (
        args.importer.includes("@vue/compiler-sfc") &&
        !args.path.startsWith(".") &&
        !args.path.startsWith("node:") &&
        !fs.existsSync(path.resolve("node_modules", args.path)) &&
        !["fs", "path", "url", "crypto", "os", "util", "stream", "events", "buffer", "assert", "module", "vm"].includes(
          args.path
        )
      ) {
        return { path: args.path, namespace: "optional-stub" };
      }
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: "optional-stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/bin.ts"],
  outfile: cjsBundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  plugins: [optionalVuePeerPlugin],
  define: {
    "import.meta.url": "undefined",
  },
});

// Strip duplicate shebang if present
const raw = fs.readFileSync(cjsBundle, "utf8").replace(/^#!.*\n/, "");
fs.writeFileSync(cjsBundle, raw, "utf8");

const ext = process.platform === "win32" ? ".exe" : "";
const outBin = path.join(releaseDir, `polyglot-${process.platform}-${process.arch}${ext}`);

const seaConfigPath = path.join(releaseDir, "sea-config.json");
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: cjsBundle,
      output: outBin,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    },
    null,
    2
  ) + "\n",
  "utf8"
);

// Node 25.5+ / 26 natively supports `node --build-sea <config>` with zero external tools!
execFileSync(process.execPath, ["--build-sea", seaConfigPath], { stdio: "inherit" });
if (process.platform !== "win32") {
  fs.chmodSync(outBin, 0o755);
}

const sizeMb = (fs.statSync(outBin).size / (1024 * 1024)).toFixed(1);
console.log(`Built standalone executable: ${outBin} (${sizeMb} MB)`);
