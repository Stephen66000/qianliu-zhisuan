/** POOL-029：员工使用规则管理 API。 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { EmployeeModelRuleError, type EmployeeModelRuleInput } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const TargetSchema = z.object({
  unified_model_id: z.string().uuid(),
  provider_resource_id: z.string().uuid(),
});

const RuleSchema = z.object({
  name: z.string().trim().min(1).max(128),
  employee_scope: z.enum(["SELECTED", "ALL"]),
  principal_ids: z.array(z.string().uuid()).default([]),
  model_scope: z.enum(["SELECTED", "ALL"]),
  model_targets: z.array(TargetSchema).default([]),
  quota_value: z.coerce.bigint().min(0n),
  allow_overage: z.boolean().default(false),
  valid_from: z.coerce.date(),
  valid_until: z.coerce.date().nullable().default(null),
}).superRefine((input, ctx) => {
  if (input.employee_scope === "SELECTED" && input.principal_ids.length === 0) {
    ctx.addIssue({ code: "custom", path: ["principal_ids"], message: "至少选择一名员工" });
  }
  if (input.model_scope === "SELECTED" && input.model_targets.length === 0) {
    ctx.addIssue({ code: "custom", path: ["model_targets"], message: "至少选择一个模型" });
  }
  if (input.valid_until !== null && input.valid_until <= input.valid_from) {
    ctx.addIssue({ code: "custom", path: ["valid_until"], message: "失效时间必须晚于生效时间" });
  }
});

const UpdateSchema = z.object({
  expected_lock_version: z.number().int().positive(),
  rule: RuleSchema,
});
const PublishSchema = z.object({
  expected_lock_version: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8).max(128),
});

function inputOf(value: z.infer<typeof RuleSchema>): EmployeeModelRuleInput {
  return {
    ...value,
    principal_ids: [...new Set(value.principal_ids)],
    model_targets: [...new Map(value.model_targets.map((target) => [
      `${target.unified_model_id}:${target.provider_resource_id}`, target,
    ])).values()],
  };
}

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as T;
}

function sendRuleError(reply: FastifyReply, error: EmployeeModelRuleError) {
  const status = error.code === "NOT_FOUND" ? 404 : error.code === "NOT_READY" ? 422 : 409;
  return reply.code(status).send({
    error: error.code.toLowerCase(), message: error.message, validation: error.validation,
  });
}

export function registerEmployeeModelRuleRoutes(app: FastifyInstance): void {
  app.get("/employee-model-rules/catalog", { preHandler: [requireAuth] }, async (req) =>
    app.employeeModelRuleRepo.catalog(req.admin!.enterpriseId));

  app.get("/employee-model-rules", { preHandler: [requireAuth] }, async (req) => ({
    rules: serialize(await app.employeeModelRuleRepo.list(req.admin!.enterpriseId)),
  }));

  app.get<{ Params: { ruleId: string } }>(
    "/employee-model-rules/:ruleId/history", { preHandler: [requireAuth] }, async (req) => ({
      versions: serialize(await app.employeeModelRuleRepo.history(req.admin!.enterpriseId, req.params.ruleId)),
    }),
  );

  app.post("/employee-model-rules", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = RuleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    const version = await app.employeeModelRuleRepo.create(
      req.admin!.enterpriseId, req.admin!.adminUserId, inputOf(parsed.data),
    );
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
      action: "employee_model_rule.create", target_type: "employee_model_rule",
      target_id: version.rule_id, change_summary: { version: version.version, name: version.name }, result: "SUCCESS",
    });
    return reply.code(201).send({ version: serialize(version) });
  });

  app.post<{ Params: { ruleId: string } }>(
    "/employee-model-rules/:ruleId/versions", { preHandler: [requireAuth] }, async (req, reply) => {
      try {
        const version = await app.employeeModelRuleRepo.createNextVersion(
          req.admin!.enterpriseId, req.admin!.adminUserId, req.params.ruleId,
        );
        return reply.code(201).send({ version: serialize(version) });
      } catch (error) {
        if (error instanceof EmployeeModelRuleError) return sendRuleError(reply, error);
        throw error;
      }
    },
  );

  app.patch<{ Params: { versionId: string } }>(
    "/employee-model-rules/versions/:versionId", { preHandler: [requireAuth] }, async (req, reply) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      try {
        const version = await app.employeeModelRuleRepo.updateDraft(
          req.admin!.enterpriseId, req.params.versionId, parsed.data.expected_lock_version,
          inputOf(parsed.data.rule),
        );
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
          action: "employee_model_rule.update", target_type: "employee_model_rule",
          target_id: version.rule_id, change_summary: { version: version.version, lock_version: version.lock_version }, result: "SUCCESS",
        });
        return { version: serialize(version) };
      } catch (error) {
        if (error instanceof EmployeeModelRuleError) return sendRuleError(reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: { versionId: string } }>(
    "/employee-model-rules/versions/:versionId/validate", { preHandler: [requireAuth] }, async (req, reply) => {
      try {
        const validation = await app.employeeModelRuleRepo.validate(req.admin!.enterpriseId, req.params.versionId);
        return { validation };
      } catch (error) {
        if (error instanceof EmployeeModelRuleError) return sendRuleError(reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: { versionId: string } }>(
    "/employee-model-rules/versions/:versionId/publish", { preHandler: [requireAuth] }, async (req, reply) => {
      const parsed = PublishSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      try {
        return serialize(await app.employeeModelRuleRepo.publish({
          enterpriseId: req.admin!.enterpriseId, versionId: req.params.versionId,
          expectedLockVersion: parsed.data.expected_lock_version,
          idempotencyKey: parsed.data.idempotency_key, adminUserId: req.admin!.adminUserId,
        }));
      } catch (error) {
        if (error instanceof EmployeeModelRuleError) return sendRuleError(reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: { versionId: string } }>(
    "/employee-model-rules/versions/:versionId/disable", { preHandler: [requireAuth] }, async (req, reply) => {
      try {
        const version = await app.employeeModelRuleRepo.disable(
          req.admin!.enterpriseId, req.params.versionId, req.admin!.adminUserId,
        );
        return { version: serialize(version) };
      } catch (error) {
        if (error instanceof EmployeeModelRuleError) return sendRuleError(reply, error);
        throw error;
      }
    },
  );
}
