/**
 * gateway W12 集成测试：多因子路由 + 提交前切换 + Affinity（WT-13/18 + WT-11/12 边界）。
 *
 * 用 real pipeline（listCandidates 多候选 + scoreAndSelect + StubUpstream 故障注入 + 真实账本）验证：
 *   - WT-13：会话 Affinity 命中原资源；原资源不可用（隔离）→ 切换健康资源；不存会话正文
 *   - WT-18：route_candidate 冻结评分因子/总分/reason/策略版本，可解释选路
 *   - 提交前切换：attempt1 429（committed=false）→ 排除已试 → attempt2 成功；WT-11 双 Attempt 双明细
 *   - 提交后不切换：STREAM_INTERRUPTED_AFTER_COMMIT → 不切换第二上游（WT-12 边界）
 *   - 无健康候选 → 503 不无账放行
 *   - 优先级：高 priority（数值小）组优先；隔离后低优先级组接管
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
let validKey: string;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w12-routing-pepper-32bytes-min!";

// 两个同池 Kimi 资源：A（affinity 目标）+ B（健康备选）
let resA: string;
let resB: string;
let stub: StubUpstream;
let poolRepo: ResourcePoolRepository;
let ledgerRepo: GatewayLedgerRepository;
let quotaRepo: QuotaGateRepository;

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${validKey}`, "content-type": "application/json" };
}

/** 用当前 stub 配置构建 app（每个用例可重建 stub 故障模式）。 */
async function buildApp(affinityResourceId: string | null): Promise<FastifyInstance> {
  const caller = async (res: unknown, req: unknown, n: number) =>
    stub.invoke(res as never, req as never, n);
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
    return routes.map((r) => ({
      resourceId: r.resource_id,
      providerCode: r.provider_code,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      weight: r.weight,
      mode: r.mode as "API" | "CODING_PLAN",
      status: r.status,
      probe: false,
      principalId: PRINCIPAL_ID,
    }));
  };
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    caller,
    poolRepo,
    quotaRepo,
    listCandidates,
    resolveAffinity: async () => affinityResourceId,
    maxAttempts: 2,
  });
  const app = buildGateway(db, PEPPER, pipeline);
  await app.ready();
  return app;
}

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  poolRepo = new ResourcePoolRepository(db);
  ledgerRepo = new GatewayLedgerRepository(db);
  quotaRepo = new QuotaGateRepository(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-W12路由" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();
  validKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    status: "ACTIVE",
  }).execute();
  const um = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: "qianliu-kimi-k3", display_name: "仟流 Kimi", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "kimi", name: "Kimi", adapter_type: "kimi",
  }).returningAll().executeTakeFirstOrThrow();
  const mkRes = async (name: string) => {
    const r = await db.insertInto("provider_resource").values({
      enterprise_id: ENT_ID, provider_id: provider.id, name,
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", resource_pool_id: "pool-kimi",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({
      enterprise_id: ENT_ID,
      unified_model_id: um.id,
      provider_resource_id: r.id,
      upstream_model: "kimi-k3",
      priority: 100,
      weight: 1,
    }).execute();
    return r.id;
  };
  resA = await mkRes("kimi-A");
  resB = await mkRes("kimi-B");

  // W14：CODING_PLAN 模式额度门禁需要 principal_grant + quota_counter（F-01 接入后必填）。
  // 两资源同 provider(kimi)/alias(qianliu-kimi-k3)，共享一个 grant；quota_value 充足覆盖多用例。
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "kimi",
    model_alias: "qianliu-kimi-k3",
    quota_value: 10_000_000n,
    allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

