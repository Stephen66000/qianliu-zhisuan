import { sql, type Kysely, type Transaction } from "kysely";

import type { Database } from "../kysely.js";
import type { FinanceUsageBackfillReport } from "./provider-finance-cutover-types.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";

const numericCount = (value: string | number | bigint | undefined): number => Number(value ?? 0);

interface UsageCountsRow {
  api_rows: string;
  plan_rows: string;
  unclassified_api: string;
  missing_api_currency: string;
  conflicting_api_currency: string;
  missing_settled_at: string;
  missing_plan_period: string;
}

async function loadUsageCounts(
  db: Kysely<Database> | Transaction<Database>, enterpriseId: string,
): Promise<UsageCountsRow> {
  const result = await sql<UsageCountsRow>`
    SELECT COUNT(*) FILTER (WHERE line.resource_mode='API')::text AS api_rows,
           COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN')::text AS plan_rows,
           COUNT(*) FILTER (WHERE line.resource_mode='API'
             AND (line.api_cost_status IS NULL OR line.api_cost_status='UNKNOWN_COST')
             AND (resolution.id IS NULL OR resolution.status<>'RESOLVED'))::text
             AS unclassified_api,
           COUNT(*) FILTER (WHERE line.resource_mode='API' AND line.api_cost IS NOT NULL
             AND line.api_cost_currency IS NULL
             AND line.api_cost_status IS DISTINCT FROM 'CONFIRMED_ZERO_NO_UPSTREAM')::text
             AS missing_api_currency,
           COUNT(*) FILTER (WHERE line.resource_mode='API' AND line.api_cost_currency IS NOT NULL
             AND line.billing_rule_snapshot->>'currency' IN ('CNY','USD')
             AND line.api_cost_currency<>line.billing_rule_snapshot->>'currency')::text
             AS conflicting_api_currency,
           COUNT(*) FILTER (WHERE line.settled_at IS NULL)::text AS missing_settled_at,
           COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN'
             AND line.subscription_period_id IS NULL)::text AS missing_plan_period
      FROM ledger_line line
      LEFT JOIN provider_finance_legacy_cost_resolution resolution
        ON resolution.enterprise_id=line.enterprise_id
       AND resolution.id=line.legacy_cost_resolution_id
     WHERE line.enterprise_id=${enterpriseId}::uuid
       AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
  `.execute(db);
  return result.rows[0]!;
}

export class ProviderFinanceUsageBackfill {
  constructor(private readonly db: Kysely<Database>) {}

