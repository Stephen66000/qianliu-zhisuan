import { sql, type Kysely, type Transaction } from "kysely";
import { Decimal } from "decimal.js";

import type { Database } from "../kysely.js";
import type {
  FinanceCarryoverCandidate, FinanceConservationReport, FinanceOpeningCandidate, FinancePreflightReport,
  FinancePurchaseCandidate, FinanceUsageBackfillReport, LegacyApiCostResolutionInput,
  LegacyApiCostResolutionView,
} from "./provider-finance-cutover-types.js";
import {
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceError,
} from "./provider-finance-types.js";
import { ProviderFinanceRepository } from "./provider-finance-repository.js";
import { ProviderFinanceUsageBackfill } from "./provider-finance-usage-backfill.js";
import { resolveLegacyApiCostGap } from "./provider-finance-legacy-resolution.js";
import { markAllocationDirty } from "./project-allocation-common.js";

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

export class ProviderFinanceCutoverRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async buildPreflightReport(enterpriseId: string): Promise<FinancePreflightReport> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadPreflightReport(trx, enterpriseId);
    });
  }

  private async loadPreflightReport(
    trx: Transaction<Database>, enterpriseId: string,
  ): Promise<FinancePreflightReport> {
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
  }

  async backfillUsageFacts(
    enterpriseId: string, apply = false,
  ): Promise<FinanceUsageBackfillReport> {
    return new ProviderFinanceUsageBackfill(this.db).run(enterpriseId, apply);
  }

  async resolveLegacyApiCostGap(
    input: LegacyApiCostResolutionInput,
  ): Promise<LegacyApiCostResolutionView> {
    return resolveLegacyApiCostGap(this.db, input);
  }

  async buildConservationReport(
    enterpriseId: string, month: string,
  ): Promise<FinanceConservationReport> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadConservationReport(trx, enterpriseId, month);
    });
  }

  async activateStrictWrites(
    enterpriseId: string, adminId: string, month: string,
  ): Promise<{ activatedAt: string; conservation: FinanceConservationReport; replayed: boolean }> {
    return this.db.transaction().setIsolationLevel("serializable").execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${`provider-finance-activation:${enterpriseId}`}::text, 0::bigint))`.execute(trx);
      const existing = await sql<{ strict_writes_enabled: boolean; activated_at: Date | null }>`
        SELECT strict_writes_enabled, activated_at
          FROM provider_finance_runtime_state
         WHERE enterprise_id=${enterpriseId}::uuid FOR UPDATE`.execute(trx);
      const current = existing.rows[0];
      if (current?.strict_writes_enabled && current.activated_at) {
        const conservation = await this.loadConservationReport(trx, enterpriseId, month);
        return { activatedAt: current.activated_at.toISOString(), conservation, replayed: true };
      }
      const conservation = await this.loadConservationReport(trx, enterpriseId, month);
      if (!conservation.passed) {
        throw new ProviderFinanceError("CONFLICT", "守恒检查未通过，不能启用严格资金写合同",
          conservation.failures);
      }
      const activatedAt = new Date();
      await sql`
        INSERT INTO provider_finance_runtime_state
          (enterprise_id, strict_writes_enabled, activated_at,
           activated_by_admin_user_id, updated_at)
        VALUES (${enterpriseId}::uuid, true, ${activatedAt}, ${adminId}::uuid, ${activatedAt})
        ON CONFLICT (enterprise_id) DO UPDATE SET
          strict_writes_enabled=true,
          activated_at=EXCLUDED.activated_at,
          activated_by_admin_user_id=EXCLUDED.activated_by_admin_user_id,
          updated_at=EXCLUDED.updated_at
      `.execute(trx);
      await trx.insertInto("operation_log").values({ actor_source: "ADMIN",
        enterprise_id: enterpriseId, admin_user_id: adminId,
        action: "provider_finance.strict_writes.activate",
        target_type: "provider_finance_runtime_state", target_id: enterpriseId,
        result: "SUCCESS", failure_reason: null,
        change_summary: JSON.stringify({ month, activated_at: activatedAt.toISOString(),
          conservation_checked_at: conservation.checkedAt }) as unknown as Record<string, unknown>,
      }).execute();
      // 口径切换改变 account_at（settled_at/created_at）与行级套餐成本口径，属归集输入事实：
      // 与标志位翻转**同事务**推脏。启用模型是"起始月登记一次、后续月按 period_month<= 继承"，
      // project_allocation_period 只有起始行——因此按**实际存在归集状态的账期**枚举：
      // 已有批次（project_allocation_run）∪ 已有脏行（project_allocation_dirty）∪ 登记行，
      // 天然有界，且不会漏掉起始月之后已发布的账期（80 终审 P1-1）。
      const { rows: affectedMonths } = await sql<{ month: string }>`
        SELECT to_char(period_month, 'YYYY-MM') AS month FROM (
          SELECT period_month FROM project_allocation_run WHERE enterprise_id = ${enterpriseId}::uuid
          UNION
          SELECT period_month FROM project_allocation_dirty WHERE enterprise_id = ${enterpriseId}::uuid
          UNION
          SELECT period_month FROM project_allocation_period WHERE enterprise_id = ${enterpriseId}::uuid
        ) months`.execute(trx);
      await markAllocationDirty(trx, enterpriseId, affectedMonths.map((row) => row.month));
      return { activatedAt: activatedAt.toISOString(), conservation, replayed: false };
    });
  }

  private async loadConservationReport(
    trx: Transaction<Database>, enterpriseId: string, month: string,
  ): Promise<FinanceConservationReport> {
    const checkedAt = new Date();
    const finance = new ProviderFinanceRepository(this.db);
    const [preflight, monthly, countResult, balancePairs] = await Promise.all([
      this.loadPreflightReport(trx, enterpriseId),
      finance.loadMonthlyFinanceSummary(trx, enterpriseId, month),
      sql<{
        opening_events: string; recharge_events: string; subscription_events: string;
        api_rows: string; priced_api: string; zero_api: string; unknown_api: string;
        resolved_legacy_api: string; plan_rows: string; attributed_plan: string;
        token_mismatches: string;
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
            AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL)
            AND (resolution.id IS NULL OR resolution.status<>'RESOLVED'))::text
            AS unknown_api,
          COUNT(*) FILTER (WHERE line.resource_mode='API'
            AND line.api_cost_status='UNKNOWN_COST'
            AND resolution.status='RESOLVED')::text AS resolved_legacy_api,
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
        LEFT JOIN provider_finance_legacy_cost_resolution resolution
          ON resolution.enterprise_id=line.enterprise_id
         AND resolution.id=line.legacy_cost_resolution_id
       WHERE line.enterprise_id=${enterpriseId}::uuid
         AND COALESCE(line.settled_at,line.created_at)>=${PROVIDER_FINANCE_CUTOVER}
      `.execute(trx),
      sql<{ provider_resource_id: string; account_currency: "CNY" | "USD" }>`
        SELECT provider_resource_id, account_currency
          FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
           AND event_type='API_OPENING_BALANCE'
         ORDER BY provider_resource_id, account_currency
      `.execute(trx),
    ]);
    const balanceViews = await Promise.all(balancePairs.rows.map(async (pair) => {
      const view = await finance.loadCurrentBalanceSnapshot(
        trx, enterpriseId, pair.provider_resource_id, pair.account_currency, checkedAt,
      );
      let formulaMatches: boolean | null = null;
      if (view?.balance !== null && view?.balance !== undefined) {
        const expected = new Decimal(view.components.openingBalance)
          .plus(view.components.openingCorrections).plus(view.components.recharges)
          .plus(view.components.balanceReconciliations)
          .plus(view.components.legacyCostAdjustments).plus(view.components.reversals)
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
      resolvedLegacyApiRows: numericCount(row.resolved_legacy_api),
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
          - counts.confirmedZeroApiRows - counts.unknownApiRows
          - counts.resolvedLegacyApiRows },
      { code: "CODING_PLAN_ATTRIBUTION_MISMATCH",
        count: counts.codingPlanUsageRows - counts.attributedCodingPlanRows },
    ].filter((item) => item.count > 0);
    return { enterpriseId, month, checkedAt: checkedAt.toISOString(), counts,
      balances: balanceViews, monthlyComplete: monthly.complete,
      passed: failures.length === 0, failures };
  }




}
