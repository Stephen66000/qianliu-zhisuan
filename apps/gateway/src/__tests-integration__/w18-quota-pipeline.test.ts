/**
 * gateway W18 整改集成测试：额度门禁接入 pipeline 热路径 + 账本聚合一致性。
 *
 * 验证 F-01（quota gate 接入 real-pipeline）+ F-03（ledger_transaction = SUM(ledger_line)）：
 *   - F-01-1：CODING_PLAN 成功请求 → deducted_quota 回写 quota_counter（settleQuota 多退少补）
 *   - F-01-2：额度耗尽 → reserve REJECT_EXHAUSTED → 排除资源 → 无健康候选 503
 *   - F-01-3：并发达 concurrency_limit → 有界等待，超时返回可解释 429
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
  type UpstreamCaller,
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
  caller?: UpstreamCaller;
  capacityWaitMs?: number;
  capacityPollMs?: number;
  poolGrant?: boolean;
  omitRouteId?: boolean;
  routeIdOverride?: string;
  afterReserve?: () => Promise<void>;
}): Promise<{
  app: FastifyInstance;
  key: string;
  grantId: string;
  resourceId: string;
  routeId: string;
  providerId: string;
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
  const route = await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: umId,
    provider_resource_id: resource.id, upstream_model: upstreamModel, priority: 100, weight: 1,
  }).returningAll().executeTakeFirstOrThrow();

  const key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: principalId,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify([umId]) as unknown as string[],
    status: "ACTIVE",
  }).execute();

  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: principalId, provider: providerCode,
    model_alias: opts.poolGrant ? "*" : alias,
    pool_model_alias: opts.poolGrant ? "*" : null,
    quota_value: opts.quotaValue ?? 1_000_000n, allow_overage: opts.allowOverage ?? false,
  }).returningAll().executeTakeFirstOrThrow();
  const grantId = grant.id;
  if (opts.mode === "CODING_PLAN") {
    await db.insertInto("quota_counter").values({ grant_id: grantId }).execute();
  }

  const stub = opts.stub ?? new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
    providerCode: providerCode as "deepseek" | "zhipu" | "kimi",
  });
  const caller = opts.caller ?? (async (res: unknown, req: unknown, n: number) =>
    stub.invoke(res as never, req as never, n));
  const fixtureQuotaRepo = new QuotaGateRepository(db);
  if (opts.afterReserve) {
    const reserveQuota = fixtureQuotaRepo.reserveQuota.bind(fixtureQuotaRepo);
    let hookPending = true;
    fixtureQuotaRepo.reserveQuota = async (input) => {
      const result = await reserveQuota(input);
      if (hookPending) {
        hookPending = false;
        await opts.afterReserve!();
      }
      return result;
    };
  }
  // listCandidates 只返回本 fixture 的资源（跨用例隔离，避免共用 alias 污染）
  const ownResourceIds = new Set<string>([resource.id]);
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
        routeId: opts.omitRouteId ? undefined : opts.routeIdOverride ?? r.route_id,
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
    db, ledgerRepo, caller, poolRepo, quotaRepo: fixtureQuotaRepo, listCandidates,
    maxAttempts: opts.maxAttempts ?? 2,
    capacityWaitMs: opts.capacityWaitMs,
    capacityPollMs: opts.capacityPollMs,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return {
    app, key, grantId, resourceId: resource.id, routeId: route.id, providerId,
    stub, principalId, ownResourceIds,
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
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      omitRouteId: true,
    });
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

  it("F-01-3：并发达 concurrency_limit → 有界等待后返回 resource_capacity_busy", async () => {
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      capacityWaitMs: 20,
      capacityPollMs: 5,
    });
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
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatchObject({
        code: "resource_capacity_busy",
        retryable: true,
        retry_after_ms: 5,
      });
    } finally {
      await fx.close();
    }
  });

  it("并发上限设为 5 时，五个不同主体可同时使用同一套餐并分别记账", async () => {
    let active = 0;
    let maxActive = 0;
    let entered = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const caller: UpstreamCaller = async () => {
      active += 1;
      entered += 1;
      maxActive = Math.max(maxActive, active);
      if (entered === 5) releaseBarrier();
      await barrier;
      active -= 1;
      return {
        status: 200,
        committed: true,
        usage: { input: 10, output: 5, cache: 0, quality: "PROVIDER_REPORTED" },
        responseOutput: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
        }],
      };
    };
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 5,
      caller,
      capacityWaitMs: 200,
      capacityPollMs: 5,
    });
    const actors = [{ key: fx.key, grantId: fx.grantId, principalId: fx.principalId }];
    try {
      for (let index = 1; index < 5; index += 1) {
        const principalId = randomUUID();
        await db.insertInto("principal").values({
          id: principalId,
          enterprise_id: ENT_ID,
          type: "EMPLOYEE",
          name: `并发员工-${index + 1}`,
        }).execute();
        const key = generateApiKey();
        await db.insertInto("principal_key").values({
          enterprise_id: ENT_ID,
          principal_id: principalId,
          key_prefix: apiKeyPrefix(key),
          key_digest: digestApiKey(key, PEPPER),
          allowed_model_ids: JSON.stringify([kimiUmId]) as unknown as string[],
          status: "ACTIVE",
        }).execute();
        const grant = await db.insertInto("principal_grant").values({
          enterprise_id: ENT_ID,
          principal_id: principalId,
          provider: "kimi",
          model_alias: KIMI_ALIAS,
          quota_value: 100_000n,
        }).returningAll().executeTakeFirstOrThrow();
        await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
        actors.push({ key, grantId: grant.id, principalId });
      }

      const responses = await Promise.all(actors.map(({ key }) => fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "并发测试" }] },
      })));

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(maxActive).toBe(5);
      for (const actor of actors) {
        expect((await counterValue(actor.grantId)).used).toBe(15n);
      }
      const principalIds = await Promise.all(responses.map(async (response) => {
        const requestId = response.headers["x-request-id"] as string;
        return (await ledgerRepo.getRequest(requestId))?.principal_id;
      }));
      expect(new Set(principalIds)).toEqual(new Set(actors.map((actor) => actor.principalId)));
    } finally {
      await fx.close();
    }
  });

  it("唯一套餐 429 保留 Retry-After，冷却后用单探针自动恢复", async () => {
    let calls = 0;
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const caller: UpstreamCaller = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 429,
          committed: false,
          usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
          error: "rate_limit_exceeded",
          upstreamErrorKind: "ENGINE_OVERLOADED",
          retryAfterMs: 1,
        };
      }
      markProbeStarted();
      await probeGate;
      return {
        status: 200,
        committed: true,
        usage: { input: 10, output: 5, cache: 0, quality: "PROVIDER_REPORTED" },
        responseOutput: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "重试成功" }],
        }],
      };
    };
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 5,
      caller,
      maxAttempts: 2,
    });
    try {
      const limited = await fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "重试" }] },
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("1");
      expect(calls).toBe(1);
      expect(await ledgerRepo.listAttempts(limited.headers["x-request-id"] as string)).toHaveLength(1);
      let resource = await db.selectFrom("provider_resource")
        .select(["status", "consecutive_failures"])
        .where("id", "=", fx.resourceId)
        .executeTakeFirstOrThrow();
      expect(resource.status).toBe("RATE_LIMITED");
      expect(resource.consecutive_failures).toBe(1);

      const cooling = await fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "冷却中" }] },
      });
      expect(cooling.statusCode).toBe(429);
      expect(cooling.json().error.code).toBe("resource_rate_limited");
      expect(calls).toBe(1);

      await db.updateTable("provider_resource")
        .set({ cooldown_until: new Date(Date.now() - 1) })
        .where("id", "=", fx.resourceId)
        .execute();
      const recovering = fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "半开恢复" }] },
      });
      await probeStarted;
      const concurrent = await fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "并发探针" }] },
      });
      expect(concurrent.statusCode).toBe(429);
      expect(concurrent.json().error.code).toBe("half_open_probe_in_progress");
      expect(calls).toBe(2);
      releaseProbe();
      const recovered = await recovering;

      expect(recovered.statusCode).toBe(200);
      expect(calls).toBe(2);
      resource = await db.selectFrom("provider_resource")
        .select(["status", "consecutive_failures"])
        .where("id", "=", fx.resourceId)
        .executeTakeFirstOrThrow();
      expect(resource.status).toBe("DEGRADED");
      expect(resource.consecutive_failures).toBe(0);
    } finally {
      // 即使用例断言或超时，也要释放正在等待的半开探针，避免关闭 Fastify 时继续悬挂。
      releaseProbe();
      await fx.close();
    }
  }, 60_000);

  it("上游 400 原样返回且不重试、不污染资源健康", async () => {
    let calls = 0;
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      caller: async () => {
        calls += 1;
        return {
          status: 400,
          committed: false,
          usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
          error: "invalid_request_error",
          failureLayer: "UPSTREAM_HTTP",
        };
      },
    });
    try {
      const response = await fx.app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: authHeader(fx.key),
        payload: {
          model: KIMI_ALIAS,
          max_tokens: 256,
          messages: [{ role: "user", content: "触发非法工具协议" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        type: "invalid_request_error",
        code: "invalid_request_error",
        retryable: false,
      });
      expect(calls).toBe(1);
      const resource = await db.selectFrom("provider_resource")
        .select(["status", "consecutive_failures"])
        .where("id", "=", fx.resourceId)
        .executeTakeFirstOrThrow();
      expect(resource).toMatchObject({ status: "ACTIVE", consecutive_failures: 0 });
    } finally {
      await fx.close();
    }
  });

  it.each([429, 403])("上游 %i 月度额度耗尽统一返回 429 并隔离为 EXHAUSTED", async (upstreamStatus) => {
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      caller: async () => ({
        status: upstreamStatus,
        committed: false,
        usage: { input: 0, output: 0, cache: 0, quality: "UNKNOWN" },
        error: "rate_limit_error",
        upstreamErrorKind: "QUOTA_EXHAUSTED",
        failureLayer: "UPSTREAM_HTTP",
      }),
    });
    try {
      const response = await fx.app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: authHeader(fx.key),
        payload: {
          model: KIMI_ALIAS,
          max_tokens: 256,
          messages: [{ role: "user", content: "额度测试" }],
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json().error).toMatchObject({
        code: "upstream_quota_exhausted",
        retryable: false,
      });
      const resource = await db.selectFrom("provider_resource")
        .select(["status", "cooldown_until"])
        .where("id", "=", fx.resourceId)
        .executeTakeFirstOrThrow();
      expect(resource.status).toBe("EXHAUSTED");
      expect(resource.cooldown_until).toBeNull();
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
      const requestId = res.headers["x-request-id"] as string;
      const tx = await ledgerRepo.getLedgerTransaction(requestId);
      expect(tx?.overage).toBe(true);
    } finally {
      await fx.close();
    }
  });

  it("POOL-012：预估超额但实际扣减未超额时冻结为 false", async () => {
    // 预估固定包含 256 output reserve，因此会超过 200；Stub 实际只扣 150。
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 200n,
      allowOverage: true,
    });
    try {
      const res = await fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;
      const tx = await ledgerRepo.getLedgerTransaction(requestId);
      expect(BigInt(tx?.total_deducted_quota ?? 0)).toBe(150n);
      expect(tx?.overage).toBe(false);
      expect((await counterValue(fx.grantId)).overage).toBe(0n);
    } finally {
      await fx.close();
    }
  });

  it("F-01-5：API 模式请求也要求 grant，但不预占 Token 额度", async () => {
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

  it("F-01-6：两个独立 K3 资源 → 主资源 429 后切换备用资源并成功结算", async () => {
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
      expect(attempts.map((attempt) => attempt.provider_resource_id)).toEqual([
        fx.resourceId,
        resB.id,
      ]);
      const resources = await db.selectFrom("provider_resource")
        .select(["id", "status"])
        .where("id", "in", [fx.resourceId, resB.id])
        .execute();
      expect(resources.find((resource) => resource.id === fx.resourceId)?.status).toBe("RATE_LIMITED");
      expect(resources.find((resource) => resource.id === resB.id)?.status).toBe("ACTIVE");

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

  it("grant 在额度预占后撤销：调用前复核拒绝、释放额度/租约且不产生费用", async () => {
    let grantIdToRevoke = "";
    const fx = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      afterReserve: async () => {
        await db
          .updateTable("principal_grant")
          .set({ status: "DISABLED" })
          .where("id", "=", grantIdToRevoke)
          .execute();
      },
    });
    grantIdToRevoke = fx.grantId;
    const callsBefore = fx.stub.calls.length;
    try {
      const res = await fx.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fx.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "grant TOCTOU" }] },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("principal_grant_required");
      expect(fx.stub.calls).toHaveLength(callsBefore);

      // reserveQuota 已发生，拒绝分支必须把预占与并发租约完整释放。
      expect((await counterValue(fx.grantId)).used).toBe(0n);
      const activeLeases = await db
        .selectFrom("concurrency_lease")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("provider_resource_id", "=", fx.resourceId)
        .where("released_at", "is", null)
        .executeTakeFirstOrThrow();
      expect(Number(activeLeases.count)).toBe(0);

      const requestId = res.headers["x-request-id"] as string;
      expect(await ledgerRepo.listLedgerLines(requestId)).toHaveLength(0);
      expect(await ledgerRepo.getLedgerTransaction(requestId)).toBeUndefined();
      expect((await ledgerRepo.getRequest(requestId))?.status).toBe("FAILED");
    } finally {
      await fx.close();
    }
  });

  it.each([
    {
      name: "Route",
      revoke: async (_fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("model_route").set({ enabled: false })
          .where("unified_model_id", "=", kimiUmId).execute();
      },
      restore: async (_fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("model_route").set({ enabled: true })
          .where("unified_model_id", "=", kimiUmId).execute();
      },
    },
    {
      name: "Resource",
      revoke: async (_fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("provider_resource").set({ status: "EXHAUSTED" })
          .where("provider_id", "=", kimiProviderId).execute();
      },
      restore: async (_fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("provider_resource").set({ status: "ACTIVE" })
          .where("provider_id", "=", kimiProviderId).execute();
      },
    },
    {
      name: "Provider",
      revoke: async (fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("provider").set({ status: "DISABLED" })
          .where("id", "=", fixture.providerId).execute();
      },
      restore: async (fixture: Awaited<ReturnType<typeof buildFixture>>) => {
        await db.updateTable("provider").set({ status: "ACTIVE" })
          .where("id", "=", fixture.providerId).execute();
      },
    },
  ])("POOL-040：额度预占后停用 $name，最终栅栏拒绝并完整释放", async ({ revoke, restore }) => {
    let fixture: Awaited<ReturnType<typeof buildFixture>> | undefined;
    fixture = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      afterReserve: async () => revoke(fixture!),
    });
    const callsBefore = fixture.stub.calls.length;
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fixture.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "POOL-040 fence" }] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("candidate_admission_revoked");
      expect(fixture.stub.calls).toHaveLength(callsBefore);
      expect((await counterValue(fixture.grantId)).used).toBe(0n);

      const activeLeases = await db.selectFrom("concurrency_lease")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("provider_resource_id", "=", fixture.resourceId)
        .where("released_at", "is", null)
        .executeTakeFirstOrThrow();
      expect(Number(activeLeases.count)).toBe(0);

      const requestId = response.headers["x-ai-request-id"] as string;
      expect(await ledgerRepo.listAttempts(requestId)).toEqual([
        expect.objectContaining({
          http_status: 503,
          response_committed: false,
          error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
          error_code: "candidate_admission_revoked",
        }),
      ]);
      expect(await ledgerRepo.listLedgerLines(requestId)).toHaveLength(0);
      expect(await ledgerRepo.getLedgerTransaction(requestId)).toBeUndefined();
      expect((await ledgerRepo.getRequest(requestId))?.status).toBe("FAILED");

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(fixture.key),
      });
      expect(models.statusCode).toBe(200);
      expect(models.json().data).toEqual([]);
    } finally {
      await restore(fixture);
      await fixture.close();
    }
  });

  it("POOL-040：已选 Route 撤权时不得被其他可用 Route 误放行，应切换后再调上游", async () => {
    let fixture: Awaited<ReturnType<typeof buildFixture>> | undefined;
    fixture = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      afterReserve: async () => {
        await db.updateTable("model_route").set({ enabled: false })
          .where("id", "=", fixture!.routeId).execute();
      },
    });
    const backup = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID,
      provider_id: kimiProviderId,
      name: `W18-fence-backup-${randomUUID().slice(0, 8)}`,
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
      concurrency_limit: 1,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: kimiUmId,
      provider_resource_id: backup.id,
      upstream_model: "kimi-k3",
      priority: 200,
      weight: 1,
    }).execute();
    fixture.ownResourceIds.add(backup.id);
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fixture.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "route-bound fence" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(fixture.stub.calls).toHaveLength(1);
      expect(fixture.stub.calls[0]?.resource.resourceId).toBe(backup.id);

      const requestId = response.headers["x-ai-request-id"] as string;
      expect((await ledgerRepo.listAttempts(requestId)).map((attempt) => ({
        resourceId: attempt.provider_resource_id,
        committed: attempt.response_committed,
        errorCode: attempt.error_code,
      }))).toEqual([
        {
          resourceId: fixture.resourceId,
          committed: false,
          errorCode: "candidate_admission_revoked",
        },
        { resourceId: backup.id, committed: true, errorCode: null },
      ]);
      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(fixture.key),
      });
      expect(models.json().data.map((model: { id: string }) => model.id)).toEqual([KIMI_ALIAS]);
    } finally {
      await db.updateTable("model_route").set({ enabled: true })
        .where("id", "=", fixture.routeId).execute();
      await fixture.close();
    }
  });

  it("POOL-040：同一资源的备用 Route 撤权后仍可按 route 身份切换", async () => {
    let fixture: Awaited<ReturnType<typeof buildFixture>> | undefined;
    fixture = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      afterReserve: async () => {
        await db.updateTable("model_route").set({ enabled: false })
          .where("id", "=", fixture!.routeId).execute();
      },
    });
    const alternateRoute = await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: kimiUmId,
      provider_resource_id: fixture.resourceId,
      upstream_model: "kimi-k3-alternate",
      priority: 200,
      weight: 1,
    }).returning("id").executeTakeFirstOrThrow();
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fixture.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "same-resource route failover" }] },
      });
      expect(response.statusCode).toBe(200);
      expect(fixture.stub.calls).toHaveLength(1);
      expect(fixture.stub.calls[0]?.resource.resourceId).toBe(fixture.resourceId);
      expect(fixture.stub.calls[0]?.resource.upstreamModel).toBe("kimi-k3-alternate");
      const requestId = response.headers["x-ai-request-id"] as string;
      expect((await ledgerRepo.listAttempts(requestId)).map((attempt) => ({
        upstreamModel: attempt.upstream_model,
        errorCode: attempt.error_code,
        committed: attempt.response_committed,
      }))).toEqual([
        { upstreamModel: "kimi-k3", errorCode: "candidate_admission_revoked", committed: false },
        { upstreamModel: "kimi-k3-alternate", errorCode: null, committed: true },
      ]);
    } finally {
      await db.updateTable("model_route").set({ enabled: true })
        .where("id", "=", fixture.routeId).execute();
      await db.deleteFrom("model_route").where("id", "=", alternateRoute.id).execute();
      await fixture.close();
    }
  });

  it("POOL-040：最终栅栏必须精确绑定已选 model_route.id", async () => {
    const fixture = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      routeIdOverride: randomUUID(),
    });
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fixture.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "route id binding" }] },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("candidate_admission_revoked");
      expect(fixture.stub.calls).toHaveLength(0);
      expect((await counterValue(fixture.grantId)).used).toBe(0n);
    } finally {
      await fixture.close();
    }
  });

  it("POOL-040：厂商池型号在额度预占后被禁用，最终栅栏拒绝且列表同步隐藏", async () => {
    let fixture: Awaited<ReturnType<typeof buildFixture>> | undefined;
    fixture = await buildFixture({
      mode: "CODING_PLAN",
      quotaValue: 100_000n,
      concurrencyLimit: 1,
      poolGrant: true,
      afterReserve: async () => {
        await db.insertInto("principal_provider_disabled_model").values({
          enterprise_id: ENT_ID,
          principal_id: fixture!.principalId,
          provider: "kimi",
          unified_model_id: kimiUmId,
          disable_rule_version_id: null,
        }).execute();
      },
    });
    const callsBefore = fixture.stub.calls.length;
    try {
      const response = await fixture.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: authHeader(fixture.key),
        payload: { model: KIMI_ALIAS, messages: [{ role: "user", content: "pool disabled fence" }] },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("principal_grant_required");
      expect(fixture.stub.calls).toHaveLength(callsBefore);
      expect((await counterValue(fixture.grantId)).used).toBe(0n);

      const activeLeases = await db.selectFrom("concurrency_lease")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("provider_resource_id", "=", fixture.resourceId)
        .where("released_at", "is", null)
        .executeTakeFirstOrThrow();
      expect(Number(activeLeases.count)).toBe(0);

      const requestId = response.headers["x-ai-request-id"] as string;
      expect(await ledgerRepo.listAttempts(requestId)).toEqual([
        expect.objectContaining({
          response_committed: false,
          error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
          error_code: "principal_grant_required",
        }),
      ]);
      expect(await ledgerRepo.listLedgerLines(requestId)).toHaveLength(0);
      expect(await ledgerRepo.getLedgerTransaction(requestId)).toBeUndefined();
      expect((await ledgerRepo.getRequest(requestId))?.status).toBe("FAILED");

      const models = await fixture.app.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(fixture.key),
      });
      expect(models.statusCode).toBe(200);
      expect(models.json().data).toEqual([]);
    } finally {
      if (fixture) {
        await db.deleteFrom("principal_provider_disabled_model")
          .where("enterprise_id", "=", ENT_ID)
          .where("principal_id", "=", fixture.principalId)
          .where("provider", "=", "kimi")
          .where("unified_model_id", "=", kimiUmId)
          .execute();
        await fixture.close();
      }
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