describe("W12 多因子路由 + 提交前切换 + Affinity", () => {
  it("WT-13：Affinity 命中原资源（会话粘性优先）", async () => {
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "kimi",
    });
    const app = await buildApp(resA); // affinity → A
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const requestId = res.headers["x-request-id"] as string;
      const attempts = await ledgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.provider_resource_id).toBe(resA); // 命中 affinity 资源
    } finally {
      await app.close();
    }
  });

  it("WT-18：route_candidate 冻结评分因子/总分/reason/策略版本（可解释）", async () => {
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 100, output: 50, cache: 0 } },
      providerCode: "kimi",
    });
    const app = await buildApp(resA);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      const requestId = res.headers["x-request-id"] as string;
      const candidates = await ledgerRepo.listRouteCandidates(requestId);
      expect(candidates.length).toBeGreaterThanOrEqual(2); // A + B 两个候选都冻结

      const winner = candidates.find((c) => c.selected)!;
      expect(winner.provider_resource_id).toBe(resA);
      expect(winner.reason_code).toMatch(/^SELECTED_/);
      expect(Number(winner.total_score)).toBeGreaterThan(0);
      // 因子快照：含 static_weight/health/affinity + 策略版本（WT-18 可解释）
      const factors = winner.score_factors as { factors: Array<{ name: string; value: number }>; policy_version: string };
      expect(factors.policy_version).toBe("w12-v1");
      const names = factors.factors.map((f) => f.name);
      expect(names).toContain("static_weight");
      expect(names).toContain("health");
      expect(names).toContain("affinity");
      expect(factors.factors.find((f) => f.name === "affinity")!.value).toBe(1); // A 命中 affinity
    } finally {
      await app.close();
    }
  });

  it("提交前切换：A 429（committed=false）→ 排除 A → B 成功（WT-11 双 Attempt 双明细）", async () => {
    // A 在 attempt1 返回 429；B 成功。StubUpstream byAttempt 按调用序号，
    // 但 A/B 是不同资源 —— 用资源维度区分：让 stub 对 A 所在资源 429，B 成功。
    // StubUpstream 按 attemptNo 配置；A 是 attempt1（429），B 是 attempt2（成功）。
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 200, output: 80, cache: 0 } },
      byAttempt: {
        1: { kind: "ERROR", status: 429, errorCode: "rate_limited", classification: "UPSTREAM_RATE_LIMITED" },
      },
      providerCode: "kimi",
    });
    const app = await buildApp(resA); // affinity → A（A 先被选中）
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200); // 最终 B 成功
      const requestId = res.headers["x-request-id"] as string;

      const attempts = await ledgerRepo.listAttempts(requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.provider_resource_id).toBe(resA);
      expect(attempts[0]!.response_committed).toBe(false);
      expect(attempts[0]!.switch_reason).toBe("UPSTREAM_RATE_LIMITED"); // 提交前切换原因
      expect(attempts[1]!.provider_resource_id).toBe(resB);
      expect(attempts[1]!.response_committed).toBe(true);

      // A 429 → 状态机：UNAVAILABLE + 冷却（W11 驱动）
      const rowA = await poolRepo.getResource(resA);
      expect(rowA!.status).toBe("UNAVAILABLE");
      expect(rowA!.consecutive_failures).toBe(1);

      // 恢复 A（供后续用例）
      await poolRepo.adminRecover(resA);
      await poolRepo.recordSuccess(resA);
    } finally {
      await app.close();
    }
  });

  it("提交后不切换：STREAM_INTERRUPTED_AFTER_COMMIT → 单 Attempt，不拼接第二上游（WT-12 边界）", async () => {
    stub = new StubUpstream({
      default: {
        kind: "STREAM",
        chunks: ["你好", " Kimi"],
        usage: { input: 50, output: 20, cache: 0 },
        failAfterChunk: 1, // committed=true 后中断
      },
      providerCode: "kimi",
    });
    const app = await buildApp(resA);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }], stream: true },
      });
      const requestId = res.headers["x-request-id"] as string;
      const attempts = await ledgerRepo.listAttempts(requestId);
      // 关键：committed=true 后中断 → 只有 1 个 Attempt（不切换第二上游）
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.response_committed).toBe(true);
      expect(attempts[0]!.error_classification).toBe("STREAM_INTERRUPTED_AFTER_COMMIT");
    } finally {
      await app.close();
    }
  });

  it("无健康候选：双资源均隔离 → 503 不无账放行", async () => {
    // 双资源都 401 隔离
    await poolRepo.recordFailure(resA, "UPSTREAM_CREDENTIAL_INVALID", new Date());
    await poolRepo.recordFailure(resB, "UPSTREAM_CREDENTIAL_INVALID", new Date());

    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 1, output: 1, cache: 0 } },
      providerCode: "kimi",
    });
    const app = await buildApp(null);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("no_healthy_candidate");
      const requestId = res.headers["x-request-id"] as string;
      // 不无账放行：无 attempt、无 usage、无结算
      expect(await ledgerRepo.listAttempts(requestId)).toHaveLength(0);
      expect(await ledgerRepo.getLedgerTransaction(requestId)).toBeUndefined();
    } finally {
      await app.close();
    }

    // 恢复现场
    await poolRepo.adminRecover(resA);
    await poolRepo.recordSuccess(resA);
    await poolRepo.adminRecover(resB);
    await poolRepo.recordSuccess(resB);
  });

  it("优先级：低 priority（数值小）组优先；A 隔离后 B 同组接管", async () => {
    // A priority 50（高优先），B priority 100；A 健康时选 A
    await db.updateTable("model_route").set({ priority: 50 }).where("provider_resource_id", "=", resA).execute();
    stub = new StubUpstream({
      default: { kind: "SUCCESS", usage: { input: 10, output: 5, cache: 0 } },
      providerCode: "kimi",
    });
    let app = await buildApp(null); // 无 affinity
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      const attempts = await ledgerRepo.listAttempts(res.headers["x-request-id"] as string);
      expect(attempts[0]!.provider_resource_id).toBe(resA); // 高优先级 A
    } finally {
      await app.close();
    }

    // A 隔离 → B（低优先级）接管
    await poolRepo.recordFailure(resA, "UPSTREAM_CREDENTIAL_INVALID", new Date());
    app = await buildApp(null);
    try {
      const res = await app.inject({
        method: "POST", url: "/v1/chat/completions", headers: authHeader(),
        payload: { model: "qianliu-kimi-k3", messages: [{ role: "user", content: "hi" }] },
      });
      expect(res.statusCode).toBe(200);
      const attempts = await ledgerRepo.listAttempts(res.headers["x-request-id"] as string);
      expect(attempts[0]!.provider_resource_id).toBe(resB);
    } finally {
      await app.close();
    }
    // 恢复
    await poolRepo.adminRecover(resA);
    await poolRepo.recordSuccess(resA);
  });
});
