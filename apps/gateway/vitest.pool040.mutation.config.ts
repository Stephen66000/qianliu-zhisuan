import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/pipeline/revoked-attempt-settlement.mutation.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/pool040-gateway",
      include: ["src/pipeline/revoked-attempt-settlement.ts"],
      thresholds: { statements: 95, branches: 85, functions: 90, lines: 95 },
    },
  },
});