  async run(
    enterpriseId: string, apply = false,
  ): Promise<FinanceUsageBackfillReport> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      if (!apply) {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const eligible = await this.loadEligibleCounts(trx, enterpriseId);
        const gaps = await this.loadRemainingGaps(trx, enterpriseId);
        return this.backfillReport(enterpriseId, "DRY_RUN", eligible,
          { settlementTime: 0, apiCostCurrency: 0, apiCostStatus: 0, subscriptionPeriod: 0 },
          0, gaps);
      }
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-finance:${enterpriseId}`}, 0))`
        .execute(trx);
      await sql`SET LOCAL lock_timeout='5s'`.execute(trx);
      const eligible = await this.loadEligibleCounts(trx, enterpriseId);
      await sql`
        CREATE TEMP TABLE provider_finance_usage_backfill_before ON COMMIT DROP AS
        SELECT id,
               md5((to_jsonb(line) - 'api_cost_currency' - 'api_cost_status'
                 - 'subscription_period_id' - 'settled_at')::text) AS non_target_hash,
               (settled_at IS NULL) AS settlement_missing,
               (api_cost_currency IS NULL) AS currency_missing,
               (api_cost_status IS NULL) AS status_missing,
               (subscription_period_id IS NULL) AS period_missing
          FROM ledger_line line
         WHERE enterprise_id=${enterpriseId}::uuid
           AND COALESCE(settled_at,created_at)>=${PROVIDER_FINANCE_CUTOVER}
      `.execute(trx);
      await sql`UPDATE ledger_line SET settled_at=created_at
        WHERE enterprise_id=${enterpriseId}::uuid AND settled_at IS NULL
          AND created_at>=${PROVIDER_FINANCE_CUTOVER}`.execute(trx);
      await sql`
        UPDATE ledger_line SET
          api_cost_currency=COALESCE(api_cost_currency, billing_rule_snapshot->>'currency'),
          api_cost_status='PRICED_USAGE'
        WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
          AND settled_at>=${PROVIDER_FINANCE_CUTOVER} AND api_cost_status IS NULL
          AND api_cost IS NOT NULL
          AND billing_rule_snapshot->>'currency' IN ('CNY','USD')
          AND (api_cost_currency IS NULL OR api_cost_currency=billing_rule_snapshot->>'currency')
      `.execute(trx);
      await sql`
        UPDATE ledger_line line SET api_cost_status='CONFIRMED_ZERO_NO_UPSTREAM'
          FROM upstream_attempt attempt
         WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
           AND line.settled_at>=${PROVIDER_FINANCE_CUTOVER} AND line.api_cost_status IS NULL
           AND line.api_cost=0 AND line.api_cost_currency IS NULL AND line.billing_rule_id IS NULL
           AND line.raw_input_tokens=0 AND line.raw_output_tokens=0
           AND line.raw_cache_tokens=0 AND line.raw_reasoning_tokens=0
           AND attempt.enterprise_id=line.enterprise_id AND attempt.id=line.upstream_attempt_id
           AND attempt.first_byte_at IS NULL AND attempt.response_committed=false
           AND attempt.error_classification='DOWNSTREAM_AUTH_OR_QUOTA'
      `.execute(trx);
      await sql`UPDATE ledger_line SET api_cost_status='UNKNOWN_COST'
        WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
          AND settled_at>=${PROVIDER_FINANCE_CUTOVER} AND api_cost_status IS NULL
          AND api_cost IS NULL AND api_cost_currency IS NULL`.execute(trx);
      await sql`UPDATE ledger_line SET api_cost_status='NOT_APPLICABLE'
        WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='CODING_PLAN'
          AND settled_at>=${PROVIDER_FINANCE_CUTOVER} AND api_cost_status IS NULL
          AND api_cost IS NULL AND api_cost_currency IS NULL`.execute(trx);
      await sql`
        UPDATE ledger_line line SET subscription_period_id=(
          SELECT period.id FROM provider_subscription_period period
           WHERE period.enterprise_id=line.enterprise_id
             AND period.provider_resource_id=line.provider_resource_id
             AND period.reversed_by_event_id IS NULL
             AND period.period_start<=line.settled_at
             AND period.period_end_exclusive>line.settled_at
           ORDER BY period.period_start DESC, period.created_at DESC, period.id DESC LIMIT 1
        )
        WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='CODING_PLAN'
          AND line.settled_at>=${PROVIDER_FINANCE_CUTOVER}
          AND line.subscription_period_id IS NULL
          AND EXISTS (
            SELECT 1 FROM provider_subscription_period period
             WHERE period.enterprise_id=line.enterprise_id
               AND period.provider_resource_id=line.provider_resource_id
               AND period.reversed_by_event_id IS NULL
               AND period.period_start<=line.settled_at
               AND period.period_end_exclusive>line.settled_at
          )
      `.execute(trx);
      const changedResult = await sql<{
        settlement_time: string; currency: string; status: string; period: string; hash_mismatch: string;
      }>`
        SELECT COUNT(*) FILTER (WHERE before.settlement_missing AND line.settled_at IS NOT NULL)::text
                 AS settlement_time,
               COUNT(*) FILTER (WHERE before.currency_missing AND line.api_cost_currency IS NOT NULL)::text
                 AS currency,
               COUNT(*) FILTER (WHERE before.status_missing AND line.api_cost_status IS NOT NULL)::text
                 AS status,
               COUNT(*) FILTER (WHERE before.period_missing AND line.subscription_period_id IS NOT NULL)::text
                 AS period,
               COUNT(*) FILTER (WHERE before.non_target_hash <>
                 md5((to_jsonb(line) - 'api_cost_currency' - 'api_cost_status'
                   - 'subscription_period_id' - 'settled_at')::text))::text AS hash_mismatch
          FROM provider_finance_usage_backfill_before before
          JOIN ledger_line line ON line.id=before.id
      `.execute(trx);
      const changed = changedResult.rows[0]!;
      return this.backfillReport(enterpriseId, "APPLY", eligible, {
        settlementTime: numericCount(changed.settlement_time),
        apiCostCurrency: numericCount(changed.currency),
        apiCostStatus: numericCount(changed.status),
        subscriptionPeriod: numericCount(changed.period),
      }, numericCount(changed.hash_mismatch), await this.loadRemainingGaps(trx, enterpriseId));
    });
  }

  private async loadEligibleCounts(trx: Transaction<Database>, enterpriseId: string) {
    const result = await sql<{
      settlement_time: string; priced_api: string; zero_api: string; unknown_api: string;
      plan_status: string; plan_period: string;
    }>`
      SELECT COUNT(*) FILTER (WHERE line.settled_at IS NULL)::text AS settlement_time,
             COUNT(*) FILTER (WHERE line.resource_mode='API' AND line.api_cost_status IS NULL
               AND line.api_cost IS NOT NULL AND line.billing_rule_snapshot->>'currency' IN ('CNY','USD')
               AND (line.api_cost_currency IS NULL
                 OR line.api_cost_currency=line.billing_rule_snapshot->>'currency'))::text AS priced_api,
             COUNT(*) FILTER (WHERE line.resource_mode='API' AND line.api_cost_status IS NULL
               AND line.api_cost=0 AND line.api_cost_currency IS NULL AND line.billing_rule_id IS NULL
               AND line.raw_input_tokens=0 AND line.raw_output_tokens=0
               AND line.raw_cache_tokens=0 AND line.raw_reasoning_tokens=0
               AND attempt.first_byte_at IS NULL AND attempt.response_committed=false
               AND attempt.error_classification='DOWNSTREAM_AUTH_OR_QUOTA')::text AS zero_api,
             COUNT(*) FILTER (WHERE line.resource_mode='API' AND line.api_cost_status IS NULL
               AND line.api_cost IS NULL AND line.api_cost_currency IS NULL)::text AS unknown_api,
             COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN' AND line.api_cost_status IS NULL
               AND line.api_cost IS NULL AND line.api_cost_currency IS NULL)::text AS plan_status,
             COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN'
               AND line.subscription_period_id IS NULL AND EXISTS (
                 SELECT 1 FROM provider_subscription_period period
                  WHERE period.enterprise_id=line.enterprise_id
                    AND period.provider_resource_id=line.provider_resource_id
                    AND period.reversed_by_event_id IS NULL
                    AND period.period_start<=COALESCE(line.settled_at,line.created_at)
                    AND period.period_end_exclusive>COALESCE(line.settled_at,line.created_at)
               ))::text AS plan_period
        FROM ledger_line line
        LEFT JOIN upstream_attempt attempt ON attempt.enterprise_id=line.enterprise_id
         AND attempt.id=line.upstream_attempt_id
       WHERE line.enterprise_id=${enterpriseId}::uuid
         AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
    `.execute(trx);
    const row = result.rows[0]!;
    return { settlementTime: numericCount(row.settlement_time), pricedApi: numericCount(row.priced_api),
      confirmedZeroApi: numericCount(row.zero_api), unknownApi: numericCount(row.unknown_api),
      codingPlanStatus: numericCount(row.plan_status), codingPlanPeriod: numericCount(row.plan_period) };
  }

  private async loadRemainingGaps(trx: Transaction<Database>, enterpriseId: string) {
    const usage = await loadUsageCounts(trx, enterpriseId);
    return [
      { code: "API_USAGE_COST_UNCLASSIFIED", count: numericCount(usage.unclassified_api) },
      { code: "API_COST_CURRENCY_MISSING", count: numericCount(usage.missing_api_currency) },
      { code: "API_COST_CURRENCY_CONFLICT", count: numericCount(usage.conflicting_api_currency) },
      { code: "SETTLEMENT_TIME_MISSING", count: numericCount(usage.missing_settled_at) },
      { code: "SUBSCRIPTION_PERIOD_MISSING", count: numericCount(usage.missing_plan_period) },
    ].filter((item) => item.count > 0);
  }

  private backfillReport(
    enterpriseId: string, mode: "DRY_RUN" | "APPLY",
    eligible: FinanceUsageBackfillReport["eligible"],
    changed: FinanceUsageBackfillReport["changed"], nonTargetHashMismatches: number,
    remainingGaps: FinanceUsageBackfillReport["remainingGaps"],
  ): FinanceUsageBackfillReport {
    return { enterpriseId, mode, cutover: PROVIDER_FINANCE_CUTOVER.toISOString(), eligible,
      changed, nonTargetHashMismatches, remainingGaps };
  }
}
