import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/__tests-integration__/w05-northbound.test.ts",
      "src/__tests-integration__/w18-quota-pipeline.test.ts",
      "src/__tests-integration__/pool043-operating-bill-settlement.test.ts",
      "src/pipeline/attempt-usage-settlement.test.ts",
      "src/pipeline/billing.pool043.test.ts",
      "src/pipeline/request-model-identity.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/pool043-gateway",
      include: [
        "src/auth/principal-auth.ts",
        "src/auth/current-model-authorization.ts",
        "src/pipeline/attempt-usage-settlement.ts",
        "src/pipeline/pricing-evidence.ts",
        "src/pipeline/request-model-identity.ts",
        "src/pipeline/revoked-attempt-settlement.ts",
        "src/routes/models.ts",
      ],
      thresholds: { statements: 95, branches: 85, functions: 90, lines: 95 },
    },
  },
});
