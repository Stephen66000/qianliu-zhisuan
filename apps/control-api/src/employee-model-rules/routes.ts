/** POOL-029：员工使用规则管理 API。 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { EmployeeModelRuleError, type EmployeeModelRuleInput } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const TargetSchema = z.object({
  unified_model_id: z.string().uuid(),
  provider_resource_id: z.string().uuid(),
});

const PoolQuotaSchema = z.object({
  provider_code: z.string().trim().min(1).max(32),
  quota_value: z.coerce.bigint().min(0n),
  allow_overage: z.boolean().default(false),
  valid_until: z.coerce.date().nullable().default(null),
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
  /** POOL-035：厂商级池额度；空数组表示无厂商级额度，发布时回退版本级 quota_value。 */
  pool_quotas: z.array(PoolQuotaSchema).default([]),
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
  // POOL-035：厂商级额度 provider_code 不可重复。
  const providers = input.pool_quotas.map((item) => item.provider_code);
  if (new Set(providers).size !== providers.length) {
    ctx.addIssue({ code: "custom", path: ["pool_quotas"], message: "同一厂商在厂商级额度中不可重复" });
  }
  // 厂商级 valid_until 不得早于版本级 valid_from。
  for (const quota of input.pool_quotas) {
    if (quota.valid_until !== null && quota.valid_until <= input.valid_from) {
      ctx.addIssue({ code: "custom", path: ["pool_quotas"], message: `厂商 ${quota.provider_code} 的失效时间必须晚于生效时间` });
    }
  }
});

const UpdateSchema = z.object({
  expected_lock_version: z.number().int().positive(),
  rule: RuleSchema,
});
const PublishSchema = z.object({
  expected_lock_version: z.number().int().positive(),
  idempotency_key: z.string().trim().min(8).max(128),
  /** POOL-033 §6：池额度语义——SET 设为规则值（默认，兼容旧客户端）；ADD 锁内追加规则值。 */
  quota_mode: z.enum(["SET", "ADD"]).default("SET"),
});

function inputOf(value: z.infer<typeof RuleSchema>): EmployeeModelRuleInput {
  return {
    ...value,
    principal_ids: [...new Set(value.principal_ids)],
    model_targets: [...new Map(value.model_targets.map((target) => [
      `${target.unified_model_id}:${target.provider_resource_id}`, target,
    ])).values()],
    // POOL-035：pool_quotas 入库为 jsonb，bigint/Date 转字符串承载，按 provider_code 去重。
    pool_quotas: [...new Map(value.pool_quotas.map((quota) => [
      quota.provider_code,
      {
        provider_code: quota.provider_code,
        quota_value: quota.quota_value.toString(),
        allow_overage: quota.allow_overage,
        valid_until: quota.valid_until ? quota.valid_until.toISOString() : null,
      },
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
          quotaMode: parsed.data.quota_mode,
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
