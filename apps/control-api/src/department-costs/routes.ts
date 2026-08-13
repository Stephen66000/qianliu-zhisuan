import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  DepartmentBillEvidenceUnavailableError,
  type DepartmentBillView,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  BudgetPutSchema,
  IdSchema,
  MonthSchema,
  PurchasePostSchema,
} from "./contracts.js";
import { loadDepartmentBill } from "./query.js";
import {
  createResourcePurchase,
  listResourcePurchases,
  readDepartmentBudget,
  saveDepartmentBudget,
} from "./writes.js";

const BudgetParams = z.object({ departmentId: IdSchema, month: MonthSchema });
const BillParams = z.object({ month: MonthSchema });
const ResourceParams = z.object({ id: IdSchema });
const PurchaseQuery = z.object({
  month: MonthSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function invalid(reply: FastifyReply, message = "请求参数不合法") {
  return reply.code(400).send({ error: "invalid_request", message });
}

async function readBillOrReply(
  app: FastifyInstance,
  reply: FastifyReply,
  enterpriseId: string,
  month: string,
): Promise<DepartmentBillView | null> {
  try {
    return await loadDepartmentBill(app.db, enterpriseId, month);
  } catch (error) {
    if (error instanceof DepartmentBillEvidenceUnavailableError) {
      reply.code(409).send({
        error: "department_evidence_unavailable",
        message: "该已结账版本没有部门冻结证据，不允许用实时数据回算",
      });
      return null;
    }
    throw error;
  }
}

function budgetFailure(kind: string, reply: FastifyReply) {
  if (kind === "not_found") {
    return reply.code(404).send({ error: "not_found", message: "部门不存在" });
  }
  if (kind === "closed") {
    return reply.code(409).send({ error: "bill_closed", message: "该月份已结账，请先按月账流程重开" });
  }
  if (kind === "idempotency_conflict") {
    return reply.code(409).send({ error: "idempotency_conflict", message: "幂等键已用于不同内容" });
  }
  return reply.code(409).send({ error: "conflict", message: "部门预算已被其他管理员修改" });
}

function purchaseFailure(kind: string, reply: FastifyReply) {
  if (kind === "not_found") {
    return reply.code(404).send({ error: "not_found", message: "资源不存在" });
  }
  if (kind === "closed") {
    return reply.code(409).send({ error: "bill_closed", message: "采购日期所在月份已结账" });
  }
  if (kind === "mode_mismatch") {
    return reply.code(409).send({
      error: "purchase_type_mismatch",
      message: "API 资源只能登记充值，Coding Plan 资源只能登记套餐采购",
    });
  }
  return reply.code(409).send({ error: "idempotency_conflict", message: "幂等键已用于不同内容" });
}

export function registerDepartmentCostRoutes(app: FastifyInstance): void {
  app.get<{ Params: { departmentId: string; month: string } }>(
    "/department-budgets/:departmentId/:month",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = BudgetParams.safeParse(req.params);
      if (!params.success) return invalid(reply);
      const enterpriseId = req.admin!.enterpriseId;
      const result = await readDepartmentBudget(
        app.db, enterpriseId, params.data.departmentId, params.data.month,
      );
      if (!result) return reply.code(404).send({ error: "not_found", message: "部门不存在" });
      const bill = await readBillOrReply(app, reply, enterpriseId, params.data.month);
      if (!bill) return;
      const current = bill.rows.find((row) => row.departmentId === params.data.departmentId);
      return {
        departmentId: result.departmentId, departmentName: result.departmentName,
        month: params.data.month, budget: result.budget,
        current: current ? {
          collectedCost: current.totalCost, actualTokens: current.actualTokens,
          budgetUsageRate: current.budgetUsageRate, status: current.budgetStatus,
          reasonCodes: current.reasonCodes,
        } : {
          collectedCost: "0.00000000", actualTokens: "0",
          budgetUsageRate: null, status: "NOT_SET", reasonCodes: [],
        },
      };
    },
  );

  app.put<{ Params: { departmentId: string; month: string } }>(
    "/department-budgets/:departmentId/:month",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = BudgetParams.safeParse(req.params);
      const body = BudgetPutSchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return invalid(reply, body.success ? "部门或月份不合法" : body.error.issues[0]?.message);
      }
      const result = await saveDepartmentBudget(app.db, {
        enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
        departmentId: params.data.departmentId, month: params.data.month,
        amount: body.data.amount, currency: body.data.currency,
        warningThreshold: body.data.warning_threshold,
        expectedVersion: body.data.expected_version,
        idempotencyKey: body.data.idempotency_key,
      });
      if (result.kind !== "ok") return budgetFailure(result.kind, reply);
      return reply.code(result.replayed ? 200 : 201).send({
        budget: result.budget, replayed: result.replayed,
      });
    },
  );

  app.get<{ Params: { month: string } }>(
    "/operating-bills/:month/departments",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = BillParams.safeParse(req.params);
      if (!params.success) return invalid(reply, "账期必须使用 YYYY-MM");
      return readBillOrReply(app, reply, req.admin!.enterpriseId, params.data.month);
    },
  );

  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/check",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = BillParams.safeParse(req.params);
      if (!params.success) return invalid(reply, "账期必须使用 YYYY-MM");
      const bill = await readBillOrReply(
        app, reply, req.admin!.enterpriseId, params.data.month,
      );
      if (!bill) return;
      const gaps = bill.reasonCodes.map((code) => ({
        code,
        severity: new Set([
          "DEPARTMENT_COST_NOT_CONSERVED", "API_COST_UNKNOWN", "PACKAGE_COST_UNKNOWN",
        ]).has(code) ? "ERROR" : "WARNING",
      }));
      return {
        month: bill.month, status: bill.status, version: bill.version,
        ok: gaps.length === 0 && bill.conservation.status === "BALANCED",
        gaps, conservation: bill.conservation, checkedAt: new Date().toISOString(),
      };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: Record<string, unknown>;
  }>(
    "/provider-resources/:id/purchases",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params);
      const query = PurchaseQuery.safeParse(req.query);
      if (!params.success || !query.success) return invalid(reply);
      const result = await listResourcePurchases(app.db, {
        enterpriseId: req.admin!.enterpriseId, resourceId: params.data.id,
        month: query.data.month, limit: query.data.limit, offset: query.data.offset,
      });
      if (!result) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      return { ...result, month: query.data.month ?? null };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/purchases",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = ResourceParams.safeParse(req.params);
      const body = PurchasePostSchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return invalid(reply, body.success ? "资源 ID 不合法" : body.error.issues[0]?.message);
      }
      const result = await createResourcePurchase(app.db, {
        enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
        resourceId: params.data.id, purchaseType: body.data.purchase_type,
        description: body.data.description ?? null, amount: body.data.amount,
        currency: body.data.currency, purchasedAt: body.data.purchased_at,
        servicePeriodStart: body.data.service_period_start ?? null,
        servicePeriodEnd: body.data.service_period_end ?? null,
        evidenceRef: body.data.evidence_ref ?? null,
        idempotencyKey: body.data.idempotency_key,
      });
      if (result.kind !== "ok") return purchaseFailure(result.kind, reply);
      return reply.code(result.replayed ? 200 : 201).send({
        purchase: result.purchase, replayed: result.replayed,
      });
    },
  );
}
