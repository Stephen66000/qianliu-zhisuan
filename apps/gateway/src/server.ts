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
    registerModelsRoute(child, db, auth);
    registerChatRoute(child, auth, pipelineHandler);
    registerMessagesRoute(child, auth, pipelineHandler);
    registerUnsupportedRoutes(child, auth);
  });

  app.get("/health", async () => ({ status: "ok", service: "gateway" }));

  return app;
}
