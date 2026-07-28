/**
 * Playwright 配置（W20）—— Web 七入口真实 API E2E。
 *
 * 工程规则测试栈锁 Playwright 1.55.0。
 * 前置：control-api 与 web dev server 已启动（用 webServer 自动拉起）；
 * 数据库由 control-api 连接的 PG 提供（宿主机 Docker / 本地 PG）。
 *
 * 运行：pnpm --filter @qianliu/web test:e2e
 * 环境变量：E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD（默认 admin / admin123，需先在库中创建）。
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    {
      command: "pnpm --filter @qianliu/control-api dev",
      url: "http://127.0.0.1:8788/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @qianliu/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
