/**
 * Principal 路由 —— 员工/项目统一主体 CRUD（W02）。
 *
 * 依据：TRD §5.2、PRD §6（创建四步、停用语义）。
 * 所有写操作：preHandler requireAuth + 自动 audit-write。
 * enterprise_id 从 session 注入，客户端不能跨企业访问。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const CreatePrincipalSchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]),
  name: z.string().min(1).max(255),
  department_label: z.string().max(255).optional(),
});

const UpdatePrincipalSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  department_label: z.string().max(255).nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

const ListPrincipalQuerySchema = z.object({
  type: z.enum(["EMPLOYEE", "PROJECT"]).optional(),
  archived: z.enum(["exclude", "only", "all"]).default("exclude"),
});

export function registerPrincipalRoutes(app: FastifyInstance): void {
  // 列表
  app.get("/principals", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ListPrincipalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const list = await app.principalRepo.list(req.admin!.enterpriseId, parsed.data);
    return { principals: list };
  });

  // 详情
  app.get<{ Params: { id: string } }>(
    "/principals/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const p = await app.principalRepo.findById(req.admin!.enterpriseId, req.params.id);
      if (!p) return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      return { principal: p };
    },
  );

  // 创建
  app.post("/principals", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreatePrincipalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const created = await app.principalRepo.create({
      enterprise_id: req.admin!.enterpriseId,
      ...parsed.data,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "principal.create",
      target_type: "principal",
      target_id: created.id,
      change_summary: { type: created.type, name: created.name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ principal: created });
  });

  // 更新（含停用/重新启用）
  app.patch<{ Params: { id: string } }>(
    "/principals/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdatePrincipalSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const existing = await app.principalRepo.findById(req.admin!.enterpriseId, req.params.id);
      if (!existing) return reply.code(404).send({ error: "not_found", message: "主体不存在" });

      if (parsed.data.status === "ACTIVE" && existing.archived_at !== null) {
        return reply.code(409).send({
          error: "principal_archived",
          message: "已归档主体不能直接重新启用，请保留历史并新建主体",
        });
      }

      let updated;
      let revokedKeyCount = 0;
      let disabledGrantCount = 0;
      if (parsed.data.status === "DISABLED") {
        const deactivated = await app.principalRepo.deactivate(
          req.admin!.enterpriseId,
          req.params.id,
          false,
          { adminUserId: req.admin!.adminUserId },
        );
        if (!deactivated) {
          return reply.code(404).send({ error: "not_found", message: "主体不存在" });
        }
        updated = deactivated.principal;
        revokedKeyCount = deactivated.revokedKeyCount;
        disabledGrantCount = deactivated.disabledGrantCount;
      } else {
        updated = await app.principalRepo.update(
          req.admin!.enterpriseId,
          req.params.id,
          parsed.data,
        );
      }

      const action =
        parsed.data.status === "DISABLED"
          ? "principal.disable"
          : parsed.data.status === "ACTIVE"
            ? "principal.reactivate"
            : "principal.update";

      if (parsed.data.status !== "DISABLED") {
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action,
          target_type: "principal",
          target_id: updated.id,
          change_summary: {
            before: {
              status: existing.status,
              name: existing.name,
              department_label: existing.department_label,
            },
            after: {
              status: updated.status,
              name: updated.name,
              department_label: updated.department_label,
            },
            revoked_keys: revokedKeyCount,
            disabled_grants: disabledGrantCount,
          },
          result: "SUCCESS",
        });
      }
      return { principal: updated };
    },
  );

  // 清理影响预览（企业隔离；二次确认前展示）
  app.get<{ Params: { id: string } }>(
    "/principals/:id/cleanup-preview",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const preview = await app.principalRepo.cleanupPreview(
        req.admin!.enterpriseId,
        req.params.id,
      );
      if (!preview) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      return { preview };
    },
  );

  // 归档：保留主体及历史引用，默认列表隐藏，同时撤销 Key/Grant。
  app.post<{ Params: { id: string } }>(
    "/principals/:id/archive",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const result = await app.principalRepo.deactivate(
        req.admin!.enterpriseId,
        req.params.id,
        true,
        { adminUserId: req.admin!.adminUserId },
      );
      if (!result) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      return {
        principal: result.principal,
        revoked_keys: result.revokedKeyCount,
        disabled_grants: result.disabledGrantCount,
      };
    },
  );

  // 安全删除：存在请求/Usage/账本/登录引用时拒绝，管理员应改用归档。
  app.delete<{ Params: { id: string } }>(
    "/principals/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const result = await app.principalRepo.deleteSafely(
        req.admin!.enterpriseId,
        req.params.id,
        { adminUserId: req.admin!.adminUserId },
      );
      if (!result) {
        return reply.code(404).send({ error: "not_found", message: "主体不存在" });
      }
      if (!result.deleted) {
        return reply.code(409).send({
          error: "principal_has_history",
          message: "主体已有请求、Usage、账本或登录引用，不能删除，请改为归档",
          preview: result.preview,
        });
      }
      return {
        deleted: true,
        removed_keys: result.removedKeyCount,
        removed_grants: result.removedGrantCount,
      };
    },
  );
}
