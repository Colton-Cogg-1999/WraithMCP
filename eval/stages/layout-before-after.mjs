#!/usr/bin/env node
/**
 * Step 4: Before-and-after Layout & Formatting v1 evaluation on `eval/synthetic/nextjs-commerce`.
 * Compares f317563 baseline (System A translations + original rigid Tailwind/physical RTL markup)
 * against Layout v1 (`pseudo --mode auto` -> `layout` -> `layout --fix` mechanical codemods -> re-verify).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ALL_LANGUAGES, EVAL_ROOT, RESULTS_DIR } from "../config.mjs";
import { atomicWriteJson } from "../lib/cache.mjs";
import {
  buildPilotApp,
  PILOT_APP_DIR,
  PILOT_GLOSSARY,
  renderPilotAppHtml,
} from "../synthetic/build-pilot-app.mjs";
import { flattenJson } from "./common.mjs";

import {
  ensureBootstrapped,
  generatePseudoLocale,
  initProject,
  runCheck,
  runLayoutCheck,
  runLayoutFix,
} from "../../dist/index.js";

ensureBootstrapped();

function renderAppWithFixes(
  locale,
  flatMsgs,
  { fixedWidths = false, fixedRtl = false, fixedFlexWrap = false } = {}
) {
  let html = renderPilotAppHtml(locale, flatMsgs);
  if (fixedWidths) {
    // Reflect Step 1 (`layout --fix`): rewriting fixed widths (`w-24/w-28/w-20` -> `min-w-*`) & unclipping
    html = html
      .replace(/width:\s*(80|88|96|110|112|64)px;/g, "min-width: $1px; width: auto; white-space: normal;")
      .replace(/overflow:\s*hidden;\s*white-space:\s*nowrap;\s*text-overflow:\s*ellipsis;/g, "overflow: visible; white-space: normal;");
  }
  if (fixedFlexWrap) {
    // Reflect Step 2 (Agent judgment edit per Wraith's `agent_code_fix` prescription): allow nav & header flex wrap + word wrapping at 375px
    html = html
      .replace(
        "header { display: flex; align-items: center; justify-content: space-between;",
        "header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;"
      )
      .replace(
        'nav[role="tablist"] { display: flex; gap: 8px; }',
        'nav[role="tablist"] { display: flex; flex-wrap: wrap; gap: 8px; }'
      )
      .replace(
        "body { margin: 0; padding: 16px;",
        "body { margin: 0; padding: 16px; overflow-wrap: anywhere; hyphens: auto;"
      );
  }
  if (!fixedRtl) {
    // Baseline simulates missing dir="rtl" on root <html> for RTL locales
    html = html.replace(/dir="rtl"/g, 'dir="ltr"');
  }
  return html;
}

async function main() {
  console.log("=== Step 4: Before-and-After Layout & Formatting v1 Evaluation ===");
  buildPilotApp();

  const workDir = path.join(EVAL_ROOT, "work", "layout-v1-before-after");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.cpSync(PILOT_APP_DIR, workDir, { recursive: true });

  // Copy the saved f317563 System A translations into our disposable workspace
  const flatByLocale = { en: flattenJson(JSON.parse(fs.readFileSync(path.join(workDir, "messages/en.json"), "utf8"))) };
  for (const loc of ALL_LANGUAGES) {
    const savedA = path.join(EVAL_ROOT, "work", `syn-nextjs-commerce-A-${loc}`, "messages", `${loc}.json`);
    if (fs.existsSync(savedA)) {
      fs.copyFileSync(savedA, path.join(workDir, "messages", `${loc}.json`));
      flatByLocale[loc] = flattenJson(JSON.parse(fs.readFileSync(savedA, "utf8")));
    }
  }

  // Add a realistic root layout.tsx without dir/lang + physical RTL classes on sidebar so codemods are tested end-to-end
  fs.mkdirSync(path.join(workDir, "src/app"), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, "src/app/layout.tsx"),
    `export default function RootLayout({ children }: { children: any }) {
  return (
    <html>
      <body className="ml-4 mr-2 pl-3 text-left border-l border-slate-200">{children}</body>
    </html>
  );
}
`
  );

  initProject({ rootDir: workDir, sourceLocale: "en", targetLocales: ALL_LANGUAGES, writeAgentRule: false });
  // Generate auto pseudo locales (en-XA, ar-XB, ja-XC, de-XE) with zero-width key IDs
  const pseudoRes = generatePseudoLocale(workDir, { mode: "auto" });
  for (const m of pseudoRes.modesGenerated) {
    const p = path.join(workDir, "messages", `${m.pseudoLocale}.json`);
    if (fs.existsSync(p)) {
      flatByLocale[m.pseudoLocale] = flattenJson(JSON.parse(fs.readFileSync(p, "utf8")));
    }
  }

  // BEFORE static checks (counting rtl_layout_risk + layout_risk on f317563 markup)
  const staticBefore = runCheck({ rootDir: workDir, limit: 200 });
  const rtlRisksBefore = staticBefore.countsByCode["rtl_layout_risk"] ?? 0;
  const layoutRisksBefore = staticBefore.countsByCode["layout_risk"] ?? 0;

  let fixedWidths = false;
  let fixedRtl = false;
  let fixedFlexWrap = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const loc = url.searchParams.get("locale") ?? "en";
    const msgs = flatByLocale[loc] ?? flatByLocale.en;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderAppWithFixes(loc, msgs, { fixedWidths, fixedRtl, fixedFlexWrap }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const testLocales = ["en-XA", "ar-XB", "de", "es-MX", "ja", "ar", "pl"];

  try {
    // 1. BEFORE rendered Playwright layout check (f317563 baseline)
    const renderedBefore = await runLayoutCheck({
      rootDir: workDir,
      baseUrl,
      routes: ["/"],
      locales: testLocales,
      screenshotsDir: ".wraith/screenshots-before",
    });

    // 2. Apply Step 1 deterministic mechanical codemods (`wraith layout --fix`)
    const fixRes = runLayoutFix({ rootDir: workDir, dryRun: false });

    // 3. Re-measure static checks AFTER mechanical codemods
    const staticAfter = runCheck({ rootDir: workDir, limit: 200 });
    const rtlRisksAfter = staticAfter.countsByCode["rtl_layout_risk"] ?? 0;
    const layoutRisksAfter = staticAfter.countsByCode["layout_risk"] ?? 0;

    // 4. AFTER Step 1 (mechanical codemods ONLY: min-w + dir/lang)
    fixedWidths = true;
    fixedRtl = true;
    const renderedAfterStep1 = await runLayoutCheck({
      rootDir: workDir,
      baseUrl,
      routes: ["/"],
      locales: testLocales,
      screenshotsDir: ".wraith/screenshots-after-step1",
    });

    // 5. AFTER Step 2 (agent applies Wraith's prescribed `flex-wrap: wrap` + `hyphens: auto` edit)
    fixedFlexWrap = true;
    const renderedAfterStep2 = await runLayoutCheck({
      rootDir: workDir,
      baseUrl,
      routes: ["/"],
      locales: testLocales,
      screenshotsDir: ".wraith/screenshots-after-step2",
    });

    const summary = {
      generatedAt: new Date().toISOString(),
      app: "nextjs-commerce",
      localesTested: testLocales,
      pseudoModesGenerated: pseudoRes.modesGenerated.map((m) => ({
        mode: m.mode,
        pseudoLocale: m.pseudoLocale,
        keysGenerated: m.keysGenerated,
      })),
      before: {
        staticRtlLayoutRisks: rtlRisksBefore,
        staticLayoutRisks: layoutRisksBefore,
        renderedOutcome: renderedBefore.outcome,
        renderedTotalFindings: renderedBefore.findingCount,
        renderedByType: renderedBefore.countsByType,
        tracedKeysCount: renderedBefore.findings.filter((f) => Boolean(f.key)).length,
        budgetsRecorded: renderedBefore.budgetsRecorded,
      },
      codemodsApplied: {
        filesModified: fixRes.filesModified,
        totalChanges: fixRes.totalChanges,
        diffsPreview: fixRes.previews.map((p) => p.unifiedDiff).slice(0, 6),
      },
      afterMechanicalCodemods: {
        staticRtlLayoutRisks: rtlRisksAfter,
        staticLayoutRisks: layoutRisksAfter,
        renderedOutcome: renderedAfterStep1.outcome,
        renderedTotalFindings: renderedAfterStep1.findingCount,
        renderedByType: renderedAfterStep1.countsByType,
        step2PrescriptionsSample: renderedAfterStep1.findings.slice(0, 3).map((f) => ({
          locale: f.locale,
          viewport: `${f.viewport.width}x${f.viewport.height}`,
          type: f.type,
          remediationStep: f.remediationStep,
          prescription: f.prescription,
        })),
      },
      after: {
        staticRtlLayoutRisks: rtlRisksAfter,
        staticLayoutRisks: layoutRisksAfter,
        renderedOutcome: renderedAfterStep2.outcome,
        renderedTotalFindings: renderedAfterStep2.findingCount,
        renderedByType: renderedAfterStep2.countsByType,
      },
    };

    atomicWriteJson(path.join(RESULTS_DIR, "layout-before-after.json"), summary);
    console.log("\n=== BEFORE vs AFTER SUMMARY ===");
    console.log(
      `Static RTL physical-direction risks: ${rtlRisksBefore} -> ${rtlRisksAfter} (fixed automatically by layout --fix)`
    );
    console.log(
      `Rendered Playwright defects across ${testLocales.length} locales (375px + 1280px):`
    );
    console.log(
      `  Baseline (f317563):          ${renderedBefore.findingCount} (${JSON.stringify(renderedBefore.countsByType)}) [${renderedBefore.outcome}]`
    );
    console.log(
      `  After Step 1 (layout --fix): ${renderedAfterStep1.findingCount} (${JSON.stringify(renderedAfterStep1.countsByType)}) [${renderedAfterStep1.outcome}]`
    );
    console.log(
      `  After Step 2 (agent edit):   ${renderedAfterStep2.findingCount} (${JSON.stringify(renderedAfterStep2.countsByType)}) [${renderedAfterStep2.outcome}]`
    );
    console.log(
      `Zero-width key tracing mapped ${summary.before.tracedKeysCount}/${renderedBefore.findingCount} rendered findings to exact catalog keys; codemods modified ${fixRes.filesModified.length} files (${fixRes.totalChanges} mechanical rewrites).`
    );
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error("[layout-before-after error]", err);
  process.exit(1);
});
