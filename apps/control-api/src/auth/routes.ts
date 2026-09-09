/**
 * 认证路由 —— 管理员登录、登出、当前会话（W02）。
 *
 * 依据：TRD §14.1（账号密码登录，无验证码）、§14.2（Cookie 安全）。
 * 流程：POST /auth/login → 校验 Argon2id → 创建 admin_session → 设置 HttpOnly Cookie。
 * 登录限速：有界内存计数（按 IP + username）；多实例部署时应换 Redis。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { verifyPassword } from "./password.js";
import {
  generateSessionToken,
  digestSessionToken,
} from "@qianliu/provider-adapters";
import { requireAuth, SESSION_COOKIE_NAME, SESSION_TTL } from "../plugins/auth-guard.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { loadAdminAccess } from "../admins/access.js";

const LoginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

export function registerAuthRoutes(app: FastifyInstance): void {
  let limiterPolicy = "";
  let loginRateLimiter = new LoginRateLimiter({ maxAttempts: 5, windowMs: 5 * 60_000, maxBuckets: 10_000 });
  app.post("/auth/login", async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
    }
    const { username, password } = parsed.data;
    const now = Date.now();
    const rateLimitKey = `${req.ip}\0${username.trim().toLowerCase()}`;

    // 一期单企业：取第一条 enterprise（部署初始化或测试种子创建）
    const enterprises = await app.db.selectFrom("enterprise").selectAll().orderBy("created_at", "asc").orderBy("id", "asc").limit(1).execute();
    const enterprise = enterprises[0];
    if (!enterprise) {
      return reply.code(500).send({ error: "server_error", message: "企业未初始化" });
    }
    const policy = `${enterprise.id}:${enterprise.security_version}`;
    if (policy !== limiterPolicy) {
      limiterPolicy = policy;
      loginRateLimiter = new LoginRateLimiter({ maxAttempts: enterprise.login_max_failures,
        windowMs: enterprise.login_lock_minutes * 60_000, maxBuckets: 10_000 });
    }
    if (loginRateLimiter.isBlocked(rateLimitKey, now)) {
      return reply.code(429).send({ error: "rate_limited", message: "尝试过于频繁，请稍后再试" });
    }

    const admin = await app.adminRepo.findByUsername(enterprise.id, username);
    if (!admin || admin.status !== "ACTIVE") {
      loginRateLimiter.recordFailure(rateLimitKey, now);
      return reply.code(401).send({ error: "invalid_credentials", message: "用户名或密码错误" });
    }

    const ok = await verifyPassword(admin.password_hash, password);
    if (!ok) {
      loginRateLimiter.recordFailure(rateLimitKey, now);
      return reply.code(401).send({ error: "invalid_credentials", message: "用户名或密码错误" });
    }

    loginRateLimiter.clear(rateLimitKey);

    const token = generateSessionToken();
    const tokenHash = digestSessionToken(token);
    const expiresAt = new Date(now + (enterprise.session_minutes * 60_000 || SESSION_TTL));
    const session = await app.adminRepo.createSession(admin.id, tokenHash, expiresAt);
    await app.db.updateTable("admin_session").set({ user_agent: req.headers["user-agent"]?.slice(0, 512) ?? null,
      ip_address: req.ip.slice(0, 64), last_seen_at: new Date(now) }).where("id", "=", session.id).execute();

    await app.auditRepo.write({
      enterprise_id: admin.enterprise_id,
      admin_user_id: admin.id,
      action: "auth.login",
      target_type: "admin_user",
      target_id: admin.id,
      result: "SUCCESS",
    });

    reply
      .setCookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        expires: expiresAt,
      })
      .code(200)
      .send({
        admin: {
          ...await loadAdminAccess(app, admin.id, admin.enterprise_id),
          id: admin.id,
          username: admin.username,
          display_name: admin.display_name,
          enterprise_id: admin.enterprise_id,
          must_change_password: admin.must_change_password,
        },
        featureFlags: app.featureFlags,
        providerFinanceMode: app.providerFinanceMode,
      });
  });

  app.post("/auth/logout", { preHandler: [requireAuth] }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (token) {
      const tokenHash = digestSessionToken(token);
      await app.adminRepo.revokeSession(tokenHash);
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "auth.logout",
        target_type: "admin_user",
        target_id: req.admin!.adminUserId,
        result: "SUCCESS",
      });
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" }).code(204).send();
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (req) => {
    return { admin: req.admin, featureFlags: app.featureFlags,
      providerFinanceMode: app.providerFinanceMode };
  });
}
