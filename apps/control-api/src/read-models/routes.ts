/**
 * 只读模型路由（W18）—— 计价规则 / 经营策略 / 供给预测列表。
 *
 * 依据：TRD §11.2（/billing-rules、/dispatch-policies、/supply-forecasts 端点）。
 * 供给预测、经营策略和路由诊断复用 /resources、/quota-rules 和 /usage 页面（TRD 行 731）。
 * 全部只读；写操作在 W19 落地。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "kysely";
import { archiveDispatchPolicy, policyPricingReadiness, PricingModeConflictError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  CreateDispatchPolicySchema,
  dispatchPolicyFields,
} from "./dispatch-policy-contract.js";
import { CreateBillingRuleSchema } from "./billing-rule-contract.js";
import { registerPricingConfigurationRoutes } from "./pricing-configuration-routes.js";

function equalDecimal(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  return units(left) === units(right);
}

export function registerReadModelRoutes(app: FastifyInstance): void {
  registerPricingConfigurationRoutes(app);
  // GET /billing-rules —— 计价规则列表（含 disabled/历史，管理后台用）
  app.get<{ Querystring: { archived?: string } }>("/billing-rules", { preHandler: [requireAuth] }, async (req, reply) => {
    const archived = z.enum(["exclude", "only", "all"]).default("exclude").safeParse(req.query.archived);
    if (!archived.success) {
      return reply.code(400).send({ error: "invalid_request", message: "归档筛选无效" });
    }
    const rules = await app.ledgerRepo.listAllBillingRules(req.admin!.enterpriseId, archived.data);
    return { rules };
  });

  app.post("/billing-rules", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateBillingRuleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const input = parsed.data;
    if (input.provider_resource_id || input.upstream_model) {
      if (!input.provider_resource_id || !input.upstream_model) {
        return reply.code(400).send({
          error: "invalid_route_reference",
          message: "资源和上游模型必须同时指定，并对应一条启用的 Model Route",
        });
      }
      const route = await app.db
        .selectFrom("model_route")
        .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
        .innerJoin(
          "provider_resource",
          "provider_resource.id",
          "model_route.provider_resource_id",
        )
        .select("model_route.id")
        .where("model_route.enterprise_id", "=", req.admin!.enterpriseId)
        .where("unified_model.enterprise_id", "=", req.admin!.enterpriseId)
        .where("provider_resource.enterprise_id", "=", req.admin!.enterpriseId)
        .where("unified_model.status", "=", "ACTIVE")
        .where("unified_model.archived_at", "is", null)
        .where("provider_resource.status", "=", "ACTIVE")
        .where("model_route.enabled", "=", true)
        .where("model_route.archived_at", "is", null)
        .where("model_route.provider_resource_id", "=", input.provider_resource_id)
        .where("model_route.upstream_model", "=", input.upstream_model)
        .executeTakeFirst();
      if (!route) {
        return reply.code(409).send({
          error: "route_not_enabled",
          message: "计价规则必须绑定当前企业的一条启用 Model Route",
        });
      }
    }
    const rule = await app.ledgerRepo.createBillingRule({
      enterprise_id: req.admin!.enterpriseId,
      rule_type: input.rule_type,
      pricing_mode: input.pricing_mode,
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
      timezone: input.timezone,
      days_of_week: input.days_of_week,
      start_time: input.start_time,
      end_time: input.end_time,
      time_windows: input.windows?.map((window) => ({
        ...window,
        days_of_week: window.days_of_week ?? null,
      })),
      multiplier: input.multiplier,
      cache_hit_price: input.cache_hit_price,
      cache_miss_price: input.cache_miss_price,
      output_price: input.output_price,
      currency: input.currency,
      priority: input.priority,
      source: input.source,
    }).catch((error: unknown) => { if (error instanceof PricingModeConflictError) return null; throw error; });
    if (!rule) return reply.code(409).send({ error: "pricing_mode_conflict", message: "绝对价格与倍率计价冲突，请通过新建规则替换整套旧价格" });
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
        time_windows: rule.time_windows,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ rule });
  });

  // GET /dispatch-policies —— 经营策略列表（含全部状态 DRAFT/VALIDATED/PUBLISHED/RETIRED）
  app.get("/dispatch-policies", { preHandler: [requireAuth] }, async (req) => {
    const policies = await app.dispatchRepo.listPolicies(req.admin!.enterpriseId);
    return { policies };
  });

  app.post("/dispatch-policies", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateDispatchPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const input = parsed.data;
    const id = await app.dispatchRepo.createPolicy({
      enterpriseId: req.admin!.enterpriseId,
      status: "DRAFT",
      createdByAdminId: req.admin!.adminUserId,
      ...dispatchPolicyFields(input),
    });
    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "dispatch_policy.create",
      target_type: "dispatch_policy",
      target_id: id,
      change_summary: {
        policy_version: input.policy_version,
        action: input.action,
        priority: input.priority ?? 100,
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({
      policy: await app.dispatchRepo.getPolicy(req.admin!.enterpriseId, id),
    });
  });

  app.patch<{ Params: { id: string } }>(
    "/dispatch-policies/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = CreateDispatchPolicySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const input = parsed.data;
      const changed = await app.dispatchRepo.updateDraftPolicy(
        req.admin!.enterpriseId,
        req.params.id,
        dispatchPolicyFields(input),
      );
      if (!changed) {
        return reply.code(409).send({
          error: "immutable_policy",
          message: "只有草稿策略可以编辑，请刷新后重试",
        });
      }
      await app.auditRepo.write({
        enterprise_id: req.admin!.enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "dispatch_policy.update",
        target_type: "dispatch_policy",
        target_id: req.params.id,
        change_summary: {
          policy_version: input.policy_version,
          principal_count: input.match_principal_scope?.length ?? "ALL",
        },
        result: "SUCCESS",
      });
      return {
        policy: await app.dispatchRepo.getPolicy(req.admin!.enterpriseId, req.params.id),
      };
    },
  );

  app.post<{ Params: { id: string; action: string } }>(
    "/dispatch-policies/:id/:action",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      if (req.params.action === "archive") {
        const body = z.object({ expected_version: z.number().int().positive() }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "缺少当前版本" });
        const changed = await archiveDispatchPolicy(app.db, req.admin!.enterpriseId, req.params.id,
          req.admin!.adminUserId, body.data.expected_version);
        if (!changed) return reply.code(409).send({ error: "conflict", message: "只有未存档的已停用策略可以存档，请刷新" });
        return { policy: await app.dispatchRepo.getPolicy(req.admin!.enterpriseId, req.params.id) };
      }
      const action = z.enum(["validate", "publish", "retire", "copy", "restore"]).safeParse(req.params.action);
      if (!action.success) {
        return reply.code(404).send({ error: "not_found", message: "未知策略操作" });
      }
      const enterpriseId = req.admin!.enterpriseId;
      const policy = await app.dispatchRepo.getPolicy(enterpriseId, req.params.id);
      if (!policy) {
        return reply.code(404).send({ error: "not_found", message: "调度策略不存在" });
      }

      if (action.data === "restore") {
        if (policy.status !== "RETIRED") {
          return reply.code(409).send({
            error: "invalid_state",
            message: `策略当前为 ${policy.status}，只有已停用历史版本可以恢复`,
          });
        }
        const outcome = await app.dispatchRepo.restorePolicyAsPublished(
          enterpriseId, policy.id, req.admin!.adminUserId,
        );
        if (outcome.kind === "invalid_reference") {
          return reply.code(400).send({ error: "invalid_reference", message: outcome.message });
        }
        if (outcome.kind === "conflict") {
          return reply.code(409).send({ error: "conflict", message: "策略状态已变化，请刷新后重试" });
        }
        return reply.code(outcome.kind === "replayed" ? 200 : 201).send({
          policy: outcome.policy, replayed: outcome.kind === "replayed",
        });
      }

      if (action.data === "copy") {
        if (policy.status !== "RETIRED") {
          return reply.code(409).send({
            error: "invalid_state",
            message: `策略当前为 ${policy.status}，只有已停用历史版本可以复制`,
          });
        }
        const copied = await app.dispatchRepo.copyPolicyAsDraft(
          enterpriseId,
          policy.id,
          req.admin!.adminUserId,
        );
        if (!copied) {
          return reply.code(409).send({ error: "conflict", message: "策略状态已变化，请刷新后重试" });
        }
        return reply.code(201).send({ policy: copied });
      }

      const transition = {
        validate: { from: "DRAFT", to: "VALIDATED" },
        publish: { from: "VALIDATED", to: "PUBLISHED" },
        retire: { from: "PUBLISHED", to: "RETIRED" },
      } as const;
      const expected = transition[action.data];
      if (policy.status !== expected.from) {
        return reply.code(409).send({
          error: "invalid_state",
          message: `策略当前为 ${policy.status}，不能执行 ${action.data}`,
        });
      }

      if (action.data === "validate" || action.data === "publish") {
        const invalidPricing = await policyPricingReadiness(app.db, enterpriseId, {
          match_unified_model: policy.matchUnifiedModel, match_provider_resource_id: policy.matchProviderResourceId,
          match_resource_mode: policy.matchResourceMode, switch_equivalent_group: [...policy.switchEquivalentGroup],
          match_price_multiplier_min: policy.matchPriceMultiplierMin,
        });
        if (invalidPricing) return reply.code(400).send({ error: "invalid_reference", message: invalidPricing });
        const [models, resources, principals] = await Promise.all([
          app.providerRepo.listUnifiedModels(enterpriseId),
          app.providerRepo.listResources(enterpriseId),
          app.principalRepo.list(enterpriseId),
        ]);
        if (
          policy.matchUnifiedModel
          && !models.some((model) => model.alias === policy.matchUnifiedModel && model.status === "ACTIVE")
        ) {
          return reply.code(400).send({ error: "invalid_reference", message: "统一模型不存在或未启用" });
        }
        const resourceIds = new Set(resources.map((resource) => resource.id));
        if (
          policy.matchProviderResourceId
          && !resourceIds.has(policy.matchProviderResourceId)
        ) {
          return reply.code(400).send({ error: "invalid_reference", message: "匹配资源不存在" });
        }
        if (policy.switchEquivalentGroup.some((id) => !resourceIds.has(id))) {
          return reply.code(400).send({ error: "invalid_reference", message: "等价资源组包含不存在的资源" });
        }
        const principalIds = new Set(principals.map((principal) => principal.id));
        if (policy.matchPrincipalScope?.some((id) => !principalIds.has(id))) {
          return reply.code(400).send({ error: "invalid_reference", message: "主体范围包含不存在的主体" });
        }
      }

      const changed = await app.dispatchRepo.transitionStatus(
        enterpriseId,
        policy.id,
        expected.from,
        expected.to,
        req.admin!.adminUserId,
        policy.version,
      );
      if (!changed) {
        return reply.code(409).send({
          error: "conflict",
          message: "策略状态已被其他管理员修改，请刷新后重试",
        });
      }
      await app.auditRepo.write({
        enterprise_id: enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: `dispatch_policy.${action.data}`,
        target_type: "dispatch_policy",
        target_id: policy.id,
        change_summary: { before: expected.from, after: expected.to },
        result: "SUCCESS",
      });
      return {
        policy: await app.dispatchRepo.getPolicy(enterpriseId, policy.id),
      };
    },
  );

  // GET /supply-forecasts —— 供给预测快照列表（每资源最新一条）
  app.get("/supply-forecasts", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const result = await sql<{
      id: string;
      provider_resource_id: string;
      resource_name: string;
      mode: string;
      rate_1h: string | null;
      rate_24h: string | null;
      rate_7d: string | null;
      forecast_exhaust_at: Date | null;
      next_recover_at: Date | null;
      coverage_hours: string | null;
      forecast_remaining_quota: string;
      confidence: string;
      data_points: number;
      not_calculable_reason: string | null;
      snapshot_at: Date;
    }>`
      WITH latest_forecast AS (
        SELECT DISTINCT ON (provider_resource_id) *
          FROM supply_forecast
         WHERE enterprise_id = ${enterpriseId}
         ORDER BY provider_resource_id, snapshot_at DESC
      )
      SELECT f.id, f.provider_resource_id, pr.name AS resource_name, pr.mode,
             f.rate_1h, f.rate_24h, f.rate_7d, f.forecast_exhaust_at,
             f.next_recover_at, f.coverage_hours,
             f.remaining_quota AS forecast_remaining_quota,
             f.confidence, f.data_points, f.not_calculable_reason, f.snapshot_at
        FROM latest_forecast f
        JOIN provider_resource pr ON pr.id = f.provider_resource_id
       ORDER BY f.snapshot_at DESC
    `.execute(app.db);
    const current = new Map(
      (await app.providerRepo.listCurrentOperatingSnapshots(enterpriseId))
        .map((snapshot) => [snapshot.provider_resource_id, snapshot]),
    );
    return {
      forecasts: result.rows.flatMap((forecast) => {
        const snapshot = current.get(forecast.provider_resource_id);
        const remaining = forecast.mode === "API"
          ? snapshot?.current_balance ?? null
          : snapshot?.remaining_quota ?? null;
        if (!snapshot || forecast.snapshot_at < snapshot.calculated_at ||
          (forecast.forecast_exhaust_at !== null
            && forecast.forecast_exhaust_at < forecast.snapshot_at
            && !equalDecimal(remaining, "0")) ||
          !equalDecimal(forecast.forecast_remaining_quota, remaining)) return [];
        return [{
          ...forecast,
          remaining_quota: remaining,
          operating_snapshot_id: snapshot.id,
          operating_snapshot_version: snapshot.version,
        }];
      }),
    };
  });
}
