import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// EG-02 定向变异的最快足够测试集：
//   - api-cost-estimation 集成（单资源聚合/完整性/价格依据/快照回退）
//   - api-cost-estimation-by-resource（折单批量 vs 逐资源一致性回归）
//   - wp3-official-balance-states（状态判定矩阵/装配）
//   - wp3-official-balance-refresh（刷新租约 begin/finish/幂等/收敛）
// 沿用 vitest.pool043.mutation.config.ts 的超时与串行惯例。
export default defineConfig({
  resolve: {
    alias: { "@qianliu/database": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/__tests-integration__/api-cost-estimation.integration.test.ts",
      "src/repositories/api-cost-estimation.fallback.test.ts",
      "src/__tests-integration__/api-cost-estimation-by-resource.integration.test.ts",
      "src/__tests-integration__/wp3-official-balance-states.integration.test.ts",
      "src/__tests-integration__/wp3-official-balance-refresh.integration.test.ts",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
