import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/directory/excel.test.ts",
      "src/department-costs/contracts.test.ts",
    ],
  },
});
