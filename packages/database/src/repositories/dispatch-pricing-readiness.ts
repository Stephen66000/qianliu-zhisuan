import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

/** Readiness is structural over effective rules, not whether the wall clock is inside a peak window. */
export async function listPricingReadyRoutes(db: Kysely<Database>, enterpriseId: string) {
  return db.selectFrom("model_route as r").innerJoin("unified_model as m", "m.id", "r.unified_model_id")
    .innerJoin("provider_resource as p", "p.id", "r.provider_resource_id")
    .innerJoin("provider as v", "v.id", "p.provider_id")
    .select(["r.id", "m.alias", "r.provider_resource_id", "p.mode", "r.upstream_model"])
    .where("r.enterprise_id", "=", enterpriseId).where("m.enterprise_id", "=", enterpriseId)
    .where("p.enterprise_id", "=", enterpriseId).where("v.enterprise_id", "=", enterpriseId)
    .where("v.status", "=", "ACTIVE").where("r.enabled", "=", true)
    .where("r.archived_at", "is", null).where("m.archived_at", "is", null)
    .where("m.status", "=", "ACTIVE").where("p.status", "in", ["ACTIVE", "DEGRADED"])
    .where(sql<boolean>`EXISTS (SELECT 1 FROM billing_rule b
      WHERE b.enterprise_id = ${enterpriseId} AND b.enabled AND b.archived_at IS NULL
      AND b.effective_from <= now() AND (b.effective_to IS NULL OR b.effective_to > now())
      AND (b.provider_resource_id IS NULL OR b.provider_resource_id = r.provider_resource_id)
      AND (b.upstream_model IS NULL OR b.upstream_model = r.upstream_model)
      AND ((p.mode = 'API' AND b.rule_type = 'API_PRICE'
        AND (b.cache_hit_price IS NOT NULL OR b.cache_miss_price IS NOT NULL OR b.output_price IS NOT NULL))
        OR (p.mode = 'CODING_PLAN' AND b.rule_type IN ('MODEL_TIER','TIME_WINDOW') AND b.multiplier IS NOT NULL)))`)
    .execute();
}

export async function policyPricingReadiness(db: Kysely<Database>, enterpriseId: string, policy: {
  match_unified_model: string | null; match_provider_resource_id: string | null;
  match_resource_mode: string | null; switch_equivalent_group: string[] | null;
  match_price_multiplier_min: string | null;
}) {
  const all = await listPricingReadyRoutes(db, enterpriseId);
  const matching = all.filter((route) => (!policy.match_unified_model || route.alias === policy.match_unified_model)
    && (!policy.match_provider_resource_id || route.provider_resource_id === policy.match_provider_resource_id)
    && (!policy.match_resource_mode || route.mode === policy.match_resource_mode));
  if (!matching.length) return "匹配的模型与资源尚未完成路由和计价配置";
  if (policy.switch_equivalent_group?.some((id) => !all.some((route) => route.provider_resource_id === id
    && (!policy.match_unified_model || route.alias === policy.match_unified_model)))) return "切换目标尚未完成同模型路由和计价配置";
  if (policy.match_price_multiplier_min && matching.some((route) => route.mode === "API")) {
    for (const route of matching.filter((row) => row.mode === "API")) {
      const explicit = await db.selectFrom("billing_rule").select("id").where("enterprise_id", "=", enterpriseId)
        .where("provider_resource_id", "=", route.provider_resource_id).where("upstream_model", "=", route.upstream_model)
        .where("pricing_mode", "=", "MULTIPLIER").where("enabled", "=", true).where("archived_at", "is", null)
        .where("effective_from", "<=", new Date()).where((eb) => eb.or([eb("effective_to", "is", null), eb("effective_to", ">", new Date())]))
        .executeTakeFirst();
      if (!explicit) return "API 绝对时段价格没有可核对倍率，请配置倍率计价或使用时间条件";
    }
  }
  return null;
}
