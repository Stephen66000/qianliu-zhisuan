/**
 * W20 E2E 共享夹具 —— 登录 + 通用导航。
 *
 * 认证：通过登录页真实 POST /auth/login（cookie 会话）。
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

/** 幂等命名（避免重复运行冲突）。 */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

export const test = base.extend({});
export { expect };
