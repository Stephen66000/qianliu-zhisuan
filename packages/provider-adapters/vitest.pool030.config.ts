import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/resource-timeout-policy.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "coverage/pool030-provider",
      include: ["src/resource-timeout-policy.ts"],
    },
  },
});
