import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@qianliu/database": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    include: [
      "src/repositories/pool039-repositories.mutation.test.ts",
      "src/repositories/employee-model-rule-repository.mutation.test.ts",
      "src/repositories/principal-access-config-repository.mutation.test.ts",
      "src/repositories/principal-access-locks.mutation.test.ts",
      "src/repositories/employee-model-rule-lifecycle.mutation.test.ts",
      "src/repositories/principal-access-read-model.mutation.test.ts",
      "src/repositories/dashboard-overages.mutation.test.ts",
      "src/__tests-integration__/employee-monthly-quota.integration.test.ts",
    ],
  },
});
