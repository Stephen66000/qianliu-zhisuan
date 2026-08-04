import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "packages/database/src/repositories/employee-model-authorization-policy.test.ts",
      "packages/database/src/__tests-integration__/pool029-authorization-rule-migration.test.ts",
      "apps/control-api/src/__tests-integration__/pool029-employee-model-rules.test.ts",
      "apps/control-api/src/__tests-integration__/w03-key-grant.test.ts",
      "apps/gateway/src/__tests-integration__/w05-northbound.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/pool029-node",
      include: [
        "packages/database/src/repositories/employee-model-authorization-policy.ts",
        "packages/database/src/repositories/employee-model-rule-repository.ts",
        "packages/database/src/repositories/employee-model-rule-validation.ts",
        "packages/database/src/repositories/key-repository.ts",
        "apps/control-api/src/employee-model-rules/routes.ts",
        "apps/gateway/src/routes/models.ts",
      ],
      thresholds: { statements: 0, branches: 0, functions: 0, lines: 0 },
    },
  },
});
