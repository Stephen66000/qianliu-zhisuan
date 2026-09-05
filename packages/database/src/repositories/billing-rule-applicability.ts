import type { Kysely, Transaction } from "kysely";
import type { BillingRule } from "@qianliu/domain";

import type { Database } from "../kysely.js";

/** 读取某一业务时点有效的规则；资源模式、scope 和时间窗由 domain 单一匹配器判定。 */
export async function listEnabledBillingRulesAt(
  db: Kysely<Database> | Transaction<Database>,
  enterpriseId: string,
  at: Date,
): Promise<BillingRule[]> {
  const rows = await db.selectFrom("billing_rule").select([
    "id", "rule_type", "rule_version", "provider_resource_id", "upstream_model",
    "effective_from", "effective_to", "timezone", "days_of_week", "start_time", "end_time",
    "time_windows", "multiplier", "cache_hit_price", "cache_miss_price", "output_price",
    "currency", "priority", "pricing_mode",
  ]).where("enterprise_id", "=", enterpriseId)
    .where("enabled", "=", true)
    .where("archived_at", "is", null)
    .where("effective_from", "<=", at)
    .where((eb) => eb.or([
      eb("effective_to", "is", null),
      eb("effective_to", ">", at),
    ]))
    .execute();
  return rows.map((row) => ({
    id: row.id,
    pricingMode: row.pricing_mode,
    ruleType: row.rule_type as BillingRule["ruleType"],
    ruleVersion: row.rule_version,
    providerResourceId: row.provider_resource_id,
    upstreamModel: row.upstream_model,
    effectiveFrom: row.effective_from.getTime(),
    effectiveTo: row.effective_to?.getTime() ?? null,
    timezone: row.timezone,
    daysOfWeek: row.days_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    timeWindows: row.time_windows?.map((window) => ({
      timezone: window.timezone,
      daysOfWeek: window.days_of_week,
      startTime: window.start_time,
      endTime: window.end_time,
    })) ?? null,
    multiplier: row.multiplier,
    cacheHitPrice: row.cache_hit_price,
    cacheMissPrice: row.cache_miss_price,
    outputPrice: row.output_price,
    currency: row.currency,
    priority: row.priority,
  }));
}
