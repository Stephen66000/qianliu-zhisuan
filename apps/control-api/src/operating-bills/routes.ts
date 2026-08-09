/** POOL-025 —— 企业 AI 算力月度经营账单 API。 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  InvalidOperatingBillMonthError,
  OperatingBillAlreadyClosedError,
  OperatingBillClosedError,
  OperatingBillCloseNoteRequiredError,
  OperatingBillConcurrentModificationError,
  OperatingBillIncompleteError,
  OperatingBillNotClosedError,
  OperatingBillReferenceError,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import { OperatingSnapshotSchema, operatingSnapshotModeError, toOperatingSnapshotInput } from "../providers/contracts.js";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const IdSchema = z.string().uuid();
const DecimalText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), "金额必须是非负十进制数");
const MoneyText = DecimalText.refine(
  (value) => /^\d+(?:\.\d{1,2})?$/.test(value),
  "人工录入金额最多保留两位小数",
);

const ValueItemSchema = z.object({
  title: z.string().trim().min(1).max(255),
  value_type: z.enum(["MONETARY", "NON_MONETARY"]),
  amount: MoneyText.nullable().optional(),
  metric_value: z.string().trim().min(1).max(255).nullable().optional(),
  metric_unit: z.string().trim().max(64).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  evidence_ref: z.string().trim().max(4000).nullable().optional(),
  related_principal_id: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.value_type === "MONETARY" && (value.amount === null || value.amount === undefined)) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "金额价值必须填写金额" });
  }
  if (value.value_type === "NON_MONETARY" && !value.metric_value) {
    ctx.addIssue({ code: "custom", path: ["metric_value"], message: "非金额价值必须填写指标" });
  }
});

const CloseSchema = z.object({
  allow_incomplete: z.boolean().default(false),
  note: z.string().trim().max(4000).nullable().optional(),
});
const ReopenSchema = z.object({ reason: z.string().trim().min(1).max(4000) });
const ProjectAssignmentSchema = z.object({
  ai_request_id: z.string().uuid(),
  project_principal_id: z.string().uuid(),
  reason: z.string().trim().max(4000).nullable().optional(),
});
const SnapshotImportSchema = z.object({
  rows: z.array(z.object({
    provider_resource_id: z.string().uuid(),
    snapshot: z.record(z.string(), z.unknown()),
  })).min(1).max(500),
});

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
}

function handleOperatingBillError(error: unknown, reply: FastifyReply) {
  if (error instanceof InvalidOperatingBillMonthError) {
    return reply.code(400).send({ error: "invalid_month", message: "账期必须使用 YYYY-MM" });
  }
  if (error instanceof OperatingBillIncompleteError) {
    return reply.code(409).send({
      error: "bill_incomplete", message: "账单存在数据缺口，不能直接结账", gaps: error.gaps,
    });
  }
  if (error instanceof OperatingBillCloseNoteRequiredError) {
    return reply.code(400).send({ error: "close_note_required", message: "带缺口结账必须填写说明" });
  }
  if (error instanceof OperatingBillConcurrentModificationError) return reply.code(409).send({
    error: "bill_concurrent_modification", message: "账单正在被并发修改，请稍后重试结账", retryable: true,
  });
  if (error instanceof OperatingBillClosedError || error instanceof OperatingBillAlreadyClosedError) {
    return reply.code(409).send({ error: "bill_closed", message: "账期已结账，重开后才能修改" });
  }
  if (error instanceof OperatingBillNotClosedError) {
    return reply.code(409).send({ error: "bill_not_closed", message: "账期尚未结账" });
  }
  if (error instanceof OperatingBillReferenceError) {
    return reply.code(404).send({ error: "not_found", message: "账单、价值事项或关联主体不存在" });
  }
  throw error;
}

export function registerOperatingBillRoutes(app: FastifyInstance): void {
  app.post("/operating-bill-snapshot-imports", { preHandler: [requireAuth] }, async (req, reply) => {
    const body = SnapshotImportSchema.safeParse(req.body);
    if (!body.success) return invalid(reply);
    const resources = await app.providerRepo.listResources(req.admin!.enterpriseId);
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
    const parsedRows = [];
    for (const [index, row] of body.data.rows.entries()) {
      const resource = resourceById.get(row.provider_resource_id);
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: `第 ${index + 1} 行资源不存在` });
      }
      const snapshot = OperatingSnapshotSchema.safeParse({ ...row.snapshot, source: "BILL_RECONCILIATION" });
      if (!snapshot.success) {
        return reply.code(400).send({ error: "invalid_import_row", message: `第 ${index + 1} 行：${snapshot.error.issues[0]?.message ?? "字段不合法"}` });
      }
      const modeError = operatingSnapshotModeError(resource.mode, snapshot.data);
      if (modeError) {
        return reply.code(400).send({ error: "invalid_import_row", message: `第 ${index + 1} 行：${modeError}` });
      }
      parsedRows.push({ resource, snapshot: snapshot.data });
    }
    const imported = [];
    for (const row of parsedRows) {
      const snapshot = await app.providerRepo.appendOperatingSnapshot(
        req.admin!.enterpriseId,
        row.resource.id,
        toOperatingSnapshotInput(row.snapshot, row.resource.mode),
      );
      if (!snapshot) throw new OperatingBillReferenceError();
      imported.push(snapshot);
    }
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
      action: "operating_bill.snapshot.import", target_type: "provider_resource_operating_snapshot",
      target_id: null, change_summary: { row_count: imported.length, snapshot_ids: imported.map((item) => item.id) },
      result: "SUCCESS",
    });
    return reply.code(201).send({ imported_count: imported.length, snapshots: imported });
  });

  app.get("/operating-bills", { preHandler: [requireAuth] }, async (req) => ({
    months: await app.operatingBillRepo.listAvailableMonths(req.admin!.enterpriseId),
  }));

  app.get<{ Params: { month: string } }>(
    "/operating-bills/:month",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      if (!MonthSchema.safeParse(req.params.month).success) return invalid(reply);
      try {
        return await app.operatingBillRepo.getBill(req.admin!.enterpriseId, req.params.month);
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );

  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/value-items",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const body = ValueItemSchema.safeParse(req.body);
      if (!month.success || !body.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: body.success ? "账期不合法" : (body.error.issues[0]?.message ?? "请求参数不合法"),
        });
      }
      try {
        const item = await app.operatingBillRepo.createValueItem({
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          month: month.data,
          title: body.data.title,
          valueType: body.data.value_type,
          amount: body.data.amount,
          metricValue: body.data.metric_value,
          metricUnit: body.data.metric_unit,
          description: body.data.description,
          evidenceRef: body.data.evidence_ref,
          relatedPrincipalId: body.data.related_principal_id,
        });
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.value.create",
          target_type: "operating_bill_value_item",
          target_id: item.id,
          change_summary: { month: month.data, value_type: item.value_type },
          result: "SUCCESS",
        });
        return reply.code(201).send({ item });
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/operating-bill-value-items/:id/confirm",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const id = IdSchema.safeParse(req.params.id);
      if (!id.success) return invalid(reply);
      try {
        const item = await app.operatingBillRepo.confirmValueItem({
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          itemId: id.data,
        });
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.value.confirm",
          target_type: "operating_bill_value_item",
          target_id: item.id,
          change_summary: { status: item.status },
          result: "SUCCESS",
        });
        return { item };
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );

  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/project-assignments",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const body = ProjectAssignmentSchema.safeParse(req.body);
      if (!month.success || !body.success) return invalid(reply);
      try {
        await app.operatingBillRepo.assignRequestToProject({
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          month: month.data,
          requestId: body.data.ai_request_id,
          projectPrincipalId: body.data.project_principal_id,
          reason: body.data.reason,
        });
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.project.assign",
          target_type: "ai_request",
          target_id: body.data.ai_request_id,
          change_summary: { month: month.data, project_principal_id: body.data.project_principal_id },
          result: "SUCCESS",
        });
        return reply.code(204).send();
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );

  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/close",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const body = CloseSchema.safeParse(req.body);
      if (!month.success || !body.success) return invalid(reply);
      try {
        const bill = await app.operatingBillRepo.closeMonth({
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          month: month.data,
          allowIncomplete: body.data.allow_incomplete,
          note: body.data.note ?? null,
        });
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.close",
          target_type: "operating_bill_period",
          target_id: null,
          change_summary: { month: month.data, version: bill.version, gap_count: bill.gaps.length },
          result: "SUCCESS",
        });
        return bill;
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );

  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/reopen",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const body = ReopenSchema.safeParse(req.body);
      if (!month.success || !body.success) return invalid(reply);
      try {
        const bill = await app.operatingBillRepo.reopenMonth({
          enterpriseId: req.admin!.enterpriseId,
          adminId: req.admin!.adminUserId,
          month: month.data,
          reason: body.data.reason,
        });
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.reopen",
          target_type: "operating_bill_period",
          target_id: null,
          change_summary: { month: month.data, previous_version: bill.version, reason: body.data.reason },
          result: "SUCCESS",
        });
        return bill;
      } catch (error) {
        return handleOperatingBillError(error, reply);
      }
    },
  );
}
