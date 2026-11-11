import { sql } from "kysely";
import {
  computeCollectionDigest,
  computeFactWatermarkHash,
  type FactWatermark,
  type FactWatermarkSection,
} from "@qianliu/domain";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
import type { Executor } from "./provider-finance-activation-facts.js";

// ===== 2.2 完整事实水位 =====

/**
 * §5.2 要求的十个分段。分段名与表名一一对应，便于审计比对。
 */
export const FACT_WATERMARK_SECTIONS = [
  "provider_resource",
  "provider_resource_operating_snapshot",
  "resource_purchase_record",
  "provider_finance_event",
  "provider_subscription_period",
  "provider_finance_legacy_cost_resolution",
  "ledger_line",
  "usage_event",
  "billing_rule",
  "provider_finance_runtime_state",
] as const;

export type FactWatermarkSectionName = (typeof FACT_WATERMARK_SECTIONS)[number];

export async function buildFactWatermark(
  db: Executor, input: { enterpriseId: string; snapshotAt: string },
): Promise<FactWatermark> {
  const cutover = PROVIDER_FINANCE_CUTOVER;
  const snapshotAt = new Date(input.snapshotAt);
  const section = (name: FactWatermarkSectionName, rows: readonly unknown[]): FactWatermarkSection =>
    ({ section: name, count: rows.length, digest: computeCollectionDigest(rows) });

  const [resources, snapshots, purchases, events, periods, resolutions, lines, usageEvents, rules, runtime] =
    await Promise.all([
      sql`SELECT id, provider_id, name, mode, status, credential_type, concurrency_limit,
                 monthly_budget_amount::text AS monthly_budget_amount, monthly_budget_currency,
                 subscription_auto_renew_enabled, version, archived_at
            FROM provider_resource WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, version, source, collected_at, currency,
                 recharge_amount::text, current_balance::text, granted_balance::text,
                 topped_up_balance::text, provider_balance_available, balance_source, cost_source,
                 cumulative_cost::text, current_period_cost::text, cost_period_start, cost_period_end,
                 balance_updated_at, package_name, package_cost::text, total_quota::text, quota_unit,
                 used_quota::text, remaining_quota::text, effective_from, effective_until,
                 reset_cycle, reset_anchor_at, reset_timezone, usage_calculation, next_reset_at,
                 subscription_period_id
            FROM provider_resource_operating_snapshot WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, purchase_type, description, amount::text, currency,
                 purchased_at, service_period_start, service_period_end, source, evidence_ref, created_by
            FROM resource_purchase_record WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, event_type, account_amount::text, account_currency,
                 cash_paid_cny::text, occurred_at, external_reference, reversal_of_event_id,
                 correction_of_event_id, reconciliation_case_id, legacy_cost_resolution_id,
                 description, evidence_ref, source, idempotency_key, created_by_admin_user_id
            FROM provider_finance_event WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, finance_event_id, product_name, period_start,
                 period_end_exclusive, source, migration_source_record_id, reversed_by_event_id,
                 created_by_admin_user_id
            FROM provider_subscription_period WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, account_currency, window_start, window_end_inclusive,
                 provider_balance_snapshot_id, provider_confirmed_balance::text,
                 local_balance_before_adjustment::text, known_api_cost::text, missing_api_cost::text,
                 unknown_line_count::text, status, adjustment_event_id, evidence_ref,
                 created_by_admin_user_id, resolved_at
            FROM provider_finance_legacy_cost_resolution WHERE enterprise_id=${input.enterpriseId}::uuid
           ORDER BY id`.execute(db),
      sql`SELECT id, ai_request_id, usage_event_id, upstream_attempt_id, provider_resource_id,
                 principal_id, resource_mode, raw_input_tokens::text, raw_output_tokens::text,
                 raw_cache_tokens::text, raw_reasoning_tokens::text, deducted_quota::text,
                 api_cost::text, api_cost_currency, api_cost_status, legacy_cost_resolution_id,
                 subscription_period_id, settled_at, usage_quality, billing_rule_id, rule_version,
                 multiplier::text, billing_rule_snapshot
            FROM ledger_line WHERE enterprise_id=${input.enterpriseId}::uuid
             AND COALESCE(settled_at,created_at)>=${cutover}
             AND COALESCE(settled_at,created_at)<=${snapshotAt}
           ORDER BY id`.execute(db),
      sql`SELECT id, ai_request_id, upstream_attempt_id, provider_resource_id,
                 input_tokens::text, output_tokens::text, cache_tokens::text, reasoning_tokens::text,
                 usage_quality, upstream_usage_id, dedup_key
            FROM usage_event WHERE enterprise_id=${input.enterpriseId}::uuid
             AND id IN (
               SELECT line.usage_event_id FROM ledger_line line
                WHERE line.enterprise_id=${input.enterpriseId}::uuid
                  AND COALESCE(settled_at,created_at)>=${cutover}
                  AND COALESCE(settled_at,created_at)<=${snapshotAt}
             )
           ORDER BY id`.execute(db),
      sql`SELECT id, provider_resource_id, upstream_model, rule_type, rule_version, effective_from,
                 effective_to, timezone, days_of_week, start_time, end_time, time_windows,
                 multiplier::text, cache_hit_price::text, cache_miss_price::text, output_price::text,
                 currency, priority, enabled, pricing_mode, source, version, archived_at
            FROM billing_rule WHERE enterprise_id=${input.enterpriseId}::uuid
             AND archived_at IS NULL
           ORDER BY id`.execute(db),
      sql`SELECT enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at
            FROM provider_finance_runtime_state WHERE enterprise_id=${input.enterpriseId}::uuid`.execute(db),
    ]);

  const sections: FactWatermarkSection[] = [
    section("provider_resource", resources.rows),
    section("provider_resource_operating_snapshot", snapshots.rows),
    section("resource_purchase_record", purchases.rows),
    section("provider_finance_event", events.rows),
    section("provider_subscription_period", periods.rows),
    section("provider_finance_legacy_cost_resolution", resolutions.rows),
    section("ledger_line", lines.rows),
    section("usage_event", usageEvents.rows),
    section("billing_rule", rules.rows),
    section("provider_finance_runtime_state", runtime.rows),
  ];
  return { sections, hash: computeFactWatermarkHash(sections) };
}
