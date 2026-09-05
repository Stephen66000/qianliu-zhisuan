import { randomUUID } from "node:crypto";
import { createKysely } from "../../../packages/database/src/index.js";
import { test, expect, login, E2E_IDS, apiGet } from "./fixtures";

let modelId: string; let resourceId: string; let routeId: string;
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_e2e')) throw new Error("dedicated local e2e DB required");
  const db = createKysely(url.toString());
  try {
    const { enterprise_id } = await db.selectFrom("unified_model").select("enterprise_id").where("id", "=", E2E_IDS.model).executeTakeFirstOrThrow();
    const provider = await db.selectFrom("provider").select("id").where("enterprise_id", "=", enterprise_id).where("code", "=", "zhipu").executeTakeFirstOrThrow();
    resourceId = (await db.insertInto("provider_resource").values({ enterprise_id, provider_id: provider.id,
      mode: "API", credential_type: "API_KEY", name: "计价验证资源", status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow()).id;
    modelId = (await db.insertInto("unified_model").values({ enterprise_id, alias: "ql-pricing-e2e", display_name: "计价验证模型", status: "PENDING_CONFIG" }).returning("id").executeTakeFirstOrThrow()).id;
    routeId = (await db.insertInto("model_route").values({ enterprise_id, unified_model_id: modelId, provider_resource_id: resourceId,
      upstream_model: "pricing-upstream", enabled: false }).returning("id").executeTakeFirstOrThrow()).id;
    await db.insertInto("provider_model_validation").values({ enterprise_id, provider_resource_id: resourceId,
      unified_model_id: modelId, upstream_model: "pricing-upstream", idempotency_key: randomUUID(), request_fingerprint: randomUUID(),
      status: "SUCCEEDED", result: { source: "ISOLATED_TEST_FIXTURE" }, started_at: new Date(), finished_at: new Date() }).execute();
  } finally { await db.destroy(); }
});

test("待配置模型一次保存计价与路由，策略独立发布停用存档", async ({ page }, testInfo) => {
  await login(page); await page.goto("/quota-rules");
  await expect(page.getByRole("tab", { name: "计价", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "新建统一模型" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新建路由" })).toHaveCount(0);
  await page.getByRole("button", { name: "新建规则", exact: true }).click();
  await page.getByLabel("模型", { exact: true }).selectOption(modelId);
  await page.getByLabel("厂商资源", { exact: true }).selectOption(routeId);
  await page.getByLabel("路由优先级", { exact: true }).fill("80");
  await page.getByLabel("路由权重", { exact: true }).fill("2");
  await page.getByLabel("规则版本", { exact: true }).fill("pricing-e2e-v1");
  await page.getByLabel("计价方式").selectOption("MULTIPLIER");
  await page.getByLabel("有效倍率（API 倍率模式 / 套餐扣减）").fill("3");
  await page.getByLabel("缓存命中输入单价（币种/Token）").fill("0.000001");
  await page.getByLabel("未命中输入单价（币种/Token）").fill("0.000002");
  await page.getByLabel("输出单价（币种/Token）").fill("0.000004");
  await expect(page.getByLabel("有效单价预览")).toContainText("输出 12");
  await page.screenshot({ path: testInfo.outputPath("pricing-form.png"), fullPage: true });
  const response = page.waitForResponse((r) => r.url().endsWith("/pricing-configurations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "保存并启用" }).click();
  expect((await response).status()).toBe(201);
  const routes = await apiGet<{ routes: Array<{ id: string; enabled: boolean; priority: number; weight: number }> }>(page, `/unified-models/${modelId}/routes`);
  expect(routes.routes.find((r) => r.id === routeId)).toMatchObject({ enabled: true, priority: 80, weight: 2 });
  await expect(page.getByRole("row").filter({ hasText: "pricing-e2e-v1" })).toBeVisible();
  await page.getByRole("tab", { name: "调度策略", exact: true }).click();
  await page.getByRole("button", { name: "新建调度策略" }).click();
  await page.getByLabel("策略版本", { exact: true }).fill("pricing-policy-v1");
  await page.getByLabel("统一模型", { exact: true }).selectOption("ql-pricing-e2e");
  await page.getByLabel("厂商资源", { exact: true }).selectOption(resourceId);
  await page.getByRole("button", { name: "创建草稿" }).click();
  const row = page.getByRole("row").filter({ hasText: "pricing-policy-v1" });
  await row.getByRole("button", { name: "校验", exact: true }).click();
  await row.getByRole("button", { name: "发布", exact: true }).click();
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await row.getByRole("button", { name: "存档", exact: true }).click();
  await page.getByRole("button", { name: "确认存档", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel("查看存档", { exact: true }).check();
  await expect(row).toContainText("已存档");
  await page.screenshot({ path: testInfo.outputPath("policy-archive.png"), fullPage: true });
});
