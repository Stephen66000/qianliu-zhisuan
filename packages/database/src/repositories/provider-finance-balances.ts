import { registeredSubscriptionHistory } from "./provider-finance-registered-history.js";
import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { balanceAmount, isBalanceNegative } from "@qianliu/domain";
import { eventView } from "./provider-finance-core.js";
import {
  loadBalanceFactTotals,
  loadOpenReconciliationCaseId,
  loadUnknownCostRows,
  toBalanceComponents,
} from "./provider-finance-balance-facts.js";
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
      const [totals, unknown, reconciliationCaseId] = await Promise.all([
        loadBalanceFactTotals(trx, {
          enterpriseId, resourceId, currency,
          eventsFrom: null, eventsTo: asOf,
          ledgerFrom: PROVIDER_FINANCE_CUTOVER, ledgerTo: asOf,
        }),
        loadUnknownCostRows(trx, { enterpriseId, resourceId, asOf }),
        loadOpenReconciliationCaseId(trx, { enterpriseId, resourceId, currency }),
      ]);
      // 分量映射与求和都来自共享实现；本处不得再书写符号或求和顺序。
      const components = toBalanceComponents(totals);
      const base = { providerResourceId: resourceId, currency, asOf: asOf.toISOString(), components,
        factWatermark: { latestFinanceEventId: totals.latestFinanceEventId,
          latestFinanceOccurredAt: totals.latestFinanceOccurredAt?.toISOString() ?? null,
          latestLedgerLineId: totals.latestLedgerLineId,
          latestSettledAt: totals.latestSettledAt?.toISOString() ?? null },
        reconciliationCaseId };
      if (totals.openingCount === 0) {
        return { ...base, state: "MISSING_OPENING_BALANCE", balance: null, gaps: [] };
      }
      if (unknown.length > 0) return { ...base, state: "INCOMPLETE_USAGE_COST", balance: null,
        gaps: unknown.map((row) => ({ code: "API_USAGE_COST_UNKNOWN", requestId: row.ai_request_id,
          ledgerLineId: row.id })) };
      return { ...base, state: isBalanceNegative(components)
          ? "NEGATIVE_RECONCILIATION_REQUIRED" : "NORMAL",
        balance: balanceAmount(components), gaps: [] };
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
