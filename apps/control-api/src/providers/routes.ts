/**
 * Provider/Resource/Model/Route 路由（W04）。
 *
 * 依据：TRD §5.4、§11.2（/providers /provider-resources /unified-models /model-routes）。
 * WT-01：登记资源账号（凭证加密存储，列表只返回指纹）。
 * WT-10：统一模型路由详情（候选、优先级、权重）。
 *
 * 安全：上游凭证明文绝不入 DB、绝不返回 API。createResource 接收明文 → 加密 → 存密文+指纹。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { encryptCredential, credentialFingerprint } from "@qianliu/provider-adapters";
import { EnterpriseReferenceError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const CreateProviderSchema = z.object({
  code: z.enum(["deepseek", "zhipu", "kimi"]),
  name: z.string().min(1).max(128),
  adapter_type: z.string().min(1).max(32),
  supported_protocols: z.array(z.string()).optional(),
  capability_set: z.record(z.string(), z.unknown()).optional(),
});

const DecimalText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), "必须是非负十进制数");

export const OperatingSnapshotSchema = z.object({
  source: z.enum(["ADMIN", "PROVIDER_SYNC", "BILL_RECONCILIATION"]).default("ADMIN"),
  collected_at: z.string().datetime(),
  currency: z.string().min(3).max(8).nullable().optional(),
  recharge_amount: DecimalText.nullable().optional(),
  current_balance: DecimalText.nullable().optional(),
  cumulative_cost: DecimalText.nullable().optional(),
  current_period_cost: DecimalText.nullable().optional(),
  cost_period_start: z.string().datetime().nullable().optional(),
  cost_period_end: z.string().datetime().nullable().optional(),
  balance_updated_at: z.string().datetime().nullable().optional(),
  package_name: z.string().max(255).nullable().optional(),
  package_cost: DecimalText.nullable().optional(),
  total_quota: DecimalText.nullable().optional(),
  quota_unit: z.string().min(1).max(32).nullable().optional(),
  used_quota: DecimalText.nullable().optional(),
  remaining_quota: DecimalText.nullable().optional(),
  effective_from: z.string().datetime().nullable().optional(),
  effective_until: z.string().datetime().nullable().optional(),
  reset_cycle: z.string().max(32).nullable().optional(),
  reset_anchor_at: z.string().datetime().nullable().optional(),
  next_reset_at: z.string().datetime().nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.total_quota !== null && value.total_quota !== undefined &&
      value.used_quota !== null && value.used_quota !== undefined &&
      value.remaining_quota !== null && value.remaining_quota !== undefined &&
      !new Decimal(value.total_quota).equals(new Decimal(value.used_quota).plus(value.remaining_quota))) {
    ctx.addIssue({
      code: "custom",
      path: ["remaining_quota"],
      message: "总额度必须等于已用额度加剩余额度",
    });
  }
});

const API_ONLY_OPERATING_FIELDS = [
  "recharge_amount",
  "current_balance",
  "cumulative_cost",
  "current_period_cost",
  "cost_period_start",
  "cost_period_end",
  "balance_updated_at",
] as const;

const PLAN_ONLY_OPERATING_FIELDS = [
  "package_name",
  "package_cost",
  "total_quota",
  "quota_unit",
  "used_quota",
  "remaining_quota",
  "effective_from",
  "effective_until",
  "reset_cycle",
  "reset_anchor_at",
  "next_reset_at",
] as const;

export function operatingSnapshotModeError(
  mode: "API" | "CODING_PLAN",
  snapshot: z.output<typeof OperatingSnapshotSchema>,
): string | null {
  const forbidden =
    mode === "API" ? PLAN_ONLY_OPERATING_FIELDS : API_ONLY_OPERATING_FIELDS;
  const populated = forbidden.filter((field) => {
    const value = snapshot[field];
    return value !== null && value !== undefined && value !== "";
  });
  if (populated.length > 0) {
    return mode === "API"
      ? `API 资源不能写入套餐字段：${populated.join(", ")}`
      : `套餐资源不能写入 API 充值/余额字段：${populated.join(", ")}`;
  }
  if (mode === "CODING_PLAN" && snapshot.source === "ADMIN") {
    if (!snapshot.total_quota) return "套餐资源必须填写总额度";
    if (!snapshot.effective_from) return "套餐资源必须填写生效时间";
    const resetCycle = snapshot.reset_cycle?.toUpperCase() ?? "NONE";
    if (!["NONE", "DAILY", "WEEKLY", "MONTHLY"].includes(resetCycle)) {
      return "重置周期必须是不重置、每日、每周或每月";
    }
    if (resetCycle !== "NONE" && !snapshot.reset_anchor_at) {
      return "启用周期重置时必须填写重置日期";
    }
  }
  return null;
}

const CreateResourceSchema = z.object({
  provider_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  mode: z.enum(["API", "CODING_PLAN"]),
  credential_type: z.enum(["API_KEY", "OAUTH", "SUBSCRIPTION_SESSION"]),
  /** 上游凭证明文（一次接收，立即加密，绝不入库）。 */
  credential_plaintext: z.string().min(1),
  upstream_models: z.array(z.string()).optional(),
  concurrency_limit: z.number().int().positive().optional(),
  operating_snapshot: OperatingSnapshotSchema.optional(),
});

