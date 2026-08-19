import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/repositories/operating-bill-account-aggregate.test.ts",
      "src/repositories/operating-bill-cost-quality.test.ts",
      "src/repositories/gateway-ledger-settlement-quality.test.ts",
      "src/repositories/operating-bill-concurrency.test.ts",
      "src/repositories/operating-bill-write-barrier.test.ts",
      "src/repositories/monthly-operating-cost.test.ts",
      "src/repositories/dispatch-policy-clone.test.ts",
      "src/__tests-integration__/pool043-operating-bill-concurrency.integration.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
