import { defineConfig } from "vitest/config";
// Second independent audit (remediation commit 0eb5251). FAILING test = confirmed defect.
// Run: npx vitest run --config audit2/vitest.config.ts
export default defineConfig({
  test: { globals: false, environment: "node", include: ["audit2/tests/**/*.test.ts"], testTimeout: 120000 },
});
