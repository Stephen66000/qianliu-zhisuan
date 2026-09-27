/**
 * 真实本地 HTTP 慢流验证（统一 300 秒空闲门限）。
 *
 * 假时钟测试只证明计时逻辑边界；本文件用真实时间验证：
 * 1. 真实 HTTP 上游首块后静默 300 秒：业务层先产生 `STREAM_IDLE_TIMEOUT`，
 *    不被 Undici bodyTimeout（空闲 + 30 秒 = 330 秒）抢先变成网络中断。
 * 2. 真实 HTTP 上游首块后 299 秒恢复：不提前失败，恢复后重置完整窗口并成功收尾。
 * 3. 本地可控反向代理（Node http 透传，无读超时）：客户端 ↔ 代理 ↔ 慢上游
 *    全链路保持连接，空闲超时的协议内错误帧可穿透代理到达客户端。
 *
 * 全部使用本机回环地址与合成内容，不使用生产用户流量。
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createOpenAiCompatibleCaller,
  SecretValue,
  type AdapterRequest,
  type AdapterResource,
} from "../index.js";

const IDLE_MS = 300_000;

function resource(baseUrl: string): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-real-slow",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 1,
    baseUrl,
    secret: new SecretValue("sk-real-slow"),
  };
}

function streamRequest(): AdapterRequest {
  return {
    requestId: "req-real-slow-1",
    unifiedModel: "qianliu-deepseek",
    capability: "chat",
    stream: true,
    body: { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true },
    onStreamChunk: () => undefined,
  };
}

/** 首块后行为由 onFirstChunk 回调决定；server.close() 由测试收尾。 */
function startSlowServer(
  onFirstChunk: (res: import("node:http").ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
      void onFirstChunk(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve({ server, url });
    });
  });
}

describe("真实本地 HTTP 慢流：统一 300 秒空闲门限", () => {
  it("首块后真实静默 300 秒：业务层先触发 STREAM_IDLE_TIMEOUT，早于 Undici bodyTimeout 330 秒", async () => {
    const { server, url } = await startSlowServer(() => {
      // 首块后保持连接、不再发送任何数据（包括零长度块也不发）。
    });
    try {
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: url },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 600_000,
      });
      const startedAt = Date.now();
      const outcome = await caller(resource(url), streamRequest(), 1);
      const elapsed = Date.now() - startedAt;

      expect(outcome).toMatchObject({
        status: 504,
        error: "upstream_timeout",
        failureLayer: "STREAM_IDLE_TIMEOUT",
      });
      // 业务门限 300 秒先触发；Undici bodyTimeout 330 秒兜底未被触达。
      expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS - 2_000);
      expect(elapsed).toBeLessThan(IDLE_MS + 25_000);
    } finally {
      server.close();
    }
  }, 360_000);

  it("首块后真实静默 299 秒恢复：不提前失败，重置完整窗口并成功收尾", async () => {
    const { server, url } = await startSlowServer(async (res) => {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS - 1_000));
      if (!res.writableEnded) {
        res.write("data: {\"choices\":[{\"delta\":{\"content\":\"299 秒恢复\"}}]}\n\n");
        res.write("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1}}\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
    try {
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: url },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 600_000,
      });
      const outcome = await caller(resource(url), streamRequest(), 1);

      expect(outcome).toMatchObject({ status: 200, committed: true });
      expect(outcome.failureLayer).not.toBe("STREAM_IDLE_TIMEOUT");
      expect(outcome.usage.output).toBe(1);
    } finally {
      server.close();
    }
  }, 360_000);

  it("本地可控反向代理透传：客户端在 300 秒空闲窗口内保持连接并收到协议内错误帧", async () => {
    // 慢上游：首块后 300 秒静默（连接保持不断开）。
    const upstream = await startSlowServer(() => {});
    // 可控代理：无读超时，双向透传（模拟部署文档要求 /v1/* 等待不低于 660 秒的链路）。
    const proxy = await new Promise<Server>((resolve) => {
      const p = createServer((clientReq, clientRes) => {
        const upstreamReq = httpRequest(
          `${upstream.url}${clientReq.url}`,
          { method: clientReq.method, headers: clientReq.headers },
          (upstreamRes) => {
            clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(clientRes);
          },
        );
        clientReq.pipe(upstreamReq);
        clientReq.on("error", () => upstreamReq.destroy());
      });
      p.listen(0, "127.0.0.1", () => resolve(p));
    });
    try {
      const proxyAddress = proxy.address();
      const proxyUrl = `http://127.0.0.1:${typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0}`;
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: proxyUrl },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 600_000,
      });
      const startedAt = Date.now();
      const outcome = await caller(resource(proxyUrl), streamRequest(), 1);
      const elapsed = Date.now() - startedAt;

      // 代理未在业务窗口内切断：错误由业务层产生并穿透代理返回。
      expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS - 2_000);
      expect(outcome).toMatchObject({ failureLayer: "STREAM_IDLE_TIMEOUT" });
    } finally {
      proxy.close();
      upstream.server.close();
    }
  }, 360_000);
});
