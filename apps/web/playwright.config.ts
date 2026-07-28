/**
 * Playwright 配置（W20）—— Web 七入口真实 API E2E。
 *
 * 工程规则测试栈锁 Playwright 1.55.0。
 * 前置：专用 `_e2e` 数据库可连接；globalSetup 自动迁移、清库并播种固定夹具，
 * webServer 自动拉起 control-api 与 Web，禁止复用可能连接其他数据库的旧进程。
 *
 * 运行：pnpm --filter @qianliu/web test:e2e
 * 环境变量：DATABASE_URL 与服务端三个安全密钥；管理员固定为 admin / admin123。
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
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
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @qianliu/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
