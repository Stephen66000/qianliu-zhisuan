// V14-C4 G02a 审计临时变异配置副本（仓库内原件已在审计后删除）：
// 仅运行展示模型纯函数单测，runner 不含 DOM 组件测试。
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
