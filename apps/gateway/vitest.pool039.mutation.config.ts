import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/auth/current-model-authorization.mutation.test.ts",
      "src/__tests-integration__/w10-kimi-e2e.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
