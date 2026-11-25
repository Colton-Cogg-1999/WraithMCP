#!/usr/bin/env node
/**
 * Milestone 6 Demo: Scanning and validating Vue/Nuxt, SvelteKit, Rails, and Django fixtures.
 * Run with: npx tsx examples/06-frameworks-demo.mjs
 */
import path from "node:path";
import { ensureBootstrapped, scanProject } from "../src/index.ts";

ensureBootstrapped();

console.log("=== Milestone 6: Multi-Framework Scan Demo ===\n");
for (const name of ["nextjs-app", "vue-app", "sveltekit-app", "rails-app", "django-app"]) {
  const res = scanProject({ rootDir: path.resolve("fixtures", name), saveUsage: false });
  console.log(
    `● ${name.padEnd(14)} → ${res.framework} (${res.i18nLibrary ?? "none"}) · ${res.sourceKeys} keys · ${res.counts.hardcodedStrings} hardcoded · ${res.counts.concatenations} concats · ${res.counts.trackedKeys} tracked`
  );
}
