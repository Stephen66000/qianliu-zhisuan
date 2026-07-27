/**
 * gateway W18 整改集成测试：额度门禁接入 pipeline 热路径 + 账本聚合一致性。
 *
 * 验证 F-01（quota gate 接入 real-pipeline）+ F-03（ledger_transaction = SUM(ledger_line)）：
 *   - F-01-1：CODING_PLAN 成功请求 → deducted_quota 回写 quota_counter（settleQuota 多退少补）
 *   - F-01-2：额度耗尽 → reserve REJECT_EXHAUSTED → 排除资源 → 无健康候选 503
 *   - F-01-3：并发达 concurrency_limit → acquireLease 返回 null → 排除资源 → 503
 *   - F-01-4：allow_overage=true → ALLOW_OVERAGE → 成功 + overage_value 记录
 *   - F-01-5：API 模式请求 → 门禁跳过，正常放行（不被误拒）
 *   - F-01-6：双 Attempt failover → 首 Attempt 失败释放预占 + 第二 Attempt 成功结算
 *   - F-03：成功请求 → ledger_transaction.total_* = SUM(ledger_line.raw_*)
 *
 * 注意：Adapter 的 model map 用 request.unifiedModel（客户端 body.model）查 key，
 * 故 body.model 必须是 Adapter 认识的 alias（qianliu-kimi-k3 / qianliu-deepseek）。
 * 多用例共享 unified_model/provider（全局唯一），每用例独立 resource + route + grant + key 隔离。
 *
 * 真实 HTTP 在 DEP-PROVIDER-CREDENTIALS 解锁后由佳哥跑。
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
  StubUpstream,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
let quotaRepo: QuotaGateRepository;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w18-quota-pipeline-pepper-32b!";

// 全局共享（Adapter model map 认识的 alias + 对应 provider）
const KIMI_ALIAS = "qianliu-kimi-k3";
const DEEPSEEK_ALIAS = "qianliu-deepseek";
let kimiUmId: string;
let deepseekUmId: string;
let kimiProviderId: string;
let deepseekProviderId: string;

function authHeader(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

/**
 * 构建独立 fixture：principal + key + resource + model_route + grant(仅 CODING_PLAN) + app。
 * 每用例独立 principal → grant 完全隔离（reserveQuota 按 principal+provider+alias 命中）。
 * 共享全局 unified_model/provider（已由 Adapter model map 决定）。
 */
async function buildFixture(opts: {
  mode: "API" | "CODING_PLAN";
  quotaValue?: bigint;
  allowOverage?: boolean;
  concurrencyLimit?: number;
  stub?: StubUpstream;
  maxAttempts?: number;
}): Promise<{
  app: FastifyInstance;
  key: string;
  grantId: string;
  resourceId: string;
  stub: StubUpstream;
  principalId: string;
  ownResourceIds: Set<string>;
  close: () => Promise<void>;
}> {
  const alias = opts.mode === "CODING_PLAN" ? KIMI_ALIAS : DEEPSEEK_ALIAS;
  const providerCode = opts.mode === "CODING_PLAN" ? "kimi" : "deepseek";
  const upstreamModel = opts.mode === "CODING_PLAN" ? "kimi-k3" : "deepseek-chat";
  const providerId = opts.mode === "CODING_PLAN" ? kimiProviderId : deepseekProviderId;
  const umId = opts.mode === "CODING_PLAN" ? kimiUmId : deepseekUmId;

  // 独立 principal（隔离 grant 命中）
  const principalId = randomUUID();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: ENT_ID, type: "EMPLOYEE", name: `W18-${principalId.slice(0, 8)}`,
  }).execute();

  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: providerId, name: `W18-${randomUUID().slice(0, 8)}`,
    mode: opts.mode, credential_type: opts.mode === "API" ? "API_KEY" : "SUBSCRIPTION_SESSION",
    concurrency_limit: opts.concurrencyLimit ?? null,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: umId,
    provider_resource_id: resource.id, upstream_model: upstreamModel, priority: 100, weight: 1,
  }).execute();

  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER), status: "ACTIVE",
  }).execute();

  let grantId = "";
  if (opts.mode === "CODING_PLAN") {
    const grant = await db.insertInto("principal_grant").values({
      enterprise_id: ENT_ID, principal_id: principalId, provider: providerCode,
      model_alias: alias, quota_value: opts.quotaValue ?? 1_000_000n, allow_overage: opts.allowOverage ?? false,
    }).returningAll().executeTakeFirstOrThrow();
    grantId = grant.id;
    await db.insertInto("quota_counter").values({ grant_id: grantId }).execute();
  }

  const stub = opts.stub ?? new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
    providerCode: providerCode as "deepseek" | "zhipu" | "kimi",
  });
  const caller = async (res: unknown, req: unknown, n: number) =>
    stub.invoke(res as never, req as never, n);
  // listCandidates 只返回本 fixture 的资源（跨用例隔离，避免共用 alias 污染）
  const ownResourceIds = new Set<string>([resource.id]);
  const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
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
        resourceId: r.resource_id,
        providerCode: r.provider_code,
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
    db, ledgerRepo, caller, poolRepo, quotaRepo, listCandidates,
    maxAttempts: opts.maxAttempts ?? 2,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return {
    app, key, grantId, resourceId: resource.id, stub, principalId, ownResourceIds,
    close: async () => { await app.close(); },
  };
}

