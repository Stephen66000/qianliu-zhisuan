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
  });

  void app.register(async (child) => {
    await registerRequestId(child);
    const auth: AuthHandler = createPrincipalAuth(db, pepper);
    // W23：WebSocket 一期未启用（详细计划 §4.6 默认关闭），握手请求显式拒绝为
    // 422 capability_not_supported，不得静默降级。WS 握手是带 Upgrade 头的 HTTP
    // 请求，普通 POST 拒绝路由拦不住，故在路由前用 onRequest 拦截。
    child.addHook("onRequest", async (req, reply) => {
      const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
      if (upgrade === "websocket") {
        const err = fromClassification(
          ERROR_CLASSIFICATION.CAPABILITY_UNSUPPORTED,
          "capability_not_supported",
          "WebSocket 一期未启用",
          req.requestId,
        );
        return reply
          .code(err.status)
          .header("x-request-id", req.requestId)
          .send({
            error: {
              message: err.message,
              type: err.type,
              code: err.code,
              param: null,
              retryable: err.retryable,
              request_id: req.requestId,
              provider: null,
              capability: "websocket",
            },
          });
      }
    });
    registerModelsRoute(child, db, auth);
    registerChatRoute(child, auth, pipelineHandler);
    registerMessagesRoute(child, auth, pipelineHandler);
    registerUnsupportedRoutes(child, auth);
  });

  app.get("/health", async () => ({ status: "ok", service: "gateway" }));

  return app;
}
