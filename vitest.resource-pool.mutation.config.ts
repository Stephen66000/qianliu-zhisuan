import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@qianliu/database": fileURLToPath(new URL("./packages/database/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["apps/gateway/src/__tests-integration__/w11-resource-pool.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
