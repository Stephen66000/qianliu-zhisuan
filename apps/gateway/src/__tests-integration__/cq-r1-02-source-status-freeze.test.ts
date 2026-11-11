/**
 * CQ-R1-02 定向返修集成用例：真实 Gateway 授权→结算链路冻结 billing_rule.source_status。
 *
 * 红→绿合同（zcode 正式审核 R1 返修指令 §3；runtime-ledger CQ-R1-02 计划）：
 *   - 真实链路＝正常北向入口 buildGateway + createRealPipeline：principal_key 认证 →
 *     resolveCurrentInvocationAuthorization（真实 DB 授权/路由/计费规则 SELECT）→
 *     上游确定性模拟返回真实用量 → persistAttemptUsageEvidence（真实账本结算落库）。
 *     禁止 computeBilling 直调、直接造快照、mock 授权映射或只看内存 BillingRule。
 *   - 写入 source_status=VERIFIED 的有效 API_PRICE 规则，经正常请求结算后断言
 *     ledger_line.billing_rule_snapshot.sourceStatus === 'VERIFIED'（原版实际 UNVERIFIED，红）。
 *   - UNVERIFIED 规则同链路落库按合同展示 UNVERIFIED（对照组）。
 *   - 费用估算读取（loadApiCostEstimation）按结算时快照：VERIFIED 不误报待核实、
 *     UNVERIFIED 计入 PRICE_BASIS_UNVERIFIED；结算后改当前规则状态不影响历史快照。
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKysely,
  GatewayLedgerRepository,
  loadApiCostEstimation,
  migrateToLatest,
  QuotaGateRepository,
  ResourcePoolRepository,
  type Database,
} from "@qianliu/database";
import {
  apiKeyPrefix,
  createOpenAiCompatibleCaller,
  digestApiKey,
  generateApiKey,
  SecretValue,
} from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createRealPipeline, type RouteCandidateRow } from "../pipeline/real-pipeline.js";
import { buildGateway } from "../server.js";

const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "cq-r1-02-source-status-pepper-32b";
const VERIFIED_ALIAS = "qianliu-verified";
const UNVERIFIED_ALIAS = "qianliu-unverified";
const VERIFIED_RULE_VERSION = "cq-r1-02-verified-v1";
const UNVERIFIED_RULE_VERSION = "cq-r1-02-unverified-v1";

let pg: PostgresTestInstance;
let db: Kysely<Database>;
let gateway: FastifyInstance;
let upstream: ReturnType<typeof createServer>;
let key = "";
let resVerified = "";
let resUnverified = "";
let ruleVerifiedId = "";
let ruleUnverifiedId = "";

beforeAll(async () => {
  // 上游确定性模拟：非流式 JSON，固定用量 prompt=100 / completion=50 / cache=0。
  upstream = createServer((request, response) => {
      request.setEncoding("utf8");
    request.on("data", () => {
      // 上游确定性模拟：请求体内容不影响响应，无需读取。
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: { role: "assistant", content: "计费快照红转绿" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");

  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "CQ-R1-02 快照冻结" }).execute();
  await db.insertInto("principal").values({
    id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "cq-r1-02 user",
  }).execute();
  key = generateApiKey();
  const modelVerified = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: VERIFIED_ALIAS, display_name: "Verified 规则模型", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const modelUnverified = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID, alias: UNVERIFIED_ALIAS, display_name: "Unverified 规则模型", status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(key), key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify([modelVerified.id, modelUnverified.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resourceVerified = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "verified 规则资源",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  resVerified = resourceVerified.id;
  const resourceUnverified = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "unverified 规则资源",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  resUnverified = resourceUnverified.id;
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: modelVerified.id,
    provider_resource_id: resourceVerified.id, upstream_model: "verified-model",
  }).execute();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID, unified_model_id: modelUnverified.id,
    provider_resource_id: resourceUnverified.id, upstream_model: "unverified-model",
  }).execute();
  // VERIFIED 规则：miss 0.000002 / output 0.000003 → 100×2e-6 + 50×3e-6 = 0.00035000
  const ruleVerified = await db.insertInto("billing_rule").values({
    enterprise_id: ENT_ID, rule_type: "API_PRICE", rule_version: VERIFIED_RULE_VERSION,
    provider_resource_id: resourceVerified.id, upstream_model: "verified-model",
    effective_from: new Date(0),
    cache_miss_price: "0.000002", output_price: "0.000003", priority: 10,
    source_status: "VERIFIED",
  }).returningAll().executeTakeFirstOrThrow();
  ruleVerifiedId = ruleVerified.id;
  // UNVERIFIED 规则：miss 0.000005 / output 0.000007 → 100×5e-6 + 50×7e-6 = 0.00085000
  const ruleUnverified = await db.insertInto("billing_rule").values({
    enterprise_id: ENT_ID, rule_type: "API_PRICE", rule_version: UNVERIFIED_RULE_VERSION,
    provider_resource_id: resourceUnverified.id, upstream_model: "unverified-model",
    effective_from: new Date(0),
    cache_miss_price: "0.000005", output_price: "0.000007", priority: 10,
    source_status: "UNVERIFIED",
  }).returningAll().executeTakeFirstOrThrow();
  ruleUnverifiedId = ruleUnverified.id;
  await db.insertInto("principal_grant").values([
    // valid_from 显式取过去时刻：colima VM 时钟相对宿主机约 +2s 漂移，
    // 默认 now() 会让授权查询的 valid_from <= 宿主机 Date 落入偏差窗（夹具问题，与本缺陷无关）。
    { enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "deepseek",
      model_alias: VERIFIED_ALIAS, quota_value: 10_000n,
      valid_from: new Date(Date.now() - 60 * 60 * 1000) },
    { enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "deepseek",
      model_alias: UNVERIFIED_ALIAS, quota_value: 10_000n,
      valid_from: new Date(Date.now() - 60 * 60 * 1000) },
  ]).execute();

  const caller = createOpenAiCompatibleCaller({
    env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
  });
  const listCandidates = async (entId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db.selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
        "provider.id as provider_id",
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
      providerId: r.provider_id,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      weight: r.weight,
      mode: r.mode as "API" | "CODING_PLAN",
      status: r.status,
      probe: false,
      principalId: PRINCIPAL_ID,
      secret: new SecretValue("cq-r1-02-secret"),
      concurrencyLimit: 2,
    }));
  };
  const pipeline = createRealPipeline({
    db,
    ledgerRepo: new GatewayLedgerRepository(db),
    poolRepo: new ResourcePoolRepository(db),
    quotaRepo: new QuotaGateRepository(db),
    caller,
    listCandidates,
  });
  gateway = buildGateway(db, PEPPER, pipeline);
  await gateway.ready();
  await gateway.listen({ port: 0, host: "127.0.0.1" });
}, 120_000);

afterAll(async () => {
  if (gateway) await gateway.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
  if (upstream) {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => error ? reject(error) : resolve());
    });
  }
}, 60_000);

/** 正常北向请求（真实授权→路由→上游→结算），返回该请求唯一 ledger_line。 */
async function settleOnceAndGetLedgerLine(model: string) {
  const response = await gateway.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    payload: { model, messages: [{ role: "user", content: "计费快照冻结" }] },
  });
  expect(response.statusCode).toBe(200);
  const aiRequest = await db.selectFrom("ai_request").selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("unified_model", "=", model)
    .orderBy("started_at", "desc")
    .executeTakeFirstOrThrow();
  return await db.selectFrom("ledger_line").selectAll()
    .where("enterprise_id", "=", ENT_ID)
    .where("ai_request_id", "=", aiRequest.id)
    .executeTakeFirstOrThrow();
}

