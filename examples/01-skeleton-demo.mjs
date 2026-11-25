#!/usr/bin/env node
/**
 * Milestone 1 Demo: Initialize a project with Wraith and inspect status.
 * Run with: npx tsx examples/01-skeleton-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject, getProjectStatus } from "../src/index.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-demo-01-"));
try {
  console.log("=== Milestone 1: Skeleton Demo ===");
  const initRes = initProject({
    rootDir: tmp,
    sourceLocale: "en",
    targetLocales: ["es-MX", "fr", "zh-Hans"],
  });
  console.log("Initialized:", initRes.configPath);
  console.log("Updated agent files:", initRes.agentFilesUpdated);

  const status = getProjectStatus(tmp);
  console.log("Status:", JSON.stringify(status, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
