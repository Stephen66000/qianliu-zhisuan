import { defineConfig } from "vitest/config";

// 仟流智算共享 vitest 配置。各 package/app 的 package.json 通过 --config 指向本文件。
// 工程规则 §7：每个工作包至少完成受影响单测/集成/E2E、负向场景、canary 和 Evidence。
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "src/**/*.test.ts",
      "src/**/__tests__/**/*.test.ts",
      "src/**/__tests-integration__/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    passWithNoTests: true,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/__tests__/**", "**/*.test.ts"],
    },
  },
});
