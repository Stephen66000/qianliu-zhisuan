import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/upstream-timeout-policy.test.ts",
      "src/upstream-caller-factory.test.ts",
      "src/upstream-failover-policy.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "coverage/pool030-gateway",
      include: [
        "src/upstream-timeout-policy.ts",
        "src/upstream-caller-factory.ts",
        "src/upstream-failover-policy.ts",
      ],
    },
  },
});
