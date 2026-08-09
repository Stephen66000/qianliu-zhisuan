import type { Kysely } from "kysely";

import type { Database } from "@qianliu/database";

/** 为旧 Gateway 集成用例补齐现在必需的最小计费前置。 */
export async function seedMissingBillingRules(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<void> {
  const routes = await db.selectFrom("model_route")
    .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
    .select([
      "model_route.provider_resource_id",
      "model_route.upstream_model",
      "provider_resource.mode",
    ])
    .where("model_route.enterprise_id", "=", enterpriseId)
    .execute();
  let index = 0;
  for (const route of routes) {
    const existing = await db.selectFrom("billing_rule").select("id")
      .where("enterprise_id", "=", enterpriseId)
      .where("provider_resource_id", "=", route.provider_resource_id)
      .where("upstream_model", "=", route.upstream_model)
      .executeTakeFirst();
    if (existing) continue;
    index += 1;
    await db.insertInto("billing_rule").values({
      enterprise_id: enterpriseId,
      provider_resource_id: route.provider_resource_id,
      upstream_model: route.upstream_model,
      rule_type: route.mode === "API" ? "API_PRICE" : "MODEL_TIER",
      rule_version: `test-${route.provider_resource_id.slice(0, 8)}-${index}`,
      effective_from: new Date(0),
      cache_miss_price: route.mode === "API" ? "0.000001" : null,
      multiplier: route.mode === "CODING_PLAN" ? "1" : null,
      priority: 1_000,
    }).execute();
  }
}
