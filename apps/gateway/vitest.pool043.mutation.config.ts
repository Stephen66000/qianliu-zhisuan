import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/auth/current-model-authorization.mutation.test.ts",
      "src/__tests-integration__/w16-dispatch*.test.ts",
      "src/pipeline/attempt-usage-settlement.test.ts",
      "src/__tests-integration__/employee-monthly-quota.test.ts",
      "src/__tests-integration__/cpqw-quota-window.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
