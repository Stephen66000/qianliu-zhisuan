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
import {
  createKysely,
  migrateToLatest,
  DashboardRepository,
  GatewayLedgerRepository,
  OperatingBillAccountRepository,
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
import { createRealPipeline } from "../pipeline/real-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let validKey: string;
let stub: StubUpstream;
let beforeCandidateReturn: (() => Promise<void>) | null = null;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w08-e2e-pepper-32bytes-min!!!!";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试" }).execute();
  await db.insertInto("principal").values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" }).execute();
  const unifiedModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "qianliu-deepseek",
    display_name: "仟流 DeepSeek",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  const visionModel = await db.insertInto("unified_model").values({
    enterprise_id: ENT_ID,
    alias: "ql-deepseek-v4-flash-vision-exp",
    display_name: "DeepSeek V4 Flash Vision Exp",
    required_capabilities: JSON.stringify(["chat", "stream", "vision"]) as unknown as string[],
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  validKey = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(validKey),
    key_digest: digestApiKey(validKey, PEPPER),
    allowed_model_ids: JSON.stringify([unifiedModel.id, visionModel.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID, provider_id: provider.id, name: "DeepSeek 主账号",
    mode: "API", credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("model_route").values([
    {
      enterprise_id: ENT_ID, unified_model_id: unifiedModel.id,
      provider_resource_id: resource.id, upstream_model: "deepseek-chat",
    },
    {
      enterprise_id: ENT_ID, unified_model_id: visionModel.id,
      provider_resource_id: resource.id, upstream_model: "deepseek-v4-flash-vision-exp",
    },
  ]).execute();
  await db.insertInto("principal_grant").values([
    {
      enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "deepseek",
      model_alias: "qianliu-deepseek", quota_value: 10_000_000n,
    },
    {
      enterprise_id: ENT_ID, principal_id: PRINCIPAL_ID, provider: "deepseek",
      model_alias: "ql-deepseek-v4-flash-vision-exp", quota_value: 10_000_000n,
    },
  ]).execute();
  const priceWindows = JSON.stringify([
      {
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "00:00",
        end_time: "12:00",
      },
      {
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "12:00",
        end_time: "00:00",
      },
    ]) as never;
  await db.insertInto("billing_rule").values([
    {
      enterprise_id: ENT_ID, provider_resource_id: resource.id,
      upstream_model: "deepseek-chat", rule_type: "API_PRICE",
      rule_version: "deepseek-test-peak-v1", effective_from: new Date(0),
      timezone: "Asia/Shanghai", days_of_week: JSON.stringify([1, 2, 3, 4, 5, 6, 7]) as unknown as number[],
      start_time: "00:00", end_time: "12:00", time_windows: priceWindows,
      cache_hit_price: "0.000001", cache_miss_price: "0.000002",
      output_price: "0.000004", priority: 10,
    },
    {
      enterprise_id: ENT_ID, provider_resource_id: resource.id,
      upstream_model: "deepseek-v4-flash-vision-exp", rule_type: "API_PRICE",
      rule_version: "deepseek-vision-test-peak-v1", effective_from: new Date(0),
      timezone: "Asia/Shanghai", days_of_week: JSON.stringify([1, 2, 3, 4, 5, 6, 7]) as unknown as number[],
      start_time: "00:00", end_time: "12:00", time_windows: priceWindows,
      cache_hit_price: "0.000001", cache_miss_price: "0.000002",
      output_price: "0.000004", priority: 10,
    },
  ]).execute();

  // StubUpstream：返回真实形状 usage（含 cache）
  stub = new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 980, output: 412, cache: 100, reasoning: 40 } },
    providerCode: "deepseek",
  });
  // caller：透传给 stub（W09 起由注册表按 providerCode 选 Adapter）
  const caller = async (res: unknown, req: unknown, n: number) => stub.invoke(res as never, req as never, n);

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
    const hook = beforeCandidateReturn;
    beforeCandidateReturn = null;
    if (hook) await hook();
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
    expect(line.rule_version).toBe("deepseek-test-peak-v1");
    expect(line.billing_rule_snapshot).toMatchObject({
      timezone: "Asia/Shanghai",
      startTime: "00:00",
      endTime: "12:00",
      cacheHitPrice: "0.000001",
      cacheMissPrice: "0.000002",
      outputPrice: "0.000004",
    });
    expect((line.billing_rule_snapshot as { timeWindows: unknown[] }).timeWindows).toHaveLength(2);
    expect((line.billing_rule_snapshot as { matchedWindow: unknown }).matchedWindow).not.toBeNull();
  });

  it("POOL20-049：Vision 模型可授权调用，图片 Token 进入输入用量并按模型规则计费", async () => {
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(models.json().data.map((model: { id: string }) => model.id)).toContain(
      "ql-deepseek-v4-flash-vision-exp",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: authHeader(),
      payload: {
        model: "ql-deepseek-v4-flash-vision-exp",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "读取图表" },
            { type: "image_url", image_url: { url: "https://example.com/chart.png" } },
          ],
        }],
      },
    });
    expect(response.statusCode).toBe(200);
    const requestId = response.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);
    const request = await ledgerRepo.getRequest(requestId);
    const usage = (await ledgerRepo.listUsageEvents(requestId))[0]!;
    const line = (await ledgerRepo.listLedgerLines(requestId))[0]!;
    expect(request).toMatchObject({
      unified_model: "ql-deepseek-v4-flash-vision-exp",
      status: "SUCCEEDED",
    });
    expect(Number(usage.input_tokens)).toBe(980);
    expect(Number(usage.output_tokens)).toBe(412);
    expect(line.api_cost).not.toBeNull();
    expect(line.rule_version).toBe("deepseek-vision-test-peak-v1");
    expect(line.billing_rule_snapshot).toMatchObject({
      cacheHitPrice: "0.000001",
      cacheMissPrice: "0.000002",
      outputPrice: "0.000004",
    });
    const dashboard = await new DashboardRepository(db).getSummary(ENT_ID, Date.now());
    expect(dashboard.resourceBreakdown.find((item) => item.providerCode === "deepseek")
      ?.modelTokenBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelAlias: "ql-deepseek-v4-flash-vision-exp",
        totalTokens: "1392",
        usageQuality: "EXACT",
      }),
    ]));
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
    }).format(new Date()).slice(0, 7);
    const employeeBill = await new OperatingBillAccountRepository(db)
      .getEmployeeDetail(ENT_ID, month, PRINCIPAL_ID);
    expect(employeeBill.providers.find((provider) => provider.providerCode === "deepseek")
      ?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currentAlias: "ql-deepseek-v4-flash-vision-exp",
        totals: expect.objectContaining({
          totalTokens: "1392",
          apiCost: line.api_cost,
        }),
      }),
    ]));
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

  it("Responses 真实 pipeline：工具调用、缓存/推理 Usage 与账本归因一致", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        input: "请调用 get_weather",
        tools: [{
          type: "function",
          name: "get_weather",
          description: "查询天气",
          parameters: { type: "object", properties: {} },
        }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.output[0].type).toBe("function_call");
    expect(body.usage.input_tokens_details.cached_tokens).toBe(100);
    expect(body.usage.output_tokens_details.reasoning_tokens).toBe(40);

    const requestId = res.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);
    const usage = (await ledgerRepo.listUsageEvents(requestId))[0]!;
    const line = (await ledgerRepo.listLedgerLines(requestId))[0]!;
    const transaction = await ledgerRepo.getLedgerTransaction(requestId);
    expect(Number(usage.reasoning_tokens)).toBe(40);
    expect(Number(line.raw_reasoning_tokens)).toBe(40);
    expect(Number(transaction!.total_reasoning_tokens)).toBe(40);

    const streamed = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "stream", stream: true },
    });
    expect(streamed.statusCode).toBe(200);
    expect(streamed.body).toContain("event: response.output_text.delta");
    expect(streamed.body).toContain("event: response.completed");
    const streamedRequestId = streamed.headers["x-request-id"];
    expect(await ledgerRepo.getLedgerTransaction(streamedRequestId)).toBeDefined();
  });

  it("POOL-007：WorkBuddy 复用 x-request-id 的多轮工具调用使用不同内部请求主键", async () => {
    const traceId = "db4f2a81-dde0-6871-3d9a-1c76e1528e02";
    const callsBefore = stub.calls.length;
    const tool = {
      type: "function",
      name: "exec_command",
      description: "执行命令",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "x-request-id": traceId },
      payload: {
        model: "qianliu-deepseek",
        input: "请调用工具",
        tools: [tool],
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-request-id"]).toBe(traceId);
    const firstAiRequestId = first.headers["x-ai-request-id"] as string;
    expect(firstAiRequestId).not.toBe(traceId);
    const functionCall = first.json().output[0];
    expect(functionCall.type).toBe("function_call");

    const second = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "x-request-id": traceId },
      payload: {
        model: "qianliu-deepseek",
        stream: true,
        input: [
          functionCall,
          {
            type: "function_call_output",
            call_id: functionCall.call_id,
            output: "Codex gateway tool call OK",
          },
        ],
        tools: [tool],
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-request-id"]).toBe(traceId);
    const secondAiRequestId = second.headers["x-ai-request-id"] as string;
    expect(secondAiRequestId).not.toBe(firstAiRequestId);
    expect(second.body).toContain("event: response.output_text.delta");
    expect(second.body).toContain("event: response.completed");
    expect(stub.calls).toHaveLength(callsBefore + 2);

    const requests = await db
      .selectFrom("ai_request")
      .selectAll()
      .where("enterprise_id", "=", ENT_ID)
      .where("client_request_id", "=", traceId)
      .orderBy("started_at", "asc")
      .execute();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(requests.every((request) => request.idempotency_key === null)).toBe(true);
    expect(requests.every((request) => request.request_fingerprint === null)).toBe(true);
    for (const request of requests) {
      expect(await new GatewayLedgerRepository(db).listAttempts(request.id)).toHaveLength(1);
      expect(await new GatewayLedgerRepository(db).listUsageEvents(request.id)).toHaveLength(1);
      expect(await new GatewayLedgerRepository(db).listLedgerLines(request.id)).toHaveLength(1);
      expect(await new GatewayLedgerRepository(db).getLedgerTransaction(request.id)).toBeDefined();
    }
  });

  it("POOL-007：成功后同体重放不访问上游、不重复账本，异体重放在上游前冲突", async () => {
    const idempotencyKey = `pool-007-success-${randomUUID()}`;
    const payload = {
      model: "qianliu-deepseek",
      messages: [{ role: "user", content: "成功后重放" }],
      stream: true,
    };
    const callsBefore = stub.calls.length;
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain("data: [DONE]");
    const aiRequestId = first.headers["x-ai-request-id"] as string;

    const replay = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...authHeader(),
        "idempotency-key": idempotencyKey,
        "x-request-id": "retry-trace",
      },
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.headers["x-request-id"]).toBe("retry-trace");
    expect(replay.headers["x-ai-request-id"]).toBe(aiRequestId);
    expect(replay.json().error).toMatchObject({
      code: "idempotency_request_succeeded",
      request_id: aiRequestId,
      original_status: "SUCCEEDED",
    });

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "idempotency-key": idempotencyKey },
      payload: {
        ...payload,
        messages: [{ role: "user", content: "不同请求体" }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("idempotency_key_conflict");
    expect(conflict.body).not.toContain("23505");
    expect(stub.calls).toHaveLength(callsBefore + 1);

    const ledgerRepo = new GatewayLedgerRepository(db);
    expect(await ledgerRepo.listAttempts(aiRequestId)).toHaveLength(1);
    expect(await ledgerRepo.listUsageEvents(aiRequestId)).toHaveLength(1);
    expect(await ledgerRepo.listLedgerLines(aiRequestId)).toHaveLength(1);
    expect(await ledgerRepo.getLedgerTransaction(aiRequestId)).toBeDefined();
    const requests = await db
      .selectFrom("ai_request")
      .select("id")
      .where("principal_key_id", "=", (await ledgerRepo.getRequest(aiRequestId))!.principal_key_id)
      .where("idempotency_key", "=", idempotencyKey)
      .execute();
    expect(requests).toHaveLength(1);
  });

  it("POOL-007：并发同体重放返回 IN_PROGRESS，只有首请求访问上游", async () => {
    const idempotencyKey = `pool-007-concurrent-${randomUUID()}`;
    const payload = {
      model: "qianliu-deepseek",
      input: "并发重放",
      stream: true,
    };
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const candidateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    beforeCandidateReturn = async () => {
      entered();
      await blocked;
    };
    const callsBefore = stub.calls.length;
    const firstPromise = app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "idempotency-key": idempotencyKey },
      payload,
    });
    await candidateEntered;

    const replay = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "idempotency-key": idempotencyKey },
      payload,
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toMatchObject({
      code: "idempotency_request_in_progress",
      retryable: true,
      original_status: "IN_PROGRESS",
    });

    release();
    const first = await firstPromise;
    expect(first.statusCode).toBe(200);
    expect(stub.calls).toHaveLength(callsBefore + 1);
    const rows = await db
      .selectFrom("ai_request")
      .select("id")
      .where("idempotency_key", "=", idempotencyKey)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it("POOL-007：FAILED 请求重放保持终态且不因环境恢复再次访问上游", async () => {
    const idempotencyKey = `pool-007-failed-${randomUUID()}`;
    const resource = await db
      .selectFrom("provider_resource")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .executeTakeFirstOrThrow();
    const payload = {
      model: "qianliu-deepseek",
      messages: [{ role: "user", content: "失败重放" }],
    };
    const callsBefore = stub.calls.length;
    await db
      .updateTable("provider_resource")
      .set({ status: "UNAVAILABLE" })
      .where("id", "=", resource.id)
      .execute();
    try {
      const failed = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...authHeader(), "idempotency-key": idempotencyKey },
        payload,
      });
      expect(failed.statusCode).toBe(503);
      const aiRequestId = failed.headers["x-ai-request-id"] as string;
      expect((await new GatewayLedgerRepository(db).getRequest(aiRequestId))!.status).toBe("FAILED");

      await db
        .updateTable("provider_resource")
        .set({ status: "ACTIVE" })
        .where("id", "=", resource.id)
        .execute();
      const replay = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...authHeader(), "idempotency-key": idempotencyKey },
        payload,
      });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toMatchObject({
        code: "idempotency_request_failed",
        request_id: aiRequestId,
        original_status: "FAILED",
      });
      expect(stub.calls).toHaveLength(callsBefore);
      expect(await new GatewayLedgerRepository(db).listAttempts(aiRequestId)).toHaveLength(0);
      expect(await new GatewayLedgerRepository(db).listUsageEvents(aiRequestId)).toHaveLength(0);
      expect(await new GatewayLedgerRepository(db).listLedgerLines(aiRequestId)).toHaveLength(0);
      expect(await new GatewayLedgerRepository(db).getLedgerTransaction(aiRequestId)).toBeUndefined();
    } finally {
      await db
        .updateTable("provider_resource")
        .set({ status: "ACTIVE" })
        .where("id", "=", resource.id)
        .execute();
    }
  });

  it("API principal_grant 撤权下一请求即时生效，且拒绝发生在上游前", async () => {
    const grant = await db
      .selectFrom("principal_grant")
      .select("id")
      .where("principal_id", "=", PRINCIPAL_ID)
      .where("provider", "=", "deepseek")
      .executeTakeFirstOrThrow();
    await db.updateTable("principal_grant").set({ status: "DISABLED" }).where("id", "=", grant.id).execute();
    const callsBefore = stub.calls.length;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("principal_grant_required");
    expect(stub.calls).toHaveLength(callsBefore);
    await db.updateTable("principal_grant").set({ status: "ACTIVE" }).where("id", "=", grant.id).execute();
  });

  it("调度期间撤销 Key 模型权限，Adapter 前复核拒绝且不访问上游", async () => {
    const model = await db
      .selectFrom("unified_model")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("alias", "=", "qianliu-deepseek")
      .executeTakeFirstOrThrow();
    const key = await db
      .selectFrom("principal_key")
      .select("id")
      .where("principal_id", "=", PRINCIPAL_ID)
      .where("status", "=", "ACTIVE")
      .executeTakeFirstOrThrow();
    beforeCandidateReturn = async () => {
      await db
        .updateTable("principal_key")
        .set({ allowed_model_ids: JSON.stringify([]) as unknown as string[] })
        .where("id", "=", key.id)
        .execute();
    };
    const callsBefore = stub.calls.length;
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: { model: "qianliu-deepseek", input: "hi" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("key_or_model_authorization_revoked");
      expect(stub.calls).toHaveLength(callsBefore);
    } finally {
      await db
        .updateTable("principal_key")
        .set({
          allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
        })
        .where("id", "=", key.id)
        .execute();
    }
  });

  it("调度期间重置 Key，旧 key_id 在 Adapter 前拒绝且不访问上游", async () => {
    const model = await db
      .selectFrom("unified_model")
      .select("id")
      .where("enterprise_id", "=", ENT_ID)
      .where("alias", "=", "qianliu-deepseek")
      .executeTakeFirstOrThrow();
    const oldKey = await db
      .selectFrom("principal_key")
      .select("id")
      .where("principal_id", "=", PRINCIPAL_ID)
      .where("status", "=", "ACTIVE")
      .executeTakeFirstOrThrow();
    let replacementKeyId: string | null = null;
    beforeCandidateReturn = async () => {
      await db
        .updateTable("principal_key")
        .set({ status: "REVOKED", revoked_at: new Date() })
        .where("id", "=", oldKey.id)
        .execute();
      const replacement = generateApiKey();
      replacementKeyId = (await db
        .insertInto("principal_key")
        .values({
          enterprise_id: ENT_ID,
          principal_id: PRINCIPAL_ID,
          key_prefix: apiKeyPrefix(replacement),
          key_digest: digestApiKey(replacement, PEPPER),
          allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
          status: "ACTIVE",
        })
        .returning("id")
        .executeTakeFirstOrThrow()).id;
    };
    const callsBefore = stub.calls.length;
    try {
      const denied = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: { model: "qianliu-deepseek", input: "hi" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("key_or_model_authorization_revoked");
      expect(stub.calls).toHaveLength(callsBefore);
    } finally {
      if (replacementKeyId) {
        await db
          .updateTable("principal_key")
          .set({ status: "REVOKED", revoked_at: new Date() })
          .where("id", "=", replacementKeyId)
          .execute();
      }
      await db
        .updateTable("principal_key")
        .set({ status: "ACTIVE", revoked_at: null })
        .where("id", "=", oldKey.id)
        .execute();
    }
  });
});
