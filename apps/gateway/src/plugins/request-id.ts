/**
 * request-id 插件 —— 分离客户端追踪 ID、内部请求主键与业务幂等键。
 *
 * - x-request-id：客户端追踪 ID，可跨 WorkBuddy 工具回合复用，不参与数据库唯一性。
 * - aiRequestId：Gateway 内部 UUID，作为 ai_request.id 贯穿 attempt/usage/账本。
 * - idempotency-key：显式业务幂等键，由 pipeline 结合请求体指纹原子认领。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const REQUEST_ID_HEADER = "x-request-id";
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const LEGACY_IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";

declare module "fastify" {
  interface FastifyRequest {
    /** 客户端追踪 ID；无合法入站值时与首次生成的 aiRequestId 相同。 */
    requestId: string;
    /** Gateway 内部请求主键，不直接采用客户端 x-request-id。 */
    aiRequestId: string;
    /** 显式业务幂等键；未提供时每次调用都是新业务请求。 */
    idempotencyKey: string | null;
  }
}

export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const incomingTraceId =
      typeof incoming === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(incoming)
        ? incoming
        : null;
    const aiRequestId = randomUUID();
    const traceId = incomingTraceId ?? aiRequestId;
    const standardKey = singleHeader(req.headers[IDEMPOTENCY_KEY_HEADER]);
    const legacyKey = singleHeader(req.headers[LEGACY_IDEMPOTENCY_KEY_HEADER]);

    req.requestId = traceId;
    req.aiRequestId = aiRequestId;
    req.idempotencyKey = null;
    reply.header(REQUEST_ID_HEADER, traceId);
    reply.header("x-ai-request-id", aiRequestId);

    if (standardKey !== null && legacyKey !== null && standardKey !== legacyKey) {
      return invalidIdempotencyKey(reply, aiRequestId, "幂等键请求头不一致");
    }
    const idempotencyKey = standardKey ?? legacyKey;
    if (idempotencyKey !== null) {
      if (!/^[\x21-\x7E]{1,128}$/.test(idempotencyKey)) {
        return invalidIdempotencyKey(reply, aiRequestId, "Idempotency-Key 必须是 1–128 位可打印 ASCII 字符");
      }
      req.idempotencyKey = idempotencyKey;
    }
  });
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function invalidIdempotencyKey(
  reply: FastifyReply,
  aiRequestId: string,
  message: string,
): FastifyReply {
  return reply.code(400).send({
    error: {
      message,
      type: "invalid_request_error",
      code: "invalid_idempotency_key",
      param: "Idempotency-Key",
      retryable: false,
      request_id: aiRequestId,
    },
  });
}
