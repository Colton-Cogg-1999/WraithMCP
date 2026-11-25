import { detectProjectAdapter } from "../adapters/registry.js";
import { scanDocumentsInProject } from "../documents/registry.js";
import { runCheck } from "./check.js";
import { registerDocumentScannerHook } from "./scan.js";
import { registerStatusHooks } from "./status.js";

let bootstrapped = false;

export function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  registerDocumentScannerHook((rootDir, docPaths) =>
    scanDocumentsInProject(rootDir, docPaths)
  );

  registerStatusHooks({
    detectProject: (rootDir, configFramework, localesPath) =>
      detectProjectAdapter(rootDir, configFramework, localesPath),
    runQuickCheck: (rootDir) => {
      const res = runCheck({ rootDir, limit: 1 });
      return {
        outcome: res.outcome,
        passed: res.passed,
        errorCount: res.errorCount,
        warningCount: res.warningCount,
        orphanedKeys: res.metrics.orphanedKeys,
        staleByLocale: res.metrics.staleByLocale,
        contextChangedByLocale: res.metrics.contextChangedByLocale,
        missingByLocale: res.metrics.missingByLocale,
        extraByLocale: res.metrics.extraByLocale,
        totalSourceKeys: res.totalSourceKeys,
        translatedByLocale: res.metrics.translatedByLocale,
        detectedLocales: res.metrics.detectedLocales,
      };
    },
  });
}