const CreateUnifiedModelSchema = z.object({
  alias: z.string().min(1).max(64),
  display_name: z.string().min(1).max(128),
  required_capabilities: z.array(z.string()).optional(),
});

const CreateRouteSchema = z.object({
  unified_model_id: z.string().uuid(),
  provider_resource_id: z.string().uuid(),
  upstream_model: z.string().min(1).max(128),
  priority: z.number().int().optional(),
  weight: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

export function registerProviderRoutes(app: FastifyInstance): void {
  // ===== Provider =====
  app.get("/providers", { preHandler: [requireAuth] }, async (req) => {
    return { providers: await app.providerRepo.listProviders(req.admin!.enterpriseId) };
  });

  app.post("/providers", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const provider = await app.providerRepo.createProvider({
      enterprise_id: req.admin!.enterpriseId,
      ...parsed.data,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider.create",
      target_type: "provider",
      target_id: provider.id,
      change_summary: { code: provider.code, name: provider.name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ provider });
  });

  // ===== Provider Resource（凭证加密存储）=====
  app.get("/provider-resources", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const [resources, snapshots] = await Promise.all([
      app.providerRepo.listResources(enterpriseId),
      app.providerRepo.listCurrentOperatingSnapshots(enterpriseId),
    ]);
    const byResource = new Map(snapshots.map((snapshot) => [
      snapshot.provider_resource_id,
      snapshot,
    ]));
    // 列表只返回指纹，绝不返回密文/明文
    return {
      resources: resources.map((r) => ({
        id: r.id,
        provider_id: r.provider_id,
        name: r.name,
        mode: r.mode,
        credential_type: r.credential_type,
        credential_fingerprint: r.credential_fingerprint,
        credential_version: r.credential_version,
        status: r.status,
        upstream_models: r.upstream_models,
        concurrency_limit: r.concurrency_limit,
        version: r.version,
        created_at: r.created_at,
        updated_at: r.updated_at,
        operating_snapshot: byResource.get(r.id) ?? null,
      })),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/provider-resources/:id/operating-snapshots",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const limit = Number(req.query.limit ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: "invalid_request", message: "limit 必须为 1-100" });
      }
      const resource = (await app.providerRepo.listResources(req.admin!.enterpriseId))
        .find((item) => item.id === req.params.id);
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      return {
        snapshots: await app.providerRepo.listOperatingSnapshotHistory(
          req.admin!.enterpriseId,
          resource.id,
          limit,
        ),
      };
    },
  );

  app.post("/provider-resources", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const { credential_plaintext, operating_snapshot, ...rest } = parsed.data;
    if (operating_snapshot) {
      const modeError = operatingSnapshotModeError(rest.mode, operating_snapshot);
      if (modeError) {
        return reply.code(400).send({ error: "invalid_operating_mode", message: modeError });
      }
    }

    // 立即加密明文（绝不入库明文）
    const encrypted = encryptCredential(credential_plaintext, app.credentialKek);
    const fingerprint = credentialFingerprint(credential_plaintext);

    let resource;
    try {
      resource = await app.providerRepo.createResource({
        enterprise_id: req.admin!.enterpriseId,
        credential_encrypted: encrypted,
        credential_fingerprint: fingerprint,
        operating_snapshot: operating_snapshot
          ? toOperatingSnapshotInput(operating_snapshot, rest.mode)
          : undefined,
        ...rest,
      });
    } catch (error) {
      if (error instanceof EnterpriseReferenceError) {
        return reply.code(409).send({
          error: "invalid_reference",
          message: "厂商不存在、已停用或不属于当前企业",
        });
      }
      throw error;
    }

    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.create",
      target_type: "provider_resource",
      target_id: resource.id,
      change_summary: { name: resource.name, mode: resource.mode, credential_fingerprint: fingerprint },
      result: "SUCCESS",
    });

    // 响应只返回指纹（明文不回显）
    return reply.code(201).send({
      resource: {
        id: resource.id,
        provider_id: resource.provider_id,
        name: resource.name,
        mode: resource.mode,
        credential_type: resource.credential_type,
        credential_fingerprint: resource.credential_fingerprint,
        credential_version: resource.credential_version,
        status: resource.status,
        upstream_models: resource.upstream_models,
        concurrency_limit: resource.concurrency_limit,
        version: resource.version,
        created_at: resource.created_at,
        updated_at: resource.updated_at,
        operating_snapshot: operating_snapshot
          ? (await app.providerRepo.listCurrentOperatingSnapshots(req.admin!.enterpriseId))
              .find((snapshot) => snapshot.provider_resource_id === resource.id) ?? null
          : null,
      },
    });
  });

  // ===== Unified Model =====
  app.get("/unified-models", { preHandler: [requireAuth] }, async (req) => {
    return { models: await app.providerRepo.listUnifiedModels(req.admin!.enterpriseId) };
  });

  app.post("/unified-models", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateUnifiedModelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const model = await app.providerRepo.createUnifiedModel(
      req.admin!.enterpriseId,
      parsed.data.alias,
      parsed.data.display_name,
      parsed.data.required_capabilities ?? null,
    );
    // W19 补齐：创建统一模型写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "unified_model.create",
      target_type: "unified_model",
      target_id: model.id,
      change_summary: { alias: model.alias, display_name: model.display_name },
      result: "SUCCESS",
    });
    return reply.code(201).send({ model });
  });

  // ===== Model Route（WT-10 路由详情）=====
  app.post("/model-routes", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateRouteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    let route;
    try {
      route = await app.providerRepo.createRoute(
        req.admin!.enterpriseId,
        parsed.data.unified_model_id,
        parsed.data.provider_resource_id,
        parsed.data.upstream_model,
        { priority: parsed.data.priority, weight: parsed.data.weight, enabled: parsed.data.enabled },
      );
    } catch (error) {
      if (error instanceof EnterpriseReferenceError) {
        return reply.code(409).send({
          error: "invalid_reference",
          message: "统一模型或厂商资源不存在、未启用或不属于当前企业",
        });
      }
      throw error;
    }
    // W19 补齐：创建模型路由写操作日志（六要素 §11.2）
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "model_route.create",
      target_type: "model_route",
      target_id: route.id,
      change_summary: {
        unified_model_id: route.unified_model_id,
        provider_resource_id: route.provider_resource_id,
        upstream_model: route.upstream_model,
        priority: route.priority,
        weight: route.weight,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ route });
  });

  // 路由详情：候选、优先级、权重（WT-10）
  app.get<{ Params: { modelId: string } }>(
    "/unified-models/:modelId/routes",
    { preHandler: [requireAuth] },
    async (req) => {
      const routes = await app.providerRepo.listRoutesByModel(
        req.admin!.enterpriseId,
        req.params.modelId,
      );
      return { routes };
    },
  );
}

