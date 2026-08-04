import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/upstream-timeout-policy.test.ts",
      "src/upstream-caller-factory.test.ts",
      "src/upstream-failover-policy.test.ts",
    ],
  },
});
