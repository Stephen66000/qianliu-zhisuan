import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@qianliu/database": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/repositories/operating-bill-account-aggregate.test.ts",
      "src/repositories/operating-bill-cost-quality.test.ts",
      "src/repositories/gateway-ledger-settlement-quality.test.ts",
      "src/repositories/gateway-ledger-cost-status.test.ts",
      "src/repositories/gateway-ledger-terminal-contract.test.ts",
      "src/repositories/operating-bill-concurrency.test.ts",
      "src/repositories/operating-bill-write-barrier.test.ts",
      "src/repositories/monthly-operating-cost.test.ts",
      "src/repositories/dispatch-policy-clone.test.ts",
      "src/__tests-integration__/pool043-operating-bill-concurrency.integration.test.ts",
      "src/__tests-integration__/employee-monthly-quota.integration.test.ts",
      "src/__tests-integration__/gateway-compat-cost-status.integration.test.ts",
      "src/__tests-integration__/gateway-zero-priced-cost-status.integration.test.ts",
      "src/__tests-integration__/pool048-upstream-error-evidence.integration.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
