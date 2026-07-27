/**
 * request-id 插件 —— 分配稳定 request_id 并贯穿（W05）。
 *
 * 依据：TRD §5.7 行 348「ai_request.id 在进入上游前创建，并贯穿响应头、日志、Trace、attempt、usage、账本」。
 * 优先使用客户端 x-request-id（幂等重试），否则生成。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const REQUEST_ID_HEADER = "x-request-id";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const id =
      typeof incoming === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    req.requestId = id;
    reply.header(REQUEST_ID_HEADER, id);
  });
}
