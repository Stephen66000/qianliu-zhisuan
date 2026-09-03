import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { operatingBillMonthRange } from "./operating-bill-month.js";
import { Money, money } from "./provider-finance-core.js";
import { ProviderFinanceReconciliationRepository } from "./provider-finance-reconciliation.js";
import type {
  FinanceCurrency,
  MonthlyFinanceSummary,
  ResourceFinanceView,
} from "./provider-finance-types.js";

export class ProviderFinanceRepository extends ProviderFinanceReconciliationRepository {
  async getMonthlyFinanceSummary(
    enterpriseId: string, month: string,
  ): Promise<MonthlyFinanceSummary> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadMonthlyFinanceSummary(trx, enterpriseId, month);
    });
  }

  async listResourceFinanceViews(
    enterpriseId: string, month: string, asOf = new Date(),
  ): Promise<ResourceFinanceView[]> {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return this.loadResourceFinanceViews(trx, enterpriseId, month, asOf);
    });
  }

  /** @internal Reuses the operating-bill close transaction snapshot. */
  async loadResourceFinanceViews(
    trx: Transaction<Database>, enterpriseId: string, month: string, asOf: Date,
  ): Promise<ResourceFinanceView[]> {
      const { start, end } = operatingBillMonthRange(month);
      const [resources, accountKeys, apiCosts, recharges, planCosts, periods] = await Promise.all([
        trx.selectFrom("provider_resource").select(["id", "mode"])
          .where("enterprise_id", "=", enterpriseId).where("status", "<>", "DELETED").execute(),
        sql<{ provider_resource_id: string; currency: FinanceCurrency }>`
          SELECT DISTINCT provider_resource_id, currency FROM (
            SELECT provider_resource_id, account_currency AS currency
              FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
               AND event_type='API_OPENING_BALANCE'
            UNION
            SELECT provider_resource_id, api_cost_currency AS currency
              FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
               AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
               AND api_cost_currency IS NOT NULL AND settled_at>=${start} AND settled_at<${end}
          ) account ORDER BY provider_resource_id, currency`.execute(trx),
        sql<{ provider_resource_id: string; currency: FinanceCurrency; amount: string }>`
          SELECT provider_resource_id, currency, COALESCE(SUM(amount),0)::text AS amount FROM (
            SELECT provider_resource_id, api_cost_currency AS currency, api_cost AS amount
              FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
               AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
               AND settled_at>=${start} AND settled_at<${end}
            UNION ALL
            SELECT provider_resource_id, account_currency, -account_amount
              FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
               AND event_type='API_LEGACY_COST_ADJUSTMENT'
               AND occurred_at>=${start} AND occurred_at<${end}
          ) cost GROUP BY provider_resource_id, currency`.execute(trx),
        sql<{ provider_resource_id: string; currency: FinanceCurrency; amount: string }>`
          SELECT provider_resource_id, account_currency AS currency,
                 COALESCE(SUM(account_amount),0)::text AS amount
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND event_type IN ('API_RECHARGE','REVERSAL')
             AND occurred_at>=${start} AND occurred_at<${end}
           GROUP BY provider_resource_id, account_currency`.execute(trx),
        sql<{ provider_resource_id: string; cash_cny: string }>`
          SELECT event.provider_resource_id, COALESCE(SUM(event.cash_paid_cny),0)::text AS cash_cny
            FROM provider_finance_event event
            JOIN provider_resource resource ON resource.enterprise_id=event.enterprise_id
             AND resource.id=event.provider_resource_id AND resource.mode='CODING_PLAN'
           WHERE event.enterprise_id=${enterpriseId}::uuid
             AND event.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
             AND event.occurred_at>=${start} AND event.occurred_at<${end}
           GROUP BY event.provider_resource_id`.execute(trx),
        sql<{ id: string; provider_resource_id: string; product_name: string;
          period_start: Date; period_end_exclusive: Date; true_tokens: string;
          request_count: string }>`
          SELECT DISTINCT ON (period.provider_resource_id)
                 period.id, period.provider_resource_id, period.product_name,
                 period.period_start, period.period_end_exclusive,
                 COALESCE(usage.true_tokens,0)::text AS true_tokens,
                 COALESCE(usage.request_count,0)::text AS request_count
            FROM provider_subscription_period period
            LEFT JOIN LATERAL (
              SELECT SUM(line.raw_input_tokens+line.raw_output_tokens) AS true_tokens,
                     COUNT(DISTINCT line.ai_request_id) AS request_count
                FROM ledger_line line WHERE line.enterprise_id=period.enterprise_id
                 AND line.subscription_period_id=period.id
            ) usage ON true
           WHERE period.enterprise_id=${enterpriseId}::uuid
             AND period.reversed_by_event_id IS NULL
             AND period.period_start<=${asOf} AND period.period_end_exclusive>${asOf}
           ORDER BY period.provider_resource_id, period.period_start DESC,
                    period.created_at DESC, period.id DESC`.execute(trx),
      ]);
      const key = (resourceId: string, currency: string) => `${resourceId}:${currency}`;
      const costs = new Map(apiCosts.rows.map((row) => [key(row.provider_resource_id, row.currency), row.amount]));
      const recharge = new Map(recharges.rows.map((row) => [key(row.provider_resource_id, row.currency), row.amount]));
      const planCash = new Map(planCosts.rows.map((row) => [row.provider_resource_id, row.cash_cny]));
      const currentPeriods = new Map(periods.rows.map((row) => [row.provider_resource_id, row]));
      const balances = await Promise.all(accountKeys.rows.map(async (account) => ({
        account,
        balance: await this.loadCurrentBalanceSnapshot(
          trx, enterpriseId, account.provider_resource_id, account.currency, asOf,
        ),
        opening: await this.loadCurrentBalanceSnapshot(
          trx, enterpriseId, account.provider_resource_id, account.currency, start,
        ),
      })));
      const accountsByResource = new Map<string, ResourceFinanceView["accounts"]>();
      for (const item of balances) {
        const list = accountsByResource.get(item.account.provider_resource_id) ?? [];
        list.push({ currency: item.account.currency,
          balanceState: item.balance?.state ?? "MISSING_OPENING_BALANCE",
          balance: item.balance?.balance ?? null,
          monthOpeningState: item.opening?.state ?? "MISSING_OPENING_BALANCE",
          monthOpeningBalance: item.opening?.balance ?? null,
          monthlyRecharge: money(recharge.get(key(item.account.provider_resource_id,
            item.account.currency)) ?? 0),
          monthlyApiCost: money(costs.get(key(item.account.provider_resource_id,
            item.account.currency)) ?? 0) });
        accountsByResource.set(item.account.provider_resource_id, list);
      }
      return resources.map((resource) => {
        const period = currentPeriods.get(resource.id);
        return { resourceId: resource.id, mode: resource.mode,
          accounts: accountsByResource.get(resource.id) ?? [],
          monthlyPlanCashCny: money(planCash.get(resource.id) ?? 0),
          currentPeriod: period ? { id: period.id, productName: period.product_name,
            periodStart: period.period_start.toISOString(),
            periodEndExclusive: period.period_end_exclusive.toISOString(),
            trueTokens: period.true_tokens, requestCount: period.request_count } : null };
      });
  }

  /** @internal Reuses a caller-owned repeatable-read snapshot for cutover conservation. */
  async loadMonthlyFinanceSummary(
    trx: Transaction<Database>, enterpriseId: string, month: string,
  ): Promise<MonthlyFinanceSummary> {
    const { start, end } = operatingBillMonthRange(month);
    const [cash, eventAmounts, apiCosts, gapResult] = await Promise.all([
      sql<{ amount: string }>`SELECT COALESCE(SUM(cash_paid_cny),0)::text AS amount
        FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
          AND occurred_at>=${start} AND occurred_at<${end}`.execute(trx),
      sql<{ mode: "API" | "CODING_PLAN"; currency: FinanceCurrency; amount: string;
        cash_cny: string }>`
        SELECT pr.mode, event.account_currency AS currency,
               COALESCE(SUM(event.account_amount),0)::text AS amount,
               COALESCE(SUM(event.cash_paid_cny),0)::text AS cash_cny
          FROM provider_finance_event event
          JOIN provider_resource pr ON pr.id=event.provider_resource_id
           AND pr.enterprise_id=event.enterprise_id
         WHERE event.enterprise_id=${enterpriseId}::uuid
           AND event.occurred_at>=${start} AND event.occurred_at<${end}
           AND (event.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
             OR event.event_type='REVERSAL')
         GROUP BY pr.mode, event.account_currency ORDER BY pr.mode, event.account_currency`.execute(trx),
      sql<{ currency: FinanceCurrency; amount: string }>`
        SELECT currency, COALESCE(SUM(amount),0)::text AS amount FROM (
          SELECT api_cost_currency AS currency, api_cost AS amount
            FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
             AND resource_mode='API' AND api_cost_status='PRICED_USAGE'
             AND settled_at>=${start} AND settled_at<${end}
          UNION ALL
          SELECT account_currency AS currency, -account_amount AS amount
            FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
             AND event_type='API_LEGACY_COST_ADJUSTMENT'
             AND occurred_at>=${start} AND occurred_at<${end}
        ) cost
        GROUP BY currency ORDER BY currency`.execute(trx),
      sql<{ code: string; count: string }>`
        SELECT 'API_USAGE_COST_UNKNOWN' AS code, COUNT(*)::text AS count
          FROM ledger_line line
          LEFT JOIN provider_finance_legacy_cost_resolution resolution
            ON resolution.enterprise_id=line.enterprise_id
           AND resolution.id=line.legacy_cost_resolution_id
         WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
           AND (line.api_cost_status='UNKNOWN_COST' OR line.api_cost_status IS NULL)
           AND COALESCE(line.settled_at, line.created_at)>=${start}
           AND COALESCE(line.settled_at, line.created_at)<${end}
           AND (resolution.id IS NULL OR resolution.status<>'RESOLVED')
        UNION ALL
        SELECT 'API_COST_CURRENCY_MISSING', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
           AND api_cost IS NOT NULL AND api_cost_currency IS NULL
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'API_COST_CURRENCY_CONFLICT', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid AND resource_mode='API'
           AND api_cost_currency IS NOT NULL
           AND billing_rule_snapshot->>'currency' IS NOT NULL
           AND billing_rule_snapshot->>'currency' <> api_cost_currency
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'OPENING_BALANCE_MISSING', COUNT(*)::text FROM (
          SELECT DISTINCT line.provider_resource_id, line.api_cost_currency
            FROM ledger_line line
           WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
             AND line.api_cost_status='PRICED_USAGE' AND line.api_cost_currency IS NOT NULL
             AND line.settled_at>=${start} AND line.settled_at<${end}
             AND NOT EXISTS (
               SELECT 1 FROM provider_finance_event opening
                WHERE opening.enterprise_id=line.enterprise_id
                  AND opening.provider_resource_id=line.provider_resource_id
                  AND opening.account_currency=line.api_cost_currency
                  AND opening.event_type='API_OPENING_BALANCE'
             )
        ) missing_opening
        UNION ALL
        SELECT 'SUBSCRIPTION_PERIOD_MISSING', COUNT(*)::text
          FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
           AND resource_mode='CODING_PLAN' AND subscription_period_id IS NULL
           AND COALESCE(settled_at, created_at)>=${start}
           AND COALESCE(settled_at, created_at)<${end}
        UNION ALL
        SELECT 'CASH_PAID_CNY_MISSING', COUNT(*)::text
          FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
           AND event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
           AND cash_paid_cny IS NULL AND occurred_at>=${start} AND occurred_at<${end}
      `.execute(trx),
    ]);
    const apiRecharges = eventAmounts.rows.filter((row) => row.mode === "API")
      .map((row) => ({ currency: row.currency, amount: money(row.amount) }));
    const codingPlanOrders = eventAmounts.rows.filter((row) => row.mode === "CODING_PLAN")
      .map((row) => ({ currency: row.currency, amount: money(row.amount) }));
    const planCash = eventAmounts.rows.filter((row) => row.mode === "CODING_PLAN")
      .reduce((sum, row) => sum.plus(row.cash_cny), new Money(0));
    const cnyApi = apiCosts.rows.find((row) => row.currency === "CNY")?.amount ?? "0";
    const summaryGaps = gapResult.rows.filter((row) => Number(row.count) > 0)
      .map((row) => ({ code: row.code, count: Number(row.count) }));
    return {
      month, timezone: "Asia/Shanghai", cashOutflowCny: money(cash.rows[0]?.amount ?? "0"),
      apiRecharges, apiOperatingCosts: apiCosts.rows.map((row) => ({
        currency: row.currency, amount: money(row.amount),
      })), codingPlanOrders, codingPlanFixedCostCny: money(planCash),
      operatingCostCny: money(new Money(cnyApi).plus(planCash)),
      operatingCostByCurrency: apiCosts.rows.filter((row) => row.currency !== "CNY")
        .map((row) => ({ currency: row.currency, amount: money(row.amount) })),
      complete: summaryGaps.length === 0,
      gaps: summaryGaps,
    };
  }

  async listSubscriptionPeriods(enterpriseId: string, resourceId: string) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const resource = await trx.selectFrom("provider_resource").select("id")
      .where("enterprise_id", "=", enterpriseId).where("id", "=", resourceId)
      .where("mode", "=", "CODING_PLAN").where("status", "<>", "DELETED")
      .executeTakeFirst();
    if (!resource) return null;
    const now = new Date();
    const rows = await trx.selectFrom("provider_subscription_period")
      .leftJoin("provider_finance_event", (join) => join
        .onRef("provider_finance_event.enterprise_id", "=", "provider_subscription_period.enterprise_id")
        .onRef("provider_finance_event.id", "=", "provider_subscription_period.finance_event_id"))
      .selectAll("provider_subscription_period")
      .select(["provider_finance_event.account_amount as fixed_fee_amount",
        "provider_finance_event.account_currency as fixed_fee_currency",
        "provider_finance_event.cash_paid_cny as fixed_cash_paid_cny"])
      .where("provider_subscription_period.enterprise_id", "=", enterpriseId)
      .where("provider_subscription_period.provider_resource_id", "=", resourceId)
      .orderBy("provider_subscription_period.period_start", "desc").execute();
    const usageResult = await sql<{
      subscription_period_id: string; request_count: string; input_tokens: string;
      output_tokens: string; cache_tokens: string; reasoning_tokens: string; true_tokens: string;
    }>`SELECT subscription_period_id, COUNT(DISTINCT ai_request_id)::text AS request_count,
              COALESCE(SUM(raw_input_tokens),0)::text AS input_tokens,
              COALESCE(SUM(raw_output_tokens),0)::text AS output_tokens,
              COALESCE(SUM(raw_cache_tokens),0)::text AS cache_tokens,
              COALESCE(SUM(raw_reasoning_tokens),0)::text AS reasoning_tokens,
              COALESCE(SUM(raw_input_tokens+raw_output_tokens),0)::text AS true_tokens
         FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
          AND provider_resource_id=${resourceId}::uuid AND resource_mode='CODING_PLAN'
          AND subscription_period_id IS NOT NULL GROUP BY subscription_period_id`.execute(trx);
    const usageByPeriod = new Map(usageResult.rows.map((usage) => [usage.subscription_period_id, usage]));
    return rows.map((row) => ({ ...row, current_status: row.reversed_by_event_id ? "REVERSED"
      : now >= row.period_end_exclusive ? "EXPIRED"
        : now >= row.period_start ? "ACTIVE" : "UPCOMING",
      token_usage: usageByPeriod.get(row.id) ?? {
        subscription_period_id: row.id, request_count: "0", input_tokens: "0",
        output_tokens: "0", cache_tokens: "0", reasoning_tokens: "0", true_tokens: "0",
      } }));
    });
  }

  async getSubscriptionPeriodUsage(enterpriseId: string, periodId: string) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const period = await trx.selectFrom("provider_subscription_period")
      .select(["id", "provider_resource_id", "product_name", "period_start",
        "period_end_exclusive", "reversed_by_event_id"])
      .where("enterprise_id", "=", enterpriseId).where("id", "=", periodId)
      .executeTakeFirst();
    if (!period) return null;
    const result = await sql<{ request_count: string; input_tokens: string; output_tokens: string;
      cache_tokens: string; reasoning_tokens: string; true_tokens: string }>`
      SELECT COUNT(DISTINCT ai_request_id)::text AS request_count,
             COALESCE(SUM(raw_input_tokens),0)::text AS input_tokens,
             COALESCE(SUM(raw_output_tokens),0)::text AS output_tokens,
             COALESCE(SUM(raw_cache_tokens),0)::text AS cache_tokens,
             COALESCE(SUM(raw_reasoning_tokens),0)::text AS reasoning_tokens,
             COALESCE(SUM(raw_input_tokens+raw_output_tokens),0)::text AS true_tokens
        FROM ledger_line WHERE enterprise_id=${enterpriseId}::uuid
         AND subscription_period_id=${periodId}::uuid`.execute(trx);
    return { period, tokenUsage: result.rows[0]! };
    });
  }

  async listReconciliationCases(
    enterpriseId: string,
    input: { status?: "OPEN" | "REJECTED" | "RESOLVED"; limit: number; offset: number },
  ) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      let query = trx.selectFrom("provider_finance_reconciliation_case").selectAll()
        .where("enterprise_id", "=", enterpriseId);
      let countQuery = trx.selectFrom("provider_finance_reconciliation_case")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("enterprise_id", "=", enterpriseId);
      if (input.status) {
        query = query.where("status", "=", input.status);
        countQuery = countQuery.where("status", "=", input.status);
      }
      const [rows, count] = await Promise.all([
        query.orderBy("created_at", "desc").orderBy("id", "desc")
          .limit(input.limit).offset(input.offset).execute(),
        countQuery.executeTakeFirstOrThrow(),
      ]);
      return { items: rows, total: Number(count.count) };
    });
  }
}
