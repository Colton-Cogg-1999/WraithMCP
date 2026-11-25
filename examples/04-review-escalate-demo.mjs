#!/usr/bin/env node
/**
 * Milestone 4 Demo: Cross-model MQM review packaging/ingestion, human escalation (CSV/XLSX/HTML),
 * advisory 100% memory matches, and pseudo-locale layout QA hotspots.
 * Run with: npx tsx examples/04-review-escalate-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTranslations,
  ensureBootstrapped,
  exportEscalation,
  generatePseudoLocale,
  importEscalationCorrections,
  ingestReviewResults,
  initProject,
  packageReviewJob,
  scanProject,
} from "../src/index.ts";

ensureBootstrapped();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-demo-04-"));
try {
  fs.cpSync(path.resolve("fixtures/nextjs-app"), tmp, { recursive: true });
  initProject({ rootDir: tmp, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
  scanProject({ rootDir: tmp });

  applyTranslations({
    rootDir: tmp,
    targetLocale: "es-MX",
    translations: [
      { key: "home.title", value: "Bienvenido a Acme Pulse" },
      { key: "feed.postHeading", value: "Entrada" },
      { key: "feed.openMenu", value: "Abrir" },
    ],
  });

  console.log("=== Milestone 4: Review & Escalation Demo ===\n");
  const pkg = packageReviewJob(tmp, { targetLocale: "es-MX", outputPath: ".wraith/review-job.json" });
  console.log(`Packaged MQM review job: ${pkg.items.length} strings -> ${pkg.outputPath}`);

  const ingest = ingestReviewResults(tmp, {
    reviewer: "gemini-cli",
    targetLocale: "es-MX",
    findings: [
      {
        key: "feed.postHeading",
        category: "terminology",
        severity: "major",
        explanation: "Prefer 'Publicación' for feed post headings.",
        suggestion: "Publicación",
        verified: true,
      },
      {
        key: "home.title",
        category: "style",
        severity: "minor",
        explanation: "Optional rewording (filtered false positive).",
        verified: false,
      },
    ],
  });
  console.log("Ingested review:", ingest);

  const esc = exportEscalation(tmp);
  console.log("Exported human review files:", esc.filesWritten);

  const correctionsFile = path.join(tmp, "corrections.json");
  fs.writeFileSync(
    correctionsFile,
    JSON.stringify([{ locale: "es-MX", key: "feed.postHeading", corrected_translation: "Publicación" }]),
    "utf8"
  );
  const imported = importEscalationCorrections(tmp, correctionsFile);
  console.log("Imported human corrections:", imported);

  const pseudo = generatePseudoLocale(tmp);
  console.log("Pseudo-locale QA checklist:", pseudo.qaChecklist);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