describe("CQ-R1-02 真实授权→结算链路冻结 source_status", () => {
  it("红证：VERIFIED 规则经真实请求结算，ledger 快照应为 VERIFIED", async () => {
    const line = await settleOnceAndGetLedgerLine(VERIFIED_ALIAS);
    const snapshot = line.billing_rule_snapshot as Record<string, unknown> | null;
    expect(line.billing_rule_id).toBe(ruleVerifiedId);
    expect(line.rule_version).toBe(VERIFIED_RULE_VERSION);
    // 价格正确性（同链路金额核对）：100×0.000002 + 50×0.000003 = 0.00035000
    expect(line.api_cost).toBe("0.00035000");
    expect(snapshot).not.toBeNull();
    // 原版缺陷：授权 SELECT/映射漏 source_status → 快照恒 UNVERIFIED。
    expect(snapshot?.sourceStatus).toBe("VERIFIED");
  });

  it("对照组：UNVERIFIED 规则同链路结算，快照按合同展示 UNVERIFIED", async () => {
    const line = await settleOnceAndGetLedgerLine(UNVERIFIED_ALIAS);
    const snapshot = line.billing_rule_snapshot as Record<string, unknown> | null;
    expect(line.billing_rule_id).toBe(ruleUnverifiedId);
    expect(line.provider_resource_id).toBe(resUnverified);
    expect(line.rule_version).toBe(UNVERIFIED_RULE_VERSION);
    expect(line.api_cost).toBe("0.00085000");
    expect(snapshot?.sourceStatus).toBe("UNVERIFIED");
  });

  it("绿证：费用估算按结算时快照展示；改当前规则状态不影响历史快照", async () => {
    const estimation = await loadApiCostEstimation(db, ENT_ID, {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(Date.now() + 60 * 60 * 1000),
    });
    const basisVerified = estimation.priceBasis.find((b) => b.ruleId === ruleVerifiedId);
    const basisUnverified = estimation.priceBasis.find((b) => b.ruleId === ruleUnverifiedId);
    // VERIFIED 不被误报为待核实；UNVERIFIED 按合同展示。
    expect(basisVerified?.sourceStatus).toBe("VERIFIED");
    expect(basisVerified?.ruleVersion).toBe(VERIFIED_RULE_VERSION);
    expect(basisUnverified?.sourceStatus).toBe("UNVERIFIED");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "0.00120000" }]);
    expect(estimation.gaps.find((g) => g.reason === "PRICE_BASIS_UNVERIFIED")?.count).toBe(1);

    // 展示依赖结算时快照：把 VERIFIED 规则改为 UNVERIFIED，历史 ledger 快照不变。
    await db.updateTable("billing_rule").set({ source_status: "UNVERIFIED" })
      .where("id", "=", ruleVerifiedId).execute();
    const ruleRow = await db.selectFrom("billing_rule").selectAll()
      .where("id", "=", ruleVerifiedId).executeTakeFirstOrThrow();
    expect(ruleRow.source_status).toBe("UNVERIFIED");
    const after = await loadApiCostEstimation(db, ENT_ID, {
      start: new Date(Date.now() - 60 * 60 * 1000),
      end: new Date(Date.now() + 60 * 60 * 1000),
    });
    const basisAfter = after.priceBasis.find((b) => b.ruleId === ruleVerifiedId);
    expect(basisAfter?.sourceStatus).toBe("VERIFIED");
    const lineAfter = await db.selectFrom("ledger_line").selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("provider_resource_id", "=", resVerified)
      .executeTakeFirstOrThrow();
    expect((lineAfter.billing_rule_snapshot as Record<string, unknown>).sourceStatus)
      .toBe("VERIFIED");
    expect(lineAfter.api_cost).toBe("0.00035000");
    expect(lineAfter.rule_version).toBe(VERIFIED_RULE_VERSION);
  });
});