export function toOperatingSnapshotInput(
  value: z.output<typeof OperatingSnapshotSchema>,
  mode: "API" | "CODING_PLAN",
) {
  const systemCalculated = value.source === "ADMIN" && mode === "CODING_PLAN";
  return {
    ...value,
    used_quota: systemCalculated ? null : value.used_quota,
    remaining_quota: systemCalculated ? null : value.remaining_quota,
    next_reset_at: systemCalculated ? null : value.next_reset_at
      ? new Date(value.next_reset_at)
      : null,
    usage_calculation: systemCalculated ? "SYSTEM_LEDGER" as const : "MANUAL_SNAPSHOT" as const,
    reset_timezone: systemCalculated ? "Asia/Shanghai" : null,
    reset_cycle: systemCalculated ? value.reset_cycle ?? "NONE" : value.reset_cycle,
    collected_at: new Date(value.collected_at),
    cost_period_start: value.cost_period_start ? new Date(value.cost_period_start) : null,
    cost_period_end: value.cost_period_end ? new Date(value.cost_period_end) : null,
    balance_updated_at: value.balance_updated_at ? new Date(value.balance_updated_at) : null,
    effective_from: value.effective_from ? new Date(value.effective_from) : null,
    effective_until: value.effective_until ? new Date(value.effective_until) : null,
    reset_anchor_at: value.reset_anchor_at ? new Date(value.reset_anchor_at) : null,
  };
}
