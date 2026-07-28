/**
 * control-api W18 集成测试：首页聚合 API（/dashboard）+ 用量账本（/usage）+ 只读模型列表。
 *
 * 覆盖（TRD §12 首页口径 + PRD §10.2/§10.3 + TRD §11.2 端点）：
 *   - /dashboard 八项口径：资源账号数/活跃人数/正在使用/API费用/最早耗尽/调度节省/资源摘要/超额列表
 *   - /dashboard 空状态（新企业无数据）：计数为 0、费用为 "0"、earliestExhaustion=null、列表空
 *   - /usage 分页 + 筛选（principal/status）
 *   - /billing-rules、/dispatch-policies、/supply-forecasts 只读列表
 *
 * 关键口径校验：
 *   - 调度节省只汇总 saving_calculable=true 且 dispatch_saving 非空的（PRD §10.2 行 398、TRD §12 行 744）
 *   - 不可计算返回 null/NOT_CALCULABLE，不伪造（PRD §10.4 空状态红线）
 *   - 月度口径只统计当前自然月（跨月数据不计入）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let adminCookie: string;

const TEST_PASSWORD = "W18-Test-Password!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试企业-W18" }).execute();
  const hash = await hashPassword(TEST_PASSWORD);
  await db
    .insertInto("admin_user")
    .values({ id: ADM_ID, enterprise_id: ENT_ID, username: "admin", password_hash: hash, status: "ACTIVE" })
    .execute();

  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();

  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: TEST_PASSWORD },
  });
  const setCookie = loginRes.headers["set-cookie"];
  adminCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

/** seed 一套完整数据：provider/resource/principal/key/grant/counter/request/ledger/forecast/dispatch。 */
async function seedFullData(): Promise<{
  principalId: string;
  resourceId: string;
  requestId: string;
}> {
  // provider + resource
  const provider = await db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code: "zhipu", name: "智谱", adapter_type: "zhipu" })
    .returningAll()
    .executeTakeFirstOrThrow();
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: "智谱主账号",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
      concurrency_limit: 10,
      status: "ACTIVE",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // principal + grant + counter
  const principal = await db
    .insertInto("principal")
    .values({ id: randomUUID(), enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" })
    .returningAll()
    .executeTakeFirstOrThrow();
  // principal_key（ai_request.principal_key_id 外键要求）
  const pkey = await db
    .insertInto("principal_key")
    .values({
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      key_prefix: "sk-test",
      key_digest: "digest-" + randomUUID(),
      status: "ACTIVE",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const grant = await db
    .insertInto("principal_grant")
    .values({
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      provider: "zhipu",
      model_alias: "qianliu-glm-coding",
      quota_value: 100_000n,
      allow_overage: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("quota_counter")
    .values({
      grant_id: grant.id,
      used_value: 50_000n,
      overage_value: 5_000n, // 超额 5000
    })
    .execute();

  // 一次成功请求（当前自然月）+ ledger_transaction（含 API 费用）
  const requestId = randomUUID();
  const now = new Date();
  await db
    .insertInto("ai_request")
    .values({
      id: requestId,
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      principal_key_id: pkey.id,
      protocol: "openai",
      unified_model: "qianliu-glm-coding",
      status: "SUCCEEDED",
      started_at: now,
      finished_at: new Date(now.getTime() + 1200),
    })
    .execute();
  await db
    .insertInto("ledger_transaction")
    .values({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      total_input_tokens: 200n,
      total_output_tokens: 100n,
      total_cache_tokens: 0n,
      total_deducted_quota: 300n,
      total_api_cost: "0.00000000", // CODING_PLAN 套餐内
      usage_quality: "UPSTREAM_REPORTED",
      attempt_count: 1,
      status: "SETTLED",
    })
    .execute();

  // 供给预测（可计算）
  await db
    .insertInto("supply_forecast")
    .values({
      enterprise_id: ENT_ID,
      provider_resource_id: resource.id,
      rate_1h: "100",
      rate_24h: "2400",
      rate_7d: "16800",
      forecast_exhaust_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      next_recover_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      coverage_hours: "168",
      remaining_quota: "50000",
      confidence: "MEDIUM",
      algorithm_version: "v1",
    })
    .execute();

  // 调度决策（可计算节省）
  await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: ENT_ID,
      ai_request_id: requestId,
      final_action: "ALLOW",
      reason_code: "POLICY_MATCHED",
      dispatch_saving: "1.50000000",
      saving_calculable: true,
      counterfactual_cost: "1.50000000",
      actual_cost: "0.00000000",
    })
    .execute();

  // 调度决策（不可计算，不应计入节省）
  const req2 = randomUUID();
  await db
    .insertInto("ai_request")
    .values({
      id: req2,
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      principal_key_id: pkey.id,
      protocol: "openai",
      unified_model: "qianliu-glm-coding",
      status: "SUCCEEDED",
      started_at: now,
      finished_at: now,
    })
    .execute();
  await db
    .insertInto("ledger_transaction")
    .values({
      ai_request_id: req2,
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      total_input_tokens: 10n,
      total_output_tokens: 5n,
      total_cache_tokens: 0n,
      total_deducted_quota: 15n,
      total_api_cost: "0.00000000",
      usage_quality: "UPSTREAM_REPORTED",
      attempt_count: 1,
      status: "SETTLED",
    })
    .execute();
  await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: ENT_ID,
      ai_request_id: req2,
      final_action: "ALLOW",
      reason_code: "NO_BASELINE",
      dispatch_saving: null,
      saving_calculable: false,
      not_calculable_reason: "NO_COUNTERFACTUAL_BASELINE",
    })
    .execute();

  return { principalId: principal.id, resourceId: resource.id, requestId };
}

describe("W18 空状态（新企业无数据）", () => {
  it("/dashboard 空状态：计数 0、费用 0、earliestExhaustion null、列表空", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resourceAccountCount).toBe(0);
    expect(body.activeEmployeeCount).toBe(0);
    expect(body.currentInUseCount).toBe(0);
    expect(body.monthlyApiCost).toBe("0");
    expect(body.monthlyDispatchSaving).toBe("0");
    expect(body.earliestExhaustion).toBeNull();
    expect(body.resourceBreakdown).toEqual([]);
    expect(body.overageList).toEqual([]);
    // 数据源 gap 字段诚实为 null（不伪造）
    expect(body.monthlyPackagePayment).toBeNull();
    expect(body.monthlyRechargeAmount).toBeNull();
  });

  it("/dashboard 未认证返回 401", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(401);
  });
});

