import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import {
  createKysely,
  migrateToLatest,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let adminCookie: string;

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const adminId = randomUUID();
const otherAdminId = randomUUID();
const principalId = randomUUID();
const principalKeyId = randomUUID();
let apiResourceId: string;
let kimiResourceId: string;
let zhipuResourceId: string;
let otherApiResourceId: string;

const currentMonth = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
}).format(new Date()).slice(0, 7);
const currentMonthStart = `${currentMonth}-01`;
const recentUsageAt = new Date(Date.now() - 36 * 60 * 60_000);

async function insertLedgerFact(resourceId: string): Promise<string> {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId,
    enterprise_id: enterpriseId,
    principal_id: principalId,
    principal_key_id: principalKeyId,
    protocol: "chat",
    unified_model: "qianliu-deepseek",
    status: "SUCCEEDED",
    started_at: recentUsageAt,
    finished_at: new Date(recentUsageAt.getTime() + 500),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId,
    enterprise_id: enterpriseId,
    attempt_no: 1,
    provider_resource_id: resourceId,
    upstream_model: "deepseek-chat",
    finished_at: new Date(recentUsageAt.getTime() + 500),
    http_status: 200,
    response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId,
    enterprise_id: enterpriseId,
    upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId,
    input_tokens: 800n,
    output_tokens: 200n,
    cache_tokens: 300n,
    usage_quality: "PROVIDER_REPORTED",
    dedup_key: `w20-resource-${requestId}`,
    created_at: recentUsageAt,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId,
    enterprise_id: enterpriseId,
    usage_event_id: usage.id,
    upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId,
    principal_id: principalId,
    resource_mode: "API",
    raw_input_tokens: 800n,
    raw_output_tokens: 200n,
    raw_cache_tokens: 300n,
    deducted_quota: null,
    api_cost: "12.50000000",
    usage_quality: "PROVIDER_REPORTED",
    created_at: recentUsageAt,
  }).execute();
  return requestId;
}

