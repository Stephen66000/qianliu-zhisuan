/**
 * R2-N1 回归测试：生产装配下额度归因（listCandidates 返空 principalId）。
 *
 * 问题（round 2 复审遗留）：
 *   生产 main.ts 的 listCandidates 把 principalId 填成 ""；
 *   real-pipeline 的 reserveQuota 用它按 principal_id 查授权 → CODING_PLAN 查不到 → 误拒 503。
 *   测试里 w09/w10/w12/w16 手动填真实主体 ID，所以测试全绿、生产会挂（生产/测试分叉）。
 *
 * 修复：real-pipeline 的额度/账本归因改用已认证的 principal.principalId（调用者），
 *   不再从候选行取。额度本就归调用者，不归路由候选。
 *
 * 本测试：模拟生产装配（listCandidates 返空 principalId），发 CODING_PLAN 请求，
 *   断言返回 200 且 quota_counter.used_value 被回写——堵住生产/测试分叉。
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
let app: FastifyInstance;
let validKey: string;
let grantId: string;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "r2n1-pepper-32bytes-min!!!!!!!";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-R2N1" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "员工" }).execute();
  const unifiedModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: "qianliu-glm-coding",
    display_name: "仟流 智谱 Coding Plan", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  validKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    allowed_model_ids: JSON.stringify([unifiedModel.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();

  // 智谱 CODING_PLAN 资源 + 授权 + counter
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "zhipu", name: "智谱", adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "智谱主账号",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION", concurrency_limit: 10,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: unifiedModel.id,
    provider_resource_id: resource.id,
    upstream_model: "glm-5.2",
  }).execute();
  // 授权：quota 50000，CODING_PLAN 模式按主体+provider+model_alias 查
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "zhipu",
    model_alias: "qianliu-glm-coding", quota_value: 50000n, allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  grantId = grant.id;
  await db.insertInto("quota_counter").values({ grant_id: grantId }).execute();

  // 模拟生产装配：listCandidates 返回 principalId: ""（与 main.ts 生产实现一致）
  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const quotaRepo = new QuotaGateRepository(db);
  const stub = new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 200, output: 100, cache: 0 } },
    providerCode: "zhipu",
  });
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
      principalId: "", // 模拟生产 main.ts（R2-N1 的根因）
    }));
  };
  const pipeline = createRealPipeline({
    db, ledgerRepo, caller, poolRepo, quotaRepo, listCandidates, maxAttempts: 2,
  });
  app = buildGateway(db, PEPPER, pipeline, {});
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${validKey}`, "content-type": "application/json" };
}

describe("R2-N1 生产装配下额度归因", () => {
  it("listCandidates 返空 principalId 时，CODING_PLAN 请求仍 200 且 quota_counter 回写", async () => {
    // 修复前：reserveQuota 用空串查 grant → REJECT_NO_GRANT → 503
    // 修复后：用 principal.principalId 查 → ALLOW → 200 + counter 回写
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-glm-coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const requestId = res.headers["x-request-id"];

    // quota_counter.used_value 被回写（预占 → 结算校正后 > 0）
    const counter = await db
      .selectFrom("quota_counter")
      .selectAll()
      .where("grant_id", "=", grantId)
      .executeTakeFirstOrThrow();
    expect(BigInt(counter.used_value)).toBeGreaterThan(0n);

    // 请求成功落账，归因到正确的调用者主体
    const ledgerRepo = new GatewayLedgerRepository(db);
    const tx = await ledgerRepo.getLedgerTransaction(requestId);
    expect(tx).toBeDefined();
    expect(tx!.principal_id).toBe(PRINCIPAL_ID);
  });
});
