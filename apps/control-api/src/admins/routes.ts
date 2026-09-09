/** POOL-015 —— 管理员账号与密码生命周期 API。 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AdminNotFoundError,
  LastActiveAdminError,
  SelfDisableError,
  type AdminUser,
} from "@qianliu/database";
import { requireAuth, SESSION_COOKIE_NAME } from "../plugins/auth-guard.js";
import {
  hashPassword,
  isStrongPassword,
  PASSWORD_POLICY_MESSAGE,
  verifyPassword,
} from "../auth/password.js";
import { registerAdminCleanupRoute } from "./cleanup-route.js";
import { updateAdminIdentity } from "./update-identity.js";

const UsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, {
    message: "用户名只能包含字母、数字、点、下划线和连字符",
  });
const DisplayNameSchema = z.string().trim().min(1).max(128);
const PasswordSchema = z
  .string()
  .max(128)
  .refine(isStrongPassword, PASSWORD_POLICY_MESSAGE);
const IdSchema = z.string().uuid();

const CreateAdminSchema = z.object({
  username: UsernameSchema,
  display_name: DisplayNameSchema,
  password: PasswordSchema,
  role_code: z.enum(["SUPER_ADMIN", "CUSTOM"]).optional(),
});
const RenameSchema = z.object({ display_name: DisplayNameSchema, role_code: z.enum(["SUPER_ADMIN", "CUSTOM"]).optional(), expected_version: z.number().int().positive().optional() });
const PasswordResetSchema = z.object({ new_password: PasswordSchema });
const ChangePasswordSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: PasswordSchema,
});

function publicAdmin(admin: AdminUser) {
  return {
    id: admin.id,
    enterprise_id: admin.enterprise_id,
    username: admin.username,
    display_name: admin.display_name,
    status: admin.status,
    role_code: admin.role_code,
    archived_at: admin.archived_at,
    must_change_password: admin.must_change_password,
    version: admin.version,
    created_at: admin.created_at,
    updated_at: admin.updated_at,
  };
}

async function auditFailure(
  app: FastifyInstance,
  req: FastifyRequest,
  action: string,
  targetId: string | null,
  reason: string,
): Promise<void> {
  await app.auditRepo.write({
    enterprise_id: req.admin!.enterpriseId,
    admin_user_id: req.admin!.adminUserId,
    action,
    target_type: "admin_user",
    target_id: targetId,
    result: "FAILURE",
    failure_reason: reason,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get("/admins", { preHandler: [requireAuth] }, async (req) => {
    const admins = await app.adminRepo.listByEnterprise(
      req.admin!.enterpriseId, (req.query as { archived?: string }).archived === "true",
    );
    const sessions = await app.db.selectFrom("admin_session as s").innerJoin("admin_user as a", "a.id", "s.admin_user_id")
      .select(eb => ["a.id", eb.fn.max("s.created_at").as("last_login_at")]).where("a.enterprise_id", "=", req.admin!.enterpriseId)
      .groupBy("a.id").execute();
    return { admins: admins.map(admin => ({ ...publicAdmin(admin), last_login_at: sessions.find(s => s.id === admin.id)?.last_login_at ?? null })) };
  });

  app.post("/admins", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      await auditFailure(app, req, "admin.create", null, "invalid_request");
      return reply.code(400).send({
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "请求参数不合法",
      });
    }
    try {
      if (parsed.data.role_code === "CUSTOM" && !await app.db.selectFrom("admin_role").select("enterprise_id")
        .where("enterprise_id", "=", req.admin!.enterpriseId).executeTakeFirst()) {
        return reply.code(400).send({ error: "role_missing", message: "请先保存自定义岗位名称和权限" });
      }
      const admin = await app.adminRepo.createManaged({
        enterpriseId: req.admin!.enterpriseId,
        username: parsed.data.username,
        displayName: parsed.data.display_name,
        passwordHash: await hashPassword(parsed.data.password),
        roleCode: parsed.data.role_code,
      });
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "admin.create",
        target_type: "admin_user",
        target_id: admin.id,
        change_summary: {
          username: admin.username,
          display_name: admin.display_name,
          status: admin.status,
          must_change_password: admin.must_change_password,
          role_code: admin.role_code,
        },
        result: "SUCCESS",
      });
      return reply.code(201).send({ admin: publicAdmin(admin) });
    } catch (error) {
      const reason = isUniqueViolation(error)
        ? "duplicate_username"
        : "create_failed";
      await auditFailure(app, req, "admin.create", null, reason);
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: reason, message: "用户名已存在" });
      }
      throw error;
    }
  });

  app.patch(
    "/admins/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = IdSchema.safeParse((req.params as { id?: unknown }).id);
      const body = RenameSchema.safeParse(req.body);
      if (!id.success || !body.success) {
        await auditFailure(
          app,
          req,
          "admin.rename",
          id.success ? id.data : null,
          "invalid_request",
        );
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "请求参数不合法" });
      }
      const result = await updateAdminIdentity(app, req.admin!, id.data, body.data);
      if (result.error) return reply.code(409).send({ error: "conflict", message: result.error });
      const admin = result.admin;
      if (!admin) {
        await auditFailure(app, req, "admin.rename", id.data, "not_found");
        return reply
          .code(404)
          .send({ error: "not_found", message: "管理员不存在" });
      }
      return { admin: publicAdmin(admin) };
    },
  );

  app.post(
    "/auth/change-password",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = ChangePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        await auditFailure(
          app,
          req,
          "admin.password.change",
          req.admin!.adminUserId,
          "invalid_request",
        );
        return reply.code(400).send({
          error: "invalid_request",
          message: parsed.error.issues[0]?.message ?? "请求参数不合法",
        });
      }
      const admin = await app.adminRepo.findByIdForEnterprise(
        req.admin!.enterpriseId,
        req.admin!.adminUserId,
      );
      if (
        !admin ||
        !(await verifyPassword(
          admin.password_hash,
          parsed.data.current_password,
        ))
      ) {
        await auditFailure(
          app,
          req,
          "admin.password.change",
          req.admin!.adminUserId,
          "invalid_current_password",
        );
        return reply.code(400).send({
          error: "invalid_current_password",
          message: "当前密码错误",
        });
      }
      const changed = await app.adminRepo.changeOwnPassword({
        enterpriseId: req.admin!.enterpriseId,
        adminId: req.admin!.adminUserId,
        previousPasswordHash: admin.password_hash,
        newPasswordHash: await hashPassword(parsed.data.new_password),
      });
      if (!changed) {
        await auditFailure(
          app,
          req,
          "admin.password.change",
          admin.id,
          "concurrent_change",
        );
        return reply.code(409).send({
          error: "conflict",
          message: "密码已被其他会话修改，请重新登录",
        });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "admin.password.change",
        target_type: "admin_user",
        target_id: admin.id,
        change_summary: { sessions_revoked: true, must_change_password: false },
        result: "SUCCESS",
      });
      return reply
        .clearCookie(SESSION_COOKIE_NAME, { path: "/" })
        .code(204)
        .send();
    },
  );

  app.post(
    "/admins/:id/reset-password",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = IdSchema.safeParse((req.params as { id?: unknown }).id);
      const body = PasswordResetSchema.safeParse(req.body);
      if (!id.success || !body.success) {
        await auditFailure(
          app,
          req,
          "admin.password.reset",
          id.success ? id.data : null,
          "invalid_request",
        );
        return reply.code(400).send({
          error: "invalid_request",
          message: body.success
            ? "请求参数不合法"
            : (body.error.issues[0]?.message ?? "请求参数不合法"),
        });
      }
      if (id.data === req.admin!.adminUserId) {
        await auditFailure(
          app,
          req,
          "admin.password.reset",
          id.data,
          "use_change_password",
        );
        return reply.code(400).send({
          error: "use_change_password",
          message: "请通过修改当前密码功能更新自己的密码",
        });
      }
      const admin = await app.adminRepo.resetPassword({
        enterpriseId: req.admin!.enterpriseId,
        adminId: id.data,
        newPasswordHash: await hashPassword(body.data.new_password),
      });
      if (!admin) {
        await auditFailure(
          app,
          req,
          "admin.password.reset",
          id.data,
          "not_found",
        );
        return reply
          .code(404)
          .send({ error: "not_found", message: "管理员不存在" });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "admin.password.reset",
        target_type: "admin_user",
        target_id: admin.id,
        change_summary: { sessions_revoked: true, must_change_password: true },
        result: "SUCCESS",
      });
      return { admin: publicAdmin(admin) };
    },
  );

  for (const status of ["ACTIVE", "DISABLED"] as const) {
    const action = status === "ACTIVE" ? "enable" : "disable";
    app.post(
      `/admins/:id/${action}`,
      { preHandler: [requireAuth] },
      async (req, reply) => {
        const id = IdSchema.safeParse((req.params as { id?: unknown }).id);
        if (!id.success) {
          await auditFailure(
            app,
            req,
            `admin.${action}`,
            null,
            "invalid_request",
          );
          return reply
            .code(400)
            .send({ error: "invalid_request", message: "管理员 ID 不合法" });
        }
        try {
          const admin = await app.adminRepo.setStatus({
            enterpriseId: req.admin!.enterpriseId,
            actorAdminId: req.admin!.adminUserId,
            targetAdminId: id.data,
            status,
          });
          await app.auditRepo.write({
            enterprise_id: req.admin!.enterpriseId,
            admin_user_id: req.admin!.adminUserId,
            action: `admin.${action}`,
            target_type: "admin_user",
            target_id: admin.id,
            change_summary: {
              status: admin.status,
              sessions_revoked: status === "DISABLED",
            },
            result: "SUCCESS",
          });
          return { admin: publicAdmin(admin) };
        } catch (error) {
          const code =
            error instanceof SelfDisableError
              ? "self_disable_forbidden"
              : error instanceof LastActiveAdminError
                ? "last_active_admin"
                : error instanceof AdminNotFoundError
                  ? "not_found"
                  : null;
          if (!code) throw error;
          await auditFailure(app, req, `admin.${action}`, id.data, code);
          return reply.code(code === "not_found" ? 404 : 409).send({
            error: code,
            message: error instanceof Error ? error.message : "操作失败",
          });
        }
      },
    );
  }

  registerAdminCleanupRoute(app);
}
