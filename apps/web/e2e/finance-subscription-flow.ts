/** Current financial entrypoint equivalent of legacy POOL-010 money/history checks.
 * A separate synthetic enterprise starts with an ACTIVE financial fixture; this does not test or claim activation.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { createKysely } from "../../../packages/database/src/index.js";
import { employeeQuotaMonth } from "../../../packages/domain/src/employee-quota-period.js";
import { expect, apiGet } from "./fixtures";

export async function verifyFinancialSubscriptionHistory(page: Page, testInfo: TestInfo) {
  const target = new URL(process.env.DATABASE_URL!);
  if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_e2e")) throw new Error("dedicated local synthetic database required");
  const db = createKysely(target.toString());
  let financialEnterpriseId: string | null = null;
  const createdAt = new Date();
  try {
    const enterpriseId = randomUUID(), adminId = randomUUID(); financialEnterpriseId = enterpriseId;
    const username = `finance-e2e-${Date.now()}`;
    const password = await db.selectFrom("admin_user").select("password_hash").where("username", "=", "admin").executeTakeFirstOrThrow();
    await db.insertInto("enterprise").values({ id: enterpriseId, name: "合成财务E2E企业", timezone: "Asia/Shanghai", created_at: new Date("2000-01-01T00:00:00Z") }).execute();
    await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username, password_hash: password.password_hash, status: "ACTIVE" }).execute();
    const month = employeeQuotaMonth(new Date(), "Asia/Shanghai");
    const previous = employeeQuotaMonth(new Date(month.periodStart.getTime() - 1), "Asia/Shanghai");
    const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    const provider = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "zhipu", name: "财务验收厂商", adapter_type: "zhipu" }).returning("id").executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: provider.id, name: "费用与周期验收套餐", mode: "CODING_PLAN", credential_type: "API_KEY", created_at: previous.periodStart }).returning("id").executeTakeFirstOrThrow();
    // Isolated precondition, not an activation bypass in application code or an activation acceptance claim.
    await db.withTables<{ provider_finance_runtime_state: { enterprise_id: string; strict_writes_enabled: boolean; activated_at: Date; activated_by_admin_user_id: string } }>()
      .insertInto("provider_finance_runtime_state").values({ enterprise_id: enterpriseId, strict_writes_enabled: true, activated_at: previous.periodStart, activated_by_admin_user_id: adminId }).execute();
    await page.getByRole("button", { name: "退出", exact: true }).click();
    await page.getByLabel("用户名").fill(username); await page.getByLabel("密码").fill("admin123"); await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.goto("/resources?tab=finance");
    await page.getByLabel("历史记录资源").selectOption(resource.id);
    for (const [index, amount, period] of [[0, "299.4", previous], [1, "399", month]] as const) {
      await page.getByRole("button", { name: "充值／订阅", exact: true }).click();
      await page.getByLabel("登记类型").selectOption(index === 0 ? "PURCHASE" : "RENEWAL");
      await page.getByLabel("订阅产品").fill("E2E 团队版");
      await page.getByLabel("服务周期开始日").fill(day(period.periodStart));
      await page.getByLabel("服务周期结束日（可选）").fill(day(new Date(period.periodEnd.getTime() - 86400_000)));
      await page.getByLabel("扣费时间").fill(`${day(period.periodStart)}T00:00`);
      await page.getByLabel("人民币实付", { exact: true }).fill(amount);
      await page.getByLabel("说明", { exact: true }).fill(`E2E POOL-010 financial history ${index + 1}`);
      await page.getByLabel("证据引用", { exact: true }).fill(`synthetic-receipt-${index + 1}`);
      await page.getByLabel("付款凭证号（可选）").fill(`synthetic-subscription-${index + 1}`);
      await page.getByRole("checkbox", { name: "自动续订", exact: true }).uncheck();
      if (index === 1) {
        await page.getByLabel("订阅金额", { exact: true }).fill("399.001");
        await page.getByRole("button", { name: "入账确认", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("请输入非负金额，最多保留两位小数");
      }
      await page.getByLabel("订阅金额", { exact: true }).fill(amount);
      await page.getByLabel("说明", { exact: true }).click();
      await expect(page.getByLabel("订阅金额", { exact: true })).toHaveValue(index === 0 ? "299.40" : "399.00");
      const recorded = page.waitForResponse(response => response.url().endsWith(`/provider-resources/${resource.id}/finance/subscriptions`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "入账确认", exact: true }).click();
      expect((await recorded).status()).toBe(201);
      await expect(page.getByRole("region", { name: "已登记订阅" })).toContainText(index === 0 ? "CNY 299.40" : "CNY 399.00");
    }
    const history = await apiGet<{ periods: Array<{ fixed_fee_amount: string; period_start: string; period_end_exclusive: string }> }>(page, `/provider-resources/${resource.id}/subscription-periods`);
    expect(history.periods).toHaveLength(2);
    expect(history.periods.map(period => Number(period.fixed_fee_amount)).sort((a, b) => a - b)).toEqual([299.4, 399]);
    expect(history.periods.map(period => period.period_start).sort()).toEqual([previous.periodStart.toISOString(), month.periodStart.toISOString()]);
    const facts = await db.selectFrom("provider_subscription_period as p").innerJoin("provider_finance_event as e", "e.id", "p.finance_event_id").select(["e.account_amount as fixed_fee_amount", "p.period_start", "p.period_end_exclusive"]).where("p.enterprise_id", "=", enterpriseId).orderBy("p.period_start").execute();
    expect(facts.map(fact => Number(fact.fixed_fee_amount))).toEqual([299.4, 399]);
    expect(facts.map(fact => fact.period_start.toISOString())).toEqual([previous.periodStart.toISOString(), month.periodStart.toISOString()]);
    expect(facts.map(fact => fact.period_end_exclusive.toISOString())).toEqual([previous.periodEnd.toISOString(), month.periodEnd.toISOString()]);
    await page.screenshot({ path: testInfo.outputPath("current-subscription-money-history-real-browser.png"), fullPage: true });
    await writeFile(testInfo.outputPath("current-subscription-financial-facts.json"), JSON.stringify({ source: "SYNTHETIC_ACTIVE_PRECONDITION_REAL_UI_API_WRITES", productionAcceptance: false, activationWorkflowTested: false, history, facts }, null, 2));
  } finally {
    if (financialEnterpriseId) await db.updateTable("enterprise").set({ created_at: createdAt }).where("id", "=", financialEnterpriseId).execute();
    await db.destroy();
  }
}
