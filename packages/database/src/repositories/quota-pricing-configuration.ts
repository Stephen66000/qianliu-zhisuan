import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { GatewayLedgerRepository } from "./gateway-ledger-repository.js";
import { pricingSetIssue } from "./pricing-set-validation.js";
import { lockPricingWrites } from "./pricing-write-guard.js";

export class PricingConfigurationError extends Error {}
type RuleInput = Omit<Parameters<GatewayLedgerRepository["createBillingRule"]>[0], "enterprise_id">;
export interface PricingConfigurationInput {
  enterpriseId: string; adminId: string; routeId: string; expectedRouteVersion: number;
  expectedModelVersion: number; priority: number; weight: number;
  submissionId: string; requestHash: string; sourceRuleIds: string[]; rules: RuleInput[];
  replaceExisting?: boolean;
}

/** One route, one price set, one atomic activation. The operation log is also the replay receipt. */
export async function savePricingConfiguration(db: Kysely<Database>, input: PricingConfigurationInput) {
  return db.transaction().execute(async (trx) => {
    await lockPricingWrites(trx, input.enterpriseId);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.enterpriseId}), hashtext(${input.submissionId}))`.execute(trx);
    const receipt = await trx.selectFrom("operation_log").select("change_summary")
      .where("enterprise_id", "=", input.enterpriseId).where("action", "=", "pricing_configuration.save")
      .where(sql<boolean>`change_summary->>'submission_id' = ${input.submissionId}`).executeTakeFirst();
    if (receipt) {
      const summary = receipt.change_summary as { request_hash: string; rule_ids: string[] };
      if (summary.request_hash !== input.requestHash) throw new PricingConfigurationError("重复提交的内容已变化，请重新提交");
      return { ruleIds: summary.rule_ids, replayed: true };
    }
    const route = await trx.selectFrom("model_route").selectAll()
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.routeId)
      .where("archived_at", "is", null).forUpdate().executeTakeFirst();
    if (!route || route.version !== input.expectedRouteVersion) throw new PricingConfigurationError("路由已变化，请刷新");
    const model = await trx.selectFrom("unified_model").selectAll()
      .where("enterprise_id", "=", input.enterpriseId).where("id", "=", route.unified_model_id)
      .where("archived_at", "is", null).forUpdate().executeTakeFirst();
    const resource = await trx.selectFrom("provider_resource").innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select(["provider_resource.id", "provider_resource.mode", "provider_resource.status", "provider.code"])
      .where("provider_resource.enterprise_id", "=", input.enterpriseId).where("provider.enterprise_id", "=", input.enterpriseId)
      .where("provider.status", "=", "ACTIVE").where("provider_resource.id", "=", route.provider_resource_id)
      .forShare().executeTakeFirst();
    if (!model || model.version !== input.expectedModelVersion || !resource || !["ACTIVE", "DEGRADED"].includes(resource.status)) {
      throw new PricingConfigurationError("模型或资源已变化、不可用，请刷新");
    }
    if (!route.enabled || model.status !== "ACTIVE") {
      const validation = await trx.selectFrom("provider_model_validation").select("id")
        .where("enterprise_id", "=", input.enterpriseId).where("provider_resource_id", "=", resource.id)
        .where("upstream_model", "=", route.upstream_model).where("status", "=", "SUCCEEDED")
        .forShare().executeTakeFirst();
      if (!validation) throw new PricingConfigurationError("请先在厂商资源的模型同步面板完成真实模型验证");
    }
    for (const id of input.sourceRuleIds) {
      const source = await trx.selectFrom("billing_rule").innerJoin("provider_resource", "provider_resource.id", "billing_rule.provider_resource_id")
        .innerJoin("provider", "provider.id", "provider_resource.provider_id").select("billing_rule.id")
        .where("billing_rule.id", "=", id).where("billing_rule.enterprise_id", "=", input.enterpriseId)
        .where("provider_resource.enterprise_id", "=", input.enterpriseId).where("provider.enterprise_id", "=", input.enterpriseId)
        .where("provider.code", "=", resource.code).where("provider_resource.mode", "=", resource.mode).forShare().executeTakeFirst();
      if (!source) throw new PricingConfigurationError("只能沿用同企业、同厂商、同资源模式的价格");
    }
    if (!input.rules.length) throw new PricingConfigurationError("至少配置一条计价规则");
    if (resource.mode === "API" && input.rules.some((rule) =>
      [rule.cache_hit_price, rule.cache_miss_price, rule.output_price].some((value) => value === null || value === undefined))) {
      throw new PricingConfigurationError("请明确填写三项 API 单价；免费项目请填 0，不能留空");
    }
    const existing = await trx.selectFrom("billing_rule").selectAll().where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", resource.id).where("upstream_model", "=", route.upstream_model)
      .where("enabled", "=", true).where("archived_at", "is", null).forUpdate().execute();
    const issue = pricingSetIssue(input.rules, input.replaceExisting ? [] : existing);
    if (issue) throw new PricingConfigurationError(issue);
    const boundary = input.rules[0]!.effective_from;
    if (input.replaceExisting) {
      if (existing.some((rule) => rule.effective_from >= boundary)) throw new PricingConfigurationError("新版本生效时间必须晚于被替换版本");
      await trx.updateTable("billing_rule").set({ effective_to: boundary, version: sql`version + 1`, updated_at: new Date() })
        .where("enterprise_id", "=", input.enterpriseId).where("provider_resource_id", "=", resource.id)
        .where("upstream_model", "=", route.upstream_model).where("enabled", "=", true).where("archived_at", "is", null)
        .where((eb) => eb.or([eb("effective_to", "is", null), eb("effective_to", ">", boundary)])).execute();
    }
    const ruleIds: string[] = [];
    const repo = new GatewayLedgerRepository(trx);
    for (const rule of input.rules) {
      if (rule.provider_resource_id !== resource.id || rule.upstream_model !== route.upstream_model
        || (resource.mode === "API" ? rule.rule_type !== "API_PRICE" : !["MODEL_TIER", "TIME_WINDOW"].includes(rule.rule_type))) {
        throw new PricingConfigurationError("计价规则与所选资源模式或模型不一致");
      }
      const duplicate = await trx.selectFrom("billing_rule").select("id").where("enterprise_id", "=", input.enterpriseId)
        .where("provider_resource_id", "=", resource.id).where("upstream_model", "=", route.upstream_model)
        .where("rule_version", "=", rule.rule_version).executeTakeFirst();
      if (duplicate) throw new PricingConfigurationError("版本已存在，请填写新版本");
      const created = await repo.createBillingRule({ ...rule, enterprise_id: input.enterpriseId,
        source: input.sourceRuleIds.length ? `WEB_ADMIN_COPY:${input.sourceRuleIds.join(",")}`.slice(0, 255) : "WEB_ADMIN" });
      ruleIds.push(created.id);
    }
    await trx.updateTable("model_route").set({ enabled: true, priority: input.priority, weight: input.weight,
      version: sql`version + 1`, updated_at: new Date() }).where("id", "=", route.id).execute();
    await trx.updateTable("unified_model").set({ status: "ACTIVE", version: sql`version + 1`, updated_at: new Date() })
      .where("id", "=", model.id).execute();
    await trx.insertInto("operation_log").values({ enterprise_id: input.enterpriseId, admin_user_id: input.adminId,
      action: "pricing_configuration.save", target_type: "model_route", target_id: route.id, result: "SUCCESS", failure_reason: null,
      change_summary: { submission_id: input.submissionId, request_hash: input.requestHash, rule_ids: ruleIds,
        source_rule_ids: input.sourceRuleIds, replaced_rule_ids: input.replaceExisting ? existing.map((rule) => rule.id) : [],
        before: { enabled: route.enabled, priority: route.priority, weight: route.weight, model_status: model.status },
        after: { enabled: true, priority: input.priority, weight: input.weight, model_status: "ACTIVE" } },
    }).execute();
    return { ruleIds, replayed: false };
  });
}
