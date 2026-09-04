import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { FinanceCurrency } from "./provider-finance-types.js";

export interface SubscriptionPeriodUsage {
  request_count: string;
  input_tokens: string;
  output_tokens: string;
  cache_tokens: string;
  reasoning_tokens: string;
  true_tokens: string;
  deducted_quota: string | null;
  deducted_quota_complete: boolean;
}

export async function loadSubscriptionPeriodUsage(
  db: Kysely<Database>, enterpriseId: string, resourceId: string, periodId: string,
  start: Date, end: Date,
): Promise<SubscriptionPeriodUsage> {
  const result = await sql<SubscriptionPeriodUsage>`
    SELECT COUNT(DISTINCT line.ai_request_id)::text AS request_count,
           COALESCE(SUM(line.raw_input_tokens),0)::text AS input_tokens,
           COALESCE(SUM(line.raw_output_tokens),0)::text AS output_tokens,
           COALESCE(SUM(line.raw_cache_tokens),0)::text AS cache_tokens,
           COALESCE(SUM(line.raw_reasoning_tokens),0)::text AS reasoning_tokens,
           COALESCE(SUM(line.raw_input_tokens+line.raw_output_tokens),0)::text AS true_tokens,
           CASE WHEN COUNT(*)=COUNT(line.deducted_quota)
                THEN COALESCE(SUM(line.deducted_quota),0)::text ELSE NULL END AS deducted_quota,
           COUNT(*)=COUNT(line.deducted_quota) AS deducted_quota_complete
      FROM ledger_line line
     WHERE line.enterprise_id=${enterpriseId}::uuid
       AND line.provider_resource_id=${resourceId}::uuid
       AND line.resource_mode='CODING_PLAN'
       AND COALESCE(line.settled_at,line.created_at)>=${start}
       AND COALESCE(line.settled_at,line.created_at)<${end}
       AND (line.subscription_period_id=${periodId}::uuid OR (
         line.subscription_period_id IS NULL AND ${periodId}::uuid=(
           SELECT candidate.id FROM provider_subscription_period candidate
            WHERE candidate.enterprise_id=line.enterprise_id
              AND candidate.provider_resource_id=line.provider_resource_id
              AND candidate.reversed_by_event_id IS NULL
              AND candidate.period_start<=COALESCE(line.settled_at,line.created_at)
              AND candidate.period_end_exclusive>COALESCE(line.settled_at,line.created_at)
            ORDER BY candidate.period_start DESC, candidate.created_at DESC, candidate.id DESC
            LIMIT 1
         )
       ))
  `.execute(db);
  return result.rows[0]!;
}

export async function loadLegacySubscriptionFee(
  db: Kysely<Database>, enterpriseId: string, resourceId: string,
  sourceSnapshotId: string | null, start: Date, end: Date,
): Promise<{ amount: string | null; currency: FinanceCurrency } | null> {
  const result = await sql<{ amount: string | null; currency: FinanceCurrency }>`
    SELECT snapshot.package_cost::text AS amount,
           COALESCE(snapshot.currency, tenant.default_currency)::text AS currency
      FROM provider_resource_operating_snapshot snapshot
      JOIN enterprise tenant ON tenant.id=snapshot.enterprise_id
     WHERE snapshot.enterprise_id=${enterpriseId}::uuid
       AND snapshot.provider_resource_id=${resourceId}::uuid
       AND snapshot.package_cost IS NOT NULL
       AND (snapshot.id=${sourceSnapshotId}::uuid OR (${sourceSnapshotId}::uuid IS NULL
         AND snapshot.effective_from<=${start} AND snapshot.effective_until>=${end}))
     ORDER BY snapshot.collected_at DESC, snapshot.version DESC
     LIMIT 1
  `.execute(db);
  return result.rows[0] ?? null;
}
