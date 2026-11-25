#!/usr/bin/env node
/**
 * Milestone 3 Demo: Fuzzy memory lookup, TMX/CSV/TBX import, glossary propagation, and context-change detection.
 * Run with: npx tsx examples/03-memory-import-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTranslations,
  ensureBootstrapped,
  importAsset,
  initProject,
  lookupMemory,
  recordGlossaryTerm,
  scanProject,
} from "../src/index.ts";

ensureBootstrapped();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wraith-demo-03-"));
try {
  fs.cpSync(path.resolve("fixtures/nextjs-app"), tmp, { recursive: true });
  initProject({ rootDir: tmp, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });
  scanProject({ rootDir: tmp });

  console.log("=== Milestone 3: Memory, Assets & Glossary Propagation Demo ===\n");

  const tmxFile = path.join(tmp, "memory.tmx");
  fs.writeFileSync(
    tmxFile,
    `<tmx version="1.4"><header srclang="en"/><body><tu><tuv xml:lang="en"><seg>Ship faster with your team.</seg></tuv><tuv xml:lang="es-MX"><seg>Lanza más rápido con tu equipo.</seg></tuv></tu></body></tmx>`,
    "utf8"
  );
  const imp = importAsset(tmp, { file: tmxFile });
  console.log("Imported TMX:", imp);

  const lookup = lookupMemory(tmp, { query: "Ship faster with your whole team.", targetLocale: "es-MX" });
  console.log("Fuzzy match:", lookup.fuzzyMatches);

  applyTranslations({
    rootDir: tmp,
    targetLocale: "es-MX",
    translations: [
      { key: "feed.postHeading", value: "Entrada" },
      { key: "feed.postAction", value: "Publicar" },
    ],
  });

  const prop = recordGlossaryTerm(tmp, {
    term: "Post",
    translations: { "es-MX": "Publicación" },
    notes: "Noun in feed UI",
  });
  console.log("Glossary propagation affected keys:", prop.affectedKeys.map((a) => a.key));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
