#!/usr/bin/env node
/**
 * Milestone 2 Demo: Full Next.js first-run flow reproducing scan -> prepare -> apply -> check -> fix -> report.
 * Run with: npx tsx examples/02-nextjs-demo.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyTranslations,
  ensureBootstrapped,
  generatePseudoLocale,
  generateReport,
  initProject,
  PolyglotStore,
  prepareBatch,
  runCheck,
  scanProject,
} from "../src/index.ts";

ensureBootstrapped();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "polyglot-demo-02-"));
try {
  fs.cpSync(path.resolve("fixtures/nextjs-app"), tmp, { recursive: true });

  console.log("=== Milestone 2: Next.js First-Run Demo ===\n");
  initProject({ rootDir: tmp, sourceLocale: "en", targetLocales: ["es-MX"], writeAgentRule: false });

  const scan = scanProject({ rootDir: tmp });
  console.log(
    `● polyglot.scan → ${scan.framework}, ${scan.i18nLibrary ?? "no i18n"} · ${scan.counts.hardcodedStrings} hardcoded strings · ${scan.counts.concatenations} concatenations`
  );

  const store = new PolyglotStore(tmp);
  store.upsertGlossaryEntry({
    term: "Acme Pulse",
    doNotTranslate: true,
    caseSensitive: true,
    translations: {},
    origin: "inferred",
  });
  store.addAssumption({ category: "brand", summary: 'Kept "Acme Pulse" untranslated.' });
  store.addAssumption({ category: "tone", locale: "es-MX", summary: 'Used informal "tú" register for es-MX.' });

  const prep = prepareBatch({ rootDir: tmp, targetLocale: "es-MX" });
  console.log(`● polyglot.prepare → ${prep.totalPending} keys ready for es-MX (plurals: ${prep.conventions.pluralCategories.join(", ")})`);

  applyTranslations({
    rootDir: tmp,
    targetLocale: "es-MX",
    translations: [
      { key: "home.title", value: "Bienvenido a Acme Pulse" },
      { key: "home.subtitle", value: "Envía más rápido con tu equipo." },
      {
        key: "home.items",
        value: "{count, plural, one {# elemento en tu bandeja} many {# elementos en tu bandeja} other {# elementos en tu bandeja}}",
      },
      {
        key: "home.roleBadge",
        value: "{role, select, admin {Administrador ({count, plural, one {# asiento} many {# asientos} other {# asientos}})} other {Miembro}}",
      },
      { key: "feed.postHeading", value: "Entrada" },
      { key: "feed.postAction", value: "Publicar" },
      { key: "feed.openMenu", value: "Abrir" },
      { key: "legacy.unusedBanner", value: "La oferta termina el viernes" },
    ],
  });

  const before = runCheck({ rootDir: tmp });
  console.log(`● polyglot.check (before refactor) → ${before.errorCount} errors, ${before.warningCount} warnings`, before.countsByCode);

  const pseudo = generatePseudoLocale(tmp);
  console.log(`● polyglot.pseudo → generated ${pseudo.keysGenerated} keys in ${pseudo.filesWritten.join(", ")}`);

  const report = generateReport(tmp);
  console.log("\n" + report.markdown);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
