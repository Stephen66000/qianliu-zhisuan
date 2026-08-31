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
import { requireAuth } from "../plugins/auth-guard.js";
import {
  CreateDispatchPolicySchema,
  DecimalString,
  TimeString,
  dispatchPolicyFields,
} from "./dispatch-policy-contract.js";

function equalDecimal(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  return units(left) === units(right);
}

const BillingWindowSchema = z
  .object({
    timezone: z.string().min(1).max(64),
    days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
    start_time: TimeString,
    end_time: TimeString,
  })
  .superRefine((window, ctx) => {
    if (window.start_time === window.end_time) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
    }
    if (window.days_of_week && new Set(window.days_of_week).size !== window.days_of_week.length) {
      ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期不能重复" });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: window.timezone }).format();
    } catch {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "无效 IANA 时区" });
    }
  });

export const CreateBillingRuleSchema = z
  .object({
    rule_type: z.enum(["API_PRICE", "TIME_WINDOW", "MODEL_TIER", "CACHE_STATE"]),
    rule_version: z.string().min(1).max(64),
    provider_resource_id: z.string().uuid().nullable().optional(),
    upstream_model: z.string().min(1).max(128).nullable().optional(),
    effective_from: z.string().datetime(),
    effective_to: z.string().datetime().nullable().optional(),
    timezone: z.string().min(1).max(64).nullable().optional(),
    days_of_week: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().optional(),
    start_time: TimeString.nullable().optional(),
    end_time: TimeString.nullable().optional(),
    windows: z.array(BillingWindowSchema).min(1).max(32).nullable().optional(),
    multiplier: DecimalString.nullable().optional(),
    cache_hit_price: DecimalString.nullable().optional(),
    cache_miss_price: DecimalString.nullable().optional(),
    output_price: DecimalString.nullable().optional(),
    currency: z.string().length(3).optional(),
    priority: z.number().int().min(0).optional(),
    source: z.string().max(255).nullable().optional(),
  })
  .superRefine((input, ctx) => {
    const windowParts = [input.timezone, input.start_time, input.end_time];
    const configuredWindowParts = windowParts.filter((value) => value !== null && value !== undefined);
    const hasWindows = Boolean(input.windows && input.windows.length > 0);
    if (hasWindows && configuredWindowParts.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["windows"],
        message: "windows 与旧版单时间窗字段不能同时配置",
      });
    }
    if (configuredWindowParts.length !== 0 && configuredWindowParts.length !== windowParts.length) {
      ctx.addIssue({
        code: "custom",
        path: ["timezone"],
        message: "timezone、start_time、end_time 必须同时配置",
      });
    }
    if (input.start_time && input.end_time && input.start_time === input.end_time) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "起止时间不能相同" });
    }
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format();
      } catch {
        ctx.addIssue({ code: "custom", path: ["timezone"], message: "无效 IANA 时区" });
      }
    }
    if (input.effective_to && new Date(input.effective_to) <= new Date(input.effective_from)) {
      ctx.addIssue({
        code: "custom",
        path: ["effective_to"],
        message: "effective_to 必须晚于 effective_from",
      });
    }
    if (input.days_of_week && new Set(input.days_of_week).size !== input.days_of_week.length) {
      ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期不能重复" });
    }
    if (input.days_of_week && configuredWindowParts.length !== windowParts.length) {
      ctx.addIssue({ code: "custom", path: ["days_of_week"], message: "星期限制必须配合完整时间窗" });
    }
    if (input.windows) {
      const keys = input.windows.map((window) =>
        `${window.timezone}|${window.days_of_week?.join(",") ?? "*"}|${window.start_time}|${window.end_time}`
      );
      if (new Set(keys).size !== keys.length) {
        ctx.addIssue({ code: "custom", path: ["windows"], message: "时间窗不能重复" });
      }
    }

    const prices = [input.cache_hit_price, input.cache_miss_price, input.output_price];
    if (input.rule_type === "API_PRICE") {
      if (input.multiplier !== null && input.multiplier !== undefined) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "API 价格规则不能配置额度倍率" });
      }
      if (prices.every((value) => value === null || value === undefined)) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "API 价格规则至少配置一个单价" });
      }
    }
    if (input.rule_type === "TIME_WINDOW" || input.rule_type === "MODEL_TIER") {
      if (input.multiplier === null || input.multiplier === undefined) {
        ctx.addIssue({ code: "custom", path: ["multiplier"], message: "额度规则必须配置倍率" });
      }
      if (prices.some((value) => value !== null && value !== undefined)) {
        ctx.addIssue({ code: "custom", path: ["cache_miss_price"], message: "额度倍率规则不能配置 API 单价" });
      }
    }
    if (
      input.rule_type === "TIME_WINDOW"
      && !hasWindows
      && configuredWindowParts.length !== windowParts.length
    ) {
      ctx.addIssue({ code: "custom", path: ["start_time"], message: "时段倍率规则必须配置完整时间窗" });
    }
    if (
      input.rule_type === "MODEL_TIER"
      && (hasWindows || configuredWindowParts.length > 0 || input.days_of_week)
    ) {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "模型档位规则不使用时间窗" });
    }
  });