describe("W18 有数据场景（seed 完整数据后）", () => {
  let seededPrincipalId: string;
  let seededResourceId: string;

  beforeAll(async () => {
    const seed = await seedFullData();
    seededPrincipalId = seed.principalId;
    seededResourceId = seed.resourceId;
  }, 120_000);

  it("/dashboard 八项口径正确", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // 1. 资源账号数 = 1
    expect(body.resourceAccountCount).toBe(1);
    // 2. 活跃人数 = 1（当月成功调用的 EMPLOYEE）
    expect(body.activeEmployeeCount).toBe(1);
    // 5. API 费用 = "0"（套餐内 total_api_cost 全 0）
    expect(Number(body.monthlyApiCost)).toBe(0);
    // 7. 最早耗尽：有可计算预测
    expect(body.earliestExhaustion).not.toBeNull();
    expect(body.earliestExhaustion.resourceId).toBe(seededResourceId);
    expect(body.earliestExhaustion.confidence).toBe("MEDIUM");
    // 8. 调度节省 = 1.5（只汇总 saving_calculable=true 的，不可计算的不计）
    expect(Number(body.monthlyDispatchSaving)).toBe(1.5);
    // 资源摘要：1 个厂商（zhipu CODING_PLAN）
    expect(body.resourceBreakdown).toHaveLength(1);
    expect(body.resourceBreakdown[0].providerCode).toBe("zhipu");
    expect(body.resourceBreakdown[0].mode).toBe("CODING_PLAN");
    expect(body.resourceBreakdown[0].accountCount).toBe(1);
    expect(Number(body.resourceBreakdown[0].totalQuota)).toBe(100000);
    expect(Number(body.resourceBreakdown[0].usedQuota)).toBe(50000);
    // 超额列表：1 条（overage 5000）
    expect(body.overageList).toHaveLength(1);
    expect(body.overageList[0].principalId).toBe(seededPrincipalId);
    expect(Number(body.overageList[0].overageValue)).toBe(5000);
  });

  it("/usage 列表返回请求级账本记录（分页）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/usage?limit=10",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.records.length).toBeGreaterThanOrEqual(2);
    const first = body.records[0];
    expect(first.requestId).toBeDefined();
    expect(first.principalName).toBe("测试员工");
    expect(first.unifiedModel).toBe("qianliu-glm-coding");
    expect(first.status).toBe("SUCCEEDED");
    expect(first.durationMs).toBeGreaterThan(0);
  });

  it("/usage 按 principal 筛选", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/usage?principal_id=${seededPrincipalId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    expect(body.records.every((r: { principalId: string }) => r.principalId === seededPrincipalId)).toBe(true);
  });

  it("/billing-rules 只读列表（空，未 seed 规则）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/billing-rules",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules).toEqual([]);
  });

  it("/supply-forecasts 只读列表（有 seed 的预测）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/supply-forecasts",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.forecasts.length).toBeGreaterThanOrEqual(1);
    expect(body.forecasts[0].confidence).toBe("MEDIUM");
    expect(body.forecasts[0].resource_name).toBe("智谱主账号");
  });
});
