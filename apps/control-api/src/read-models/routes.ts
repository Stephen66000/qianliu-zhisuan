/**
 * 只读模型路由（W18）—— 计价规则 / 经营策略 / 供给预测列表。
 *
 * 依据：TRD §11.2（/billing-rules、/dispatch-policies、/supply-forecasts 端点）。
 * 供给预测、经营策略和路由诊断复用 /resources、/quota-rules 和 /usage 页面（TRD 行 731）。
 * 全部只读；写操作在 W19 落地。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const DecimalString = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((value) => /^\d+(?:\.\d+)?$/.test(value), {
    message: "价格必须是非负十进制数",
  });

const CreateBillingRuleSchema = z.object({
  rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
  rule_version: z.string().min(1).max(64),
  provider_resource_id: z.string().uuid().nullable().optional(),
  upstream_model: z.string().min(1).max(128).nullable().optional(),
  effective_from: z.string().datetime(),
  effective_to: z.string().datetime().nullable().optional(),
  multiplier: DecimalString.nullable().optional(),
  cache_hit_price: DecimalString.nullable().optional(),
  cache_miss_price: DecimalString.nullable().optional(),
  output_price: DecimalString.nullable().optional(),
  currency: z.string().length(3).optional(),
  priority: z.number().int().min(0).optional(),
  source: z.string().max(255).nullable().optional(),
});

export function registerReadModelRoutes(app: FastifyInstance): void {
  // GET /billing-rules —— 计价规则列表（含 disabled/历史，管理后台用）
  app.get("/billing-rules", { preHandler: [requireAuth] }, async (req) => {
    const rules = await app.ledgerRepo.listAllBillingRules(req.admin!.enterpriseId);
    return { rules };
  });

  app.post("/billing-rules", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateBillingRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const input = parsed.data;
    const rule = await app.ledgerRepo.createBillingRule({
      enterprise_id: req.admin!.enterpriseId,
      rule_type: input.rule_type,
      rule_version: input.rule_version,
      provider_resource_id: input.provider_resource_id,
      upstream_model: input.upstream_model,
      effective_from: new Date(input.effective_from),
      effective_to:
        input.effective_to === undefined
          ? undefined
          : input.effective_to === null
            ? null
            : new Date(input.effective_to),
      multiplier: input.multiplier,
      cache_hit_price: input.cache_hit_price,
      cache_miss_price: input.cache_miss_price,
      output_price: input.output_price,
      currency: input.currency,
      priority: input.priority,
      source: input.source,
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "billing_rule.create",
      target_type: "billing_rule",
      target_id: rule.id,
      change_summary: {
        rule_type: rule.rule_type,
        rule_version: rule.rule_version,
        provider_resource_id: rule.provider_resource_id,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ rule });
  });

  // GET /dispatch-policies —— 经营策略列表（含全部状态 DRAFT/VALIDATED/PUBLISHED/RETIRED）
  app.get("/dispatch-policies", { preHandler: [requireAuth] }, async (req) => {
    const policies = await app.dispatchRepo.listPublishedPolicies(req.admin!.enterpriseId);
    return { policies };
  });

  // GET /supply-forecasts —— 供给预测快照列表（每资源最新一条）
  app.get("/supply-forecasts", { preHandler: [requireAuth] }, async (req) => {
    const forecasts = await app.db
      .selectFrom("supply_forecast")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "supply_forecast.provider_resource_id",
      )
      .where("supply_forecast.enterprise_id", "=", req.admin!.enterpriseId)
      .orderBy("supply_forecast.snapshot_at", "desc")
      .select([
        "supply_forecast.id",
        "supply_forecast.provider_resource_id",
        "provider_resource.name as resource_name",
        "supply_forecast.rate_1h",
        "supply_forecast.rate_24h",
        "supply_forecast.rate_7d",
        "supply_forecast.forecast_exhaust_at",
        "supply_forecast.next_recover_at",
        "supply_forecast.coverage_hours",
        "supply_forecast.remaining_quota",
        "supply_forecast.confidence",
        "supply_forecast.data_points",
        "supply_forecast.not_calculable_reason",
        "supply_forecast.snapshot_at",
      ])
      .execute();
    return { forecasts };
  });
}
