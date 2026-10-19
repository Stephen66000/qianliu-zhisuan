import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";

export interface SubscriptionCoverage {
  ledgerLineId: string;
  providerResourceId: string;
  linkedPeriodId: string | null;
  candidatePeriodId: string | null;
  matchCount: number;
  feeKnown: boolean;
  feeRequiredInWindow: boolean;
  lineHash: string;
  nonTargetHash: string;
  periodHash: string | null;
}

/** Unique, active [start,end) coverage; never choose an overlapping period by sorting.
 * Cash evidence mirrors the registered-history reader: an event, a legacy purchase,
 * or a registered CNY snapshot. A period alone is not evidence of a known fee.
 * A carryover starting before the cash window requires no invented payment in this
 * window; its missing historical price remains separate from this window's cash.
 * Hashes are PostgreSQL JSON fingerprints for a fixed, reviewable repair manifest.
 */
export async function loadSubscriptionCoverage(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date, includeFingerprints = false,
): Promise<SubscriptionCoverage[]> {
  const effectiveStart = start < PROVIDER_FINANCE_CUTOVER ? PROVIDER_FINANCE_CUTOVER : start;
  if (effectiveStart >= end) return [];
  const result = await sql<SubscriptionCoverage>`
    WITH periods AS MATERIALIZED (
      SELECT period.*, CASE WHEN ${includeFingerprints} THEN md5(to_jsonb(period)::text) END AS period_hash,
        CASE WHEN period.finance_event_id IS NOT NULL THEN EXISTS (
          SELECT 1 FROM provider_finance_event event
           WHERE event.enterprise_id=period.enterprise_id AND event.id=period.finance_event_id
             AND event.provider_resource_id=period.provider_resource_id
             AND event.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
             AND event.cash_paid_cny IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM provider_finance_event reversal
               WHERE reversal.enterprise_id=event.enterprise_id AND reversal.reversal_of_event_id=event.id)
        ) ELSE (
          EXISTS (SELECT 1 FROM resource_purchase_record purchase
            WHERE purchase.enterprise_id=period.enterprise_id
              AND purchase.provider_resource_id=period.provider_resource_id
              AND purchase.purchase_type='PACKAGE_PURCHASE' AND purchase.currency='CNY'
              AND (purchase.id=period.migration_source_record_id OR
                purchase.service_period_start=(period.period_start AT TIME ZONE 'Asia/Shanghai')::date))
          OR (NOT EXISTS (SELECT 1 FROM resource_purchase_record purchase
            WHERE purchase.enterprise_id=period.enterprise_id
              AND purchase.provider_resource_id=period.provider_resource_id
              AND purchase.purchase_type='PACKAGE_PURCHASE'
              AND (purchase.id=period.migration_source_record_id OR
                purchase.service_period_start=(period.period_start AT TIME ZONE 'Asia/Shanghai')::date))
            AND (SELECT COALESCE(snapshot.currency,tenant.default_currency)='CNY'
              FROM provider_resource_operating_snapshot snapshot
              JOIN enterprise tenant ON tenant.id=snapshot.enterprise_id
             WHERE snapshot.enterprise_id=period.enterprise_id
               AND snapshot.provider_resource_id=period.provider_resource_id
               AND snapshot.package_cost IS NOT NULL
               AND (snapshot.subscription_period_id=period.id OR
                 (snapshot.subscription_period_id IS NULL AND
                   (snapshot.id=period.migration_source_record_id OR
                     (period.migration_source_record_id IS NULL
                       AND snapshot.effective_from<=period.period_start
                       AND snapshot.effective_until>=period.period_end_exclusive))))
             ORDER BY snapshot.collected_at DESC,snapshot.version DESC LIMIT 1))
        ) END AS fee_known
        FROM provider_subscription_period period
       WHERE period.enterprise_id=${enterpriseId}::uuid AND period.reversed_by_event_id IS NULL
         AND period.period_start<${end} AND period.period_end_exclusive>${effectiveStart}
    )
    SELECT line.id AS "ledgerLineId", line.provider_resource_id AS "providerResourceId",
           line.subscription_period_id AS "linkedPeriodId",
           CASE WHEN COUNT(period.id)=1 THEN MIN(period.id::text) END AS "candidatePeriodId",
           COUNT(period.id)::integer AS "matchCount",
           COALESCE(BOOL_AND(period.fee_known),false) AS "feeKnown",
           COALESCE(BOOL_OR(period.period_start>=${start}),false) AS "feeRequiredInWindow",
           CASE WHEN ${includeFingerprints} THEN md5(to_jsonb(line)::text) ELSE '' END AS "lineHash",
           CASE WHEN ${includeFingerprints} THEN md5((to_jsonb(line)-'subscription_period_id')::text) ELSE '' END AS "nonTargetHash",
           CASE WHEN COUNT(period.id)=1 THEN MIN(period.period_hash) END AS "periodHash"
      FROM ledger_line line
      LEFT JOIN periods period ON period.enterprise_id=line.enterprise_id
       AND period.provider_resource_id=line.provider_resource_id
       AND period.period_start<=COALESCE(line.settled_at,line.created_at)
       AND period.period_end_exclusive>COALESCE(line.settled_at,line.created_at)
     WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='CODING_PLAN'
       AND COALESCE(line.settled_at,line.created_at)>=${effectiveStart}
       AND COALESCE(line.settled_at,line.created_at)<${end}
     GROUP BY line.id ORDER BY line.id
  `.execute(db);
  return result.rows;
}

export function subscriptionExpenseGaps(rows: SubscriptionCoverage[]) {
  return [
    { code: "SUBSCRIPTION_PERIOD_MISSING", count: rows.filter((row) => row.matchCount===0 ||
      (row.matchCount===1 && row.linkedPeriodId!==null && row.linkedPeriodId!==row.candidatePeriodId)).length.toString() },
    { code: "SUBSCRIPTION_PERIOD_AMBIGUOUS", count: rows.filter((row) => row.matchCount>1).length.toString() },
    { code: "SUBSCRIPTION_FEE_MISSING", count: rows.filter((row) => row.matchCount===1 && row.feeRequiredInWindow && !row.feeKnown).length.toString() },
  ];
}
