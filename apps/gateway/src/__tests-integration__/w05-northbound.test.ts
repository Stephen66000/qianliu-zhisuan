/**
 * gateway W05 契约测试：北向合同冻结（M2 代表性运行链）。
 *
 * 覆盖：
 *   - GET /v1/models 返回 OpenAI 兼容形状
 *   - POST /v1/chat/completions 非流式 + 流式（OpenAI chat.completion / chunk）
 *   - POST /v1/messages（Anthropic）
 *   - WT-14：未支持能力 422 + capability_not_supported + 不可重试
 *   - 鉴权：无 Bearer / 无效 Key / 停用主体 401
 *   - request_id 贯穿响应头
 *
 * 用 Testcontainer PG + 真实 Key（M1 schema）+ stub pipeline。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { createKysely, migrateToLatest, type Database } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
} from "@qianliu/provider-adapters";
import { buildGateway } from "../server.js";
import { stubPipeline } from "../pipeline/stub-pipeline.js";

let pg: PostgresTestInstance;
let db: Database;
let app: FastifyInstance;
let validKey: string;
let keyId: string;
let allowedModelId: string;
let pipelineCalls = 0;
const ENT_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "w05-test-pepper-32bytes-min!!!!";

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  // 种子：企业 + principal + principal_key + unified_model
  await db.insertInto("enterprise").values({ id: ENT_ID, name: "仟流测试" }).execute();
  await db
    .insertInto("principal")
    .values({ id: PRINCIPAL_ID, enterprise_id: ENT_ID, type: "EMPLOYEE", name: "测试员工" })
    .execute();
  validKey = generateApiKey();
  keyId = (await db
    .insertInto("principal_key")
    .values({
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      key_prefix: apiKeyPrefix(validKey),
      key_digest: digestApiKey(validKey, PEPPER),
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow()).id;
  allowedModelId = (await db
    .insertInto("unified_model")
    .values({
      enterprise_id: ENT_ID,
      alias: "qianliu-deepseek",
      display_name: "仟流 DeepSeek",
      status: "ACTIVE",
    })
    .returning("id")
    .executeTakeFirstOrThrow()).id;
  await db
    .insertInto("unified_model")
    .values({
      enterprise_id: ENT_ID,
      alias: "qianliu-denied",
      display_name: "未授权模型",
      status: "ACTIVE",
    })
    .execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENT_ID,
    code: "deepseek",
    name: "DeepSeek",
    adapter_type: "deepseek",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENT_ID,
    provider_id: provider.id,
    name: "DeepSeek 主账号",
    mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("model_route").values({
    enterprise_id: ENT_ID,
    unified_model_id: allowedModelId,
    provider_resource_id: resource.id,
    upstream_model: "deepseek-chat",
  }).execute();
  await db
    .updateTable("principal_key")
    .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
    .where("id", "=", keyId)
    .execute();
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: ENT_ID,
    principal_id: PRINCIPAL_ID,
    provider: "deepseek",
    model_alias: "qianliu-deepseek",
    quota_value: 1_000_000n,
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

  app = buildGateway(db, PEPPER, async (input) => {
    pipelineCalls += 1;
    await stubPipeline(input);
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

function authHeader(key = validKey): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe("W05 北向合同", () => {
  it("GET /v1/models 返回 OpenAI 兼容形状 + qianliu-* 别名", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]).toEqual({
      id: "qianliu-deepseek",
      object: "model",
      owned_by: "qianliu",
    });
  });

  it("Codex 模型目录只返回当前 Key 获授权模型", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models?client_version=0.146.0",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models.map((model: { slug: string }) => model.slug)).toEqual([
      "qianliu-deepseek",
    ]);
    expect(body.models[0]).toMatchObject({
      display_name: "仟流 DeepSeek",
      shell_type: "unified_exec",
      supported_in_api: true,
    });
  });

  it("Grant 撤权或过期后模型目录即时隐藏，不能只依赖 Key 白名单", async () => {
    await db.updateTable("principal_grant").set({ status: "DISABLED" })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
    const revoked = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(revoked.json()).toEqual({ object: "list", data: [] });
    await db.updateTable("principal_grant").set({ status: "ACTIVE", valid_until: new Date(Date.now() - 1_000) })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
    const expired = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(expired.json()).toEqual({ object: "list", data: [] });
    await db.updateTable("principal_grant").set({ valid_until: null })
      .where("principal_id", "=", PRINCIPAL_ID).where("model_alias", "=", "qianliu-deepseek").execute();
  });

  it("allowed_model_ids 过滤模型列表，未授权调用在 pipeline/上游前拒绝", async () => {
    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const listed = await app.inject({ method: "GET", url: "/v1/models", headers: authHeader() });
    expect(listed.json().data.map((model: { id: string }) => model.id)).toEqual(["qianliu-deepseek"]);

    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-denied",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("model_not_allowed");
    expect(pipelineCalls).toBe(before);
  });

  it("异常历史 NULL 权限 fail-closed：模型列表为空且调用不进入 pipeline", async () => {
    await sql`
      ALTER TABLE principal_key
      ALTER COLUMN allowed_model_ids DROP NOT NULL
    `.execute(db);
    try {
      await db
        .updateTable("principal_key")
        .set({ allowed_model_ids: null })
        .where("id", "=", keyId)
        .execute();

      const listed = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: authHeader(),
      });
      expect(listed.json()).toEqual({ object: "list", data: [] });
      const codexListed = await app.inject({
        method: "GET",
        url: "/v1/models?client_version=0.146.0",
        headers: authHeader(),
      });
      expect(codexListed.json()).toEqual({ models: [] });

      const before = pipelineCalls;
      const denied = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...authHeader(), "content-type": "application/json" },
        payload: {
          model: "qianliu-deepseek",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("model_not_allowed");
      expect(pipelineCalls).toBe(before);
    } finally {
      await db
        .updateTable("principal_key")
        .set({
          allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[],
        })
        .where("id", "=", keyId)
        .execute();
      await sql`
        ALTER TABLE principal_key
        ALTER COLUMN allowed_model_ids SET NOT NULL
      `.execute(db);
    }
  });

  it("Key 模型撤权下一请求即时生效，恢复授权后可继续调用", async () => {
    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(denied.statusCode).toBe(403);
    expect(pipelineCalls).toBe(before);

    await db
      .updateTable("principal_key")
      .set({ allowed_model_ids: JSON.stringify([allowedModelId]) as unknown as string[] })
      .where("id", "=", keyId)
      .execute();
    const restored = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("模型停用下一请求即时生效，且在 pipeline/上游前拒绝", async () => {
    await db
      .updateTable("unified_model")
      .set({ status: "INACTIVE" })
      .where("id", "=", allowedModelId)
      .execute();
    const before = pipelineCalls;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("model_not_allowed");
    expect(pipelineCalls).toBe(before);

    await db
      .updateTable("unified_model")
      .set({ status: "ACTIVE" })
      .where("id", "=", allowedModelId)
      .execute();
  });

  it("无 Bearer 返回 401 + OpenAI 错误 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("invalid_principal_key");
    expect(body.error.retryable).toBe(false);
  });

  it("无效 Key 返回 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: authHeader("sk-qianliu-invalid-key"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /v1/chat/completions 非流式返回 chat.completion + usage + request_id 头", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    // request_id 贯穿
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("POST /v1/chat/completions 流式返回 SSE chat.completion.chunk + [DONE]", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const text = res.body;
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("data: [DONE]");
    // usage 在最后 chunk
    expect(text).toContain("total_tokens");
  });

  it("POST /v1/messages 返回 Anthropic message 形状", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.usage.input_tokens).toBeDefined();
    expect(body.usage.output_tokens).toBeDefined();
  });

  it("WT-14：POST /v1/embeddings 返回 422 + capability_not_supported + 不可重试", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.code).toBe("capability_not_supported");
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBeDefined();
  });

  it("POST /v1/responses 非流式返回 Response + 缓存/推理 Usage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        input: "hi",
        reasoning: { effort: "medium", summary: "auto" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("response");
    expect(body.output[0].type).toBe("message");
    expect(body.usage.input_tokens_details.cached_tokens).toBe(2);
    expect(body.usage.output_tokens_details.reasoning_tokens).toBe(3);
    expect(body.reasoning.effort).toBe("medium");
  });

  it("POST /v1/responses 流式事件包含 completed 与完整 Usage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi", stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: response.output_text.delta");
    expect(res.body).toContain("event: response.completed");
    expect(res.body).toContain("reasoning_tokens");
  });

  it("POST /v1/responses 工具调用映射 function_call 与参数流事件", async () => {
    const payload = {
      model: "qianliu-deepseek",
      input: [{ role: "user", content: [{ type: "input_text", text: "调用工具" }] }],
      tools: [{
        type: "function",
        name: "get_weather",
        description: "查询天气",
        parameters: { type: "object", properties: {} },
      }],
    };
    const nonStream = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload,
    });
    expect(nonStream.statusCode).toBe(200);
    expect(nonStream.json().output[0]).toMatchObject({
      type: "function_call",
      name: "get_weather",
      arguments: "{}",
    });

    const stream = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { ...payload, stream: true },
    });
    expect(stream.body).toContain("response.function_call_arguments.delta");
    expect(stream.body).toContain("response.output_item.done");
  });

  it("W23：POST /v1/messages/count_tokens 返回 422 + capability_not_supported", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/messages/count_tokens",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.retryable).toBe(false);
  });

  it("W23：WebSocket 握手（Upgrade 头）返回 422 + capability_not_supported，不静默降级", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/messages",
      headers: { ...authHeader(), upgrade: "websocket", connection: "Upgrade" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.type).toBe("capability_not_supported");
    expect(body.error.code).toBe("capability_not_supported");
    expect(body.error.capability).toBe("websocket");
    expect(body.error.retryable).toBe(false);
  });

  it("缺少 model 返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("bodyLimit 已从 Fastify 默认 1MB 抬高：1.5MB 请求体正常进入路由（不再 413）", async () => {
    // 1.5MB 文本内容，超过 Fastify 默认 bodyLimit 1MB；旧实现会返回 413。
    const bigContent = "x".repeat(1.5 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: bigContent }],
      },
    });
    // 进入路由即返回 200（stub pipeline 回声），证明未被 bodyLimit 拦截。
    expect(res.statusCode).toBe(200);
  });

  it("请求体超过 bodyLimit 上限返回 413 + OpenAI envelope + payload_too_large（不再 reason=unknown）", async () => {
    // 11MB 文本内容，超过默认 10MB bodyLimit；触发 FST_ERR_CTP_BODY_TOO_LARGE。
    const oversized = "y".repeat(11 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: oversized }],
      },
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("payload_too_large");
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBeDefined();
  });

  it("客户端传 x-request-id 仅作为追踪 ID 回显", async () => {
    const customId = "client-custom-req-id-123";
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...authHeader(), "x-request-id": customId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(customId);
    expect(res.headers["x-ai-request-id"]).toBeDefined();
    expect(res.headers["x-ai-request-id"]).not.toBe(customId);
  });

  it("非法或相互冲突的 Idempotency-Key 在 pipeline 前返回稳定 400", async () => {
    const callsBefore = pipelineCalls;
    const conflicting = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        ...authHeader(),
        "idempotency-key": "standard-key",
        "x-idempotency-key": "different-key",
      },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json().error.code).toBe("invalid_idempotency_key");
    expect(conflicting.headers["x-ai-request-id"]).toBeDefined();

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { ...authHeader(), "idempotency-key": "contains whitespace" },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_idempotency_key");
    expect(pipelineCalls).toBe(callsBefore);
  });
});
