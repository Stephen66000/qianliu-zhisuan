import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/repositories/monthly-operating-cost.test.ts",
      "src/repositories/operating-bill-monthly-cost.test.ts",
      "src/repositories/usage-quality.test.ts",
      "src/repositories/dispatch-policy-clone.test.ts",
    ],
    coverage: { enabled: false },
  },
});