async function counterValue(grantId: string): Promise<{ used: bigint; overage: bigint }> {
  const c = await db.selectFrom("quota_counter").selectAll().where("grant_id", "=", grantId).executeTakeFirstOrThrow();
  return { used: BigInt(c.used_value), overage: BigInt(c.overage_value) };
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  quotaRepo = new QuotaGateRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W18额度接入" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();

  // 全局共享 unified_model + provider（Adapter model map 决定的 alias/code）
  kimiUmId = (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: KIMI_ALIAS, display_name: "仟流 Kimi W18", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow()).id;
  deepseekUmId = (await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: DEEPSEEK_ALIAS, display_name: "仟流 DeepSeek W18", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow()).id;
  kimiProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi-W18", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow()).id;
  deepseekProviderId = (await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek-W18", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow()).id;
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W18 额度门禁接入 pipeline + 账本聚合（F-01/F-03 整改）", () => {
  it("F-01-1：CODING_PLAN 成功 → deducted_quota 回写 quota_counter", async () => {
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 100_000n });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hello world" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;

      const lines = await ledgerRepo.listLedgerLines(requestId);
      expect(lines).toHaveLength(1);
      const lineDeducted = BigInt(lines[0]!.deducted_quota ?? 0n);
      expect(lineDeducted).toBe(150n); // 100+50+0，multiplier="1"

      // F-01 核心：quota_counter.used_value = 实际 deducted_quota（settle 回写）
      const c = await counterValue(fx.grantId);
      expect(c.used).toBe(lineDeducted);
      expect(c.overage).toBe(0n);
    } finally {
      await fx.close();
    }
  });

  it("F-01-2：额度耗尽 → REJECT_EXHAUSTED → 排除资源 → 503", async () => {
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 1n });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error.code).toBe("no_healthy_candidate");
      const c = await counterValue(fx.grantId);
      expect(c.used).toBe(0n); // REJECT 不改 counter
    } finally {
      await fx.close();
    }
  });

  it("F-01-3：并发达 concurrency_limit → lease 返回 null → 排除资源 → 503", async () => {
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 100_000n, concurrencyLimit: 1 });
    try {
      // 手动占满并发：建 ai_request + acquireLease
      const reqId = randomUUID();
      const keyRow = await db.selectFrom("principal_key").select("id")
        .where("principal_id", "=", fx.principalId).executeTakeFirstOrThrow();
      await db.insertInto("ai_request").values({
        id: reqId, enterprise_id: ENT_ID, principal_id: fx.principalId, principal_key_id: keyRow.id,
        protocol: "chat", unified_model: KIMI_ALIAS, status: "IN_PROGRESS",
      }).execute();
      const lease = await quotaRepo.acquireLease({
        enterpriseId: ENT_ID, providerResourceId: fx.resourceId, aiRequestId: reqId,
      });
      expect(lease).not.toBeNull();

      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(503); // lease 满 → 排除资源 → 无健康候选
    } finally {
      await fx.close();
    }
  });

  it("F-01-4：allow_overage=true → ALLOW_OVERAGE → 成功 + 超额记录", async () => {
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 1n, allowOverage: true });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const c = await counterValue(fx.grantId);
      expect(c.used).toBeGreaterThan(1n); // 实际 deducted_quota 回写
    } finally {
      await fx.close();
    }
  });

  it("F-01-5：API 模式请求 → 门禁跳过，正常放行（不被误拒）", async () => {
    // API 模式：无 grant，门禁跳过
    const fx = await buildFixture({ mode: "API" });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: DEEPSEEK_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;
      const tx = await ledgerRepo.getLedgerTransaction(requestId);
      expect(tx).toBeDefined();
      expect(Number(tx!.total_api_cost)).toBeGreaterThan(0); // API 模式有费用
    } finally {
      await fx.close();
    }
  });

  it("F-01-6：双 Attempt failover → 首失败释放预占 + 第二成功结算", async () => {
    // 双资源 failover：需两个 CODING_PLAN 资源同 grant（同 provider/alias）
    // 用 buildFixture 建第一个资源 + grant，再手动加第二个资源
    const stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      byAttempt: {
        1: { kind: "ERROR", status: 429, errorCode: "rate_limited", classification: "UPSTREAM_RATE_LIMITED" },
      },
      providerCode: "kimi",
    });
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 100_000n, stub });

    // 加第二个资源（B），同 unified_model + provider，不同 resource
    const resB = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: kimiProviderId, name: `W18-failover-B-${randomUUID().slice(0, 8)}`,
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID, unified_model_id: kimiUmId,
      provider_resource_id: resB.id, upstream_model: "kimi-k3", priority: 200, weight: 1,
    }).execute();
    fx.ownResourceIds.add(resB.id); // 让 listCandidates 可见 B（failover 目标）

    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;
      const attempts = await ledgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(2); // 双 Attempt

      // F-01 核心：首 Attempt 429（zeroUsage 无明细）→ releaseQuota 释放；
      // 第二 Attempt 成功 → settleQuota 结算。used = 仅成功 Attempt 的 deducted_quota
      const lines = await ledgerRepo.listLedgerLines(requestId);
      expect(lines).toHaveLength(1); // 429 无 usage
      const c = await counterValue(fx.grantId);
      expect(c.used).toBe(BigInt(lines[0]!.deducted_quota ?? 0n)); // 仅成功 Attempt 回写
    } finally {
      await fx.close();
    }
  });

  it("F-03：ledger_transaction.total_* = SUM(ledger_line.raw_*)（聚合一致性）", async () => {
    const fx = await buildFixture({ mode: "CODING_PLAN", quotaValue: 100_000n });
    try {
      const res = await fx.app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "aggregation test" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;

      const lines = await ledgerRepo.listLedgerLines(requestId);
      const tx = await ledgerRepo.getLedgerTransaction(requestId);
      expect(tx).toBeDefined();
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // F-03：事务聚合 = 明细之和
      const sumIn = lines.reduce((s, l) => s + BigInt(l.raw_input_tokens), 0n);
      const sumOut = lines.reduce((s, l) => s + BigInt(l.raw_output_tokens), 0n);
      const sumCache = lines.reduce((s, l) => s + BigInt(l.raw_cache_tokens), 0n);
      const sumDeducted = lines.reduce((s, l) => s + BigInt(l.deducted_quota ?? 0n), 0n);

      expect(BigInt(tx!.total_input_tokens)).toBe(sumIn);
      expect(BigInt(tx!.total_output_tokens)).toBe(sumOut);
      expect(BigInt(tx!.total_cache_tokens)).toBe(sumCache);
      expect(BigInt(tx!.total_deducted_quota)).toBe(sumDeducted);
    } finally {
      await fx.close();
    }
  });
});
