/**
 * 北向端到端慢流验证：慢上游 → Gateway /v1/chat/completions → 下游反向代理 → HTTP 客户端。
 *
 * 与 provider-adapters 侧 real-slow-stream-idle.test.ts 的分工：
 *   - 那边的真实 300 秒用例证明 Caller 层业务门限先于 Undici bodyTimeout 触发；
 *   - 本文件把同一真实 300 秒计时放进完整北向拓扑：真实 Chat 路由（registerChatRoute）、
 *     真实 Chat StreamWriter（createChatStreamWriter）、真实失败文案常量
 *     （STREAM_IDLE_TIMEOUT_MESSAGE），经本地可控反代到达真实 HTTP 客户端。
 *
 * 断言：
 *   1. 客户端先收到正常 SSE 正文 chunk（已提交流）；
 *   2. 空闲超时后收到流内 error frame：约定中文文案 + 机器码 upstream_timeout + 真实 request_id
 *      （与 x-ai-request-id 响应头一致）；
 *   3. 随后收到 data: [DONE]，连接由服务端正常结束；
 *   4. 全程 ≥ 300 秒业务门限，证明超时由业务层产生并穿透代理。
 *
 * 范围说明：DB 侧鉴权/路由/额度/账本依赖 Postgres 容器（本环境无 Docker），
 * 不在本文件覆盖；其合同由单元与既有数据库集成测试保证。本文件聚焦 6.2 的
 * 北向协议与连接保持行为。全部使用本机回环地址与合成内容，不使用生产用户流量。
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll } from "vitest";
import { createOpenAiCompatibleCaller, SecretValue, type AdapterResource } from "@qianliu/provider-adapters";
import { registerChatRoute, type GatewayPipelineBody, type PipelineHandler } from "../routes/chat.js";
import type { AuthHandler } from "../routes/models.js";
import { createChatStreamWriter } from "../routes/chat-protocol.js";
import { STREAM_IDLE_TIMEOUT_MESSAGE } from "../pipeline/upstream-error-diagnostic.js";

const IDLE_MS = 300_000;

let gateway: FastifyInstance;

afterAll(async () => {
  if (gateway) await gateway.close();
});

function resource(baseUrl: string): AdapterResource {
  return {
    providerCode: "deepseek",
    resourceId: "res-northbound-slow",
    mode: "API",
    upstreamModel: "deepseek-chat",
    concurrencyLimit: 1,
    baseUrl,
    secret: new SecretValue("sk-northbound-slow"),
  };
}

/** 首块后保持连接、不再发送任何数据（包括零长度块）。 */
function startSlowServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"首块\"}}]}\n\n");
      // 之后静默：由客户端侧业务空闲门限（300 秒）触发终止。
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve({ server, url });
    });
  });
}

/** 可控反代：无读超时，双向透传（部署文档要求 /v1/* 等待不低于 660 秒的等价链路）。 */
function startProxy(targetUrl: string): Promise<Server> {
  return new Promise((resolve) => {
    const proxy = createServer((clientReq, clientRes) => {
      const upstreamReq = httpRequest(
        `${targetUrl}${clientReq.url}`,
        { method: clientReq.method, headers: clientReq.headers },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
        },
      );
      clientReq.pipe(upstreamReq);
      clientReq.on("error", () => upstreamReq.destroy());
    });
    proxy.listen(0, "127.0.0.1", () => resolve(proxy));
  });
}

