import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKysely,
  GatewayLedgerRepository,
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
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";
import { createRealPipeline } from "../pipeline/real-pipeline.js";
import { buildGateway } from "../server.js";

const ENTERPRISE_ID = randomUUID();
const PRINCIPAL_ID = randomUUID();
const PEPPER = "p0-real-upstream-pepper-32bytes";

let pg: PostgresTestInstance;
let db: Kysely<Database>;
let gateway: FastifyInstance;
let upstream: ReturnType<typeof createServer>;
let key = "";
let upstreamAuthorization = "";
let upstreamBody: Record<string, unknown> = {};
let primaryResourceId = "";
let fallbackResourceId = "";
let exerciseBufferedStreamFailover = false;

beforeAll(async () => {
  upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization ?? "";
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      upstreamBody = JSON.parse(raw) as Record<string, unknown>;
      if (
        exerciseBufferedStreamFailover
        && request.headers.authorization === "Bearer interrupt-http-secret"
      ) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write([
          "data: {\"choices\":[{\"delta\":{\"content\":\"未向客户端提交\"}}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":13,\"completion_tokens\":4}}\n\n",
        ].join(""));
        setTimeout(() => response.destroy(), 10);
        return;
      }
      if (upstreamBody.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"故障切换成功\"}}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":81,\"completion_tokens\":19,\"prompt_tokens_details\":{\"cached_tokens\":11},\"completion_tokens_details\":{\"reasoning_tokens\":7}}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "真实厂商兼容响应",
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 81,
          completion_tokens: 19,
          prompt_tokens_details: { cached_tokens: 11 },
          completion_tokens_details: { reasoning_tokens: 7 },
        },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("upstream did not bind");

  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({
    id: ENTERPRISE_ID,
    name: "P0 real upstream",
  }).execute();
  await db.insertInto("principal").values({
    id: PRINCIPAL_ID,
    enterprise_id: ENTERPRISE_ID,
    type: "EMPLOYEE",
    name: "Codex user",
  }).execute();
  const model = await db.insertInto("unified_model").values({
    enterprise_id: ENTERPRISE_ID,
    alias: "qianliu-deepseek",
    display_name: "DeepSeek",
    status: "ACTIVE",
  }).returningAll().executeTakeFirstOrThrow();
  key = generateApiKey();
  await db.insertInto("principal_key").values({
    enterprise_id: ENTERPRISE_ID,
    principal_id: PRINCIPAL_ID,
    key_prefix: apiKeyPrefix(key),
    key_digest: digestApiKey(key, PEPPER),
    allowed_model_ids: JSON.stringify([model.id]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: ENTERPRISE_ID,
    code: "deepseek",
    name: "DeepSeek",
    adapter_type: "deepseek",
  }).returningAll().executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: ENTERPRISE_ID,
    provider_id: provider.id,
    name: "real HTTP resource",
    mode: "API",
    credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  primaryResourceId = resource.id;
  const fallbackResource = await db.insertInto("provider_resource").values({
    enterprise_id: ENTERPRISE_ID,
    provider_id: provider.id,
    name: "real HTTP fallback resource",
    mode: "API",
    credential_type: "API_KEY",
  }).returningAll().executeTakeFirstOrThrow();
  fallbackResourceId = fallbackResource.id;
  await db.insertInto("model_route").values({
    enterprise_id: ENTERPRISE_ID,
    unified_model_id: model.id,
    provider_resource_id: resource.id,
    upstream_model: "deepseek-chat",
  }).execute();
  await db.insertInto("model_route").values({
    enterprise_id: ENTERPRISE_ID,
    unified_model_id: model.id,
    provider_resource_id: fallbackResource.id,
    upstream_model: "deepseek-chat",
  }).execute();
  await db.insertInto("principal_grant").values({
    enterprise_id: ENTERPRISE_ID,
    principal_id: PRINCIPAL_ID,
    provider: "deepseek",
    model_alias: "qianliu-deepseek",
    quota_value: 10_000n,
  }).execute();

  const caller = createOpenAiCompatibleCaller({
    env: { DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
  });
  const ledgerRepo = new GatewayLedgerRepository(db);
  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    poolRepo: new ResourcePoolRepository(db),
    quotaRepo: new QuotaGateRepository(db),
    caller,
    listCandidates: async () => exerciseBufferedStreamFailover
      ? [
          {
            resourceId: resource.id,
            providerCode: "deepseek",
            upstreamModel: "deepseek-chat",
            priority: 1,
            weight: 100,
            mode: "API",
            status: "ACTIVE",
            probe: false,
            principalId: PRINCIPAL_ID,
            secret: new SecretValue("interrupt-http-secret"),
            concurrencyLimit: 2,
          },
          {
            resourceId: fallbackResource.id,
            providerCode: "deepseek",
            upstreamModel: "deepseek-chat",
            priority: 2,
            weight: 100,
            mode: "API",
            status: "ACTIVE",
            probe: false,
            principalId: PRINCIPAL_ID,
            secret: new SecretValue("real-http-secret"),
            concurrencyLimit: 2,
          },
        ]
      : [{
          resourceId: resource.id,
          providerCode: "deepseek",
          upstreamModel: "deepseek-chat",
          priority: 100,
          weight: 100,
          mode: "API",
          status: "ACTIVE",
          probe: false,
          principalId: PRINCIPAL_ID,
          secret: new SecretValue("real-http-secret"),
          concurrencyLimit: 2,
        }],
  });
  gateway = buildGateway(db, PEPPER, pipeline);
  await gateway.ready();
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

describe("P0 Responses → 真实 Chat Completions caller → 账本", () => {
  it("工具历史被转换，上游文本与完整 Usage 回到 Responses/账本", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/responses",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        model: "qianliu-deepseek",
        instructions: "继续处理工具结果",
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "exec_command",
            arguments: "{\"cmd\":\"pwd\"}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "/workspace",
          },
        ],
        tools: [{
          type: "function",
          name: "exec_command",
          parameters: { type: "object", properties: {} },
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamAuthorization).toBe("Bearer real-http-secret");
    expect(upstreamBody).toMatchObject({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "继续处理工具结果" },
        {
          role: "assistant",
          tool_calls: [{
            id: "call_1",
            function: {
              name: "exec_command",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "/workspace",
        },
      ],
    });
    const payload = response.json();
    expect(payload.output[0].content[0].text).toBe("真实厂商兼容响应");
    expect(payload.usage).toMatchObject({
      input_tokens: 81,
      output_tokens: 19,
      input_tokens_details: { cached_tokens: 11 },
      output_tokens_details: { reasoning_tokens: 7 },
    });

    const requestId = response.headers["x-request-id"];
    const ledgerRepo = new GatewayLedgerRepository(db);
    const transaction = await ledgerRepo.getLedgerTransaction(requestId);
    expect(Number(transaction!.total_input_tokens)).toBe(81);
    expect(Number(transaction!.total_output_tokens)).toBe(19);
    expect(Number(transaction!.total_cache_tokens)).toBe(11);
    expect(Number(transaction!.total_reasoning_tokens)).toBe(7);
  });

  it("Chat 北向返回真实上游正文，不再固定返回 OK", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "真实内容" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("真实厂商兼容响应");
  });

  it("Chat stream:true 经生产 real-pipeline 返回 SSE、Usage 与 DONE", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      payload: {
        model: "qianliu-deepseek",
        messages: [{ role: "user", content: "流式内容" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("\"object\":\"chat.completion.chunk\"");
    expect(response.body).toContain("故障切换成功");
    expect(response.body).toContain("\"finish_reason\":\"stop\"");
    expect(response.body).toContain("\"prompt_tokens\":81");
    expect(response.body).toContain("\"cached_tokens\":11");
    expect(response.body).toContain("\"reasoning_tokens\":7");
    expect(response.body).toContain("data: [DONE]");
  });

  it("缓冲式上游流中断保持未提交并安全切换，不拼接首资源 delta", async () => {
    exerciseBufferedStreamFailover = true;
    try {
      const response = await gateway.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        payload: {
          model: "qianliu-deepseek",
          input: "验证流中断 failover",
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("故障切换成功");
      expect(response.body).not.toContain("未向客户端提交");
      const requestId = response.headers["x-request-id"] as string;
      const attempts = await new GatewayLedgerRepository(db).listAttempts(requestId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({
        provider_resource_id: primaryResourceId,
        response_committed: false,
        error_classification: "TRANSPORT_ERROR",
        switch_reason: "TRANSPORT_ERROR",
      });
      expect(attempts[1]).toMatchObject({
        provider_resource_id: fallbackResourceId,
        response_committed: true,
      });

      const lines = await new GatewayLedgerRepository(db).listLedgerLines(requestId);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        provider_resource_id: primaryResourceId,
        raw_input_tokens: "13",
        raw_output_tokens: "4",
        usage_quality: "ESTIMATED",
      });
    } finally {
      exerciseBufferedStreamFailover = false;
    }
  });
});
