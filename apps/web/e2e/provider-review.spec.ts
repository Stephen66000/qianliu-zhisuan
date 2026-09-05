import { createKysely } from "../../../packages/database/src/index.js";
import { randomUUID } from "node:crypto";
import { test, expect, login, apiGet, E2E_IDS } from "./fixtures";
import type { ResourceUtilization } from "../src/api/v2-types";
import type { ResourceUsageOverview } from "../src/api/types";
import { formatCount } from "../src/lib/format";

const fixtureRequests: string[] = [];
let fixtureProvider: string | undefined;
let fixtureResource: string | undefined;
let fixtureGrant: string | undefined;
let fixtureRoute: string | undefined;
let originalPlanCreatedAt: Date | undefined;

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !url.pathname.endsWith("_e2e")) {
    throw new Error("资源复盘夹具只能写入本机专用 _e2e 数据库");
  }
  const db = createKysely(databaseUrl);
  try {
    const resource = await db.selectFrom("provider_resource").select(["enterprise_id", "created_at"])
      .where("id", "=", E2E_IDS.isolatedResource).executeTakeFirstOrThrow();
    originalPlanCreatedAt = resource.created_at;
    const route = await db.insertInto("model_route").values({ enterprise_id: resource.enterprise_id,
      unified_model_id: E2E_IDS.model, provider_resource_id: E2E_IDS.isolatedResource,
      upstream_model: "glm-4.6", enabled: true }).onConflict((oc) => oc.doNothing()).returning("id").executeTakeFirst();
    fixtureRoute = route?.id;
    const provider = await db.insertInto("provider").values({ enterprise_id: resource.enterprise_id,
      code: "deepseek", name: "DeepSeek 复盘验证", adapter_type: "deepseek" }).returning("id").executeTakeFirstOrThrow();
    fixtureProvider = provider.id;
    const api = await db.insertInto("provider_resource").values({ enterprise_id: resource.enterprise_id,
      provider_id: provider.id, name: "DeepSeek 复盘 API", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow();
    fixtureResource = api.id;
    const key = await db.selectFrom("principal_key").select("id").where("principal_id", "=", E2E_IDS.principal).executeTakeFirstOrThrow();
    const month = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const atMonth = (offset: number) => new Date(Date.UTC(month.getFullYear(), month.getMonth() + offset, 1) - 8 * 3600_000);
    for (const [id, mode] of [[api.id, "API"], [E2E_IDS.isolatedResource, "CODING_PLAN"]] as const) {
      await db.updateTable("provider_resource").set({ created_at: atMonth(-4) }).where("id", "=", id).execute();
      for (const [index, tokens] of [8000000n, 10000000n, 12000000n, 9000000n].entries()) {
        await addTokenFact(db, resource.enterprise_id, key.id, id, mode, tokens, atMonth(index - 3));
      }
    }
    const grant = await db.insertInto("principal_grant").values({ enterprise_id: resource.enterprise_id,
      principal_id: E2E_IDS.principal, provider: "deepseek", model_alias: "*", pool_model_alias: "*",
      quota_value: 300000000n, valid_from: atMonth(-3), status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow();
    fixtureGrant = grant.id;
  } finally { await db.destroy(); }
});

test.afterAll(async () => {
  if (!originalPlanCreatedAt) return;
  const db = createKysely(process.env.DATABASE_URL!);
  try {
    await db.transaction().execute(async (trx) => {
      if (fixtureRequests.length) {
        await trx.deleteFrom("ledger_line").where("ai_request_id", "in", fixtureRequests).execute();
        await trx.deleteFrom("usage_event").where("ai_request_id", "in", fixtureRequests).execute();
        await trx.deleteFrom("upstream_attempt").where("ai_request_id", "in", fixtureRequests).execute();
        await trx.deleteFrom("ai_request").where("id", "in", fixtureRequests).execute();
      }
      if (fixtureGrant) await trx.deleteFrom("principal_grant").where("id", "=", fixtureGrant).execute();
      if (fixtureRoute) await trx.deleteFrom("model_route").where("id", "=", fixtureRoute).execute();
      if (fixtureResource) await trx.deleteFrom("provider_resource").where("id", "=", fixtureResource).execute();
      if (fixtureProvider) await trx.deleteFrom("provider").where("id", "=", fixtureProvider).execute();
      await trx.updateTable("provider_resource").set({ created_at: originalPlanCreatedAt! })
        .where("id", "=", E2E_IDS.isolatedResource).execute();
    });
  } finally { await db.destroy(); }
});

async function addTokenFact(db: ReturnType<typeof createKysely>, enterpriseId: string,
  keyId: string, resourceId: string, mode: "API" | "CODING_PLAN", tokens: bigint, at: Date) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
    principal_id: E2E_IDS.principal, principal_key_id: keyId, protocol: "chat", unified_model: "provider-review",
    status: "SUCCEEDED", started_at: at, finished_at: at }).execute();
  fixtureRequests.push(requestId);
  const attempt = await db.insertInto("upstream_attempt").values({ enterprise_id: enterpriseId,
    ai_request_id: requestId, provider_resource_id: resourceId, upstream_model: "provider-review",
    attempt_no: 1, http_status: 200, response_committed: true, finished_at: at }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ enterprise_id: enterpriseId,
    ai_request_id: requestId, upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
    input_tokens: tokens - 1n, output_tokens: 1n, usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID(),
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId, ai_request_id: requestId,
    upstream_attempt_id: attempt.id, usage_event_id: usage.id, provider_resource_id: resourceId,
    principal_id: E2E_IDS.principal, resource_mode: mode, raw_input_tokens: tokens - 1n,
    raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", api_cost: mode === "API" ? "1" : null,
    created_at: at, settled_at: at }).execute();
}

