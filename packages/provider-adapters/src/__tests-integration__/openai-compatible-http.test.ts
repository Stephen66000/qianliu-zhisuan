import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleCaller,
  SecretValue,
  type AdapterRequest,
  type AdapterResource,
} from "../index.js";

let server: ReturnType<typeof createServer>;
let baseUrl = "";
const receivedBodies: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      receivedBodies.push(JSON.parse(raw) as Record<string, unknown>);
      if (request.headers["x-request-id"] === "req-empty-usage-http") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "不得伪成功" } }],
          usage: {},
        }));
        return;
      }
      if (request.headers["x-request-id"] === "req-empty-stream-usage-http") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"无有效计量\"}}],\"usage\":null}\n\n",
          "data: {\"choices\":[],\"usage\":{}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      if (request.headers["x-request-id"] === "req-invalid-sse-json-http") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end([
          "data: {\"choices\":[{\"delta\":{\"content\":\"不可静默截断\"}}]}\n\n",
          "data: {broken-json}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":9,\"completion_tokens\":2}}\n\n",
          "data: [DONE]\n\n",
        ].join(""));
        return;
      }
      if (request.headers["x-request-id"] === "req-interrupted-http") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write([
          "data: {\"choices\":[{\"delta\":{\"content\":\"TCP 部分响应\"}}]}\n\n",
          "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":18,\"completion_tokens\":5,\"prompt_tokens_details\":{\"cached_tokens\":3}}}\n\n",
        ].join(""));
        setTimeout(() => response.destroy(), 10);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "来自真实 HTTP 上游",
          },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 16,
          completion_tokens: 7,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe("OpenAI-compatible caller 本地真实 HTTP 集成", () => {
  it("Responses 经 TCP POST 到 /chat/completions，并返回厂商文本而非 Stub", async () => {
    const caller = createOpenAiCompatibleCaller({
      env: { DEEPSEEK_BASE_URL: baseUrl },
    });
    const resource: AdapterResource = {
      providerCode: "deepseek",
      resourceId: "real-http-resource",
      mode: "API",
      upstreamModel: "deepseek-chat",
      concurrencyLimit: 1,
      secret: new SecretValue("local-real-secret"),
    };
    const request: AdapterRequest = {
      requestId: "req-real-http",
      unifiedModel: "qianliu-deepseek",
      capability: "responses",
      stream: false,
      body: {
        model: "qianliu-deepseek",
        input: "你好",
      },
    };

    const outcome = await caller(resource, request, 1);

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]).toMatchObject({
      model: "deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: "你好" }],
    });
    expect(outcome.responseOutput).toEqual([{
      id: "msg_req-real-http",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "来自真实 HTTP 上游",
        annotations: [],
        logprobs: [],
      }],
    }]);
    expect(outcome.usage).toMatchObject({
      input: 16,
      output: 7,
      cache: 4,
    });
  });

  it("TCP 流在 delta 后中断仍为未提交，并保留估算计量供安全 failover 入账", async () => {
    const caller = createOpenAiCompatibleCaller({
      env: { DEEPSEEK_BASE_URL: baseUrl },
    });
    const resource: AdapterResource = {
      providerCode: "deepseek",
      resourceId: "interrupted-http-resource",
      mode: "API",
      upstreamModel: "vendor-model-from-route",
      concurrencyLimit: 1,
      secret: new SecretValue("local-real-secret"),
    };
    const request: AdapterRequest = {
      requestId: "req-interrupted-http",
      unifiedModel: "enterprise-custom-alias",
      capability: "responses",
      stream: true,
      body: {
        model: "enterprise-custom-alias",
        input: "触发中断",
      },
    };

    const outcome = await caller(resource, request, 1);

    expect(receivedBodies.at(-1)).toMatchObject({
      model: "vendor-model-from-route",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(outcome).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: {
        input: 18,
        output: 5,
        cache: 3,
        quality: "ESTIMATED",
      },
    });
  });

  it("真实 TCP 下空 Usage 与损坏 SSE 均在提交前失败", async () => {
    const caller = createOpenAiCompatibleCaller({
      env: { DEEPSEEK_BASE_URL: baseUrl },
    });
    const resource: AdapterResource = {
      providerCode: "deepseek",
      resourceId: "invalid-upstream-resource",
      mode: "API",
      upstreamModel: "deepseek-chat",
      concurrencyLimit: 1,
      secret: new SecretValue("local-real-secret"),
    };
    const baseRequest: Omit<AdapterRequest, "requestId" | "stream"> = {
      unifiedModel: "qianliu-deepseek",
      capability: "responses",
      body: {
        model: "qianliu-deepseek",
        input: "验证失败关闭",
      },
    };

    const emptyJsonUsage = await caller(resource, {
      ...baseRequest,
      requestId: "req-empty-usage-http",
      stream: false,
    }, 1);
    expect(emptyJsonUsage).toMatchObject({
      status: 0,
      committed: false,
      error: "upstream_invalid_response",
    });

    const emptyStreamUsage = await caller(resource, {
      ...baseRequest,
      requestId: "req-empty-stream-usage-http",
      stream: true,
    }, 1);
    expect(emptyStreamUsage).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: { quality: "ESTIMATED" },
    });

    const brokenSse = await caller(resource, {
      ...baseRequest,
      requestId: "req-invalid-sse-json-http",
      stream: true,
    }, 1);
    expect(brokenSse).toMatchObject({
      status: 0,
      committed: false,
      error: "transport_error",
      usage: { quality: "ESTIMATED" },
    });
  });
});
