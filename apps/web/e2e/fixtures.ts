/**
 * W20 E2E 共享夹具 —— 登录 + 通用导航。
 *
 * 认证：通过登录页真实 POST /api/auth/login（cookie 会话）。
 * 前置数据：企业/管理员需在库中预置（见 README）；E2E 创建的对象幂等命名（时间戳后缀）。
 */
import { test as base, expect, type Page } from "@playwright/test";

export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? "admin";
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "admin123";

/** 通过登录页登录并进入看板。 */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(ADMIN_USERNAME);
  await page.getByLabel("密码").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "首页看板" })).toBeVisible();
}

export const E2E_IDS = {
  resource: "00000000-0000-4000-8000-000000000011",
  isolatedResource: "00000000-0000-4000-8000-000000000012",
  model: "00000000-0000-4000-8000-000000000013",
  principal: "00000000-0000-4000-8000-000000000020",
  request: "00000000-0000-4000-8000-000000000030",
  streamRequest: "00000000-0000-4000-8000-000000000050",
} as const;

export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.evaluate(async (requestPath) => {
    const browserResponse = await fetch(`/api${requestPath}`, { credentials: "same-origin" });
    return {
      ok: browserResponse.ok,
      status: browserResponse.status,
      body: await browserResponse.text(),
    };
  }, path);
  expect(response.ok, `${path} 应返回成功，实际 HTTP ${response.status}`).toBe(true);
  return JSON.parse(response.body) as T;
}

export const test = base.extend({});
export { expect };
