import { defineConfig } from "vitest/config";

// 资金核心路径增量变异测试（I1 复审 R3 Evidence Gap 整改）：
// 只跑 domain 资金激活投影相关单测，作为 Stryker 对 domain 资金模块
// 做变异测试时的测试集（单元级，无容器依赖，速度快）。
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/__tests__/provider-finance-activation-projection.test.ts",
      "src/__tests__/provider-finance-activation-summary.test.ts",
      // R3 第二轮：针对存活突变体密集区的定向加固测试（compareStrings/isWithin/hasTokens、
      // 字段摘要键名敏感性、coveringPeriods 边界、修复计划全分支、逐月抵消、余额投影缺口）。
      "src/__tests__/provider-finance-activation-hardening.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
