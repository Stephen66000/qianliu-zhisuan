/**
 * CPQW 集成测试：窗口额度提示与自动恢复（Gateway 热路径）。
 *
 * 覆盖计划§2/§3/§5/§6 的关键验收：
 *   - B3/F3：混合 CP+API 模型在 CP 明确耗尽时零付费 API Attempt，PLAN_ONLY 不给隐式回退
 *   - 首次明确 5 小时耗尽 → 429 upstream_window_exhausted + 冻结窗口字段 + 北京时间文案；
 *     block 创建、EXHAUSTED、事件字段同源（Retry-After = ceil(retry_after_ms/1000)）
 *   - 等待期重复请求（准入拒绝）→ provider_quota_exhausted + EXHAUSTION_RECORD、零上游调用
 *   - 管理只改 status 不清 block → 仍零生成（B "Admin changes only the visible resource status"）
 *   - MODEL_POOL 多资源不可聚合呈现
 *   - API-only 对照不受影响
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  ResourcePoolRepository,
  QuotaGateRepository,
  type Database,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";
import { formatShanghaiResetTime } from "../pipeline/quota-window-presentation.js";
import type { Outcome } from "@qianliu/contracts";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
const ENT_ID = randomUUID();
const PEPPER = "cpqw-gateway-pepper-32bytes-ok!";
const KIMI_ALIAS = "qianliu-kimi-k3";
const DEEPSEEK_ALIAS = "qianliu-deepseek";
let kimiUmId: string;
let deepseekUmId: string;
let kimiProviderId: string;
let deepseekProviderId: string;

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

interface Fixture {
  app: FastifyInstance;
  key: string;
  cpResourceId: string;
  apiResourceId: string;
  principalId: string;
  callerCalls: Array<{ resourceId: string; mode: string }>;
  close: () => Promise<void>;
}

function makeCaller(handler: (resource: { id: string; mode: "API" | "CODING_PLAN" }) => Promise<Outcome>, recorder: Array<{ resourceId: string; mode: string }>): UpstreamCaller {
  return async (resource, _request, _attemptNo) => {
    recorder.push({ resourceId: resource.resourceId, mode: resource.mode });
    return await handler(resource as never);
  };
}

async function buildFixture(opts: {
  withApi: boolean;
  caller: UpstreamCaller;
  extraResourceIds?: string[];
}): Promise<Fixture> {
  const principalId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: `CPQW-${principalId.slice(0, 8)}`,
  }).execute();
  const cpResource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: kimiProviderId, name: `CPQW-CP-${randomUUID().slice(0, 8)}`,
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", credential_version: 1,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: kimiUmId,
    provider_resource_id: cpResource.id, upstream_model: "kimi-k3", priority: 100, weight: 1,
  }).execute();
  let apiResourceId = "";
  if (opts.withApi) {
    const apiResource = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: deepseekProviderId, name: `CPQW-API-${randomUUID().slice(0, 8)}`,
      mode: "API", credential_type: "API_KEY",
    }).returningAll().executeTakeFirstOrThrow();
    apiResourceId = apiResource.id;
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID, unified_model_id: kimiUmId,
      provider_resource_id: apiResource.id, upstream_model: "deepseek-chat", priority: 200, weight: 1,
    }).execute();
  }
  await seedMissingBillingRules(db, ENT_ID);

  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify(opts.withApi ? [kimiUmId, deepseekUmId] : [kimiUmId]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const kimiGrant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: principalId, provider: "Kimi",
    model_alias: KIMI_ALIAS, quota_value: 1_000_000n,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: kimiGrant.id }).execute();
  if (opts.withApi) {
    await db.insertInto("principal_grant").values({
      enterprise_id: ENT_ID, principal_id: principalId, provider: "deepseek",
      model_alias: KIMI_ALIAS, quota_value: 1_000_000n,
    }).execute();
  }

  const ownResourceIds = new Set<string>([
    cpResource.id,
    ...(opts.withApi ? [apiResourceId] : []),
    ...(opts.extraResourceIds ?? []),
  ]);
  const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "model_route.id as route_id",
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
        "provider.id as provider_row_id",
        "unified_model.id as unified_model_id",
        "model_route.upstream_model",
        "model_route.priority",
        "model_route.weight",
        "provider_resource.mode",
        "provider_resource.status",
      ])
      .where("model_route.enterprise_id", "=", entId)
      .where("unified_model.alias", "=", model)
      .where("model_route.enabled", "=", true)
      .execute();
    return routes
      .filter((r) => ownResourceIds.has(r.resource_id))
      .map((r) => ({
        routeId: r.route_id,
        resourceId: r.resource_id,
        providerCode: r.provider_code,
        providerId: r.provider_row_id,
        unifiedModelId: r.unified_model_id,
        upstreamModel: r.upstream_model,
        priority: r.priority,
        weight: r.weight,
        mode: r.mode as "API" | "CODING_PLAN",
        status: r.status,
        probe: false,
        principalId,
      }));
  };
  const pipeline = createRealPipeline({
    db, ledgerRepo, caller: opts.caller, poolRepo, quotaRepo: new QuotaGateRepository(db), listCandidates,
    maxAttempts: 2,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return {
    app, key, cpResourceId: cpResource.id, apiResourceId, principalId,
    callerCalls: [],
    close: async () => { await app.close(); },
  };
}

beforeAll(async () => {
  pg = await startPostgresContainer("cpqw_gateway");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "CPQW窗口额度测试" }).execute();
  kimiUmId = (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: KIMI_ALIAS, display_name: "CPQW Kimi", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow()).id;
  deepseekUmId = (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: DEEPSEEK_ALIAS, display_name: "CPQW DeepSeek", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow()).id;
  // 复审缺陷 3：生产历史 code 为大写 "Kimi"；本文件全程使用生产形态验证 canonical 化。
  kimiProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "Kimi", name: "Kimi-CPQW", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow()).id;
  deepseekProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek-CPQW", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow()).id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("CPQW：窗口额度提示与自动恢复（Gateway）", () => {
  it("首次明确 5 小时耗尽（混合 CP+API）：零付费 Attempt、冻结字段与北京时间文案、block+EXHAUSTED", async () => {
    const resetAt = new Date(Date.now() + 60 * 60_000); // 1 小时后
    const calls: Array<{ resourceId: string; mode: string }> = [];
    const caller = makeCaller(async (resource) => {
      if (resource.mode === "API") {
        throw new Error("PLAN_ONLY violation: API resource invoked");
      }
      return {
        status: 429,
        committed: false,
        usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
        error: "upstream_http_429",
        upstreamErrorKind: "WINDOW_EXHAUSTED",
        recoverAt: resetAt.toISOString(),
        upstreamRecoverAtSource: "RESET_AT",
        retryAfterMs: 3_600_000,
        failureLayer: "UPSTREAM_HTTP",
      } satisfies Outcome;
    }, calls);
    const fx = await buildFixture({ withApi: true, caller });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe("rate_limit_error");
      expect(body.error.code).toBe("upstream_window_exhausted");
      expect(body.error.message).toBe(
        `Kimi 厂商 5 小时额度已用完，预计 ${formatShanghaiResetTime(resetAt, new Date())}（北京时间）恢复，系统将自动恢复服务，请届时重试。`,
      );
      expect(body.error.quota_block_scope).toBe("RESOURCE");
      // 复审缺陷 3：大写生产 code 下仍输出 canonical provider 与厂商名。
      expect(body.error.provider).toBe("kimi");
      expect(body.error.quota_windows).toEqual([
        { type: "FIVE_HOUR", reset_at: resetAt.toISOString(), reset_source: "UPSTREAM_RESET_AT" },
      ]);
      expect(body.error.quota_window_unknown).toBe(false);
      expect(body.error.next_reset_at).toBe(resetAt.toISOString());
      expect(body.error.not_calculable_reason).toBeNull();
      expect(body.error.retryable).toBe(true);
      // 三者同源：retry_after_ms 与 Retry-After 头一致，且不超过初始 1 小时窗口。
      expect(body.error.retry_after_ms).toBeLessThanOrEqual(3_600_000);
      expect(body.error.retry_after_ms).toBeGreaterThan(3_590_000);
      expect(Number(res.headers["retry-after"])).toBe(Math.ceil(body.error.retry_after_ms / 1_000));
      expect(res.headers["x-request-id"]).toBeTruthy();

      // B3：只调用了 CP 资源一次；无任何 API Attempt。
      expect(calls).toHaveLength(1);
      expect(calls[0]!.mode).toBe("CODING_PLAN");
      const requestId = res.headers["x-request-id"] as string;
      const attempts = await ledgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.provider_resource_id).toBe(fx.cpResourceId);

      // 资源事实：EXHAUSTED + 活跃 block（incident + FIVE_HOUR 未来重置点）。
      const row = await db.selectFrom("provider_resource")
        .select(["status", "quota_block_state"])
        .where("id", "=", fx.cpResourceId).executeTakeFirstOrThrow();
      expect(row.status).toBe("EXHAUSTED");
      const block = row.quota_block_state as Record<string, unknown>;
      expect(block.schemaVersion).toBe(1);
      expect(block.windows).toEqual([
        { type: "FIVE_HOUR", observedAt: expect.any(String), resetAt: resetAt.toISOString(), resetSource: "UPSTREAM_RESET_AT" },
      ]);
    } finally {
      await fx.close();
    }
  });

  it("等待期重复请求：准入拒绝给具体窗口与 EXHAUSTION_RECORD，零上游调用", async () => {
    const calls: Array<{ resourceId: string; mode: string }> = [];
    const caller = makeCaller(async () => ({
      status: 429, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      error: "upstream_http_429", upstreamErrorKind: "WINDOW_EXHAUSTED",
      recoverAt: new Date(Date.now() + 3_600_000).toISOString(),
      upstreamRecoverAtSource: "RESET_AT",
      failureLayer: "UPSTREAM_HTTP",
    } satisfies Outcome), calls);
    const fx = await buildFixture({ withApi: false, caller });
    try {
      const first = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(first.statusCode).toBe(429);
      expect(calls).toHaveLength(1);

      const second = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "again" }] },
      });
      expect(second.statusCode).toBe(429);
      expect(calls).toHaveLength(1); // 零新增上游调用
      const body = JSON.parse(second.body);
      expect(body.error.code).toBe("provider_quota_exhausted");
      expect(body.error.message).toContain("Kimi 厂商 5 小时额度已用完");
      expect(body.error.quota_windows[0].reset_source).toBe("EXHAUSTION_RECORD");
      expect(body.error.quota_windows[0].type).toBe("FIVE_HOUR");
      expect(body.error.retryable).toBe(true);
      expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
      const attempts = await ledgerRepo.listAttempts(second.headers["x-request-id"] as string);
      expect(attempts).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });

  it("管理只改 status 不清 block：仍零生成、零半开（Admin changes only the visible resource status）", async () => {
    const calls: Array<{ resourceId: string; mode: string }> = [];
    const caller = makeCaller(async () => ({
      status: 429, committed: false,
      usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
      error: "upstream_http_429", upstreamErrorKind: "WINDOW_EXHAUSTED",
      recoverAt: new Date(Date.now() + 3_600_000).toISOString(),
      upstreamRecoverAtSource: "RESET_AT",
      failureLayer: "UPSTREAM_HTTP",
    } satisfies Outcome), calls);
    const fx = await buildFixture({ withApi: false, caller });
    try {
      const first = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(first.statusCode).toBe(429);
      // 管理员仅把可见 status 改回 DEGRADED（block 事实仍在）。
      await db.updateTable("provider_resource").set({ status: "DEGRADED" })
        .where("id", "=", fx.cpResourceId).execute();
      const second = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(second.statusCode).toBe(429);
      expect(JSON.parse(second.body).error.code).toBe("provider_quota_exhausted");
      expect(calls).toHaveLength(1); // 零生成、零半开探测
    } finally {
      await fx.close();
    }
  });

  it("多 CP 资源阻断：MODEL_POOL 聚合，不冒充单账号时间", async () => {
    const calls: Array<{ resourceId: string; mode: string }> = [];
    const caller = makeCaller(async () => ({
      status: 200, committed: true,
      usage: { input: 1, output: 1, cache: 0, quality: "PROVIDER_REPORTED" },
      responseOutput: undefined,
    } satisfies Outcome), calls);
    // 第二个同模型同 provider 的 CP 资源（grant 已覆盖），与主资源一起进候选集。
    const other = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: kimiProviderId, name: `CPQW-CP2-${randomUUID().slice(0, 8)}`,
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID, unified_model_id: kimiUmId,
      provider_resource_id: other.id, upstream_model: "kimi-k3", priority: 150, weight: 1,
    }).execute();
    await seedMissingBillingRules(db, ENT_ID);
    const fx = await buildFixture({ withApi: false, caller, extraResourceIds: [other.id] });
    try {
      const block = {
        schemaVersion: 1, incidentId: randomUUID(), credentialVersion: null,
        startedAt: new Date().toISOString(), unknownWindow: false,
        windows: [{ type: "WEEKLY", observedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 86_400_000).toISOString(), resetSource: "UPSTREAM_RESET_AT" }],
      };
      for (const resourceId of [fx.cpResourceId, other.id]) {
        await db.updateTable("provider_resource")
          .set({ status: "EXHAUSTED", quota_block_state: JSON.stringify(block) as unknown as Record<string, unknown> })
          .where("id", "=", resourceId).execute();
      }
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(429);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("provider_quota_exhausted");
      expect(body.error.quota_block_scope).toBe("MODEL_POOL");
      expect(body.error.quota_windows).toEqual([]);
      expect(body.error.quota_window_unknown).toBe(true);
      expect(body.error.next_reset_at).toBeNull();
      expect(body.error.not_calculable_reason).toBe("MULTIPLE_RESOURCE_RESET_TIMES");
      expect(body.error.message).toContain("套餐资源受阻");
      expect(calls).toHaveLength(0);
    } finally {
      await fx.close();
    }
  });

  it("API-only 对照：无 CP 路由的模型沿用原 API 行为", async () => {
    const calls: Array<{ resourceId: string; mode: string }> = [];
    const caller = makeCaller(async () => ({
      status: 200, committed: true,
      usage: { input: 10, output: 5, cache: 0, quality: "PROVIDER_REPORTED" },
    } satisfies Outcome), calls);
    // 独立 principal + 纯 API 模型。
    const principalId = randomUUID();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: `CPQW-API-${principalId.slice(0, 8)}`,
    }).execute();
    const apiResource = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: deepseekProviderId, name: `CPQW-ONLY-${randomUUID().slice(0, 8)}`,
      mode: "API", credential_type: "API_KEY",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID, unified_model_id: deepseekUmId,
      provider_resource_id: apiResource.id, upstream_model: "deepseek-chat", priority: 100, weight: 1,
    }).execute();
    await seedMissingBillingRules(db, ENT_ID);
    const key = generateApiKey();
    await db.insertInto("principal_key").values({
      enterprise_id: ENT_ID, principal_id: principalId,
      key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
      allowed_model_ids: JSON.stringify([deepseekUmId]) as unknown as string[], status: "ACTIVE",
    }).execute();
    await db.insertInto("principal_grant").values({
      enterprise_id: ENT_ID, principal_id: principalId, provider: "deepseek",
      model_alias: DEEPSEEK_ALIAS, quota_value: 1_000_000n,
    }).execute();
    const ownIds = new Set([apiResource.id]);
    const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
      const routes = await db.selectFrom("model_route")
        .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
        .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
        .innerJoin("provider", "provider.id", "provider_resource.provider_id")
        .select([
          "model_route.id as route_id", "provider_resource.id as resource_id",
          "provider.code as provider_code", "provider.id as provider_row_id",
          "unified_model.id as unified_model_id", "model_route.upstream_model",
          "model_route.priority", "model_route.weight",
          "provider_resource.mode", "provider_resource.status",
        ])
        .where("model_route.enterprise_id", "=", entId)
        .where("unified_model.alias", "=", model)
        .where("model_route.enabled", "=", true)
        .execute();
      return routes
        .filter((r) => ownIds.has(r.resource_id))
        .map((r) => ({
          routeId: r.route_id, resourceId: r.resource_id, providerCode: r.provider_code,
          providerId: r.provider_row_id, unifiedModelId: r.unified_model_id,
          upstreamModel: r.upstream_model, priority: r.priority, weight: r.weight,
          mode: r.mode as "API" | "CODING_PLAN", status: r.status, probe: false, principalId,
        }));
    };
    const pipeline = createRealPipeline({
      db, ledgerRepo, caller, poolRepo, quotaRepo: new QuotaGateRepository(db), listCandidates, maxAttempts: 2,
    });
    const app = buildGateway(db, PEPPER, pipeline);
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(key),
        payload: { model: DEEPSEEK_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.mode).toBe("API");
    } finally {
      await app.close();
    }
  });
});
