/**
 * CPQW 任务 5.2 集成测试：同一 Key 从耗尽、等待到自动恢复的完整链路。
 *
 * 链路（真实 pipeline + 隔离 PG，无真实厂商调用）：
 *   1. 明确 5 小时耗尽 → 429 upstream_window_exhausted + block 建立；
 *      失败 Attempt 的并发租约与额度预占当场释放（lease.released_at、counter=0）。
 *   2. 等待期同一 Key 重试 → 准入拒绝给具体窗口（EXHAUSTION_RECORD），
 *      零上游调用、零新 Attempt（零后台重放）。
 *   3. 阻断期间 Key 模型缓存被刷新为不含该模型（模拟阻断期重算）。
 *   4. 到期后经 Worker/管理员共用条件提交入口确认双窗口正余量 → 自动恢复：
 *      status DEGRADED、block 清空、Key 模型集合自动恢复（管理员零操作）。
 *   5. 同一 Key 新请求 → 200 成功并正确计量扣减；租约再次释放。
 *
 * 撤权对照：等待期间撤销 Grant → 恢复后不复活（仍 403，不改写成额度提示）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  createKysely,
  migrateToLatest,
  GatewayLedgerRepository,
  QuotaBlockRepository,
  QuotaGateRepository,
  refreshEmployeeKeyModels,
  ResourcePoolRepository,
  type Database,
} from "@qianliu/database";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  encryptCredential,
  type UpstreamCaller,
} from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";
import type { Outcome } from "@qianliu/contracts";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
const ENT_ID = randomUUID();
const PEPPER = "cpqw-chain-pepper-32bytes!";
const ALIAS = "qianliu-kimi-k3";
const KEK = Buffer.alloc(32, 11);
let umId: string;
let providerId: string;

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

async function buildChainFixture(caller: UpstreamCaller): Promise<{
  app: FastifyInstance;
  key: string;
  resourceId: string;
  grantId: string;
  principalId: string;
  close: () => Promise<void>;
}> {
  const principalId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: `CPQW链路-${principalId.slice(0, 8)}`,
  }).execute();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: providerId, name: `CPQW链路-${randomUUID().slice(0, 8)}`,
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    credential_ciphertext: JSON.stringify(encryptCredential("cpqw-chain", KEK)),
    credential_version: 1,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: umId,
    provider_resource_id: resource.id, upstream_model: "kimi-k3", priority: 100, weight: 1,
  }).execute();
  await seedMissingBillingRules(db, ENT_ID);
  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify([umId]) as unknown as string[], status: "ACTIVE",
  }).execute();
  // 池式授权（pool_model_alias="*"）：Key 模型重算按厂商池语义纳入/排除，
  // 使恢复后的缓存刷新与撤权后的排除都能被断言。
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: principalId, provider: "Kimi",
    model_alias: "*", pool_model_alias: "*", quota_value: 1_000_000n,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  const ownIds = new Set([resource.id]);
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
    db, ledgerRepo, caller, poolRepo, quotaRepo: new QuotaGateRepository(db), listCandidates,
    maxAttempts: 2,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return {
    app, key, resourceId: resource.id, grantId: grant.id, principalId,
    close: async () => { await app.close(); },
  };
}

beforeAll(async () => {
  pg = await startPostgresContainer("cpqw_key_chain");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "CPQW完整链路测试" }).execute();
  umId = (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: ALIAS, display_name: "CPQW链路Kimi", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow()).id;
  providerId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "Kimi", name: "Kimi-链路", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow()).id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function unreleasedLeases(requestId: string): Promise<number> {
  const rows = await db.selectFrom("concurrency_lease").select(["id", "released_at", "expires_at"])
    .where("ai_request_id", "=", requestId).execute();
  const now = Date.now();
  return rows.filter((row) => row.released_at === null && row.expires_at.getTime() > now).length;
}

async function counterUsed(grantId: string): Promise<bigint> {
  const row = await db.selectFrom("quota_counter").select("used_value")
    .where("grant_id", "=", grantId).executeTakeFirstOrThrow();
  return BigInt(row.used_value);
}

async function allowedModels(principalId: string): Promise<string[]> {
  const row = await db.selectFrom("principal_key").select("allowed_model_ids")
    .where("principal_id", "=", principalId).where("status", "=", "ACTIVE")
    .executeTakeFirstOrThrow();
  return (row.allowed_model_ids ?? []) as unknown as string[];
}

async function recoverViaSharedEntry(resourceId: string, at: Date): Promise<void> {
  const quotaBlockRepo = new QuotaBlockRepository(db);
  const capture = await quotaBlockRepo.captureQuotaQueryToken(resourceId, at);
  expect(capture).not.toBeNull();
  const commit = await quotaBlockRepo.commitQuotaQueryResult({
    token: capture!.token, source: "PROVIDER_SYNC", adapterVersion: "pool032-v1",
    providerDataAt: at,
    windows: [
      { windowType: "FIVE_HOUR", limit: "100", used: "0", remaining: "100", unit: "POINT", ratio: "0", resetAt: new Date(at.getTime() + 3_600_000), unsupported: false },
      { windowType: "WEEKLY", limit: "1000", used: "10", remaining: "990", unit: "POINT", ratio: "0.01", resetAt: new Date(at.getTime() + 86_400_000), unsupported: false },
    ],
    now: at,
  });
  expect(commit).toMatchObject({ status: "COMMITTED", recovered: true });
}

describe("CPQW 任务5.2：同一 Key 耗尽 → 等待 → 自动恢复完整链路", () => {
  it("耗尽释放租约与预占；等待期重试零上游；恢复自动刷新 Key 缓存；同 Key 成功调用", async () => {
    const resetAt = new Date(Date.now() + 30 * 60_000);
    const calls: Array<{ mode: string }> = [];
    let call = 0;
    const caller: UpstreamCaller = async (resource) => {
      call += 1;
      calls.push({ mode: resource.mode });
      if (call === 1) {
        return {
          status: 429, committed: false,
          usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
          error: "upstream_http_429", upstreamErrorKind: "WINDOW_EXHAUSTED",
          recoverAt: resetAt.toISOString(), upstreamRecoverAtSource: "RESET_AT",
          failureLayer: "UPSTREAM_HTTP",
        } satisfies Outcome;
      }
      return {
        status: 200, committed: true,
        usage: { input: 100, output: 50, cache: 0, quality: "PROVIDER_REPORTED" },
      } satisfies Outcome;
    };
    const fx = await buildChainFixture(caller);
    try {
      // 1. 首次请求：明确耗尽。
      const req1 = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(req1.statusCode).toBe(429);
      expect(JSON.parse(req1.body).error.code).toBe("upstream_window_exhausted");
      const request1Id = req1.headers["x-request-id"] as string;
      expect(await ledgerRepo.listAttempts(request1Id)).toHaveLength(1);
      // 失败 Attempt 的并发租约与额度预占已释放（不残留）。
      expect(await unreleasedLeases(request1Id)).toBe(0);
      expect(await counterUsed(fx.grantId)).toBe(0n);
      const row1 = await db.selectFrom("provider_resource")
        .select(["status", "quota_block_state", "cooldown_until"])
        .where("id", "=", fx.resourceId).executeTakeFirstOrThrow();
      expect(row1.status).toBe("EXHAUSTED");
      expect(row1.quota_block_state).not.toBeNull();
      expect(row1.cooldown_until?.toISOString()).toBe(resetAt.toISOString());

      // 2. 等待期同一 Key 重试：准入给具体窗口，零上游调用、零新 Attempt。
      const req2 = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "retry" }] },
      });
      expect(req2.statusCode).toBe(429);
      const body2 = JSON.parse(req2.body).error;
      expect(body2.code).toBe("provider_quota_exhausted");
      expect(body2.quota_windows[0]).toMatchObject({ type: "FIVE_HOUR", reset_source: "EXHAUSTION_RECORD" });
      expect(call).toBe(1);
      expect(await ledgerRepo.listAttempts(req2.headers["x-request-id"] as string)).toHaveLength(0);
      expect(await ledgerRepo.listAttempts(request1Id)).toHaveLength(1); // 零后台重放

      // 3. 阻断期间 Key 模型缓存被重算为不含该模型（阻断期资源不可服务）。
      await db.updateTable("principal_key")
        .set({ allowed_model_ids: JSON.stringify([]) as unknown as string[] })
        .where("principal_id", "=", fx.principalId).where("status", "=", "ACTIVE").execute();
      expect(await allowedModels(fx.principalId)).toEqual([]);

      // 4. 到期自动恢复（Worker/管理员共用条件提交入口）：DEGRADED、block 清空、
      //    Key 模型集合自动恢复——管理员零操作。
      await recoverViaSharedEntry(fx.resourceId, resetAt);
      const row2 = await db.selectFrom("provider_resource")
        .select(["status", "quota_block_state", "cooldown_until"])
        .where("id", "=", fx.resourceId).executeTakeFirstOrThrow();
      expect(row2.status).toBe("DEGRADED");
      expect(row2.quota_block_state).toBeNull();
      expect(row2.cooldown_until).toBeNull();
      expect(await allowedModels(fx.principalId)).toEqual([umId]);

      // 5. 同一 Key 新请求成功并正确计量；租约再次释放。
      const req3 = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "after recovery" }] },
      });
      expect(req3.statusCode).toBe(200);
      expect(call).toBe(2);
      expect(calls[1]!.mode).toBe("CODING_PLAN");
      const request3Id = req3.headers["x-request-id"] as string;
      expect(await ledgerRepo.listAttempts(request3Id)).toHaveLength(1);
      expect(await counterUsed(fx.grantId)).toBe(150n);
      expect(await unreleasedLeases(request3Id)).toBe(0);
    } finally {
      await fx.close();
    }
  });

  it("撤权对照：等待期间撤销 Grant → 恢复后仍 403，不改写成额度提示、不复活权限", async () => {
    const resetAt = new Date(Date.now() + 20 * 60_000);
    let call = 0;
    const caller: UpstreamCaller = async () => {
      call += 1;
      return call === 1
        ? {
            status: 429, committed: false,
            usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
            error: "upstream_http_429", upstreamErrorKind: "WINDOW_EXHAUSTED",
            recoverAt: resetAt.toISOString(), upstreamRecoverAtSource: "RESET_AT",
            failureLayer: "UPSTREAM_HTTP",
          } satisfies Outcome
        : {
            status: 200, committed: true,
            usage: { input: 1, output: 1, cache: 0, quality: "PROVIDER_REPORTED" },
          } satisfies Outcome;
    };
    const fx = await buildChainFixture(caller);
    try {
      const req1 = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(req1.statusCode).toBe(429);
      // 等待期间撤销 Grant（授权撤销路径），并按管理路径重算 Key 模型缓存。
      await db.updateTable("principal_grant").set({ status: "DISABLED" })
        .where("id", "=", fx.grantId).execute();
      await db.transaction().execute(async (trx) => {
        await refreshEmployeeKeyModels(trx, ENT_ID, fx.principalId);
      });
      expect(await allowedModels(fx.principalId)).toEqual([]);
      const blocked = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "blocked" }] },
      });
      // 撤销+缓存刷新后：Key 模型层先行拒绝（403，非额度提示）。
      expect(blocked.statusCode).toBe(403);
      expect(JSON.parse(blocked.body).error.code).toBe("model_not_allowed");

      // 额度自动恢复（额度事实与授权相互独立）。
      await recoverViaSharedEntry(fx.resourceId, resetAt);
      const row = await db.selectFrom("provider_resource").select(["status", "quota_block_state"])
        .where("id", "=", fx.resourceId).executeTakeFirstOrThrow();
      expect(row.status).toBe("DEGRADED");
      expect(row.quota_block_state).toBeNull();

      // 恢复不复活已撤销权限：Key 缓存重算后不含该模型；请求仍 403 而非额度提示。
      expect(await allowedModels(fx.principalId)).toEqual([]);
      const req3 = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: ALIAS, messages: [{ role: "user", content: "after" }] },
      });
      expect(req3.statusCode).toBe(403);
      expect(JSON.parse(req3.body).error.code).toBe("model_not_allowed");
      expect(call).toBe(1); // 从未再次访问上游
      // 若撤权后未刷新缓存（现实时延窗口），Grant 层同样先行拒绝且非额度提示：
      // 恢复不复活已撤销权限由准入的实时 Grant/Key 检查保证，而非依赖缓存。
    } finally {
      await fx.close();
    }
  });
});
