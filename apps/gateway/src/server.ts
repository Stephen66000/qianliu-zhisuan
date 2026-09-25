/**
 * @qianliu/gateway —— 北向 Gateway 数据平面构建器（W05）。
 *
 * buildGateway(db, pepper, pipelineHandler) 同步注册插件与路由。
 * W05：北向合同 + 鉴权 + request_id + 能力拒绝（422）。
 * W06/W07：pipelineHandler 注入完整 Adapter + 账本。
 */
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { registerRequestId } from "./plugins/request-id.js";
import {
  createModelAuthorization,
  createPrincipalAuth,
  type PrincipalAuthResult,
} from "./auth/principal-auth.js";
import { chainGuards, createQuiescenceGate } from "./admission/enterprise-maintenance.js";
import { registerModelsRoute, type AuthHandler } from "./routes/models.js";
import { registerChatRoute, type PipelineHandler } from "./routes/chat.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerResponsesRoute } from "./routes/responses.js";
import { registerUnsupportedRoutes } from "./routes/unsupported.js";
import { fromClassification, sendErrorEnvelope } from "./plugins/error-envelope.js";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";
import { readPositiveIntEnv } from "@qianliu/config";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    principal?: PrincipalAuthResult;
  }
}

export interface GatewayOptions {
  port?: number;
  host?: string;
}

/**
 * 入站请求体上限（字节）。Fastify 默认仅 1MB，ZCode coding-plan 等长会话单轮
 * 累积上下文几轮即超 1MB，会在 application/json 解析阶段被拒（FST_ERR_CTP_BODY_TOO_LARGE → 413）。
 * 默认 10MB 给足余量；可通过 GATEWAY_REQUEST_BODY_LIMIT_BYTES 覆盖。
 * H-1：校验逻辑复用 @qianliu/config 的 readPositiveIntEnv（与 control-api 共享，防漂移）。
 */
const REQUEST_BODY_LIMIT_DEFAULT = 10 * 1024 * 1024;

export function readRequestBodyLimit(env: NodeJS.ProcessEnv): number {
  return readPositiveIntEnv(env, "GATEWAY_REQUEST_BODY_LIMIT_BYTES", REQUEST_BODY_LIMIT_DEFAULT, "字节");
}

export function buildGateway(
  db: Kysely<Database>,
  pepper: string,
  pipelineHandler: PipelineHandler,
  _opts: GatewayOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    genReqId: () => crypto.randomUUID(), // 兜底；request-id 插件会覆盖
    // W24：反代（Caddy/nginx）终止 TLS 时，信任 X-Forwarded-* 以正确判定协议/主机（影响 Cookie secure）。
    trustProxy: process.env.NODE_ENV === "production",
    // 入站 bodyLimit：默认 1MB 太小，长会话会撞 FST_ERR_CTP_BODY_TOO_LARGE。
    bodyLimit: readRequestBodyLimit(process.env),
  });

  // W23：WebSocket 一期未启用（详细计划 §4.6 默认关闭），握手请求显式拒绝为
  // 422 capability_not_supported，不得静默降级。
  // 实现边界：当前未注册任何 'upgrade' 事件监听器，WS 握手请求会走正常 Fastify
  // 请求生命周期，故根 scope onRequest 能拦住（child scope 会被未匹配路由 404
  // 短路）。一旦未来注册 upgrade 监听器（如 @fastify/websocket），Node 会把
  // Upgrade 请求路由到 upgrade 事件、绕过 Fastify 生命周期，此 hook 将失效——
  // 届时需改用 app.server.on('upgrade', ...) 显式拒绝（M6 双审 P1/A1）。
  app.addHook("onRequest", async (req, reply) => {
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
    if (upgrade === "websocket") {
      const err = fromClassification(
        ERROR_CLASSIFICATION.CAPABILITY_UNSUPPORTED,
        "capability_not_supported",
        "WebSocket 一期未启用",
        req.id,
      );
      return reply
        .code(err.status)
        .header("x-request-id", req.id)
        .send({
          error: {
            message: err.message,
            type: err.type,
            code: err.code,
            param: null,
            retryable: err.retryable,
            request_id: req.id,
            provider: null,
            capability: "websocket",
          },
        });
    }
  });

  // 入站请求体超 bodyLimit 时，Fastify 默认走原生错误 JSON（非 OpenAI envelope，
  // 且会被日志层记成 reason=unknown）。这里统一拦截 FST_ERR_CTP_BODY_TOO_LARGE，
  // 转成 OpenAI 兼容 envelope + code=payload_too_large，便于客户端识别。
  app.setErrorHandler((err, req, reply) => {
    // Fastify 5 的 error handler 入参为 unknown；FST_ERR_CTP_BODY_TOO_LARGE 是
    // Fastify 内部错误（Error 子类，带 .code 字符串）。
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "FST_ERR_CTP_BODY_TOO_LARGE"
    ) {
      const ge = fromClassification(
        ERROR_CLASSIFICATION.PAYLOAD_TOO_LARGE,
        "payload_too_large",
        "请求体超过上限，请减少消息历史或附件后重试",
        req.id,
      );
      return sendErrorEnvelope(reply, ge);
    }
    // B-1：其余错误复刻 Fastify 默认 errorHandler 行为（含日志 + 状态码 + 序列化）。
    // 原 reply.send(err) 会丢失默认的 req.log.error 日志记录。
    const status = reply.statusCode >= 400 ? reply.statusCode : 500;
    const level = status >= 500 ? "error" : "info";
    req.log[level]({ err }, err instanceof Error ? err.message : String(err));
    reply.code(status).send(err);
  });

  void app.register(async (child) => {
    await registerRequestId(child);
    const auth: AuthHandler = createPrincipalAuth(db, pepper);
    const authorizeModel: AuthHandler = createModelAuthorization(db);
    // PFA-09：静默期内目标企业的新模型调用在 pipeline 之前被短路（零上游、零账本事实）。
    const maintenanceGate: AuthHandler = createQuiescenceGate(db);
    const guardedModelAuthorization: AuthHandler =
      chainGuards(maintenanceGate, authorizeModel);
    registerModelsRoute(child, db, auth);
    registerChatRoute(child, auth, guardedModelAuthorization, pipelineHandler);
    registerMessagesRoute(child, auth, guardedModelAuthorization, pipelineHandler);
    registerResponsesRoute(child, auth, guardedModelAuthorization, pipelineHandler);
    registerUnsupportedRoutes(child, auth);
  });

  app.get("/health", async () => ({ status: "ok", service: "gateway" }));

  return app;
}