describe("北向端到端：Chat SSE 经反代在 300 秒空闲后收到协议内错误帧", () => {
  it("客户端先收正文 chunk，空闲超时后收中文文案+机器码+真实 request_id 的流内错误帧并正常收尾", async () => {
    const upstream = await startSlowServer();
    try {
      // 真实 OpenAI-compatible Caller（与生产同源），默认统一 300 秒空闲门限。
      const caller = createOpenAiCompatibleCaller({
        env: { DEEPSEEK_BASE_URL: upstream.url },
        firstByteTimeoutMs: 5_000,
        requestTimeoutMs: 600_000,
        streamIdleTimeoutMs: IDLE_MS,
      });

      // 北向 Chat 路由 + 真实 StreamWriter。鉴权/模型授权为透传（DB 依赖不可用，
      // 见文件头范围说明）；pipelineHandler 复刻 pipeline-response.ts 的
      // committed 失败分支（真实文案常量 + 真实机器码 + 真实 request_id）。
      gateway = Fastify({ logger: false });
      const passAuth: AuthHandler = async (req) => {
        req.requestId = randomUUID();
      };
      const pipelineHandler: PipelineHandler = async ({ request, reply, body, capability }) => {
        const requestId = randomUUID();
        const streamWriter = createChatStreamWriter(reply, {
          requestId,
          traceId: request.id,
          createdAt: Date.now(),
          model: body.model,
        });
        const gatewayBody = body as GatewayPipelineBody;
        const outcome = await caller(resource(upstream.url), {
          requestId,
          unifiedModel: gatewayBody.model,
          capability,
          stream: gatewayBody.stream === true,
          body: gatewayBody,
          onStreamChunk: (payload) => streamWriter.writeChunk(payload),
        });
        if (!outcome.error) {
          streamWriter.complete(outcome);
          return;
        }
        if (streamWriter.committed) {
          streamWriter.fail({
            code: outcome.error === "stream_interrupted_after_commit"
              ? "upstream_stream_interrupted"
              : outcome.error,
            message: outcome.failureLayer === "STREAM_IDLE_TIMEOUT"
              ? STREAM_IDLE_TIMEOUT_MESSAGE
              : "上游流超时",
            requestId,
          });
          return;
        }
        reply.code(504).header("x-request-id", request.id).send({
          error: {
            message: outcome.failureLayer === "STREAM_IDLE_TIMEOUT"
              ? STREAM_IDLE_TIMEOUT_MESSAGE
              : "上游流超时",
            type: "server_error",
            code: outcome.error,
            param: null,
            retryable: true,
            request_id: requestId,
          },
        });
      };
      registerChatRoute(gateway, passAuth, passAuth, pipelineHandler);
      await gateway.listen({ port: 0, host: "127.0.0.1" });
      const gatewayAddress = gateway.server.address();
      const gatewayUrl = `http://127.0.0.1:${typeof gatewayAddress === "object" && gatewayAddress ? gatewayAddress.port : 0}`;

      // 下游客户端 → 反代 → Gateway。
      const proxy = await startProxy(gatewayUrl);
      try {
        const proxyAddress = proxy.address();
        const proxyUrl = `http://127.0.0.1:${typeof proxyAddress === "object" && proxyAddress ? proxyAddress.port : 0}`;
        const startedAt = Date.now();
        const clientRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer test-key",
          },
          body: JSON.stringify({
            model: "qianliu-deepseek",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        });

        // SSE 已提交：HTTP 200 + 事件流响应头，携带真实请求 ID。
        expect(clientRes.status).toBe(200);
        expect(clientRes.headers.get("content-type")).toContain("text/event-stream");
        const aiRequestId = clientRes.headers.get("x-ai-request-id");
        expect(aiRequestId).toBeTruthy();

        // 读取整个事件流直至服务端正常结束。
        const reader = clientRes.body!.getReader();
        const decoder = new TextDecoder();
        let sseText = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          sseText += decoder.decode(value, { stream: true });
        }
        const elapsed = Date.now() - startedAt;

        // 解析 data: 帧序列。
        const frames = sseText
          .split("\n\n")
          .filter((block) => block.startsWith("data: "))
          .map((block) => block.slice("data: ".length));

        // 1. 先收到正常正文 chunk（流已提交）。
        expect(frames.length).toBeGreaterThan(1);
        const firstChunk = JSON.parse(frames[0]!) as {
          choices: Array<{ delta: { content?: string } }>;
        };
        expect(firstChunk.choices[0]?.delta.content).toBe("首块");

        // 2. 空闲超时后收到协议内 error frame：中文文案 + 机器码 + 真实 request_id。
        // [DONE] 帧不是 JSON，跳过解析。
        const errorFrame = frames
          .map((raw) => {
            try {
              return JSON.parse(raw) as { error?: { code?: string; message?: string; request_id?: string } };
            } catch {
              return null;
            }
          })
          .find((payload) => payload?.error);
        expect(errorFrame).toBeDefined();
        expect(errorFrame!.error!.code).toBe("upstream_timeout");
        expect(errorFrame!.error!.message).toBe(STREAM_IDLE_TIMEOUT_MESSAGE);
        expect(errorFrame!.error!.request_id).toBe(aiRequestId);

        // 3. 服务端以 [DONE] 正常收尾。
        expect(frames[frames.length - 1]).toBe("[DONE]");

        // 4. 全程由真实 300 秒业务门限主导（Caller 层计时证据见
        // provider-adapters real-slow-stream-idle.test.ts；此处证明同一门限
        // 在北向拓扑下生效且错误帧穿透反代）。
        expect(elapsed).toBeGreaterThanOrEqual(IDLE_MS - 2_000);
        expect(elapsed).toBeLessThan(IDLE_MS + 25_000);
      } finally {
        proxy.close();
      }
    } finally {
      upstream.server.close();
    }
  }, 360_000);
});
