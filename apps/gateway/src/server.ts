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
import { createPrincipalAuth, type PrincipalAuthResult } from "./auth/principal-auth.js";
import { registerModelsRoute, type AuthHandler } from "./routes/models.js";
import { registerChatRoute, type PipelineHandler } from "./routes/chat.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerUnsupportedRoutes } from "./routes/unsupported.js";
import { fromClassification } from "./plugins/error-envelope.js";
import { ERROR_CLASSIFICATION } from "@qianliu/domain";

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

  void app.register(async (child) => {
    await registerRequestId(child);
    const auth: AuthHandler = createPrincipalAuth(db, pepper);
    registerModelsRoute(child, db, auth);
    registerChatRoute(child, auth, pipelineHandler);
    registerMessagesRoute(child, auth, pipelineHandler);
    registerUnsupportedRoutes(child, auth);
  });

  app.get("/health", async () => ({ status: "ok", service: "gateway" }));

  return app;
}
