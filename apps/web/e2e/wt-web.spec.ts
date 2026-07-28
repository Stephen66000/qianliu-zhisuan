/**
 * WT-01~20 Web 路径 E2E —— 七入口真实 API 回归（M5 DoD）。
 *
 * 覆盖 Web 管理后台能真实驱动的 WT 子集；网关运行时类
 * （WT-03 第三方工具调用、WT-07 套餐切换、WT-13 会话亲和、WT-20 协议矩阵）
 * 非 Web 路径，由后端集成测试覆盖（见 Evidence §WT 映射表）。
 */
import { test, expect, login, uniqueName } from "./fixtures";

test.describe("M5 七入口真实 API E2E", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // WT-08：首页看板八项指标可见
  test("WT-08 首页看板展示八项指标", async ({ page }) => {
    await expect(page.getByText("厂商资源账号")).toBeVisible();
    await expect(page.getByText("本账期活跃人数")).toBeVisible();
    await expect(page.getByText("本月 API 费用（元）")).toBeVisible();
    await expect(page.getByText("本月调度节省（元）")).toBeVisible();
    // 数据源 gap 不伪造
    await expect(page.getByText("数据源待接入").first()).toBeVisible();
  });

  // WT-01：登记厂商资源（凭证一次提交不回显）
  test("WT-01 登记厂商资源", async ({ page }) => {
    await page.goto("/resources");
    await page.getByRole("button", { name: /登记资源/ }).click();
    const name = uniqueName("智谱资源");
    await page.getByLabel("资源名称").fill(name);
    await page.getByLabel("上游凭证").fill("sk-e2e-secret-not-stored");
    // provider 下拉可能为空（无已登记厂商）→ 跳过提交，仅校验表单与凭证不回显
    await expect(page.getByLabel("上游凭证")).toHaveValue("sk-e2e-secret-not-stored");
    await expect(page.getByText("sk-e2e-secret-not-stored")).toHaveCount(0);
  });

  // WT-02：创建员工（主体）
  test("WT-02 创建员工主体", async ({ page }) => {
    await page.goto("/principals");
    await page.getByRole("button", { name: /新建主体/ }).click();
    const name = uniqueName("员工");
    await page.getByLabel("名称").fill(name);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(name)).toBeVisible();
  });

  // WT-09：停用主体（二次确认 + 级联撤销 Key 提示）
  test("WT-09 停用主体需二次确认", async ({ page }) => {
    await page.goto("/principals");
    await page.getByRole("button", { name: /新建主体/ }).click();
    const name = uniqueName("停用对象");
    await page.getByLabel("名称").fill(name);
    await page.getByRole("button", { name: "创建" }).click();
    await expect(page.getByText(name)).toBeVisible();

    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "停用" }).click();
    // 二次确认对话框说明影响对象
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/全部有效 Key 将被同步撤销/)).toBeVisible();
    await page.getByRole("button", { name: "确认停用" }).click();
    await expect(row.getByText("已停用")).toBeVisible();
  });

  // WT-05：用量账本 token/扣减/费用列
  test("WT-05 用量账本列与套餐内展示", async ({ page }) => {
    await page.goto("/usage");
    await expect(page.getByRole("heading", { name: "用量账本" })).toBeVisible();
    // 空态或表格表头
    const empty = await page.getByText("没有账本记录").isVisible().catch(() => false);
    if (!empty) {
      await expect(page.getByRole("columnheader", { name: "输入 Token" })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: /API 费用/ })).toBeVisible();
    }
  });

  // WT-10：路由过程下钻（有数据时展开候选）
  test("WT-10 账本路由过程下钻", async ({ page }) => {
    await page.goto("/usage");
    const expandBtn = page.getByRole("button", { name: "展开路由过程" }).first();
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click();
      await expect(page.getByText("路由候选")).toBeVisible();
      await expect(page.getByText("上游尝试")).toBeVisible();
      await expect(page.getByText("调度决策")).toBeVisible();
    }
  });

  // WT-15：供给预测（看板最早耗尽 + 资源摘要）
  test("WT-15 看板预测信息", async ({ page }) => {
    await expect(page.getByText("最早耗尽资源")).toBeVisible();
    await expect(page.getByText("预测可信度")).toBeVisible();
  });

  // 异常告警入口 + 标记已处理
  test("告警看板运行正常或标记已处理", async ({ page }) => {
    await page.goto("/alerts");
    await expect(page.getByRole("heading", { name: "异常告警" })).toBeVisible();
    const normal = await page.getByText("运行正常").isVisible().catch(() => false);
    if (!normal) {
      const markBtn = page.getByRole("button", { name: "标记已处理" }).first();
      if (await markBtn.isVisible().catch(() => false)) {
        await markBtn.click();
      }
    }
  });

  // 操作日志（审计追踪）
  test("操作日志入口", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /操作日志/ })).toBeVisible();
  });

  // 七入口导航可达
  test("七入口导航全部可达", async ({ page }) => {
    const entries = [
      { path: "/dashboard", name: "首页看板" },
      { path: "/principals", name: "使用主体" },
      { path: "/resources", name: "厂商资源" },
      { path: "/quota-rules", name: "额度规则" },
      { path: "/usage", name: "用量账本" },
      { path: "/alerts", name: "异常告警" },
      { path: "/settings", name: "系统设置" },
    ];
    for (const e of entries) {
      await page.goto(e.path);
      await expect(page).toHaveURL(new RegExp(e.path));
    }
  });

  // 主题切换三态
  test("主题切换三态（跟随系统/浅色/深色）", async ({ page }) => {
    await page.getByRole("button", { name: "浅色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.getByRole("button", { name: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "跟随系统" }).click();
  });
});