async function count(table: string, where = "TRUE"): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::integer AS count
      FROM ${sql.table(table)}
     WHERE ${sql.raw(where)}
  `.execute(db);
  return result.rows[0]!.count;
}

beforeAll(async () => {
  pg = await startPostgresContainer("w20_resource_insights");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "W20 资源企业", timezone: "Asia/Shanghai" },
    { id: otherEnterpriseId, name: "W20 隔离企业", timezone: "Asia/Shanghai" },
  ]).execute();
  await db.insertInto("admin_user").values([
    {
      id: adminId,
      enterprise_id: enterpriseId,
      username: "w20-resource-admin",
      display_name: "资源管理员",
      password_hash: await hashPassword("W20-Resource-Test-Password!"),
      status: "ACTIVE",
    },
    {
      id: otherAdminId,
      enterprise_id: otherEnterpriseId,
      username: "w20-resource-other",
      display_name: "隔离管理员",
      password_hash: await hashPassword("W20-Resource-Other-Password!"),
      status: "ACTIVE",
    },
  ]).execute();
  await db.insertInto("principal").values({
    id: principalId,
    enterprise_id: enterpriseId,
    type: "EMPLOYEE",
    name: "资源测试员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: principalKeyId,
    enterprise_id: enterpriseId,
    principal_id: principalId,
    key_prefix: "ql_w20_resource",
    key_digest: randomUUID(),
  }).execute();

  const providers = await db.insertInto("provider").values([
    { enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "openai" },
    { enterprise_id: enterpriseId, code: "kimi", name: "Kimi", adapter_type: "kimi" },
    { enterprise_id: enterpriseId, code: "zhipu", name: "智谱", adapter_type: "zhipu" },
    { enterprise_id: otherEnterpriseId, code: "deepseek", name: "隔离 DeepSeek", adapter_type: "openai" },
  ]).returning(["id", "enterprise_id", "code"]).execute();
  const providerId = (enterprise: string, code: string) =>
    providers.find((provider) => provider.enterprise_id === enterprise && provider.code === code)!.id;
  const resources = await db.insertInto("provider_resource").values([
    {
      enterprise_id: enterpriseId,
      provider_id: providerId(enterpriseId, "deepseek"),
      name: "DeepSeek API",
      mode: "API",
      credential_type: "API_KEY",
    },
    {
      enterprise_id: enterpriseId,
      provider_id: providerId(enterpriseId, "kimi"),
      name: "Kimi Coding Plan",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
    },
    {
      enterprise_id: enterpriseId,
      provider_id: providerId(enterpriseId, "zhipu"),
      name: "智谱 Coding Plan",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
    },
    {
      enterprise_id: otherEnterpriseId,
      provider_id: providerId(otherEnterpriseId, "deepseek"),
      name: "隔离 API",
      mode: "API",
      credential_type: "API_KEY",
    },
  ]).returning(["id", "name"]).execute();
  apiResourceId = resources.find((resource) => resource.name === "DeepSeek API")!.id;
  kimiResourceId = resources.find((resource) => resource.name === "Kimi Coding Plan")!.id;
  zhipuResourceId = resources.find((resource) => resource.name === "智谱 Coding Plan")!.id;
  otherApiResourceId = resources.find((resource) => resource.name === "隔离 API")!.id;

  await insertLedgerFact(apiResourceId);
  await sql`
    INSERT INTO provider_resource_operating_snapshot
      (enterprise_id, provider_resource_id, version, source, collected_at,
       currency, current_balance, package_cost, total_quota, used_quota,
       remaining_quota, quota_unit, effective_from, effective_until)
    VALUES
      (${enterpriseId}::uuid, ${apiResourceId}::uuid, 1, 'PROVIDER_SYNC', now(),
       'CNY', 87.5, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
      (${enterpriseId}::uuid, ${kimiResourceId}::uuid, 1, 'PROVIDER_SYNC', now(),
       'CNY', NULL, 300, 100, 35, 65, 'POINT', '2026-08-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00'),
      (${enterpriseId}::uuid, ${zhipuResourceId}::uuid, 1, 'PROVIDER_SYNC', now(),
       'CNY', NULL, 500, 100, 90, 10, 'POINT', '2026-06-26T00:00:00+08:00', '2026-09-26T00:00:00+08:00')
  `.execute(db);
  await sql`
    INSERT INTO provider_quota_window
      (enterprise_id, provider_resource_id, window_type, limit_value, used_value,
       remaining_value, unit, ratio, reset_at, provider_data_at, collected_at,
       source, adapter_version, sync_status, last_success_at)
    VALUES
      (${enterpriseId}::uuid, ${kimiResourceId}::uuid, 'FIVE_HOUR', 100, 40,
       60, 'PERCENT', 0.4, now() + interval '1 hour', now(), now(),
       'PROVIDER_SYNC', 'w20-test-v1', 'SUCCESS', now()),
      (${enterpriseId}::uuid, ${kimiResourceId}::uuid, 'WEEKLY', 100, 20,
       80, 'PERCENT', 0.2, now() + interval '4 days', now(), now(),
       'PROVIDER_SYNC', 'w20-test-v1', 'SUCCESS', now()),
      (${enterpriseId}::uuid, ${zhipuResourceId}::uuid, 'FIVE_HOUR', 100, 75,
       25, 'PERCENT', 0.75, now() + interval '2 hours', now(), now(),
       'PROVIDER_SYNC', 'w20-test-v1', 'SUCCESS', now()),
      (${enterpriseId}::uuid, ${zhipuResourceId}::uuid, 'WEEKLY', 100, 90,
       10, 'PERCENT', 0.9, now() + interval '2 days', now(), now(),
       'PROVIDER_SYNC', 'w20-test-v1', 'SUCCESS', now())
  `.execute(db);
  await sql`
    INSERT INTO supply_forecast
      (enterprise_id, provider_resource_id, rate_1h, rate_24h, rate_7d,
       forecast_exhaust_at, next_recover_at, coverage_hours, remaining_quota,
       confidence, data_points, algorithm_version, snapshot_at)
    VALUES
      (${enterpriseId}::uuid, ${apiResourceId}::uuid, 10, 8, 7,
       now() + interval '2 days', now() + interval '3 days', 48, 336,
       'HIGH', 100, 'w20-test-v1', now() - interval '20 minutes')
  `.execute(db);
  await sql`
    INSERT INTO resource_purchase_record
      (enterprise_id, provider_resource_id, purchase_type, description, amount,
       currency, purchased_at, source, created_by)
    VALUES
      (${enterpriseId}::uuid, ${apiResourceId}::uuid, 'API_RECHARGE', 'DeepSeek 充值', 120,
       'CNY', ${recentUsageAt}, 'ADMIN', ${adminId}::uuid),
      (${enterpriseId}::uuid, ${kimiResourceId}::uuid, 'PACKAGE_PURCHASE', 'Kimi 套餐', 300,
       'CNY', ${recentUsageAt}, 'ADMIN', ${adminId}::uuid),
      (${enterpriseId}::uuid, ${zhipuResourceId}::uuid, 'PACKAGE_PURCHASE', '智谱套餐', 500,
       'CNY', ${recentUsageAt}, 'ADMIN', ${adminId}::uuid)
  `.execute(db);

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "w20-resource-admin", password: "W20-Resource-Test-Password!" },
  });
  const setCookie = login.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("W20-08 逐资源利用、耗尽与无调用事实", () => {
  it("API 无预算分母保持 null，Coding Plan 分开返回 5h/周窗口", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/provider-resources/utilization?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ resources: Array<Record<string, unknown>> }>();
    expect(body.resources).toHaveLength(3);
    const api = body.resources.find((resource) => resource.resourceId === apiResourceId)!;
    expect(api).toMatchObject({
      mode: "API",
      budgetAmount: null,
      utilizationRate: null,
      utilizationStatus: "NOT_CONFIGURED",
      notCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
      realTokens: "1000",
      apiCost: null,
      idleStatus: "UNASSESSED",
    });
    expect(api.lastSettledRequestAt).toEqual(expect.any(String));
    expect(api.continuousNoCallDays).toEqual(expect.any(Number));

    const kimi = body.resources.find((resource) => resource.resourceId === kimiResourceId)!;
    expect(kimi.idleStatus).toBe("UNASSESSED");
    expect(kimi.utilizationStatus).not.toBe("IDLE");
    expect(kimi).toMatchObject({
      utilizationRate: "0.35000000",
      utilizationBasis: "CODING_PLAN_SUBSCRIPTION_PERIOD",
      servicePeriodStart: expect.stringContaining("2026-08-01"),
      servicePeriodEnd: expect.stringContaining("2026-09-01"),
    });
    expect(kimi.quotaWindows).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "FIVE_HOUR", usedValue: "40.00000000", ratio: "0.400000" }),
      expect.objectContaining({ type: "WEEKLY", usedValue: "20.00000000", ratio: "0.200000" }),
    ]));
  });

  it("月度利用按结算时间归属，不按账本行创建时间跨月", async () => {
    const previousMonth = new Date(
      new Date(`${currentMonthStart}T00:00:00+08:00`).getTime() - 1_000,
    );
    const original = await db.selectFrom("ledger_line").select(["id", "ai_request_id"])
      .where("provider_resource_id", "=", apiResourceId).executeTakeFirstOrThrow();
    const laterSettledRequestId = await insertLedgerFact(apiResourceId);
    await db.updateTable("ledger_line").set({ created_at: recentUsageAt,
      settled_at: previousMonth }).where("id", "=", original.id).execute();
    await db.updateTable("ledger_line").set({
      created_at: new Date(previousMonth.getTime() - 86_400_000), settled_at: recentUsageAt,
    }).where("ai_request_id", "=", laterSettledRequestId).execute();
    try {
      const response = await app.inject({ method: "GET",
        url: `/provider-resources/utilization?month=${currentMonth}`,
        headers: { cookie: adminCookie } });
      expect(response.json().resources.find(
        (resource: { resourceId: string }) => resource.resourceId === apiResourceId,
      )).toMatchObject({ requestCount: 1, realTokens: "1000",
        lastSettledRequestAt: recentUsageAt.toISOString() });
    } finally {
      await db.updateTable("ledger_line").set({ created_at: recentUsageAt, settled_at: null })
        .where("id", "=", original.id).execute();
      await db.deleteFrom("ledger_line").where("ai_request_id", "=", laterSettledRequestId).execute();
      await db.deleteFrom("usage_event").where("ai_request_id", "=", laterSettledRequestId).execute();
      await db.deleteFrom("upstream_attempt").where("ai_request_id", "=", laterSettledRequestId).execute();
      await db.deleteFrom("ai_request").where("id", "=", laterSettledRequestId).execute();
    }
  });

  it("POOL20-047：API 月预算按资源和月份追加版本，支持幂等、冲突、清除和租户隔离", async () => {
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId,
      provider_resource_id: apiResourceId,
      version: 2,
      source: "ADMIN",
      collected_at: new Date(`${currentMonth}-01T00:00:00+08:00`),
      currency: "CNY",
      current_balance: "100",
    }).execute();
    const idempotencyKey = randomUUID();
    const createPayload = {
      amount: "100.00000000",
      currency: "CNY",
      createdBy: "资源管理员",
      expected_version: 0,
      idempotency_key: idempotencyKey,
    };
    const created = await app.inject({
      method: "PUT",
      url: `/provider-resources/${apiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: createPayload,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      resourceId: apiResourceId,
      month: currentMonth,
      version: 1,
      status: "ACTIVE",
      amount: "100.00000000",
      currency: "CNY",
    });
    const replay = await app.inject({
      method: "PUT",
      url: `/provider-resources/${apiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: createPayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(created.json());
    expect(await count("provider_resource_monthly_budget", `provider_resource_id = '${apiResourceId}'`)).toBe(1);

    const idempotencyConflict = await app.inject({
      method: "PUT",
      url: `/provider-resources/${apiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: { ...createPayload, amount: "200.00000000" },
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.json()).toMatchObject({ error: "idempotency_conflict" });
    const versionConflict = await app.inject({
      method: "PUT",
      url: `/provider-resources/${apiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: { ...createPayload, idempotency_key: randomUUID() },
    });
    expect(versionConflict.statusCode).toBe(409);
    expect(versionConflict.json()).toMatchObject({ error: "conflict" });

    const utilization = await app.inject({
      method: "GET",
      url: `/provider-resources/utilization?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(utilization.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === apiResourceId,
    )).toMatchObject({
      budgetAmount: "100.00000000",
      budgetCurrency: "CNY",
      budgetVersion: 1,
      budgetStatus: "ACTIVE",
      apiCost: "132.50000000",
      utilizationRate: "1.32500000",
      budgetDifference: "-32.50000000",
      utilizationBasis: "API_MONTHLY_BUDGET",
    });

    const codingPlan = await app.inject({
      method: "PUT",
      url: `/provider-resources/${kimiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: createPayload,
    });
    expect(codingPlan.statusCode).toBe(409);
    const isolated = await app.inject({
      method: "GET",
      url: `/provider-resources/${otherApiResourceId}/monthly-budgets?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(isolated.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "PUT",
      url: `/provider-resources/${apiResourceId}/monthly-budgets/${currentMonth}`,
      headers: { cookie: adminCookie },
      payload: {
        amount: null,
        currency: null,
        expected_version: 1,
        idempotency_key: randomUUID(),
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ version: 2, status: "CLEARED", amount: null });
    const history = await app.inject({
      method: "GET",
      url: `/provider-resources/${apiResourceId}/monthly-budgets?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      current: { version: 2, status: "CLEARED" },
      history: [
        { version: 2, status: "CLEARED", createdBy: "资源管理员" },
        { version: 1, status: "ACTIVE", amount: "100.00000000", createdBy: "资源管理员" },
      ],
    });
    expect((await sql<{ count: number }>`
      SELECT count(*)::integer AS count
        FROM operation_log
       WHERE action IN ('provider_resource_monthly_budget.update', 'provider_resource_monthly_budget.clear')
         AND target_id IN (${created.json().id}::uuid, ${cleared.json().id}::uuid)
    `.execute(db)).rows[0]!.count).toBe(2);
    await db.deleteFrom("provider_resource_operating_snapshot")
      .where("provider_resource_id", "=", apiResourceId)
      .where("version", "=", 2)
      .execute();
  });

  it("POOL20-041：订阅周期边界缺失时保留额度事实但不声称周期利用率", async () => {
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId,
      provider_resource_id: kimiResourceId,
      version: 2,
      source: "PROVIDER_SYNC",
      collected_at: new Date(),
      currency: "CNY",
      package_cost: "300",
      total_quota: "100",
      used_quota: "35",
      remaining_quota: "65",
      quota_unit: "POINT",
      effective_from: new Date("2026-08-01T00:00:00+08:00"),
      effective_until: null,
    }).execute();
    const response = await app.inject({
      method: "GET",
      url: `/provider-resources/utilization?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    const kimi = response.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === kimiResourceId,
    );
    expect(kimi).toMatchObject({
      totalQuota: "100.00000000",
      usedQuota: "35.00000000",
      servicePeriodStart: expect.any(String),
      servicePeriodEnd: null,
      utilizationRate: null,
      utilizationBasis: null,
      utilizationStatus: "UNKNOWN",
      idleEntitlementCost: null,
      notCalculableReason: "SUBSCRIPTION_PERIOD_END_NOT_AVAILABLE",
    });
    const endMissingProcurement = await app.inject({
      method: "GET", url: `/procurement-reviews/${currentMonth}`, headers: { cookie: adminCookie },
    });
    expect(endMissingProcurement.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === kimiResourceId,
    )).toMatchObject({
      reviewLabel: "数据不足", utilizationRate: null, idleEntitlementCost: null,
      packageCost: "300.00000000", currency: "CNY",
      notCalculableReason: "SUBSCRIPTION_PERIOD_END_NOT_AVAILABLE",
    });
    expect(endMissingProcurement.json().summary.packageCosts).toEqual([
      { currency: "CNY", amount: "800.00000000" },
    ]);
    const endMissingBill = await app.inject({
      method: "GET", url: `/operating-bills/${currentMonth}`, headers: { cookie: adminCookie },
    });
    expect(endMissingBill.json().providers.find(
      (resource: { providerResourceId: string }) => resource.providerResourceId === kimiResourceId,
    )).toMatchObject({
      utilization: null, planAssessment: null, idleEntitlementCost: null,
      packageCost: "300.00000000", currency: "CNY",
    });
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId,
      provider_resource_id: kimiResourceId,
      version: 3,
      source: "PROVIDER_SYNC",
      collected_at: new Date(Date.now() + 1),
      currency: "CNY",
      package_cost: "300",
      total_quota: "100",
      used_quota: "35",
      remaining_quota: "65",
      quota_unit: "POINT",
      effective_from: null,
      effective_until: new Date("2026-09-01T00:00:00+08:00"),
    }).execute();
    const startMissing = await app.inject({
      method: "GET", url: `/procurement-reviews/${currentMonth}`, headers: { cookie: adminCookie },
    });
    expect(startMissing.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === kimiResourceId,
    )).toMatchObject({
      reviewLabel: "数据不足", utilizationRate: null, idleEntitlementCost: null,
      packageCost: "300.00000000", currency: "CNY",
      notCalculableReason: "SUBSCRIPTION_PERIOD_START_NOT_AVAILABLE",
    });
    expect(startMissing.json().summary.packageCosts).toEqual([
      { currency: "CNY", amount: "800.00000000" },
    ]);
    const startMissingBill = await app.inject({
      method: "GET", url: `/operating-bills/${currentMonth}`, headers: { cookie: adminCookie },
    });
    expect(startMissingBill.json().providers.find(
      (resource: { providerResourceId: string }) => resource.providerResourceId === kimiResourceId,
    )).toMatchObject({
      utilization: null, planAssessment: null, idleEntitlementCost: null,
      packageCost: "300.00000000", currency: "CNY",
    });
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId,
      provider_resource_id: kimiResourceId,
      version: 4,
      source: "PROVIDER_SYNC",
      collected_at: new Date(Date.now() + 2),
      currency: "CNY",
      package_cost: "300",
      total_quota: "100",
      used_quota: "35",
      remaining_quota: "65",
      quota_unit: "POINT",
      effective_from: new Date("2026-08-01T00:00:00+08:00"),
      effective_until: new Date("2026-09-01T00:00:00+08:00"),
    }).execute();
  });

  it("超过 15 分钟的预测不返回精确日期，最近使用和闲置只保留事实", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/provider-resources/utilization?month=${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    const api = response.json().resources.find((resource: { resourceId: string }) => resource.resourceId === apiResourceId);
    expect(api).toMatchObject({
      forecastExhaustAt: null,
      nextRecoverAt: null,
      coverageHours: null,
      forecastNotCalculableReason: "FORECAST_STALE",
      idleStatus: "UNASSESSED",
    });
    expect(api.forecastDataAt).toEqual(expect.any(String));
    expect(api.lastSettledRequestAt).toEqual(expect.any(String));
    expect(api.continuousNoCallDays).toBeGreaterThanOrEqual(1);
  });
});

