/**
 * Principal 路由 —— 员工/项目统一主体 CRUD（W02）。
 *
 * 依据：TRD §5.2、PRD §6（创建四步、停用语义）。
 * 所有写操作：preHandler requireAuth + 自动 audit-write。
 * enterprise_id 从 session 注入，客户端不能跨企业访问。
 */
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
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
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

const ProjectDepartmentBody = z.object({
  organization_unit_id: z.string().uuid(),
  expected_version: z.number().int().nonnegative(),
  reason: z.string().trim().max(500).nullable().optional(),
});

export function registerPrincipalRoutes(
  app: FastifyInstance,
  options: { departmentCost?: boolean } = {},
): void {
  // 列表
  app.get("/principals", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ListPrincipalQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const [list, total] = await Promise.all([
      app.principalRepo.list(req.admin!.enterpriseId, parsed.data),
      app.principalRepo.count(req.admin!.enterpriseId, parsed.data),
    ]);
    return {
      principals: list,
      total,
      limit: parsed.data.limit ?? list.length,
      offset: parsed.data.offset,
    };
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

  if (options.departmentCost !== false) app.get<{ Params: { id: string } }>(
    "/principals/:id/department-assignment",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) return reply.code(400).send({ error: "invalid_request" });
      const project = await app.db.selectFrom("principal").select("id")
        .where("enterprise_id", "=", req.admin!.enterpriseId)
        .where("id", "=", id.data).where("type", "=", "PROJECT").executeTakeFirst();
      if (!project) return reply.code(404).send({ error: "not_found", message: "项目主体不存在" });
      const result = await sql<{
        id: string; organization_unit_id: string; department_name: string;
        version: number; source: string; valid_from: Date; reason: string | null;
      }>`
        SELECT a.id, a.organization_unit_id, u.name AS department_name, a.version,
               a.source, a.valid_from, a.reason
          FROM project_department_assignment a
          JOIN organization_unit u ON u.id = a.organization_unit_id
           AND u.enterprise_id = a.enterprise_id
         WHERE a.enterprise_id = ${req.admin!.enterpriseId}::uuid
           AND a.project_principal_id = ${id.data}::uuid AND a.valid_until IS NULL
         LIMIT 1
      `.execute(app.db);
      const row = result.rows[0];
      return { assignment: row ? { ...row, valid_from: row.valid_from.toISOString() } : null };
    },
  );

  if (options.departmentCost !== false) app.put<{ Params: { id: string } }>(
    "/principals/:id/department-assignment",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = z.string().uuid().safeParse(req.params.id);
      const body = ProjectDepartmentBody.safeParse(req.body);
      if (!id.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request", message: "项目部门参数不合法" });
      }
      const outcome = await app.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext(
          ${`${req.admin!.enterpriseId}:project-department:${id.data}`}
        ))`.execute(trx);
        const project = await trx.selectFrom("principal")
          .select(["id", "owner_person_id", "status"])
          .where("enterprise_id", "=", req.admin!.enterpriseId)
          .where("id", "=", id.data).where("type", "=", "PROJECT")
          .where("archived_at", "is", null).forUpdate().executeTakeFirst();
        const department = await trx.selectFrom("organization_unit").select(["id", "name"])
          .where("enterprise_id", "=", req.admin!.enterpriseId)
          .where("id", "=", body.data.organization_unit_id)
          .where("status", "=", "ACTIVE").executeTakeFirst();
        if (!project || !department) return { kind: "not_found" as const };
        const current = await trx.selectFrom("project_department_assignment").selectAll()
          .where("enterprise_id", "=", req.admin!.enterpriseId)
          .where("project_principal_id", "=", id.data)
          .where("valid_until", "is", null).forUpdate().executeTakeFirst();
        if ((current?.version ?? 0) !== body.data.expected_version) {
          return { kind: "conflict" as const };
        }
        if (current?.organization_unit_id === department.id) {
          return { kind: "ok" as const, assignment: current, departmentName: department.name, replayed: true };
        }
        const now = new Date();
        if (current) {
          await trx.updateTable("project_department_assignment").set({ valid_until: now })
            .where("enterprise_id", "=", req.admin!.enterpriseId)
            .where("id", "=", current.id).execute();
        }
        const assignment = await trx.insertInto("project_department_assignment").values({
          enterprise_id: req.admin!.enterpriseId,
          project_principal_id: project.id,
          organization_unit_id: department.id,
          valid_from: now,
          source: "EXPLICIT",
          owner_person_id_at_assignment: project.owner_person_id,
          version: (current?.version ?? 0) + 1,
          created_by: req.admin!.adminUserId,
          reason: body.data.reason ?? null,
        }).returningAll().executeTakeFirstOrThrow();
        await trx.updateTable("principal").set({
          department_label: department.name, version: sql`version + 1`, updated_at: now,
        }).where("enterprise_id", "=", req.admin!.enterpriseId).where("id", "=", project.id).execute();
        await trx.insertInto("operation_log").values({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "project.department_assignment.update",
          target_type: "principal",
          target_id: project.id,
          change_summary: {
            previous_department_id: current?.organization_unit_id ?? null,
            organization_unit_id: department.id,
            assignment_version: assignment.version,
          },
          result: "SUCCESS",
          failure_reason: null,
        }).execute();
        return { kind: "ok" as const, assignment, departmentName: department.name, replayed: false };
      });
      if (outcome.kind === "not_found") {
        return reply.code(404).send({ error: "not_found", message: "项目主体或部门不存在" });
      }
      if (outcome.kind === "conflict") {
        return reply.code(409).send({ error: "conflict", message: "项目部门归属已被修改" });
      }
      return {
        assignment: {
          ...outcome.assignment,
          department_name: outcome.departmentName,
          valid_from: outcome.assignment.valid_from.toISOString(),
          valid_until: outcome.assignment.valid_until?.toISOString() ?? null,
          created_at: outcome.assignment.created_at.toISOString(),
        },
        replayed: outcome.replayed,
      };
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
