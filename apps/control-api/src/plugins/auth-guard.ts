/**
 * auth-guard —— 校验请求携带有效 session，注入 AdminContext。
 *
 * 依据：TRD §11.2 L722「所有写操作只接受已登录管理员」。
 * 用法：app.decorateRequest('admin', null); 写路由 preHandler: [requireAuth]。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { digestSessionToken } from "@qianliu/provider-adapters";
import type { AdminContext } from "../server.js";
import { allowsRoute, loadAdminAccess } from "../admins/access.js";

const SESSION_COOKIE = "qianliu_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 小时

export async function requireAuth(
  this: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    await reply.code(401).send({ error: "unauthenticated", message: "未登录" });
    return;
  }
  const tokenHash = digestSessionToken(token);
  const session = await this.adminRepo.findSessionByTokenHash(tokenHash);
  if (!session) {
    await reply.clearCookie(SESSION_COOKIE).code(401).send({ error: "unauthenticated", message: "会话无效或已过期" });
    return;
  }
  if (session.admin_status !== "ACTIVE") {
    await reply.clearCookie(SESSION_COOKIE).code(403).send({ error: "forbidden", message: "账号已停用" });
    return;
  }
  req.admin = {
    ...await loadAdminAccess(this, session.admin_id, session.admin_enterprise_id),
    sessionId: session.session_id,
    adminUserId: session.admin_id,
    enterpriseId: session.admin_enterprise_id,
    username: session.admin_username,
    displayName: session.admin_display_name,
    mustChangePassword: session.admin_must_change_password,
  } satisfies AdminContext;
  if (
    session.admin_must_change_password &&
    !new Set(["/auth/me", "/auth/logout", "/auth/change-password"]).has(req.routeOptions.url ?? "")
  ) {
    await reply.code(403).send({
      error: "password_change_required",
      message: "首次登录必须先修改密码",
    });
    return;
  }
  if (!allowsRoute(req.admin, req.routeOptions.url ?? "", req.method)) {
    await reply.code(403).send({ error: "permission_denied", message: "没有此模块的访问或操作权限" });
    return;
  }
  await this.db.updateTable("admin_session").set({ last_seen_at: new Date() })
    .where("id", "=", session.session_id).execute();
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_TTL = SESSION_TTL_MS;