test("厂商模块复盘：真实接口与页面一致、四 Tab 按需加载、删列后对齐", async ({ page }, testInfo) => {
  await login(page);
  const overviewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/provider-resources/usage-overview")) overviewRequests.push(request.url());
  });
  await page.goto("/resources");
  await expect(page.getByRole("columnheader", { name: "利用率" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "凭证指纹" })).toHaveCount(0);
  await expect(page.getByText(/逐资源查看请求|按登记事实展示/)).toHaveCount(0);
  const month = await page.getByLabel("资源利用月份").inputValue();
  const usage = await apiGet<{ resources: ResourceUtilization[] }>(page, `/provider-resources/utilization?month=${month}`);
  expect(usage.resources.length).toBeGreaterThan(0);
  for (const resource of usage.resources) {
    const fact = resource.tokenUtilization!;
    expect(fact.basis).toBe("CURRENT_MONTH_VS_UP_TO_3_COMPLETE_MONTHS");
    const row = page.locator("#resource-utilization").getByRole("row")
      .filter({ has: page.getByText(`${resource.providerName} · ${resource.resourceName}`, { exact: true }) });
    const rate = row.locator("td").nth(4);
    const expectedPercent = fact.rate === null ? "—" : new Intl.NumberFormat("en-US", {
      style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false,
    }).format(Number(fact.rate));
    await expect(rate).toHaveText(expectedPercent);
    await expect(rate.locator("span")).toHaveAttribute("title", new RegExp(`本月真实 Token ${formatCount(fact.currentMonthTokens)}`));
  }
  expect(overviewRequests).toHaveLength(0);
  await expect(page.locator("#resource-utilization").getByText("90.0%", { exact: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("resource-utilization.png"), fullPage: true });

  await page.getByRole("tab", { name: "用量总览" }).click();
  await expect(page.getByRole("heading", { name: "模型使用明细" })).toBeVisible();
  const overview = await apiGet<ResourceUsageOverview>(page, "/provider-resources/usage-overview");
  expect(overview.providerSummaries.find((item) => item.providerCode === "deepseek" && item.mode === "API")?.allocatedQuota).toBe("300000000");
  const models = page.getByRole("heading", { name: "模型使用明细" }).locator("../..").locator("table");
  await expect(models.locator("th")).toHaveCount(7);
  for (const row of await models.locator("tbody tr").all()) await expect(row.locator("td")).toHaveCount(7);
  await expect(page.getByRole("columnheader", { name: "所属资源余额 / 剩余额度" })).toHaveCount(0);
  await expect(page.getByText(/按厂商与模式汇总|每行对应一个具体模型/)).toHaveCount(0);
  const plans = overview.modelDetails.filter((item) => item.mode === "CODING_PLAN");
  expect(plans.length).toBeGreaterThan(0);
  await expect(models.getByText("不涉及", { exact: true })).toHaveCount(plans.length);
  const summaries = page.getByRole("heading", { name: "厂商总体使用情况" }).locator("../..").locator("tbody tr");
  for (const [index, item] of overview.providerSummaries.entries()) {
    await expect(summaries.nth(index).locator("td").nth(6)).toHaveText(item.allocatedQuota === null ? "—" : formatCount(item.allocatedQuota));
  }
  await page.screenshot({ path: testInfo.outputPath("usage-overview.png"), fullPage: true });

  await page.getByRole("tab", { name: "额度窗口" }).click();
  await expect(page.getByRole("heading", { name: "厂商额度窗口" })).toBeVisible();
  await expect(page.getByText(/厂商 Coding Plan 返回的实时窗口额度/)).toHaveCount(0);
  await page.getByRole("tab", { name: "供给与健康" }).click();
  await expect(page.getByRole("heading", { name: "供给预测" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "资源健康与异常" })).toBeVisible();
  await expect(page.getByText(/展示每个资源最新快照|按资源展示运行状态、原因/)).toHaveCount(0);
  await page.goto("/resources#resource-health");
  await expect(page.getByRole("tab", { name: "供给与健康" })).toHaveAttribute("aria-selected", "true");
});