const CreateBillingRuleSetSchema = z.object({
  rules: z.array(CreateBillingRuleSchema).min(1).max(32),
});

type CreateBillingRule = z.infer<typeof CreateBillingRuleSchema>;

async function enabledModelRouteExists(
  app: FastifyInstance,
  enterpriseId: string,
  providerResourceId: string,
  upstreamModel: string,
): Promise<boolean> {
  const route = await app.db
    .selectFrom("model_route")
    .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .select("model_route.id")
    .where("model_route.enterprise_id", "=", enterpriseId)
    .where("unified_model.enterprise_id", "=", enterpriseId)
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .where("unified_model.status", "=", "ACTIVE")
    .where("unified_model.archived_at", "is", null)
    .where("provider_resource.status", "=", "ACTIVE")
    .where("model_route.enabled", "=", true)
    .where("model_route.archived_at", "is", null)
    .where("model_route.provider_resource_id", "=", providerResourceId)
    .where("model_route.upstream_model", "=", upstreamModel)
    .executeTakeFirst();
  return Boolean(route);
}

export function toBillingRuleInput(enterpriseId: string, input: CreateBillingRule) {
  return {
    enterprise_id: enterpriseId,
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
  };
}

export function registerReadModelRoutes(app: FastifyInstance): void {
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
      if (!await enabledModelRouteExists(
        app,
        req.admin!.enterpriseId,
        input.provider_resource_id,
        input.upstream_model,
      )) {
        return reply.code(409).send({
          error: "route_not_enabled",
          message: "计价规则必须绑定当前企业的一条启用 Model Route",
        });
      }
    }
    const rule = await app.ledgerRepo.createBillingRule(
      toBillingRuleInput(req.admin!.enterpriseId, input),
    );
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

  // 复制整套规则：客户端完成差异确认后一次提交，服务端原子落库。
  app.post("/billing-rule-sets", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateBillingRuleSetSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const [first, ...rest] = parsed.data.rules;
    if (
      !first?.provider_resource_id
      || !first.upstream_model
      || rest.some((rule) =>
        rule.provider_resource_id !== first.provider_resource_id
        || rule.upstream_model !== first.upstream_model)
    ) {
      return reply.code(400).send({
        error: "invalid_rule_set_target",
        message: "整套规则必须绑定同一条启用的 Model Route",
      });
    }
    const enterpriseId = req.admin!.enterpriseId;
    if (!await enabledModelRouteExists(
      app,
      enterpriseId,
      first.provider_resource_id,
      first.upstream_model,
    )) {
      return reply.code(409).send({
        error: "route_not_enabled",
        message: "计价规则必须绑定当前企业的一条启用 Model Route",
      });
    }
    const rules = await app.ledgerRepo.createBillingRulesAtomically(
      parsed.data.rules.map((rule) => toBillingRuleInput(enterpriseId, rule)),
    );
    await app.auditRepo.write({
      enterprise_id: enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "billing_rule_set.copy",
      target_type: "billing_rule_set",
      target_id: rules[0]!.id,
      change_summary: {
        provider_resource_id: first.provider_resource_id,
        upstream_model: first.upstream_model,
        rule_ids: rules.map((rule) => rule.id),
        rule_versions: rules.map((rule) => rule.rule_version),
      },
      result: "SUCCESS",
    });
    return reply.code(201).send({ rules });
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

      if (action.data === "validate") {
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
