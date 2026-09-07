import { operatingConsumptionFilter } from "./operating-consumption-filter.js";
import { registeredSubscriptionHistory } from "./provider-finance-registered-history.js";
import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { Money, eventView, money } from "./provider-finance-core.js";
import { ProviderFinanceEventRepository } from "./provider-finance-events.js";
import {
  PROVIDER_FINANCE_CUTOVER,
  ProviderFinanceError,
  type FinanceBalanceView,
  type FinanceCurrency,
  type FinanceEventType,
  type FinanceEventView,
} from "./provider-finance-types.js";

export class ProviderFinanceBalanceRepository extends ProviderFinanceEventRepository {
  async getCurrentBalance(
    enterpriseId: string, resourceId: string, currency: FinanceCurrency, asOf?: Date,
  ): Promise<FinanceBalanceView | null> {
    return this.db.transaction().setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(trx);
        const effectiveAsOf = asOf ?? new Date();
        if (effectiveAsOf.getTime() > Date.now()) {
          throw new ProviderFinanceError("INVALID_REQUEST", "余额截止时间不能晚于当前时间");
        }
        return this.loadCurrentBalanceSnapshot(trx, enterpriseId, resourceId, currency, effectiveAsOf);
      });
  }

  /** @internal Reuses a caller-owned repeatable-read snapshot for atomic reports. */
  async loadCurrentBalanceSnapshot(
    trx: Transaction<Database>, enterpriseId: string, resourceId: string,
    currency: FinanceCurrency, asOf: Date,
  ): Promise<FinanceBalanceView | null> {
      const resource = await trx.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
        .where("mode", "=", "API").where("status", "<>", "DELETED").executeTakeFirst();
      if (!resource) return null;
      const empty = {
        openingBalance: "0.00000000", openingCorrections: "0.00000000",
        recharges: "0.00000000", usageDebits: "0.00000000",
        balanceReconciliations: "0.00000000", legacyCostAdjustments: "0.00000000",
        reversals: "0.00000000",
      };
      if (asOf < PROVIDER_FINANCE_CUTOVER) return {
        providerResourceId: resourceId, currency, asOf: asOf.toISOString(),
        state: "LEGACY_ARCHIVED", balance: null, components: empty,
        factWatermark: { latestFinanceEventId: null, latestFinanceOccurredAt: null,
          latestLedgerLineId: null, latestSettledAt: null },
        reconciliationCaseId: null, gaps: [],
      };
      const [events, usage, unknown, openCase] = await Promise.all([
        sql<{ opening: string; corrections: string; recharges: string; reconciliations: string;
          legacy_costs: string;
          reversals: string; opening_count: string; latest_id: string | null; latest_at: Date | null }>`
          SELECT COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE'),0)::text AS opening,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_OPENING_BALANCE_CORRECTION'),0)::text AS corrections,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_RECHARGE'),0)::text AS recharges,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_BALANCE_RECONCILIATION'),0)::text AS reconciliations,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='API_LEGACY_COST_ADJUSTMENT'),0)::text AS legacy_costs,
                 COALESCE(SUM(account_amount) FILTER (WHERE event_type='REVERSAL'),0)::text AS reversals,
                 COUNT(*) FILTER (WHERE event_type='API_OPENING_BALANCE')::text AS opening_count,
                 (ARRAY_AGG(id ORDER BY occurred_at DESC, created_at DESC, id DESC))[1] AS latest_id,
                 MAX(occurred_at) AS latest_at
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND provider_resource_id=${resourceId}::uuid AND account_currency=${currency}
             AND occurred_at <= ${asOf}`.execute(trx),
        sql<{ amount: string; latest_id: string | null; latest_at: Date | null }>`
          SELECT COALESCE(SUM(api_cost) FILTER (
                   WHERE api_cost_status='PRICED_USAGE' AND api_cost_currency=${currency}
                 ),0)::text AS amount,
                 (ARRAY_AGG(id ORDER BY COALESCE(settled_at,created_at) DESC,
                   created_at DESC, id DESC))[1] AS latest_id,
                 MAX(COALESCE(settled_at,created_at)) AS latest_at
            FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
             AND provider_resource_id=${resourceId}::uuid AND resource_mode='API'
             AND COALESCE(settled_at,created_at) >= ${PROVIDER_FINANCE_CUTOVER}
             AND COALESCE(settled_at,created_at) <= ${asOf}`.execute(trx),
        sql<{ id: string; ai_request_id: string }>`SELECT line.id, line.ai_request_id
          FROM ledger_line line
          LEFT JOIN provider_finance_legacy_cost_resolution resolution
            ON resolution.enterprise_id=line.enterprise_id
           AND resolution.id=line.legacy_cost_resolution_id
          WHERE line.enterprise_id=${enterpriseId}::uuid
            AND line.provider_resource_id=${resourceId}::uuid
            AND line.resource_mode='API'
            AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL)
           AND ${operatingConsumptionFilter("line")}
            AND COALESCE(line.settled_at, line.created_at) >= ${PROVIDER_FINANCE_CUTOVER}
            AND COALESCE(line.settled_at, line.created_at) <= ${asOf}
            AND (resolution.id IS NULL OR resolution.status<>'RESOLVED'
              OR resolution.window_end_inclusive>${asOf})
          ORDER BY COALESCE(line.settled_at, line.created_at), line.id LIMIT 100`.execute(trx),
        trx.selectFrom("provider_finance_reconciliation_case").select("id")
          .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId)
          .where("account_currency", "=", currency).where("status", "=", "OPEN")
          .executeTakeFirst(),
      ]);
      const e = events.rows[0]!; const u = usage.rows[0]!;
      const components = { openingBalance: money(e.opening), openingCorrections: money(e.corrections),
        recharges: money(e.recharges), usageDebits: money(u.amount),
        balanceReconciliations: money(e.reconciliations),
        legacyCostAdjustments: money(e.legacy_costs), reversals: money(e.reversals) };
      const base = { providerResourceId: resourceId, currency, asOf: asOf.toISOString(), components,
        factWatermark: { latestFinanceEventId: e.latest_id,
          latestFinanceOccurredAt: e.latest_at?.toISOString() ?? null,
          latestLedgerLineId: u.latest_id, latestSettledAt: u.latest_at?.toISOString() ?? null },
        reconciliationCaseId: openCase?.id ?? null };
      if (Number(e.opening_count) === 0) return { ...base, state: "MISSING_OPENING_BALANCE", balance: null, gaps: [] };
      if (unknown.rows.length > 0) return { ...base, state: "INCOMPLETE_USAGE_COST", balance: null,
        gaps: unknown.rows.map((row) => ({ code: "API_USAGE_COST_UNKNOWN", requestId: row.ai_request_id, ledgerLineId: row.id })) };
      const balance = new Money(e.opening).plus(e.corrections).plus(e.recharges)
        .plus(e.reconciliations).plus(e.legacy_costs).plus(e.reversals).minus(u.amount);
      return { ...base, state: balance.isNegative() ? "NEGATIVE_RECONCILIATION_REQUIRED" : "NORMAL",
        balance: money(balance), gaps: [] };
  }

  async listFinanceEvents(
    enterpriseId: string,
    resourceId: string,
    input: { from?: Date; to?: Date; eventType?: FinanceEventType; limit: number; offset: number },
  ): Promise<{ items: FinanceEventView[]; total: number } | null> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const resource = await trx.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
        .where("status", "<>", "DELETED").executeTakeFirst();
      if (!resource) return null;
      const rows = await trx.selectFrom("provider_finance_event").selectAll()
        .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId).execute();
      const registered = await registeredSubscriptionHistory(trx, enterpriseId);
      const items = [...rows.map(eventView), ...registered.filter((row) => row.providerResourceId === resourceId)]
        .filter((row) => (!input.from || new Date(row.occurredAt) >= input.from)
          && (!input.to || new Date(row.occurredAt) < input.to) && (!input.eventType || row.eventType === input.eventType))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return { items: items.slice(input.offset, input.offset + input.limit), total: items.length };
    });
  }

}
