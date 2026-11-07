import { defineConfig } from "vitest/config";

// EG-02（v1.5 送审准备 · gate-supplement run2）：新模块定向覆盖率。
// 仅圈定本阶段高风险既有测试（api-cost-estimation 单资源/折单批量/attempts、
// 官方余额 states/refresh/sync-writes、刷新路由域、worker 周期同步），
// coverage.include＝核心实现文件，报告落 coverage/eg02/。
// 阈值沿用 V3 全局（vitest.config.ts 同源）：95/85/90/95。
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "packages/database/src/__tests-integration__/api-cost-estimation.integration.test.ts",
      "packages/database/src/repositories/api-cost-estimation.fallback.test.ts",
      "packages/database/src/__tests-integration__/api-cost-estimation-by-resource.integration.test.ts",
      "packages/database/src/__tests-integration__/api-cost-estimation-attempts.integration.test.ts",
      "packages/database/src/__tests-integration__/wp3-official-balance-states.integration.test.ts",
      "packages/database/src/__tests-integration__/wp3-official-balance-refresh.integration.test.ts",
      "apps/control-api/src/__tests-integration__/official-balance-refresh.http.test.ts",
      "apps/worker/src/provider-operating-sync/runner.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/eg02",
      include: [
        "packages/database/src/repositories/api-cost-estimation.ts",
        "packages/database/src/repositories/official-balance-states.ts",
        "packages/database/src/repositories/official-balance-refresh-repository.ts",
        "packages/database/src/repositories/official-balance-sync-writes.ts",
        "apps/control-api/src/providers/official-balance-routes.ts",
        "apps/worker/src/provider-operating-sync/runner.ts",
      ],
      thresholds: { statements: 95, branches: 85, functions: 90, lines: 95 },
    },
  },
});
