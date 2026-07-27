/**
 * @qianliu/control-api —— 控制平面与管理 API 构建器（W02）。
 *
 * buildControlApi(db) 同步注册所有插件与路由，返回 Fastify 实例。
 * 测试直接调用此函数；生产入口在 main.ts。
 *
 * 安全：HttpOnly+Secure+SameSite Cookie；严格 CORS（TRD §14.2）。
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import {
  PrincipalRepository,
  AuditRepository,
  AdminRepository,
  KeyRepository,
  GrantRepository,
  ProviderRepository,
} from "@qianliu/database";
import {
  generateApiKey,
  digestApiKey,
  apiKeyPrefix,
  decodeKek,
} from "@qianliu/provider-adapters";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerPrincipalRoutes } from "./principals/routes.js";
import { registerAuditRoutes } from "./plugins/audit-routes.js";
import { registerKeyRoutes } from "./keys/routes.js";
import { registerGrantRoutes } from "./grants/routes.js";
import { registerProviderRoutes } from "./providers/routes.js";

/** 已认证管理员的请求上下文（auth-guard 注入）。 */
export interface AdminContext {
  adminUserId: string;
  enterpriseId: string;
  username: string;
}

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminContext;
  }
  interface FastifyInstance {
    db: Kysely<Database>;
    principalRepo: PrincipalRepository;
    auditRepo: AuditRepository;
    adminRepo: AdminRepository;
    keyRepo: KeyRepository;
    grantRepo: GrantRepository;
    providerRepo: ProviderRepository;
    credentialKek: Buffer;
  }
}

export interface ControlApiOptions {
  port?: number;
  host?: string;
}

export function buildControlApi(db: Kysely<Database>, _opts: ControlApiOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  app.decorate("db", db);
  app.decorate("principalRepo", new PrincipalRepository(db));
  app.decorate("auditRepo", new AuditRepository(db));
  app.decorate("adminRepo", new AdminRepository(db));
  app.decorate(
    "keyRepo",
    new KeyRepository(
      db,
      // F-02：dev fallback 仅测试态可达；生产入口 main.ts 已用 requireEnv 拦截缺失
      process.env.GATEWAY_KEY_PEPPER ?? "dev-only-pepper",
      generateApiKey,
      digestApiKey,
      apiKeyPrefix,
    ),
  );
  app.decorate("grantRepo", new GrantRepository(db));
  app.decorate("providerRepo", new ProviderRepository(db));
  // KEK：从环境注入；F-02 dev fallback 仅测试态可达，生产入口 main.ts 已拦截缺失
  app.decorate(
    "credentialKek",
    decodeKek(
      process.env.CREDENTIAL_KEK ??
        "ZGV2LW9ubHkta2VrLXJlcGxhY2UtaW4tcGlsb3QAAAA=", // dev placeholder 32 bytes
    ),
  );

  app.get("/health", async () => ({ status: "ok", service: "control-api" }));

  // 在插件作用域内注册 cookie/cors/路由，保证 ready 时全部就绪
  void app.register(async (child) => {
    await child.register(cookie, {
      // F-02：dev fallback 仅测试态可达；生产入口 main.ts 已用 requireEnv 拦截缺失
      secret: process.env.COOKIE_SECRET ?? "dev-only-cookie-secret-REPLACE",
    });
    await child.register(cors, {
      origin: process.env.WEB_ORIGIN ?? true,
      credentials: true,
    });
    registerAuthRoutes(child);
    registerPrincipalRoutes(child);
    registerAuditRoutes(child);
    registerKeyRoutes(child);
    registerGrantRoutes(child);
    registerProviderRoutes(child);
  });

  return app;
}
