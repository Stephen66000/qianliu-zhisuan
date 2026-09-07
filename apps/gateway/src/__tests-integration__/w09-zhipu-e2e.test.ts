/**
 * gateway W09 端到端测试：智谱 Coding Plan 代表链（M3 DoD：WT-03/05 + 多厂商注册表 + canary）。
 *
 * 用 real pipeline（注册表 → ZhipuAdapter + StubUpstream(providerCode=zhipu) + 真实账本）验证：
 *   - 多厂商：findResource 带出 provider_code=zhipu，注册表解析到 ZhipuAdapter（不再硬编码 deepseek）
 *   - WT-03：Key → /v1/models（qianliu-glm-coding）→ chat → usage 归因 → 账本落账
 *   - WT-05：usage 原始口径可见（input/output，cache=0）
 *   - Coding Plan 账本边界：mode=CODING_PLAN → api_cost=null / total_api_cost="0"
 *   - 正文 canary 0（沿用 M2 机制）
 *
 * 真实智谱 HTTP 在 DEP-PROVIDER-CREDENTIALS 解锁后由佳哥跑（W09 上线签字门禁）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely, migrateToLatest, GatewayLedgerRepository, ResourcePoolRepository, QuotaGateRepository, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createPgCanarySink, scanCanary } from "@qianliu/observability";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  StubUpstream,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { seedMissingBillingRules } from "./billing-rule-fixture.js";
import { createRealPipeline } from "../pipeline/real-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let validKey: string;
let upstreamCalls = 0;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w09-zhipu-pepper-32bytes-min!!!";

const CONTENT_TABLES = [
  "ai_request",
  "route_candidate",
  "upstream_attempt",
  "usage_event",
  "ledger_line",
  "ledger_transaction",
];

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试-智谱" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();
  validKey = generateApiKey();
  const keyRowId = (await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    allowed_model_ids: JSON.stringify([]) as unknown as string[],
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow()).id;
  const authorizedModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "qianliu-glm-coding",
    display_name: "仟流 智谱 Coding Plan",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  await db.updateTable("principal_key").set({
    allowed_model_ids: JSON.stringify([authorizedModel.id]) as unknown as string[],
  }).where("id", "=", keyRowId).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "zhipu", name: "智谱", adapter_type: "zhipu",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "智谱 Coding Plan 主账号",
    mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: authorizedModel.id,
    provider_resource_id: resource.id,
    upstream_model: "glm-5.2",
  }).execute();
  await seedMissingBillingRules(db, ENT_ID);

  // W14：CODING_PLAN 模式额度门禁需要 principal_grant + quota_counter（F-01 接入后必填）。
  // quota_value 充足，覆盖本测试的预占/结算校正。
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "zhipu",
    model_alias: "qianliu-glm-coding",
    quota_value: 1_000_000n,
    allow_overage: false,
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  // StubUpstream：智谱 Coding Plan 返回原始口径 usage（无 cache 分项）
  const stub = new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 760, output: 318, cache: 0 } },
    providerCode: "zhipu",
  });
  // caller：透传给 stub（注册表按 provider_code=zhipu 解析到 ZhipuAdapter）
  const caller = async (res: unknown, req: unknown, n: number) => { upstreamCalls += 1; return stub.invoke(res as never, req as never, n); };

  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const quotaRepo = new QuotaGateRepository(db);
  // W12：findResource（单资源）→ listCandidates（多候选）
  const listCandidates = async (entId: string, model: string) => {
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

  const pipeline = createRealPipeline({ db, ledgerRepo, caller, poolRepo, quotaRepo, listCandidates });
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

describe("W09 端到端 智谱 Coding Plan 代表链", () => {
  it.each([
    ["/v1/chat/completions", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png" } }] }] }],
    ["/v1/messages", { max_tokens: 64, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }] }] }],
    ["/v1/responses", { input: [{ role: "user", content: [{ type: "input_image", file_id: "private-test-file" }] }] }],
  ] as const)("POOL20-054 %s rejects image before upstream or quota consumption", async (url, body) => {
    for (const stream of [false, true]) {
      const before = upstreamCalls;
      const quotaBefore = await db.selectFrom("quota_counter").selectAll().execute();
      const res = await app.inject({ method: "POST", url, headers: authHeader(), payload: { model: "qianliu-glm-coding", stream, ...body } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: "model_image_unsupported", message: "模型不支持图片", retryable: false });
      expect(upstreamCalls).toBe(before);
      const requestId = res.headers["x-ai-request-id"] as string;
      const ledger = new GatewayLedgerRepository(db);
      expect(await ledger.getRequest(requestId)).toMatchObject({ status: "FAILED" });
      expect(await ledger.listAttempts(requestId)).toHaveLength(0);
      expect(await ledger.listUsageEvents(requestId)).toHaveLength(0);
      expect(await ledger.listLedgerLines(requestId)).toHaveLength(0);
      expect(await db.selectFrom("quota_counter").selectAll().execute()).toEqual(quotaBefore);
    }
  });

  it("WT-03：models 可见 → chat 调用 → 账本落账完整闭环", async () => {
    // 1. models（qianliu-glm-coding 别名可见）
    const modelsRes = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(modelsRes.statusCode).toBe(200);
    expect(modelsRes.json().data[0].id).toBe("qianliu-glm-coding");

    // 2. chat
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-glm-coding", messages: [{ role: "user", content: "hi" }] },
    });
    expect(chatRes.statusCode).toBe(200);
    const chatBody = chatRes.json();
    expect(chatBody.object).toBe("chat.completion");
    expect(chatBody.usage.total_tokens).toBe(760 + 318);
    const requestId = chatRes.headers["x-request-id"];

    // 3. 账本落账（通过 request_id 追踪，全引用同一 requestId）
    const ledgerRepo = new GatewayLedgerRepository(db);
    const request = await ledgerRepo.getRequest(requestId);
    expect(request).toBeDefined();
    expect(request!.status).toBe("SUCCEEDED");

    const attempts = await ledgerRepo.listAttempts(requestId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].response_committed).toBe(true);

    const usageEvents = await ledgerRepo.listUsageEvents(requestId);
    expect(usageEvents).toHaveLength(1);
    expect(Number(usageEvents[0].input_tokens)).toBe(760);
    expect(Number(usageEvents[0].output_tokens)).toBe(318);
    expect(Number(usageEvents[0].cache_tokens)).toBe(0);
    expect(usageEvents[0].usage_quality).toBe("PROVIDER_REPORTED");

    const lines = await ledgerRepo.listLedgerLines(requestId);
    expect(lines).toHaveLength(1);

    const tx = await ledgerRepo.getLedgerTransaction(requestId);
    expect(tx).toBeDefined();
    expect(Number(tx!.total_input_tokens)).toBe(760);
    expect(Number(tx!.total_output_tokens)).toBe(318);
    expect(tx!.attempt_count).toBe(1);
  });

  it("WT-05：usage 原始口径可见 + Coding Plan 账本边界（api_cost=null / total_api_cost=0）", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-glm-coding", messages: [{ role: "user", content: "hi" }] },
    });
    const requestId = chatRes.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);

    const usageEvents = await ledgerRepo.listUsageEvents(requestId);
    const line = (await ledgerRepo.listLedgerLines(requestId))[0]!;
    const tx = (await ledgerRepo.getLedgerTransaction(requestId))!;

    // 原始口径可见（input/output，cache=0）
    expect(Number(usageEvents[0]!.input_tokens)).toBe(760);
    expect(Number(usageEvents[0]!.output_tokens)).toBe(318);
    expect(Number(usageEvents[0]!.cache_tokens)).toBe(0);

    // Coding Plan 模式：不产生 API 费用（TRD §7.2 / §10 边界；扣减额度归 W13/W14）
    expect(line.resource_mode).toBe("CODING_PLAN");
    expect(line.api_cost).toBeNull();
    expect(Number(tx.total_api_cost)).toBe(0); // F-03：聚合后为 "0.00000000"，数值断言
    expect(line.usage_quality).toBe("PROVIDER_REPORTED");
  });

  it("多厂商：findResource 带出 provider_code=zhipu，注册表解析到 ZhipuAdapter（不硬编码 deepseek）", async () => {
    // W12：listCandidates 替代 findResource；此处直接查库验证 provider_code 带出
    const found = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
        "provider_resource.mode",
      ])
      .where("model_route.enterprise_id", "=", ENT_ID)
      .where("unified_model.alias", "=", "qianliu-glm-coding")
      .where("model_route.enabled", "=", true)
      .executeTakeFirst();
    expect(found).toBeDefined();
    expect(found!.provider_code).toBe("zhipu");
    expect(found!.mode).toBe("CODING_PLAN");

    // resolveAdapter("zhipu", ...) 应返回 ZhipuAdapter（providerCode 校验）
    const { resolveAdapter } = await import("../pipeline/adapter-registry.js");
    const adapter = resolveAdapter("zhipu", async () => ({
      status: 200, committed: true,
      usage: { input: 0, output: 0, cache: 0, quality: "PROVIDER_REPORTED" },
    }));
    expect(adapter.providerCode).toBe("zhipu");
    expect(adapter.capabilities.has("coding_plan")).toBe(true);
  });

  it("正文 canary 为 0：智谱请求 body 在账本表 0 命中（METADATA_ONLY）", async () => {
    const BODY_CANARY = "SECRET_ZHIPU_MESSAGE_BODY_W09_CANARY_TEST_67890";

    // 走一次完整智谱流程，body 含 canary
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-glm-coding", messages: [{ role: "user", content: BODY_CANARY }] },
    });
    expect(chatRes.statusCode).toBe(200);

    // 跨账本表扫描 row_to_json::text（沿用 M2 机制）
    const scanFn = async (canary: string): Promise<number> => {
      let total = 0;
      for (const table of CONTENT_TABLES) {
        const result = await sql`SELECT COUNT(*)::int AS hits FROM (SELECT row_to_json(r)::text AS txt FROM ${sql.raw(table)} r) s WHERE s.txt LIKE ${"%" + canary + "%"}`.execute(db);
        total += Number((result.rows[0] as { hits: number }).hits);
      }
      return total;
    };
    const result = await scanCanary(BODY_CANARY, [createPgCanarySink(scanFn)]);
    expect(result.hits.postgres, "智谱请求正文 canary 在账本表必须 0 命中").toBe(0);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("request_id 贯穿智谱代表链所有账本对象", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: { model: "qianliu-glm-coding", messages: [{ role: "user", content: "hi" }] },
    });
    const requestId = chatRes.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);

    expect((await ledgerRepo.getRequest(requestId))!.id).toBe(requestId);
    expect((await ledgerRepo.listAttempts(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.listUsageEvents(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.listLedgerLines(requestId))[0]!.ai_request_id).toBe(requestId);
    expect((await ledgerRepo.getLedgerTransaction(requestId))!.ai_request_id).toBe(requestId);
  });
});
