/**
 * 项目账归集路由（候选 C3；合同 11 §3.3）。/operating-bills 前缀 → billing 模块。
 * GET 纯读不建任务；runs/enablement POST 需 billing operate（方法级守卫）。
 */
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  getAllocationRunStatus, getUnallocatedSummary, listAllocationLines, listUnallocatedLines,
  enqueueAllocationRun, enableProjectAllocation, resolveAllocationPrincipal,
  PrincipalNotAccessibleError,
} from "@qianliu/database";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerOperatingBillAllocationRoutes(app: FastifyInstance): void {
  app.get<{ Params: { month: string } }>("/operating-bills/:month/project-allocation-status", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    if (!MONTH_RE.test(req.params.month)) {
      return reply.code(400).send({ error: "invalid_request", message: "账期格式不合法" });
    }
    const status = await getAllocationRunStatus(app.db, req.admin!.enterpriseId, req.params.month);
    return reply.code(200).send({ month: req.params.month, ...status });
  });

  app.post<{ Params: { month: string } }>("/operating-bills/:month/project-allocation-runs", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    if (!MONTH_RE.test(req.params.month)) {
      return reply.code(400).send({ error: "invalid_request", message: "账期格式不合法" });
    }
    const body = req.body as { reason?: string; idempotencyKey?: string } | undefined;
    const { rows: closedRows } = await sql<{ status: string }>`
      SELECT status FROM operating_bill_period
      WHERE enterprise_id = ${req.admin!.enterpriseId} AND period_month = ${`${req.params.month}-01`}::date
      LIMIT 1`.execute(app.db);
    const closed = closedRows[0];
    if (closed?.status === "CLOSED") {
      return reply.code(409).send({ error: "period_closed", message: "账期已关闭，不能登记新批次" });
    }
    const result = await enqueueAllocationRun(app.db, {
      enterpriseId: req.admin!.enterpriseId,
      month: req.params.month,
      actorType: "ADMIN",
      actorAdminId: req.admin!.adminUserId,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "project_allocation.run.create",
      target_type: "project_allocation_run",
      target_id: result.runId,
      change_summary: { month: req.params.month, created: result.created, reason: body?.reason ?? null },
      result: "SUCCESS",
    });
    return reply.code(result.created ? 202 : 200).send(result);
  });

  app.post<{ Params: { month: string } }>("/operating-bills/:month/project-allocation-enablement", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    const body = req.body as { startMonth?: string; reason?: string } | undefined;
    if (!body?.startMonth || !MONTH_RE.test(body.startMonth)) {
      return reply.code(400).send({ error: "invalid_request", message: "起始账期格式不合法" });
    }
    const result = await enableProjectAllocation(app.db, {
      enterpriseId: req.admin!.enterpriseId,
      startMonth: body.startMonth,
      actorAdminId: req.admin!.adminUserId,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "project_allocation.enablement.create",
      target_type: "project_allocation_period",
      target_id: result.runId,
      change_summary: { startMonth: body.startMonth, reason: body.reason ?? null, enabled: result.enabled },
      result: "SUCCESS",
    });
    return reply.code(result.enabled ? 201 : 200).send(result);
  });

  app.get<{ Params: { month: string; projectId: string } }>(
    "/operating-bills/:month/projects/:projectId/allocation-lines",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const query = req.query as { run_id?: string; employee_id?: string; source?: string; limit?: string; offset?: string };
      if (!MONTH_RE.test(req.params.month)) {
        return reply.code(400).send({ error: "invalid_request", message: "账期格式不合法" });
      }
      // 主体类型合同：项目明细要求本企业 PROJECT；不存在/跨企业/类型不符统一 404。
      try {
        await resolveAllocationPrincipal(app.db, req.admin!.enterpriseId, req.params.projectId, "PROJECT");
      } catch (error) {
        if (error instanceof PrincipalNotAccessibleError) {
          return reply.code(404).send({ error: "not_found", message: "对象不存在或不可访问" });
        }
        throw error;
      }
      const result = await listAllocationLines(app.db, req.admin!.enterpriseId, req.params.month, req.params.projectId, {
        runId: query.run_id,
        employeeId: query.employee_id,
        source: query.source,
        limit: Math.min(Math.max(Number(query.limit ?? 25), 1), 100),
        offset: Math.min(Math.max(Number(query.offset ?? 0), 0), 100_000),
      });
      return reply.code(200).send({ month: req.params.month, projectPrincipalId: req.params.projectId, ...result });
    },
  );

  app.get<{ Params: { month: string } }>("/operating-bills/:month/project-unallocated", {
    preHandler: [requireAuth],
  }, async (req, reply) => {
    if (!MONTH_RE.test(req.params.month)) {
      return reply.code(400).send({ error: "invalid_request", message: "账期格式不合法" });
    }
    const query = req.query as {
      run_id?: string; reason?: string; employee_id?: string; resource_id?: string;
      limit?: string; offset?: string;
    };
    // 员工筛选走企业 + 类型解析：不存在/跨企业/类型不符统一 404，避免泄露或静默空集。
    try {
      for (const [value, label] of [
        [query.employee_id, "员工标识"], [query.resource_id, "资源标识"],
      ] as const) {
        if (value !== undefined && !UUID_RE.test(value)) {
          return reply.code(400).send({ error: "invalid_request", message: `${label}格式不合法` });
        }
      }
      if (query.employee_id !== undefined) {
        await resolveAllocationPrincipal(app.db, req.admin!.enterpriseId, query.employee_id, "EMPLOYEE");
      }
    } catch (error) {
      if (error instanceof PrincipalNotAccessibleError) {
        return reply.code(404).send({ error: "not_found", message: "对象不存在或不可访问" });
      }
      throw error;
    }
    const summary = await getUnallocatedSummary(app.db, req.admin!.enterpriseId, req.params.month);
    const detail = await listUnallocatedLines(app.db, req.admin!.enterpriseId, req.params.month, {
      runId: query.run_id,
      reason: query.reason,
      employeeId: query.employee_id,
      resourceId: query.resource_id,
      limit: Math.min(Math.max(Number(query.limit ?? 25), 1), 100),
      offset: Math.min(Math.max(Number(query.offset ?? 0), 0), 100_000),
    });
    return reply.code(200).send({ month: req.params.month, ...summary, detail });
  });
}

