/**
 * U01（候选 C3 WP07）：项目成员管理 → 项目账 → 归集明细 的真实浏览器链路。
 * 依托 M5 Playwright 夹具（独立 *_e2e 库 + 真实登录）。
 */
import { test, expect } from "./fixtures";
import { E2E_IDS, login } from "./fixtures";

test.describe("项目成员与 AI 用量归集 U01", () => {
  test("主体页存在成员与归集入口；成员页可访问并展示合同文案", async ({ page }) => {
    await login(page);
    await page.goto("/principals");
    await expect(page.getByRole("heading", { name: "使用主体" })).toBeVisible();

    // 直接访问 pool043 项目成员页（夹具固定项目）。
    await page.goto(`/principals/${E2E_IDS.pool043Project}/project-members`);
    await expect(page.getByRole("heading", { name: "成员与归集" })).toBeVisible();
    await expect(page.getByText("依据管理规则归集，不代表实际工作内容")).toBeVisible();
    await expect(page.getByText("添加成员")).toBeVisible();
    await expect(page.getByText("当前成员").first()).toBeVisible();
  });

  test("项目账列表渲染归集列；明细页未启用时展示引导而非假数据", async ({ page }) => {
    await login(page);
    await page.goto("/operating-bill/projects");
    await expect(page.getByRole("heading", { name: "项目账" }).or(page.getByText("项目账")).first()).toBeVisible();
    // 归集列表头存在（增强列）。
    await expect(page.getByRole("columnheader", { name: "归集" })).toBeVisible();

    await page.goto(`/operating-bill/projects/${E2E_IDS.pool043Project}/allocation`);
    await expect(page.getByText("项目归集明细")).toBeVisible();
    // 未启用或未计算：不出现伪造的 0 批次，而显示启用引导/空态。
    const enableHint = page.getByRole("button", { name: "启用项目归集" });
    const emptyHint = page.getByText("该账期还没有可用的归集批次");
    await expect(enableHint.or(emptyHint)).toBeVisible();
  });
});
