import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ADMIN_MODULES } from "@qianliu/contracts";
import { sql } from "kysely";
import { requireAuth } from "../plugins/auth-guard.js";
import { PASSWORD_POLICY_MESSAGE } from "../auth/password.js";
import { registerVersionRoute } from "./version-route.js";
import { registerReferenceRoutes } from "./reference-routes.js";

const permission = z.object({ view: z.boolean(), operate: z.boolean() }).strict()
  .refine(p => !p.operate || p.view, "操作权限必须同时允许查看");
const roleSchema = z.object({ expected_version: z.number().int().min(0), name: z.string().trim().min(1).max(128),
  permissions: z.partialRecord(z.enum(ADMIN_MODULES.map(m => m[0]) as [typeof ADMIN_MODULES[number][0], ...typeof ADMIN_MODULES[number][0][]]), permission),
}).strict().refine(r => !r.permissions.admins?.operate && !r.permissions.security?.operate && !r.permissions.version?.operate,
  "账号授权、登录策略及发布操作仅限超级管理员");
const securitySchema = z.object({ expected_version: z.number().int().positive(),
  session_minutes: z.number().int().min(15).max(1440), login_max_failures: z.number().int().min(3).max(10),
  login_lock_minutes: z.number().int().min(5).max(60), force_initial_password_change: z.boolean(),
}).strict();
const securityColumns = ["session_minutes", "login_max_failures", "login_lock_minutes", "force_initial_password_change", "security_version"] as const;

export function registerAccountSettingsRoutes(app: FastifyInstance) {
  registerVersionRoute(app);
  registerReferenceRoutes(app);
  app.get("/admin-role", { preHandler: [requireAuth] }, async req => ({
    role: await app.db.selectFrom("admin_role").selectAll().where("enterprise_id", "=", req.admin!.enterpriseId).executeTakeFirst() ?? null,
    modules: ADMIN_MODULES,
  }));
  app.put("/admin-role", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.issues[0]?.message });
    const { expected_version, name, permissions } = parsed.data;
    const enterpriseId = req.admin!.enterpriseId;
    const role = await app.db.transaction().execute(async trx => {
      await trx.selectFrom("enterprise").select("id").where("id", "=", enterpriseId).forUpdate().execute();
      const before = await trx.selectFrom("admin_role").selectAll().where("enterprise_id", "=", enterpriseId).executeTakeFirst();
      if ((before?.version ?? 0) !== expected_version) return null;
      const next = await trx.insertInto("admin_role").values({ enterprise_id: enterpriseId, name,
        permissions, version: expected_version + 1, updated_at: new Date() })
        .onConflict(c => c.column("enterprise_id").doUpdateSet({ name, permissions, version: expected_version + 1, updated_at: new Date() }))
        .returningAll().executeTakeFirstOrThrow();
      await trx.insertInto("operation_log").values({ enterprise_id: enterpriseId, admin_user_id: req.admin!.adminUserId,
        actor_source: "ADMIN", action: "admin.role.update", target_type: "admin_role", target_id: enterpriseId,
        result: "SUCCESS", change_summary: { before: before ?? null, after: next } }).execute();
      return next;
    });
    return role ? { role } : reply.code(409).send({ error: "conflict", message: "岗位已被其他管理员修改，请刷新" });
  });
  app.get("/security-settings", { preHandler: [requireAuth] }, async req => ({
    settings: await app.db.selectFrom("enterprise").select(securityColumns).where("id", "=", req.admin!.enterpriseId).executeTakeFirstOrThrow(),
    password_policy: PASSWORD_POLICY_MESSAGE,
  }));
  app.patch("/security-settings", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = securitySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: "登录策略参数无效" });
    const { expected_version, ...values } = parsed.data;
    const result = await app.db.transaction().execute(async trx => {
      const before = await trx.selectFrom("enterprise").select(securityColumns).where("id", "=", req.admin!.enterpriseId).forUpdate().executeTakeFirstOrThrow();
      if (before.security_version !== expected_version) return null;
      const after = await trx.updateTable("enterprise").set({ ...values, security_version: expected_version + 1 })
        .where("id", "=", req.admin!.enterpriseId).returning(securityColumns).executeTakeFirstOrThrow();
      // Shortening policy caps existing sessions; it never extends their expiry.
      await sql`UPDATE admin_session SET expires_at = LEAST(expires_at, now() + ${values.session_minutes} * interval '1 minute')
        WHERE admin_user_id IN (SELECT id FROM admin_user WHERE enterprise_id = ${req.admin!.enterpriseId}::uuid)
        AND revoked_at IS NULL`.execute(trx);
      await trx.insertInto("operation_log").values({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        actor_source: "ADMIN", action: "security.settings.update", target_type: "enterprise", target_id: req.admin!.enterpriseId,
        change_summary: { before, after }, result: "SUCCESS" }).execute();
      return after;
    });
    return result ? { settings: result } : reply.code(409).send({ error: "conflict", message: "登录策略已改变，请刷新" });
  });
  app.get("/admin-sessions", { preHandler: [requireAuth] }, async req => ({ sessions: await app.db.selectFrom("admin_session as s")
    .innerJoin("admin_user as a", "a.id", "s.admin_user_id").select(["s.id", "a.username", "a.display_name", "s.user_agent", "s.ip_address", "s.last_seen_at", "s.created_at", "s.expires_at"])
    .where("a.enterprise_id", "=", req.admin!.enterpriseId).where("a.archived_at", "is", null).where("a.status", "=", "ACTIVE")
    .where("s.revoked_at", "is", null).where("s.expires_at", ">", new Date()).orderBy("s.created_at", "desc").limit(200).execute(), current_session_id: req.admin!.sessionId }));
  app.delete("/admin-sessions/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: "invalid_request" });
    if (id.data === req.admin!.sessionId) return reply.code(409).send({ error: "current_session", message: "请通过退出登录结束当前会话" });
    const changed = await app.db.transaction().execute(async trx => {
      const session = await trx.updateTable("admin_session").set({ revoked_at: new Date() }).where("id", "=", id.data)
        .where("admin_user_id", "in", trx.selectFrom("admin_user").select("id").where("enterprise_id", "=", req.admin!.enterpriseId))
        .where("revoked_at", "is", null).returning("id").executeTakeFirst();
      if (session) await trx.insertInto("operation_log").values({ enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId, actor_source: "ADMIN", action: "admin.session.revoke", target_type: "admin_session",
        target_id: id.data, result: "SUCCESS" }).execute();
      return session;
    });
    return changed ? reply.code(204).send() : reply.code(404).send({ error: "not_found" });
  });
}
