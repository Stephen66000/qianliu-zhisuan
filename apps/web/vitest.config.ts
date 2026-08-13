// W18 前端组件测试配置（vitest + jsdom + @testing-library）。
// 根 vitest.config.ts 是 node 环境且 include 不含 .tsx，前端测试用本文件独立配置；
// 执行入口：apps/web package.json 的 test script。
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
    reporters: ["default"],
  },
});
