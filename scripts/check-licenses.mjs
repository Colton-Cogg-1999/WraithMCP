import fs from "node:fs";
import path from "node:path";

const ALLOWED_TOKENS = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "Zlib",
]);

function isPermissive(expr) {
  if (!expr) return false;
  if (typeof expr === "object") {
    if (expr.type) return isPermissive(expr.type);
    return false;
  }
  const clean = String(expr).replace(/[()]/g, " ").trim();
  // Accept OR expressions if at least one branch is permissive; AND requires all parts permissive
  const orParts = clean.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((p) => isPermissive(p));
  }
  const andParts = clean.split(/\s+AND\s+/i);
  return andParts.every((p) => ALLOWED_TOKENS.has(p.trim()));
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const runtimeRoots = Object.keys(pkg.dependencies ?? {});
const visited = new Set();
const issues = [];
const checked = [];

function checkPackage(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const pkgPath = path.resolve("node_modules", name, "package.json");
  if (!fs.existsSync(pkgPath)) return;
  const meta = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const lic = meta.license ?? (Array.isArray(meta.licenses) ? meta.licenses.map((l) => l.type).join(" OR ") : "");
  checked.push({ name: meta.name, version: meta.version, license: lic });
  if (!isPermissive(lic)) {
    issues.push({ name: meta.name, version: meta.version, license: lic });
  }
  for (const dep of Object.keys(meta.dependencies ?? {})) {
    checkPackage(dep);
  }
}

for (const root of runtimeRoots) {
  checkPackage(root);
}

console.log(`Audited ${checked.length} runtime packages.`);
if (issues.length > 0) {
  console.error("Non-permissive or unrecognized licenses found:", issues);
  process.exit(1);
}
console.log("All runtime dependencies use permissive licenses (MIT/Apache/BSD/ISC).");
