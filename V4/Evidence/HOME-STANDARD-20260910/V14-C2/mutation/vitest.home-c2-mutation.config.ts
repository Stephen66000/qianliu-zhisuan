// V14-C2 审计临时变异配置（审计后删除）：仅运行同期窗口纯函数单测。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/repositories/dashboard-home.test.ts"],
    testTimeout: 30_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