describe("W20-09 轻量采购复盘", () => {
  it("POOL20-047：已关账采购复盘继续读取关账时的预算版本", async () => {
    const month = "2025-06";
    const monthDate = `${month}-01`;
    const firstBudgetId = randomUUID();
    await db.insertInto("provider_resource_monthly_budget").values({
      id: firstBudgetId, enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      month: monthDate, version: 1, status: "ACTIVE", amount: "100", currency: "CNY",
      created_by: adminId, idempotency_key: randomUUID(), request_hash: "a".repeat(64),
      response_snapshot: {},
    }).execute();
    const draft = await app.operatingBillRepo.getBill(enterpriseId, month);
    expect(draft.providers.find((row) => row.providerResourceId === apiResourceId)).toMatchObject({
      monthlyBudgetId: firstBudgetId, monthlyBudgetVersion: 1, monthlyBudgetAmount: "100.00000000",
    });
    const period = await db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: monthDate, status: "CLOSED",
      current_version: 1, created_by: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    const frozen = { ...draft, status: "CLOSED", version: 1,
      closedAt: new Date().toISOString(), closedBy: "资源管理员" };
    await db.insertInto("operating_bill_version").values({
      enterprise_id: enterpriseId, period_id: period.id, version: 1,
      snapshot: frozen as unknown as Record<string, unknown>, close_note: "POOL20-047 冻结",
      closed_by: adminId,
    }).execute();
    await db.updateTable("provider_resource_monthly_budget").set({ is_current: false })
      .where("id", "=", firstBudgetId).execute();
    await db.insertInto("provider_resource_monthly_budget").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      month: monthDate, version: 2, status: "ACTIVE", amount: "200", currency: "CNY",
      created_by: adminId, idempotency_key: randomUUID(), request_hash: "b".repeat(64),
      response_snapshot: {},
    }).execute();

    const response = await app.inject({
      method: "GET", url: `/procurement-reviews/${month}`, headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === apiResourceId,
    )).toMatchObject({ budgetAmount: "100.00000000", budgetVersion: 1 });

    await db.deleteFrom("operating_bill_version").where("period_id", "=", period.id).execute();
    await db.deleteFrom("operating_bill_period").where("id", "=", period.id).execute();
    await db.deleteFrom("provider_resource_monthly_budget")
      .where("provider_resource_id", "=", apiResourceId).where("month", "=", monthDate).execute();
  });

  it("旧 CLOSED JSON 缺少币种数组时安全投影冻结 scalar，不改写历史账单", async () => {
    const legacyMonth = "2025-07";
    const draft = await app.operatingBillRepo.getBill(enterpriseId, legacyMonth);
    const legacy = JSON.parse(JSON.stringify(draft)) as Record<string, unknown> & {
      summary: Record<string, unknown>;
    };
    legacy.status = "CLOSED";
    legacy.version = 1;
    legacy.summary.apiCost = "12.50000000";
    legacy.summary.packageCost = "9999999999999999.99999999";
    legacy.summary.endingBalanceCurrency = "USD";
    const legacyProviders = legacy.providers as Array<Record<string, unknown>>;
    const legacyApi = legacyProviders.find((row) => row.mode === "API");
    const legacyPlan = legacyProviders.find((row) => row.mode === "CODING_PLAN");
    expect(legacyApi).toBeDefined();
    expect(legacyPlan).toBeDefined();
    Object.assign(legacyApi!, {
      currency: "USD", apiCost: "12.50000000", apiSpendCurrency: undefined,
    });
    for (const field of ["monthlyBudgetId", "monthlyBudgetVersion", "monthlyBudgetStatus",
      "monthlyBudgetAmount", "monthlyBudgetCurrency", "monthlyBudgetAt"]) delete legacyApi![field];
    Object.assign(legacyPlan!, {
      currency: "CNY", packageCost: "9999999999999999.99999999",
      packageCostCurrency: undefined,
    });
    legacy.providers = [legacyApi!, legacyPlan!];
    delete legacy.summary.apiSpends;
    delete legacy.summary.packageCosts;
    delete legacy.summary.totalSpends;
    const period = await db.insertInto("operating_bill_period").values({
      enterprise_id: enterpriseId, period_month: `${legacyMonth}-01`, status: "CLOSED",
      current_version: 1, created_by: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("operating_bill_version").values({
      enterprise_id: enterpriseId, period_id: period.id, version: 1,
      snapshot: legacy, close_note: "7305 时代冻结账单", closed_by: adminId,
    }).execute();
    await db.insertInto("provider_resource_monthly_budget").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      month: `${legacyMonth}-01`, version: 1, status: "ACTIVE", amount: "999",
      currency: "USD", created_by: adminId, idempotency_key: randomUUID(),
      request_hash: "c".repeat(64), response_snapshot: {},
    }).execute();

    const response = await app.inject({
      method: "GET", url: `/procurement-reviews/${legacyMonth}`, headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toMatchObject({
      apiSpends: [{ currency: "USD", amount: "12.50000000" }],
      packageCosts: [{ currency: "CNY", amount: "9999999999999999.99999999" }],
    });
    expect(response.json().resources.find(
      (resource: { resourceId: string }) => resource.resourceId === apiResourceId,
    )).toMatchObject({
      budgetAmount: null,
      budgetVersion: 0,
      notCalculableReason: "FROZEN_BUDGET_FACT_NOT_AVAILABLE",
    });
    const stored = await db.selectFrom("operating_bill_version").select("snapshot")
      .where("period_id", "=", period.id).executeTakeFirstOrThrow();
    expect((stored.snapshot as { summary: Record<string, unknown> }).summary.apiSpends).toBeUndefined();
    await db.deleteFrom("provider_resource_monthly_budget")
      .where("provider_resource_id", "=", apiResourceId)
      .where("month", "=", `${legacyMonth}-01`).execute();
  });

  it("逐资源返回独立采购事实、利用率、确定性标签和依据", async () => {
    const first = await app.inject({
      method: "GET",
      url: `/procurement-reviews/${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    const second = await app.inject({
      method: "GET",
      url: `/procurement-reviews/${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    const replay = second.json();
    expect(body.resources).toHaveLength(3);
    expect(body.summary).toMatchObject({
      purchaseCashAmounts: [{ currency: "CNY", amount: "920.00000000" }],
      apiSpends: [],
      packageCosts: [{ currency: "CNY", amount: "800.00000000" }],
      planUtilization: "56.25",
    });
    expect(body.note).toEqual({ text: "", version: 0, updatedAt: null, updatedBy: null });
    expect(JSON.stringify(body)).not.toContain("人工判断");

    const byId = new Map(body.resources.map((resource: { resourceId: string }) => [resource.resourceId, resource]));
    expect(byId.get(apiResourceId)).toMatchObject({
      purchaseCashAmount: "120.00000000",
      purchaseCashAmounts: [{ currency: "CNY", amount: "120.00000000" }],
      apiCost: null,
      ledgerApiCost: "12.50000000",
      apiSpendReason: "待补期初余额",
      utilizationRate: null,
      reviewLabel: "数据不足",
      reviewReason: expect.stringContaining("MONTHLY_BUDGET_NOT_CONFIGURED"),
      idleStatus: "UNASSESSED",
    });
    expect(byId.get(kimiResourceId)).toMatchObject({
      purchaseCashAmount: "300.00000000",
      utilizationRate: "0.35000000",
      reviewLabel: "利用不足",
      reviewReason: expect.stringMatching(/套餐|无调用|没有已结算请求/),
      idleStatus: "UNASSESSED",
    });
    expect(byId.get(zhipuResourceId)).toMatchObject({
      purchaseCashAmount: "500.00000000",
      utilizationRate: "0.90000000",
      reviewLabel: "利用不足",
      reviewReason: expect.stringMatching(/套餐|无调用|没有已结算请求/),
      idleStatus: "UNASSESSED",
      servicePeriodStart: expect.stringContaining("2026-06-26"),
      servicePeriodEnd: expect.stringContaining("2026-09-26"),
    });
    expect(byId.get(kimiResourceId).reviewLabel).not.toBe("闲置");
    expect(byId.get(zhipuResourceId).reviewLabel).not.toBe("闲置");
    expect(replay.resources.map((resource: { reviewLabel: string; reviewReason: string }) => ({
      reviewLabel: resource.reviewLabel,
      reviewReason: resource.reviewReason,
    }))).toEqual(body.resources.map((resource: { reviewLabel: string; reviewReason: string }) => ({
      reviewLabel: resource.reviewLabel,
      reviewReason: resource.reviewReason,
    })));
  });

  it("备注使用乐观锁和幂等回执，并发只成功一次，且不修改账本或创建采购", async () => {
    const before = {
      ledger: await count("ledger_line", `enterprise_id = '${enterpriseId}'::uuid`),
      purchases: await count("resource_purchase_record", `enterprise_id = '${enterpriseId}'::uuid`),
      resources: await count("provider_resource", `enterprise_id = '${enterpriseId}'::uuid`),
    };
    const firstPayload = {
      note: "首次复盘：保持观察",
      expected_version: 0,
      idempotency_key: "w20-note-first",
    };
    const first = await app.inject({
      method: "PUT",
      url: `/procurement-reviews/${currentMonth}/note`,
      headers: { cookie: adminCookie },
      payload: firstPayload,
    });
    const replay = await app.inject({
      method: "PUT",
      url: `/procurement-reviews/${currentMonth}/note`,
      headers: { cookie: adminCookie },
      payload: firstPayload,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ note: firstPayload.note, version: 1 });

    const reusedKey = await app.inject({
      method: "PUT",
      url: `/procurement-reviews/${currentMonth}/note`,
      headers: { cookie: adminCookie },
      payload: { ...firstPayload, note: "同键异参" },
    });
    const staleVersion = await app.inject({
      method: "PUT",
      url: `/procurement-reviews/${currentMonth}/note`,
      headers: { cookie: adminCookie },
      payload: { note: "过期写入", expected_version: 0, idempotency_key: "w20-note-stale" },
    });
    expect(reusedKey.statusCode).toBe(409);
    expect(reusedKey.json()).toMatchObject({ error: "idempotency_conflict" });
    expect(staleVersion.statusCode).toBe(409);
    expect(staleVersion.json()).toMatchObject({ error: "conflict" });

    const concurrent = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/procurement-reviews/${currentMonth}/note`,
        headers: { cookie: adminCookie },
        payload: { note: "并发备注 A", expected_version: 1, idempotency_key: "w20-note-a" },
      }),
      app.inject({
        method: "PUT",
        url: `/procurement-reviews/${currentMonth}/note`,
        headers: { cookie: adminCookie },
        payload: { note: "并发备注 B", expected_version: 1, idempotency_key: "w20-note-b" },
      }),
    ]);
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const review = await app.inject({
      method: "GET",
      url: `/procurement-reviews/${currentMonth}`,
      headers: { cookie: adminCookie },
    });
    expect(review.json().note).toMatchObject({ version: 2, updatedBy: "资源管理员" });
    expect(["并发备注 A", "并发备注 B"]).toContain(review.json().note.text);

    expect(await count("procurement_review_note", `enterprise_id = '${enterpriseId}'::uuid AND month = '${currentMonthStart}'::date`)).toBe(1);
    expect(await count("procurement_review_note_idempotency", `enterprise_id = '${enterpriseId}'::uuid AND month = '${currentMonthStart}'::date`)).toBe(2);
    expect(await count("operation_log", `enterprise_id = '${enterpriseId}'::uuid AND action = 'procurement_review_note.update'`)).toBe(2);
    const audits = await sql<{ change_summary: unknown }>`
      SELECT change_summary
        FROM operation_log
       WHERE enterprise_id = ${enterpriseId}::uuid
         AND action = 'procurement_review_note.update'
       ORDER BY created_at
    `.execute(db);
    expect(JSON.stringify(audits.rows)).not.toContain("首次复盘");
    expect(JSON.stringify(audits.rows)).not.toContain("并发备注");

    expect({
      ledger: await count("ledger_line", `enterprise_id = '${enterpriseId}'::uuid`),
      purchases: await count("resource_purchase_record", `enterprise_id = '${enterpriseId}'::uuid`),
      resources: await count("provider_resource", `enterprise_id = '${enterpriseId}'::uuid`),
    }).toEqual(before);
  });
});
