import { defineConfig } from "vitest/config";

// Independent adversarial audit suite. Each test asserts the behaviour the
// documentation promises; a FAILING test is a confirmed defect.
// Run: npx vitest run --config audit/vitest.config.ts
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["audit/tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
