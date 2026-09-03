import { sql, type Kysely, type Transaction } from "kysely";
import { Decimal } from "decimal.js";

import type { Database } from "../kysely.js";
import type {
  FinanceCarryoverCandidate, FinanceConservationReport, FinanceOpeningCandidate, FinancePreflightReport,
  FinancePurchaseCandidate, FinanceUsageBackfillReport,
} from "./provider-finance-cutover-types.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
import { ProviderFinanceRepository } from "./provider-finance-repository.js";

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
    SELECT COUNT(*) FILTER (WHERE resource_mode='API')::text AS api_rows,
           COUNT(*) FILTER (WHERE resource_mode='CODING_PLAN')::text AS plan_rows,
           COUNT(*) FILTER (WHERE resource_mode='API'
             AND (api_cost_status IS NULL OR api_cost_status='UNKNOWN_COST'))::text
             AS unclassified_api,
           COUNT(*) FILTER (WHERE resource_mode='API' AND api_cost IS NOT NULL
             AND api_cost_currency IS NULL
             AND api_cost_status IS DISTINCT FROM 'CONFIRMED_ZERO_NO_UPSTREAM')::text
             AS missing_api_currency,
           COUNT(*) FILTER (WHERE resource_mode='API' AND api_cost_currency IS NOT NULL
             AND billing_rule_snapshot->>'currency' IN ('CNY','USD')
             AND api_cost_currency<>billing_rule_snapshot->>'currency')::text
             AS conflicting_api_currency,
           COUNT(*) FILTER (WHERE settled_at IS NULL)::text AS missing_settled_at,
           COUNT(*) FILTER (WHERE resource_mode='CODING_PLAN'
             AND subscription_period_id IS NULL)::text AS missing_plan_period
      FROM ledger_line
     WHERE enterprise_id=${enterpriseId}::uuid
       AND COALESCE(settled_at,created_at)>=${PROVIDER_FINANCE_CUTOVER}
  `.execute(db);
  return result.rows[0]!;
}

export class ProviderFinanceCutoverRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async buildPreflightReport(enterpriseId: string): Promise<FinancePreflightReport> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const [openingResult, purchaseResult, carryoverResult, usage] = await Promise.all([
        sql<{
          enterprise_id: string; provider_id: string; provider_name: string; resource_id: string;
          resource_name: string; currency: string | null; amount: string | null;
          snapshot_id: string | null; snapshot_at: Date | null; opening_id: string | null;
        }>`
          SELECT resource.enterprise_id, provider.id AS provider_id, provider.name AS provider_name,
                 resource.id AS resource_id, resource.name AS resource_name,
                 account.currency, account.amount,
                 snapshot.id AS snapshot_id, snapshot.collected_at AS snapshot_at,
                 account.opening_id
            FROM provider_resource resource
            JOIN provider ON provider.id=resource.provider_id
             AND provider.enterprise_id=resource.enterprise_id
            LEFT JOIN LATERAL (
              SELECT value.id, value.currency, value.current_balance, value.collected_at
                FROM provider_resource_operating_snapshot value
               WHERE value.enterprise_id=resource.enterprise_id
                 AND value.provider_resource_id=resource.id
                 AND value.collected_at<=${PROVIDER_FINANCE_CUTOVER}
                 AND value.current_balance IS NOT NULL
               ORDER BY value.collected_at DESC, value.version DESC, value.id DESC LIMIT 1
            ) snapshot ON true
            JOIN LATERAL (
              SELECT opening.account_currency AS currency, opening.account_amount::text AS amount,
                     opening.id AS opening_id
                FROM provider_finance_event opening
               WHERE opening.enterprise_id=resource.enterprise_id
                 AND opening.provider_resource_id=resource.id
                 AND opening.event_type='API_OPENING_BALANCE'
              UNION ALL
              SELECT snapshot.currency, snapshot.current_balance::text, NULL::uuid
               WHERE snapshot.currency IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM provider_finance_event opening
                  WHERE opening.enterprise_id=resource.enterprise_id
                    AND opening.provider_resource_id=resource.id
                    AND opening.event_type='API_OPENING_BALANCE'
                    AND opening.account_currency=snapshot.currency
               )
              UNION ALL
              SELECT NULL::varchar, NULL::text, NULL::uuid
               WHERE snapshot.id IS NULL AND NOT EXISTS (
                 SELECT 1 FROM provider_finance_event opening
                  WHERE opening.enterprise_id=resource.enterprise_id
                    AND opening.provider_resource_id=resource.id
                    AND opening.event_type='API_OPENING_BALANCE'
               )
            ) account ON true
           WHERE resource.enterprise_id=${enterpriseId}::uuid
             AND resource.mode='API' AND resource.status<>'DELETED'
           ORDER BY provider.name, resource.name, resource.id, account.currency
        `.execute(trx),
        sql<{
          id: string; provider_resource_id: string; resource_mode: "API" | "CODING_PLAN";
          purchase_type: string; amount: string; currency: string; purchased_at: Date;
          service_period_start: string | null; service_period_end: string | null;
          evidence_ref: string | null; migrated_event_id: string | null;
        }>`
          SELECT purchase.id, purchase.provider_resource_id, resource.mode AS resource_mode,
                 purchase.purchase_type, purchase.amount::text, purchase.currency,
                 purchase.purchased_at, purchase.service_period_start::text,
                 purchase.service_period_end::text, purchase.evidence_ref,
                 migrated.id AS migrated_event_id
            FROM resource_purchase_record purchase
            JOIN provider_resource resource ON resource.enterprise_id=purchase.enterprise_id
             AND resource.id=purchase.provider_resource_id
            LEFT JOIN provider_finance_event migrated
              ON migrated.enterprise_id=purchase.enterprise_id
             AND migrated.provider_resource_id=purchase.provider_resource_id
             AND migrated.external_reference=('legacy-purchase:' || purchase.id::text)
           WHERE purchase.enterprise_id=${enterpriseId}::uuid
             AND purchase.purchased_at>=${PROVIDER_FINANCE_CUTOVER}
           ORDER BY purchase.purchased_at, purchase.created_at, purchase.id
        `.execute(trx),
        sql<{
          resource_id: string; resource_name: string; package_name: string | null;
          effective_from: Date; effective_until: Date; snapshot_id: string;
          prepared_period_id: string | null;
        }>`
          SELECT resource.id AS resource_id, resource.name AS resource_name,
                 snapshot.package_name, snapshot.effective_from, snapshot.effective_until,
                 snapshot.id AS snapshot_id, period.id AS prepared_period_id
            FROM provider_resource resource
            JOIN LATERAL (
              SELECT value.id, value.package_name, value.effective_from, value.effective_until
                FROM provider_resource_operating_snapshot value
               WHERE value.enterprise_id=resource.enterprise_id
                 AND value.provider_resource_id=resource.id
                 AND value.effective_from<=${PROVIDER_FINANCE_CUTOVER}
                 AND value.effective_until>${PROVIDER_FINANCE_CUTOVER}
               ORDER BY value.collected_at DESC, value.version DESC, value.id DESC LIMIT 1
            ) snapshot ON true
            LEFT JOIN provider_subscription_period period
              ON period.enterprise_id=resource.enterprise_id
             AND period.provider_resource_id=resource.id
             AND period.source='MIGRATED_CARRYOVER'
             AND period.migration_source_record_id=snapshot.id
           WHERE resource.enterprise_id=${enterpriseId}::uuid
             AND resource.mode='CODING_PLAN' AND resource.status<>'DELETED'
           ORDER BY resource.name, resource.id
        `.execute(trx),
        loadUsageCounts(trx, enterpriseId),
      ]);
      const openingCandidates: FinanceOpeningCandidate[] = openingResult.rows.map((row) => ({
        enterpriseId: row.enterprise_id, providerId: row.provider_id,
        providerName: row.provider_name, resourceId: row.resource_id,
        resourceName: row.resource_name, currency: row.currency, amount: row.amount,
        snapshotId: row.snapshot_id, snapshotAt: row.snapshot_at?.toISOString() ?? null,
        status: row.opening_id ? "CONFIRMED" : row.snapshot_id ? "CANDIDATE" : "MISSING",
      }));
      const purchaseCandidates: FinancePurchaseCandidate[] = purchaseResult.rows.map((row) => {
        const gaps: string[] = [];
        if (row.currency !== "CNY" && row.currency !== "USD") gaps.push("ACCOUNT_CURRENCY_INVALID");
        // 旧表没有人民币实付，不能用原币金额自动替代。
        gaps.push("CASH_PAID_CNY_MISSING");
        if (row.resource_mode === "CODING_PLAN"
          && (!row.service_period_start || !row.service_period_end)) {
          gaps.push("SUBSCRIPTION_PERIOD_MISSING");
        }
        return {
          id: row.id, resourceId: row.provider_resource_id, resourceMode: row.resource_mode,
          purchaseType: row.purchase_type, amount: row.amount, currency: row.currency,
          purchasedAt: row.purchased_at.toISOString(), servicePeriodStart: row.service_period_start,
          servicePeriodEnd: row.service_period_end, evidenceRef: row.evidence_ref,
          alreadyMigrated: row.migrated_event_id !== null, gaps: row.migrated_event_id ? [] : gaps,
        };
      });
      const carryoverCandidates: FinanceCarryoverCandidate[] = carryoverResult.rows.map((row) => ({
        resourceId: row.resource_id, resourceName: row.resource_name,
        productName: row.package_name, periodStart: row.effective_from.toISOString(),
        periodEndExclusive: row.effective_until.toISOString(), snapshotId: row.snapshot_id,
        alreadyPrepared: row.prepared_period_id !== null,
      }));
      const blockers = [
        { code: "OPENING_BALANCE_UNCONFIRMED",
          count: openingCandidates.filter((item) => item.status !== "CONFIRMED").length },
        { code: "LEGACY_PURCHASE_REQUIRES_REVIEW",
          count: purchaseCandidates.filter((item) => !item.alreadyMigrated && item.gaps.length > 0).length },
        { code: "CARRYOVER_PERIOD_UNPREPARED",
          count: carryoverCandidates.filter((item) => !item.alreadyPrepared).length },
        { code: "API_USAGE_COST_UNCLASSIFIED", count: numericCount(usage.unclassified_api) },
        { code: "API_COST_CURRENCY_MISSING", count: numericCount(usage.missing_api_currency) },
        { code: "API_COST_CURRENCY_CONFLICT", count: numericCount(usage.conflicting_api_currency) },
        { code: "SETTLEMENT_TIME_MISSING", count: numericCount(usage.missing_settled_at) },
        { code: "SUBSCRIPTION_PERIOD_MISSING", count: numericCount(usage.missing_plan_period) },
      ].filter((item) => item.count > 0);
      return {
        enterpriseId, cutover: PROVIDER_FINANCE_CUTOVER.toISOString(),
        generatedAt: new Date().toISOString(), openingCandidates, purchaseCandidates,
        carryoverCandidates, usage: {
          apiRows: numericCount(usage.api_rows), codingPlanRows: numericCount(usage.plan_rows),
          unclassifiedApiRows: numericCount(usage.unclassified_api),
          missingApiCurrencyRows: numericCount(usage.missing_api_currency),
          conflictingApiCurrencyRows: numericCount(usage.conflicting_api_currency),
          missingSettlementTimeRows: numericCount(usage.missing_settled_at),
          missingSubscriptionPeriodRows: numericCount(usage.missing_plan_period),
        }, ready: blockers.length === 0, blockers,
      };
    });
  }

  async backfillUsageFacts(
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

  async buildConservationReport(
    enterpriseId: string, month: string,
  ): Promise<FinanceConservationReport> {
    const [preflight, monthly, countResult, balancePairs] = await Promise.all([
      this.buildPreflightReport(enterpriseId),
      new ProviderFinanceRepository(this.db).getMonthlyFinanceSummary(enterpriseId, month),
      sql<{
        opening_events: string; recharge_events: string; subscription_events: string;
        api_rows: string; priced_api: string; zero_api: string; unknown_api: string;
        plan_rows: string; attributed_plan: string; token_mismatches: string;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
            AND event_type='API_OPENING_BALANCE')::text AS opening_events,
          (SELECT COUNT(*) FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
            AND event_type='API_RECHARGE')::text AS recharge_events,
          (SELECT COUNT(*) FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
            AND event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL'))::text
            AS subscription_events,
          COUNT(*) FILTER (WHERE line.resource_mode='API')::text AS api_rows,
          COUNT(*) FILTER (WHERE line.resource_mode='API'
            AND line.api_cost_status='PRICED_USAGE')::text AS priced_api,
          COUNT(*) FILTER (WHERE line.resource_mode='API'
            AND line.api_cost_status='CONFIRMED_ZERO_NO_UPSTREAM')::text AS zero_api,
          COUNT(*) FILTER (WHERE line.resource_mode='API'
            AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL))::text
            AS unknown_api,
          COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN')::text AS plan_rows,
          COUNT(*) FILTER (WHERE line.resource_mode='CODING_PLAN'
            AND line.subscription_period_id IS NOT NULL)::text AS attributed_plan,
          COUNT(*) FILTER (WHERE usage.id IS NULL
            OR line.raw_input_tokens<>usage.input_tokens
            OR line.raw_output_tokens<>usage.output_tokens
            OR line.raw_cache_tokens<>usage.cache_tokens
            OR line.raw_reasoning_tokens<>usage.reasoning_tokens)::text AS token_mismatches
        FROM ledger_line line
        LEFT JOIN usage_event usage ON usage.enterprise_id=line.enterprise_id
         AND usage.id=line.usage_event_id
       WHERE line.enterprise_id=${enterpriseId}::uuid
         AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
      `.execute(this.db),
      sql<{ provider_resource_id: string; account_currency: "CNY" | "USD" }>`
        SELECT provider_resource_id, account_currency
          FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
           AND event_type='API_OPENING_BALANCE'
         ORDER BY provider_resource_id, account_currency
      `.execute(this.db),
    ]);
    const finance = new ProviderFinanceRepository(this.db);
    const balanceViews = await Promise.all(balancePairs.rows.map(async (pair) => {
      const view = await finance.getCurrentBalance(
        enterpriseId, pair.provider_resource_id, pair.account_currency,
      );
      let formulaMatches: boolean | null = null;
      if (view?.balance !== null && view?.balance !== undefined) {
        const expected = new Decimal(view.components.openingBalance)
          .plus(view.components.openingCorrections).plus(view.components.recharges)
          .plus(view.components.balanceReconciliations).plus(view.components.reversals)
          .minus(view.components.usageDebits).toDecimalPlaces(8).toFixed(8);
        formulaMatches = expected === view.balance;
      }
      return { resourceId: pair.provider_resource_id, currency: pair.account_currency,
        state: view?.state ?? "RESOURCE_MISSING", balance: view?.balance ?? null, formulaMatches };
    }));
    const row = countResult.rows[0]!;
    const counts = {
      openingEvents: numericCount(row.opening_events), rechargeEvents: numericCount(row.recharge_events),
      subscriptionEvents: numericCount(row.subscription_events), apiUsageRows: numericCount(row.api_rows),
      pricedApiRows: numericCount(row.priced_api), confirmedZeroApiRows: numericCount(row.zero_api),
      unknownApiRows: numericCount(row.unknown_api), codingPlanUsageRows: numericCount(row.plan_rows),
      attributedCodingPlanRows: numericCount(row.attributed_plan),
      tokenFactMismatches: numericCount(row.token_mismatches),
    };
    const failures = [
      ...preflight.blockers,
      { code: "MONTHLY_FINANCE_INCOMPLETE", count: monthly.complete ? 0 : 1 },
      { code: "BALANCE_FORMULA_MISMATCH",
        count: balanceViews.filter((item) => item.formulaMatches === false).length },
      { code: "TOKEN_FACT_MISMATCH", count: counts.tokenFactMismatches },
      { code: "API_USAGE_CLASSIFICATION_MISMATCH",
        count: counts.apiUsageRows - counts.pricedApiRows
          - counts.confirmedZeroApiRows - counts.unknownApiRows },
      { code: "CODING_PLAN_ATTRIBUTION_MISMATCH",
        count: counts.codingPlanUsageRows - counts.attributedCodingPlanRows },
    ].filter((item) => item.count > 0);
    return { enterpriseId, month, checkedAt: new Date().toISOString(), counts,
      balances: balanceViews, monthlyComplete: monthly.complete,
      passed: failures.length === 0, failures };
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
