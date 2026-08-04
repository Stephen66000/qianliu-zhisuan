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
let streamScenario: "default" | "chat-live" | "messages-long" = "default";
let upstreamFirstEventAt = 0;
let gatewayBaseUrl = "";

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
        if (streamScenario === "chat-live") {
          upstreamFirstEventAt = Date.now();
          response.write("data: {\"choices\":[{\"delta\":{\"content\":\"首事件\"}}]}\n\n");
          setTimeout(() => response.end([
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":8,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
          ].join("")), 80);
          return;
        }
        if (streamScenario === "messages-long") {
          upstreamFirstEventAt = Date.now();
          response.write("data: {\"choices\":[{\"delta\":{\"content\":\"长\"}}]}\n\n");
          setTimeout(() => response.write(
            "data: {\"choices\":[{\"delta\":{\"content\":\"流\"}}]}\n\n",
          ), 20_100);
          setTimeout(() => response.write(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_long\",\"function\":{\"name\":\"exec_\",\"arguments\":\"\"}}]}}]}\n\n",
          ), 40_200);
          setTimeout(() => response.write(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"command\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}]}}]}\n\n",
          ), 50_200);
          setTimeout(() => response.end([
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":7,\"prompt_tokens_details\":{\"cached_tokens\":3}}}\n\n",
            "data: [DONE]\n\n",
          ].join("")), 60_300);
          return;
        }
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
  await gateway.listen({ port: 0, host: "127.0.0.1" });
  const gatewayAddress = gateway.server.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("gateway did not bind");
  gatewayBaseUrl = `http://127.0.0.1:${gatewayAddress.port}`;
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

  it("Claude Web Search 第二轮经 Gateway 转为 tool_calls/tool 消息", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "qianliu-deepseek",
        max_tokens: 256,
        system: [{ type: "text", text: "使用搜索结果回答" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "查最新定价" }] },
          {
            role: "assistant",
            content: [{
              type: "tool_use",
              id: "toolu_web_e2e",
              name: "web_search",
              input: { query: "official pricing" },
            }],
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "toolu_web_e2e",
              content: [{ type: "text", text: "官方定价结果" }],
            }],
          },
        ],
        tools: [{
          name: "web_search",
          description: "搜索网页",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
        }],
        tool_choice: { type: "tool", name: "web_search" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamBody).toMatchObject({
      messages: [
        { role: "system", content: "使用搜索结果回答" },
        { role: "user", content: "查最新定价" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "toolu_web_e2e",
            function: { name: "web_search", arguments: "{\"query\":\"official pricing\"}" },
          }],
        },
        { role: "tool", tool_call_id: "toolu_web_e2e", content: "官方定价结果" },
      ],
      tool_choice: { type: "function", function: { name: "web_search" } },
    });
  });

  it("Claude MCP 第二轮并行工具结果保持调用 ID 对应", async () => {
    const response = await gateway.inject({
      method: "POST",
      url: "/v1/messages",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      payload: {
        model: "qianliu-deepseek",
        max_tokens: 256,
        messages: [
          { role: "user", content: "检查仓库" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_status_e2e", name: "mcp_git_status", input: {} },
              { type: "tool_use", id: "toolu_diff_e2e", name: "mcp_git_diff", input: { stat: true } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_status_e2e", content: "clean" },
              { type: "tool_result", tool_use_id: "toolu_diff_e2e", content: "2 files changed" },
            ],
          },
        ],
        tools: [],
        tool_choice: { type: "any", disable_parallel_tool_use: false },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(upstreamBody).toMatchObject({
      messages: [
        { role: "user", content: "检查仓库" },
        {
          role: "assistant",
          tool_calls: [
            { id: "toolu_status_e2e", function: { name: "mcp_git_status", arguments: "{}" } },
            {
              id: "toolu_diff_e2e",
              function: { name: "mcp_git_diff", arguments: "{\"stat\":true}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "toolu_status_e2e", content: "clean" },
        { role: "tool", tool_call_id: "toolu_diff_e2e", content: "2 files changed" },
      ],
      tool_choice: "required",
      parallel_tool_calls: true,
    });
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

  it("Chat 真实 Socket 在上游首事件后 1 秒内转发", async () => {
    streamScenario = "chat-live";
    try {
      const response = await fetch(`${gatewayBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-client-id": "pool014-chat-e2e",
        },
        body: JSON.stringify({
          model: "qianliu-deepseek",
          messages: [{ role: "user", content: "实时转发" }],
          stream: true,
        }),
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const firstReceivedAt = Date.now();
      const rest = await readRemainingStream(reader);
      const body = new TextDecoder().decode(first.value) + rest;

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(firstReceivedAt - upstreamFirstEventAt).toBeLessThan(1_000);
      expect(body).toContain("首事件");
      expect(body).toContain("\"finish_reason\":\"stop\"");
      expect(body).toContain("data: [DONE]");
    } finally {
      streamScenario = "default";
    }
  });

  it("Messages 真实 SSE 连续输出超过 60 秒，工具、usage 与事件顺序符合 Anthropic", async () => {
    streamScenario = "messages-long";
    try {
      const response = await fetch(`${gatewayBaseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-client-id": "claude-desktop-via-cc-switch",
        },
        body: JSON.stringify({
          model: "qianliu-deepseek",
          max_tokens: 256,
          messages: [{ role: "user", content: "跨 60 秒长流" }],
          tools: [{ name: "exec_command", input_schema: { type: "object" } }],
          stream: true,
        }),
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const firstReceivedAt = Date.now();
      const body = new TextDecoder().decode(first.value) + await readRemainingStream(reader);

      expect(response.status).toBe(200);
      expect(firstReceivedAt - upstreamFirstEventAt).toBeLessThan(1_000);
      expect(body).toContain("event: message_start");
      expect(body).toContain("\"text\":\"长\"");
      expect(body).toContain("\"text\":\"流\"");
      expect(body).toContain("\"name\":\"exec_command\"");
      expect(body).toContain("\"partial_json\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"");
      expect(body).toContain("\"stop_reason\":\"tool_use\"");
      expect(body).toContain("\"input_tokens\":18");
      expect(body).toContain("\"output_tokens\":7");
      expect(body.indexOf("event: message_start")).toBeLessThan(body.indexOf("event: content_block_start"));
      expect(body.indexOf("event: content_block_stop")).toBeLessThan(body.indexOf("event: message_delta"));
      expect(body.indexOf("event: message_delta")).toBeLessThan(body.indexOf("event: message_stop"));

      const requestId = response.headers.get("x-ai-request-id")!;
      const ledgerRepo = new GatewayLedgerRepository(db);
      const requestRow = await ledgerRepo.getRequest(requestId);
      const attempts = await ledgerRepo.listAttempts(requestId);
      expect(requestRow).toMatchObject({
        protocol: "messages",
        stream: true,
        client_id: "claude-desktop-via-cc-switch",
        agent_family: "OTHER",
        agent_identity_source: "DECLARED_HEADER",
        agent_identity_confidence: "DECLARED",
        client_identity_rule_version: "2026-08-03.v1",
      });
      expect(attempts[0]).toMatchObject({
        http_status: 200,
        response_committed: true,
        failure_layer: null,
      });
      expect(attempts[0]!.first_byte_at).not.toBeNull();
    } finally {
      streamScenario = "default";
    }
  }, 75_000);

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

async function readRemainingStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output + decoder.decode();
}
