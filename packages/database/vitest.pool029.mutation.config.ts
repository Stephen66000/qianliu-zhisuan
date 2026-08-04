import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/repositories/employee-model-authorization-policy.test.ts"],
  },
});
