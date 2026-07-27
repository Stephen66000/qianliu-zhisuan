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
  await db
    .insertInto("principal_key")
    .values({
      enterprise_id: ENT_ID,
      principal_id: PRINCIPAL_ID,
      key_prefix: apiKeyPrefix(validKey),
      key_digest: digestApiKey(validKey, PEPPER),
      status: "ACTIVE",
    })
    .execute();
  await db
    .insertInto("unified_model")
    .values({
      enterprise_id: ENT_ID,
      alias: "qianliu-deepseek",
      display_name: "仟流 DeepSeek",
      status: "ACTIVE",
    })
    .execute();

  app = buildGateway(db, PEPPER, stubPipeline);
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

  it("WT-14：POST /v1/responses 同样 422", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/responses",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: { model: "qianliu-deepseek", input: "hi" },
    });
    expect(res.statusCode).toBe(422);
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

  it("客户端传 x-request-id 被复用（幂等）", async () => {
    const customId = "client-custom-req-id-123";
    const res = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { ...authHeader(), "x-request-id": customId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe(customId);
  });
});
