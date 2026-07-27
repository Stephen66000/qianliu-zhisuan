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

export function registerPrincipalRoutes(app: FastifyInstance): void {
  // 列表
  app.get("/principals", { preHandler: [requireAuth] }, async (req) => {
    const type = (req.query as { type?: "EMPLOYEE" | "PROJECT" }).type;
    const list = await app.principalRepo.list(req.admin!.enterpriseId, type ? { type } : undefined);
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

      const updated = await app.principalRepo.update(
        req.admin!.enterpriseId,
        req.params.id,
        parsed.data,
      );

      // 停用主体时同步撤销全部有效 Key（TRD §5.3 L219）
      if (parsed.data.status === "DISABLED") {
        const revokedCount = await app.keyRepo.revokeAllByPrincipal(
          req.admin!.enterpriseId,
          req.params.id,
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "key.revoke_on_disable",
          target_type: "principal",
          target_id: req.params.id,
          change_summary: { revoked_keys: revokedCount },
          result: "SUCCESS",
        });
      }

      const action =
        parsed.data.status === "DISABLED"
          ? "principal.disable"
          : parsed.data.status === "ACTIVE"
            ? "principal.reactivate"
            : "principal.update";

      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action,
        target_type: "principal",
        target_id: updated.id,
        change_summary: { before: { status: existing.status, name: existing.name }, after: { status: updated.status, name: updated.name } },
        result: "SUCCESS",
      });
      return { principal: updated };
    },
  );
}
