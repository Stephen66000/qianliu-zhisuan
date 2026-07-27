/**
 * gateway W08 端到端测试：DeepSeek 代表链（M2 DoD：WT-03/05/14）。
 *
 * 用 real pipeline（StubUpstream + DeepSeekAdapter + 真实账本）验证完整闭环：
 *   WT-03：Key → /v1/models → /v1/chat/completions → usage 归因 → 账本落账
 *   WT-05：账本可见输入/输出/缓存 Token + API 费用
 *   WT-14：未支持能力 422（W05 已覆盖，此处端到端复测）
 *
 * WT-12（流式提交后中断）在 real-pipeline 单 Attempt 简化版不展开，W07 StubUpstream 已覆盖 committed 边界。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, GatewayLedgerRepository, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  StubUpstream,
  DeepSeekAdapter,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { createRealPipeline } from "../pipeline/real-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let validKey: string;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w08-e2e-pepper-32bytes-min!!!!";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();
  validKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    status: "ACTIVE",
  }).execute();
  await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "qianliu-deepseek",
    display_name: "仟流 DeepSeek",
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "DeepSeek 主账号",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: (await db.selectFrom("unified_model").select("id").executeTakeFirstOrThrow()).id,
    provider_resource_id: resource.id,
    upstream_model: "deepseek-chat",
  }).execute();

  // StubUpstream：返回真实形状 usage（含 cache）
  const stub = new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 980, output: 412, cache: 100 } },
  });
  const adapter = new DeepSeekAdapter(async (res, req, n) => stub.invoke(res, req, n));

  const ledgerRepo = new GatewayLedgerRepository(db);
  const findResource = async (entId: string, model: string) => {
    const route = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .select(["provider_resource.id as resource_id", "model_route.upstream_model", "provider_resource.mode", "unified_model.alias"])
      .where("model_route.enterprise_id", "=", entId)
      .where("unified_model.alias", "=", model)
      .where("model_route.enabled", "=", true)
      .executeTakeFirst();
    if (!route) return undefined;
    return {
      resourceId: route.resource_id,
      upstreamModel: route.upstream_model,
      principalId: PRINCIPAL_ID,
      mode: route.mode,
    };
  };

  const pipeline = createRealPipeline({ db, ledgerRepo, adapter, findResource });
  app = buildGateway(db, PEPPER, pipeline);
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

describe("W08 端到端 DeepSeek 代表链", () => {
  it("WT-03：models 可见 → chat 调用 → 账本落账完整闭环", async () => {
    // 1. models
    const modelsRes = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(modelsRes.statusCode).toBe(200);
    expect(modelsRes.json().data[0].id).toBe("qianliu-deepseek");

    // 2. chat
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatBody = chatRes.json();
    expect(chatBody.object).toBe("chat.completion");
    expect(chatBody.usage.total_tokens).toBe(980 + 412);
    const requestId = chatRes.headers["x-request-id"];

    // 3. 账本落账（通过 request_id 追踪）
    const ledgerRepo = new GatewayLedgerRepository(db);
    const request = await ledgerRepo.getRequest(requestId);
    expect(request).toBeDefined();
    expect(request!.status).toBe("SUCCEEDED");

    const attempts = await ledgerRepo.listAttempts(requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].response_committed).toBe(true);

    const usageEvents = await ledgerRepo.listUsageEvents(requestId);
    expect(usageEvents).toHaveLength(1);
    expect(Number(usageEvents[0].input_tokens)).toBe(980);
    expect(Number(usageEvents[0].output_tokens)).toBe(412);
    expect(Number(usageEvents[0].cache_tokens)).toBe(100);
    expect(usageEvents[0].usage_quality).toBe("PROVIDER_REPORTED");

    const lines = await ledgerRepo.listLedgerLines(requestId);
    expect(lines).toHaveLength(1);

    const tx = await ledgerRepo.getLedgerTransaction(requestId);
    expect(tx).toBeDefined();
    expect(Number(tx!.total_input_tokens)).toBe(980);
    expect(Number(tx!.total_output_tokens)).toBe(412);
    expect(tx!.attempt_count).toBe(1);
  });

  it("WT-05：账本可见输入/输出/缓存 Token + API 费用", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    const requestId = chatRes.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);

    const usageEvents = await ledgerRepo.listUsageEvents(requestId);
    const line = (await ledgerRepo.listLedgerLines(requestId))[0]!;
    // 三维度可见
    expect(Number(usageEvents[0]!.input_tokens)).toBe(980);
    expect(Number(usageEvents[0]!.output_tokens)).toBe(412);
    expect(Number(usageEvents[0]!.cache_tokens)).toBe(100);
    // API 费用
    expect(line.api_cost).not.toBeNull();
    expect(Number(line.api_cost)).toBeGreaterThan(0);
    expect(line.resource_mode).toBe("API");
    expect(line.usage_quality).toBe("PROVIDER_REPORTED");
  });

  it("WT-14：未支持能力端到端 422", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe("capability_not_supported");
  });

  it("request_id 贯穿响应头、request、attempt、usage、ledger", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    const requestId = chatRes.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);

    // 所有账本对象都引用同一 requestId
    expect((await ledgerRepo.getRequest(requestId))!.id).toBe(requestId);
    expect((await ledgerRepo.listAttempts(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.listUsageEvents(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.listLedgerLines(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.getLedgerTransaction(requestId))!.ai_request_id).toBe(requestId);
  });
});
