// V14-C6 G02 复跑临时配置（审计后删除副本归档于证据目录）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/components/dashboard/standard-home-model.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
