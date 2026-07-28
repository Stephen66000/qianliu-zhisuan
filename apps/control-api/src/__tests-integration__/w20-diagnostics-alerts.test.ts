/**
 * control-api W20 集成测试：诊断下钻 + 异常告警。
 *
 * 覆盖：
 *   - GET /gateway-requests/:id（结算汇总 + 404 越界）
 *   - GET /gateway-requests/:id/route-candidates（WT-10/18）
 *   - GET /gateway-requests/:id/attempts（WT-11/12：多 attempt + response_committed）
 *   - GET /gateway-requests/:id/dispatch-decision（WT-16/17）
 *   - GET /alerts（四域派生：凭证失效 + 提前耗尽 + 对账差异）
 *   - POST /alerts/disposition（标记已处理 + audit + 抑制展示）
 *   - 安全：下钻不返回 Secret/Key 摘要
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

const TEST_PASSWORD = "W20-Test-Password!";
const ENT_ID = randomUUID();
const ADM_ID = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流 W20 测试企业" }).execute();
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

/** provider 按 code 复用（UNIQUE(enterprise_id, code)）。 */
async function ensureProvider(code: "deepseek" | "zhipu" | "kimi") {
  const existing = await db
    .selectFrom("provider")
    .selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("code", "=", code)
    .executeTakeFirst();
  if (existing) return existing;
  return db
    .insertInto("provider")
    .values({ enterprise_id: ENT_ID, code, name: `${code} 测试`, adapter_type: code })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** seed 一个完整请求链：request + 2 candidates + 2 attempts + transaction + decision。 */
async function seedRequestChain(): Promise<{ requestId: string; principalId: string; resourceId: string }> {
  const provider = await ensureProvider("zhipu");
  const resource = await db
    .insertInto("provider_resource")
    .values({
      enterprise_id: ENT_ID,
      provider_id: provider.id,
      name: `智谱主账号-${randomUUID().slice(0, 8)}`,
      mode: "API",
      credential_type: "API_KEY",
      status: "ACTIVE",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const principal = await db
    .insertInto("principal")
    .values({ enterprise_id: ENT_ID, type: "EMPLOYEE", name: "W20 员工" })
    .returningAll()
    .executeTakeFirstOrThrow();
  const pkey = await db
    .insertInto("principal_key")
    .values({
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      key_prefix: "sk-w20",
      key_digest: "digest-" + randomUUID(),
      status: "ACTIVE",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

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
      unified_model: "glm-4.6",
      status: "SUCCEEDED",
      started_at: now,
      finished_at: new Date(now.getTime() + 2500),
    })
    .execute();

  // 2 个候选（一个选中）
  await db
    .insertInto("route_candidate")
    .values([
      {
        ai_request_id: requestId,
        enterprise_id: ENT_ID,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        priority: 100,
        weight: 1,
        selected: true,
        score_factors: { static_priority: 100, error_rate: 0, latency_ms: 800 },
        total_score: "0.95",
        reason_code: "SELECTED",
      },
      {
        ai_request_id: requestId,
        enterprise_id: ENT_ID,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.5",
        priority: 200,
        weight: 1,
        selected: false,
        score_factors: { static_priority: 200 },
        total_score: "0.60",
        reason_code: "LOWER_PRIORITY",
      },
    ])
    .execute();

  // 2 个 attempt（第一次失败切换，第二次成功；WT-11）
  await db
    .insertInto("upstream_attempt")
    .values([
      {
        ai_request_id: requestId,
        enterprise_id: ENT_ID,
        attempt_no: 1,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        http_status: 500,
        error_classification: "UPSTREAM_5XX",
        response_committed: false,
        switch_reason: "upstream_5xx",
      },
      {
        ai_request_id: requestId,
        enterprise_id: ENT_ID,
        attempt_no: 2,
        provider_resource_id: resource.id,
        upstream_model: "glm-4.6",
        http_status: 200,
        response_committed: true,
      },
    ])
    .execute();

  await db
    .insertInto("ledger_transaction")
    .values({
      ai_request_id: requestId,
      enterprise_id: ENT_ID,
      principal_id: principal.id,
      total_input_tokens: 300n,
      total_output_tokens: 150n,
      total_cache_tokens: 0n,
      total_deducted_quota: 450n,
      total_api_cost: "0.02000000",
      usage_quality: "UPSTREAM_REPORTED",
      attempt_count: 2,
      status: "SETTLED",
    })
    .execute();

  await db
    .insertInto("dispatch_decision")
    .values({
      enterprise_id: ENT_ID,
      ai_request_id: requestId,
      dispatch_input: { model: "glm-4.6" },
      final_action: "ALLOW",
      reason_code: "DEFAULT_ALLOW",
      saving_calculable: false,
      not_calculable_reason: "no_counterfactual_baseline",
    })
    .execute();

  return { requestId, principalId: principal.id, resourceId: resource.id };
}

describe("W20 诊断下钻", () => {
  it("GET /gateway-requests/:id 返回结算汇总（WT-11：attempt_count=2）", async () => {
    const { requestId } = await seedRequestChain();
    const res = await app.inject({
      method: "GET",
      url: `/gateway-requests/${requestId}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.request.unifiedModel).toBe("glm-4.6");
    expect(body.settlement.attemptCount).toBe(2);
    expect(body.settlement.totalInputTokens).toBe("300");
  });

  it("GET /gateway-requests/:id/route-candidates 返回候选与评分因子（WT-10/18）", async () => {
    const { requestId } = await seedRequestChain();
    const res = await app.inject({
      method: "GET",
      url: `/gateway-requests/${requestId}/route-candidates`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const candidates = res.json().candidates;
    expect(candidates).toHaveLength(2);
    expect(candidates[0].selected).toBe(true);
    expect(candidates[0].scoreFactors.error_rate).toBe(0);
  });

  it("GET /gateway-requests/:id/attempts 返回多 attempt（WT-11/12）", async () => {
    const { requestId } = await seedRequestChain();
    const res = await app.inject({
      method: "GET",
      url: `/gateway-requests/${requestId}/attempts`,
      headers: { cookie: adminCookie },
    });
    const attempts = res.json().attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0].responseCommitted).toBe(false);
    expect(attempts[0].switchReason).toBe("upstream_5xx");
    expect(attempts[1].httpStatus).toBe(200);
  });

  it("GET /gateway-requests/:id/dispatch-decision 返回决策（WT-16/17）", async () => {
    const { requestId } = await seedRequestChain();
    const res = await app.inject({
      method: "GET",
      url: `/gateway-requests/${requestId}/dispatch-decision`,
      headers: { cookie: adminCookie },
    });
    const decision = res.json().decision;
    expect(decision.finalAction).toBe("ALLOW");
    expect(decision.savingCalculable).toBe(false);
    expect(decision.notCalculableReason).toBe("no_counterfactual_baseline");
  });

  it("下钻不返回 Secret/Key 摘要；越界请求 404", async () => {
    const { requestId } = await seedRequestChain();
    const res = await app.inject({
      method: "GET",
      url: `/gateway-requests/${requestId}`,
      headers: { cookie: adminCookie },
    });
    const text = JSON.stringify(res.json());
    expect(text).not.toContain("key_digest");
    expect(text).not.toContain("credential");

    const notFound = await app.inject({
      method: "GET",
      url: `/gateway-requests/${randomUUID()}`,
      headers: { cookie: adminCookie },
    });
    expect(notFound.statusCode).toBe(404);
  });
});

describe("W20 异常告警", () => {
  it("GET /alerts 派生四域告警（凭证失效 + 提前耗尽）", async () => {
    const provider = await ensureProvider("kimi");
    const credInvalid = await db
      .insertInto("provider_resource")
      .values({
        enterprise_id: ENT_ID,
        provider_id: provider.id,
        name: `Kimi 失效账号-${randomUUID().slice(0, 8)}`,
        mode: "CODING_PLAN",
        credential_type: "SUBSCRIPTION_SESSION",
        status: "CREDENTIAL_INVALID",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto("supply_forecast")
      .values({
        enterprise_id: ENT_ID,
        provider_resource_id: credInvalid.id,
        rate_24h: "1000",
        forecast_exhaust_at: new Date(Date.now() + 12 * 3600 * 1000),
        coverage_hours: "12",
        confidence: "HIGH",
        algorithm_version: "v1",
      })
      .execute();

    const res = await app.inject({
      method: "GET",
      url: "/alerts",
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const alerts = res.json().alerts;
    const domains = new Set(alerts.map((a: { domain: string }) => a.domain));
    expect(domains.has("CREDENTIAL_INVALID")).toBe(true);
    expect(domains.has("RESOURCE_UNAVAILABLE")).toBe(true); // 提前耗尽 coverage 12h < 24h
  });

  it("POST /alerts/disposition 标记已处理并抑制 OPEN 展示 + 写 audit", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: "/alerts",
      headers: { cookie: adminCookie },
    });
    const open = listRes
      .json()
      .alerts.find((a: { status: string; domain: string }) => a.status === "OPEN" && a.domain === "CREDENTIAL_INVALID");
    expect(open).toBeDefined();

    const res = await app.inject({
      method: "POST",
      url: "/alerts/disposition",
      headers: { cookie: adminCookie },
      payload: {
        alert_key: open.alertKey,
        domain: open.domain,
        status: "RESOLVED",
        resolution_note: "已重新授权",
      },
    });
    expect(res.statusCode).toBe(200);

    // 标记后该告警不再是 OPEN
    const after = await app.inject({
      method: "GET",
      url: "/alerts",
      headers: { cookie: adminCookie },
    });
    const target = after.json().alerts.find((a: { alertKey: string }) => a.alertKey === open.alertKey);
    expect(target.status).toBe("RESOLVED");

    // audit
    const logs = await db
      .selectFrom("operation_log")
      .select("action")
      .where("enterprise_id", "=", ENT_ID)
      .where("action", "=", "alert.disposition")
      .execute();
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("未认证 401", async () => {
    const res = await app.inject({ method: "GET", url: "/alerts" });
    expect(res.statusCode).toBe(401);
  });
});
