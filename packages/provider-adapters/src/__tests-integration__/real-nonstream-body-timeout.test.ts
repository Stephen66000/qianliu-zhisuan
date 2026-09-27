/**
 * 真实本地 HTTP 回归（C-P1-1）：非流式请求的底层 bodyTimeout 绑定总时限，
 * 不被流式空闲门限提前截断。
 *
 * 复现基线（Node 22 真实 HTTP）：服务端立即发 HTTP headers、35 秒后返回合法
 * JSON；当 streamIdleTimeoutMs=1000、requestTimeoutMs=40000 时，修复前
 * bodyTimeout=空闲+30s≈31.5 秒截断正文 → status=0 / upstream_invalid_json /
 * UPSTREAM_PROTOCOL；修复后 bodyTimeout=总时限+30s=70 秒，35 秒 JSON 成功。
 *
 * 同时保留流式 idle+margin 断言：流式请求在首块后静默 1 秒由业务层
 * STREAM_IDLE_TIMEOUT 先触发（早于 bodyTimeout 31 秒），证明流式形态的
 * 底层兜底不被本修复削弱。全部本机回环 + 合成内容。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleCaller,
  SecretValue,
  type AdapterRequest,
  type AdapterResource,
} from "../index.js";

const BODY_DELAY_MS = 35_000;
const STREAM_IDLE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 40_000;

function resource(baseUrl: string): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-real-nonstream",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 1,
    baseUrl,
    secret: new SecretValue("sk-real-nonstream"),
  };
}

function nonStreamRequest(): AdapterRequest {
  return {
    requestId: "req-real-nonstream-1",
    unifiedModel: "qianliu-deepseek",
    capability: "chat",
    stream: false,
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] },
  };
}

function streamRequest(): AdapterRequest {
  return {
    requestId: "req-real-nonstream-2",
    unifiedModel: "qianliu-deepseek",
    capability: "chat",
    stream: true,
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true },
    onStreamChunk: () => undefined,
  };
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve({ server, url });
    });
  });
}

describe("真实本地 HTTP：非流式 bodyTimeout 绑定总时限（C-P1-1）", () => {
  it("headers 立即返回、35 秒延迟正文：合法 JSON 在总时限内成功，不被空闲门限截断", async () => {
    const { server, url } = await startServer((_req, res) => {
      // headers-first：立即响应头（writeHead 在 Node 里缓冲到首次写出，
      // 必须 flushHeaders 才真正即时到达——与真实上游行为对齐），正文延迟 35 秒。
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      setTimeout(() => {
        if (!res.writableEnded) {
          res.end(JSON.stringify({
            id: "chatcmpl-delayed",
            choices: [{ message: { role: "assistant", content: "延迟正文成功" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }));
        }
      }, BODY_DELAY_MS);
    });
    try {
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: url },
        streamIdleTimeoutMs: STREAM_IDLE_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      const startedAt = Date.now();
      const outcome = await caller(resource(url), nonStreamRequest(), 1);
      const elapsed = Date.now() - startedAt;

      // 修复前：约 31.5 秒被底层截断 → status=0 / upstream_invalid_json / UPSTREAM_PROTOCOL。
      expect(outcome).toMatchObject({ status: 200, committed: true });
      expect(outcome.error).toBeUndefined();
      expect(outcome.failureLayer).not.toBe("UPSTREAM_PROTOCOL");
      expect(outcome.usage).toMatchObject({ input: 2, output: 3 });
      expect(elapsed).toBeGreaterThanOrEqual(BODY_DELAY_MS - 2_000);
      expect(elapsed).toBeLessThan(REQUEST_TIMEOUT_MS);
    } finally {
      server.close();
    }
  }, 60_000);

  it("流式形态保留 idle+margin 断言：首块后静默 1 秒由业务层先触发，早于 bodyTimeout 31 秒", async () => {
    const { server, url } = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
      // 之后静默：业务空闲门限 1 秒先于 bodyTimeout（1 秒 + 30 秒）触发。
    });
    try {
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: url },
        streamIdleTimeoutMs: STREAM_IDLE_MS,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      const startedAt = Date.now();
      const outcome = await caller(resource(url), streamRequest(), 1);
      const elapsed = Date.now() - startedAt;

      expect(outcome).toMatchObject({
        status: 504,
        error: "upstream_timeout",
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
      // 业务门限 1 秒先触发；若被 bodyTimeout 31 秒截断则 elapsed 会落在 30 秒以上。
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      server.close();
    }
  }, 30_000);
});
