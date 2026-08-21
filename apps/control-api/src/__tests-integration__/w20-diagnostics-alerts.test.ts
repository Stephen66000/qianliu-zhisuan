/**
 * control-api W20 集成测试：诊断下钻 + 异常告警。
 *
 * 覆盖：
 *   - GET /gateway-requests/:id（结算汇总 + 404 越界）
 *   - GET /gateway-requests/:id/route-candidates（WT-10/18）
 *   - GET /gateway-requests/:id/attempts（WT-11/12：多 attempt + response_committed）
 *   - GET /gateway-requests/:id/dispatch-decision（WT-16/17）
 *   - GET /alerts（TRD §13 四域八类技术信号）
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
  pg = process.env.POOL048_CONTROL_DATABASE_URL
    ? { connectionString: process.env.POOL048_CONTROL_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer();
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
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
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

  it("POOL20-048：Attempt 诊断按白名单返回，污染 jsonb fail-closed 且跨企业 404", async () => {
    const { requestId } = await seedRequestChain();
    const attempt = await db.selectFrom("upstream_attempt")
      .select("id").where("ai_request_id", "=", requestId).orderBy("attempt_no").executeTakeFirstOrThrow();
    const evidence = {
      httpStatus: 400, type: "invalid_request_error", code: "invalid_request_error",
      param: "tools[].function.parameters.properties.*",
      messageCategory: "INVALID_TOOL_SCHEMA", diagnosticHash: "4".repeat(64),
    };
    const shape = {
      topLevelFields: ["messages", "model", "stream", "stream_options", "tools"],
      messageCount: 2, messageRoles: { system: 1, user: 1 }, contentKinds: ["string"],
      contentBlockTypes: [], assistantToolCallCount: 0, toolResultCount: 0,
      unmatchedAssistantToolCallCount: 0, unmatchedToolResultCount: 0,
      toolCount: 1, functionToolCount: 1, invalidToolCount: 1,
      toolSchemaIssueCounts: { FUNCTION_NAME_INVALID: 1 }, toolTypes: ["function"],
      schemaKeywords: ["properties", "required", "type"], schemaMaxDepth: 4,
      schemaNodeCount: 10, schemaPropertyCount: 2, toolChoiceKind: "auto",
      stream: true, streamOptionsIncluded: true, countOverflowed: false,
    };
    await db.updateTable("upstream_attempt").set({
      upstream_error_evidence: evidence,
      request_shape_summary: shape,
    }).where("id", "=", attempt.id).execute();

    const safe = await app.inject({
      method: "GET", url: `/gateway-requests/${requestId}/attempts`,
      headers: { cookie: adminCookie },
    });
    expect(safe.statusCode).toBe(200);
    expect(safe.json().attempts[0]).toMatchObject({
      upstreamErrorEvidence: evidence,
      requestShapeSummary: shape,
    });

    const canary = "POOL048_PRIVATE_CONTROL_CANARY";
    await db.updateTable("upstream_attempt").set({
      upstream_error_evidence: { message: canary },
      request_shape_summary: { toolName: canary },
    }).where("id", "=", attempt.id).execute();
    const polluted = await app.inject({
      method: "GET", url: `/gateway-requests/${requestId}/attempts`,
      headers: { cookie: adminCookie },
    });
    expect(polluted.statusCode).toBe(200);
    expect(polluted.json().attempts[0]).toMatchObject({
      upstreamErrorEvidence: null,
      requestShapeSummary: null,
    });
    expect(JSON.stringify(polluted.json())).not.toContain(canary);

    const otherEnterpriseId = randomUUID();
    const otherPrincipalId = randomUUID();
    const otherKeyId = randomUUID();
    const otherRequestId = randomUUID();
    await db.insertInto("enterprise").values({ id: otherEnterpriseId, name: "POOL048 其他企业" }).execute();
    await db.insertInto("principal").values({
      id: otherPrincipalId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "其他员工",
    }).execute();
    await db.insertInto("principal_key").values({
      id: otherKeyId, enterprise_id: otherEnterpriseId, principal_id: otherPrincipalId,
      key_prefix: "pool048-other", key_digest: randomUUID(), allowed_model_ids: [],
    }).execute();
    await db.insertInto("ai_request").values({
      id: otherRequestId, enterprise_id: otherEnterpriseId, principal_id: otherPrincipalId,
      principal_key_id: otherKeyId, protocol: "chat", unified_model: "ql-other",
    }).execute();
    const denied = await app.inject({
      method: "GET", url: `/gateway-requests/${otherRequestId}/attempts`,
      headers: { cookie: adminCookie },
    });
    expect(denied.statusCode).toBe(404);
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

describe("W20 异常告警（alert_event 生命周期）", () => {
  it("GET /alerts 派生并落库（凭证失效 + 提前耗尽按最新快照）", async () => {
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
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ENT_ID,
      provider_resource_id: credInvalid.id,
      version: 1,
      source: "PROVIDER_SYNC",
      collected_at: new Date(Date.now() - 60_000),
      total_quota: "10000",
      used_quota: "9000",
      remaining_quota: "1000",
      quota_unit: "TOKEN",
    }).execute();
    await db
      .insertInto("supply_forecast")
      .values({
        enterprise_id: ENT_ID,
        provider_resource_id: credInvalid.id,
        rate_24h: "1000",
        forecast_exhaust_at: new Date(Date.now() + 12 * 3600 * 1000),
        coverage_hours: "12",
        remaining_quota: "1000",
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
    expect(domains.has("RESOURCE_UNAVAILABLE")).toBe(true);

    // 已落 alert_event（持久化事实）
    const rows = await db
      .selectFrom("alert_event")
      .selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("TRD §13 四域八类技术信号全部落入 alert_event", async () => {
    const { requestId, principalId, resourceId } = await seedRequestChain();
    const key = await db
      .selectFrom("principal_key")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("principal_id", "=", principalId)
      .executeTakeFirstOrThrow();

    await db
      .updateTable("provider_resource")
      .set({ status: "DEGRADED", consecutive_failures: 4 })
      .where("id", "=", resourceId)
      .execute();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: ENT_ID,
      provider_resource_id: resourceId,
      version: 1,
      source: "PROVIDER_SYNC",
      collected_at: new Date(Date.now() - 60_000),
      total_quota: "1000",
      used_quota: "900",
      remaining_quota: "100",
      quota_unit: "TOKEN",
    }).execute();
    await db
      .insertInto("supply_forecast")
      .values({
        enterprise_id: ENT_ID,
        provider_resource_id: resourceId,
        forecast_exhaust_at: new Date(Date.now() + 2 * 3600 * 1000),
        coverage_hours: "2",
        remaining_quota: "100",
        confidence: "HIGH",
        algorithm_version: "w20-eight-signals",
      })
      .execute();

    const grant = await db
      .insertInto("principal_grant")
      .values({
        enterprise_id: ENT_ID,
        principal_id: principalId,
        provider: "zhipu",
        model_alias: `eight-signals-${randomUUID().slice(0, 8)}`,
        quota_value: 1000n,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("quota_counter")
      .values({ grant_id: grant.id, used_value: 950n, overage_value: 10n })
      .execute();

    const run = await db
      .insertInto("reconciliation_run")
      .values({
        enterprise_id: ENT_ID,
        range_from: new Date(Date.now() - 3600 * 1000),
        range_to: new Date(),
        result: "REVIEW",
        algorithm_version: "w20-eight-signals",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("reconciliation_discrepancy")
      .values({
        enterprise_id: ENT_ID,
        reconciliation_run_id: run.id,
        discrepancy_type: "SETTLEMENT_MISMATCH",
        ai_request_id: requestId,
        detail: { expected: "450", actual: "449" },
      })
      .execute();

    const routingRequestId = randomUUID();
    const streamingRequestId = randomUUID();
    await db
      .insertInto("ai_request")
      .values([
        {
          id: routingRequestId,
          enterprise_id: ENT_ID,
          principal_id: principalId,
          principal_key_id: key.id,
          protocol: "openai",
          unified_model: "glm-4.6",
          status: "FAILED",
          error_classification: "NO_AVAILABLE_RESOURCE",
          error_code: "NO_CANDIDATE",
        },
        {
          id: streamingRequestId,
          enterprise_id: ENT_ID,
          principal_id: principalId,
          principal_key_id: key.id,
          protocol: "openai",
          unified_model: "glm-4.6",
          stream: true,
          status: "FAILED",
          error_classification: "STREAM_INTERRUPTED",
          error_code: "UPSTREAM_STREAM_CLOSED",
        },
      ])
      .execute();

    const provider = await ensureProvider("deepseek");
    await db
      .insertInto("provider_resource")
      .values({
        enterprise_id: ENT_ID,
        provider_id: provider.id,
        name: `八信号凭证-${randomUUID().slice(0, 8)}`,
        mode: "API",
        credential_type: "API_KEY",
        status: "CREDENTIAL_INVALID",
      })
      .execute();

    const policy = await db
      .insertInto("dispatch_policy")
      .values({
        enterprise_id: ENT_ID,
        status: "PUBLISHED",
        action: "SWITCH",
        policy_version: `eight-signals-${randomUUID().slice(0, 8)}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .updateTable("dispatch_decision")
      .set({
        matched_policy_id: policy.id,
        matched_policy_action: "SWITCH",
        final_action: "ALLOW",
      })
      .where("ai_request_id", "=", requestId)
      .execute();

    const response = await app.inject({
      method: "GET",
      url: "/alerts",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const signals = new Set(
      response.json().alerts.map((alert: { signal: string }) => alert.signal),
    );
    expect(signals.size).toBeGreaterThanOrEqual(8);
    for (const signal of [
      "resource_unavailable",
      "principal_usage_anomaly",
      "call_deduction_anomaly",
      "credential_security_anomaly",
      "routing_anomaly",
      "streaming_anomaly",
      "supply_anomaly",
      "dispatch_anomaly",
    ]) {
      expect(signals.has(signal), signal).toBe(true);
    }
  });

  it("evaluate 幂等：重复调用同 key 不重复插入，只刷新 last_seen", async () => {
    await app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } });
    const before = await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("status", "=", "OPEN")
      .execute();
    await app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } });
    const after = await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("status", "=", "OPEN")
      .execute();
    expect(after.length).toBe(before.length); // 无重复插入
  });

  it("evaluate 并发幂等：同一新信号只产生一条 OPEN 事件", async () => {
    const provider = await ensureProvider("kimi");
    const resource = await db
      .insertInto("provider_resource")
      .values({
        enterprise_id: ENT_ID,
        provider_id: provider.id,
        name: `并发幂等-${randomUUID().slice(0, 8)}`,
        mode: "CODING_PLAN",
        credential_type: "SUBSCRIPTION_SESSION",
        status: "CREDENTIAL_INVALID",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const rows = await db
      .selectFrom("alert_event")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where(
        "alert_key",
        "=",
        `CREDENTIAL_INVALID:CREDENTIAL_INVALID:${resource.id}`,
      )
      .where("status", "=", "OPEN")
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("处置后转历史：?history=true 可见，未处理列表不再含", async () => {
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
      payload: { alert_key: open.alertKey, status: "RESOLVED", resolution_note: "已重新授权" },
    });
    expect(res.statusCode).toBe(200);

    // 未处理列表不再含（key 不再有 OPEN，故 evaluate 也不会复活它——已 RESOLVED）
    const active = await app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } });
    const stillActive = active.json().alerts.find((a: { alertKey: string }) => a.alertKey === open.alertKey);
    expect(stillActive).toBeUndefined();

    // 历史可见
    const hist = await app.inject({ method: "GET", url: "/alerts?history=true", headers: { cookie: adminCookie } });
    const inHistory = hist.json().history.find((a: { alertKey: string }) => a.alertKey === open.alertKey);
    expect(inHistory).toBeDefined();
    expect(inHistory.status).toBe("RESOLVED");

    // audit
    const logs = await db
      .selectFrom("operation_log")
      .select("action")
      .where("enterprise_id", "=", ENT_ID)
      .where("action", "=", "alert.disposition")
      .execute();
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("源恢复后 AUTO_RESOLVED 并保留历史", async () => {
    const provider = await ensureProvider("deepseek");
    const res = await db
      .insertInto("provider_resource")
      .values({
        enterprise_id: ENT_ID,
        provider_id: provider.id,
        name: `临时失效-${randomUUID().slice(0, 8)}`,
        mode: "API",
        credential_type: "API_KEY",
        status: "CREDENTIAL_INVALID",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // 评估 → 告警出现
    await app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } });
    // 源恢复（状态改回 ACTIVE）
    await db
      .updateTable("provider_resource")
      .set({ status: "ACTIVE" })
      .where("id", "=", res.id)
      .execute();
    // 再评估 → AUTO_RESOLVED
    await app.inject({ method: "GET", url: "/alerts", headers: { cookie: adminCookie } });
    const row = await db
      .selectFrom("alert_event")
      .select("status")
      .where("enterprise_id", "=", ENT_ID)
      .where("resource_id", "=", res.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("AUTO_RESOLVED");
  });

  it("未认证 401", async () => {
    const res = await app.inject({ method: "GET", url: "/alerts" });
    expect(res.statusCode).toBe(401);
  });
});
