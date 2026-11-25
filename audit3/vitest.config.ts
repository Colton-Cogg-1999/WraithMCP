import { defineConfig } from "vitest/config";
// Third independent audit (remediation round 2, f317563). FAILING test = confirmed defect.
// Run: npx vitest run --config audit3/vitest.config.ts
export default defineConfig({
  test: { globals: false, environment: "node", include: ["audit3/tests/**/*.test.ts"], testTimeout: 120000 },
});
