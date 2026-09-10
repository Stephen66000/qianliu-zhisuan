/**
 * 标准版首页费用同期聚合（HOME-STANDARD-20260910 WP02）。
 *
 * 上月同期费用为真实同期聚合（显式窗口重跑），禁止把整月费用按天数折算：
 *   - 资金读模型口径：镜像 loadMonthlyFinanceSummary 的 apiCost / 套餐现金查询面；
 *   - 余额桥接口径：loadMonthlyOperatingCosts 本就支持任意窗口（期初/期末按窗口边界取快照）。
 * 当期费用不做本地重算，由路由层直接采用经营账单 getBill 快照（与月度总览逐字段一致）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";
import {
  loadMonthlyOperatingCosts,
  type MonthlyOperatingCostSummary,
} from "./monthly-operating-cost.js";
import { summarizeMonthlyOperatingCosts } from "./monthly-operating-summary.js";
import { countFinanceGaps } from "./provider-finance-gaps.js";
import type { CurrencyAmount } from "./dashboard-home-types.js";

function groupCurrencyAmounts(values: CurrencyAmount[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const value of values) {
    totals.set(value.currency, (totals.get(value.currency) ?? 0) + Number(value.amount));
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toFixed(8) }));
}

/** 资金读模型口径的上月同期费用（显式窗口重跑；缺口规则复用权威区间化 countFinanceGaps）。 */
export async function loadWindowOperatingFinance(
  db: Kysely<Database>,
  enterpriseId: string,
  start: Date,
  end: Date,
): Promise<{ totalSpends: CurrencyAmount[]; incompleteReason: string | null }> {
  const [apiCosts, planCash, gapRows] = await Promise.all([
    sql<{ currency: string; amount: string }>`
      SELECT currency, COALESCE(SUM(amount),0)::text AS amount FROM (
        SELECT api_cost_currency AS currency, api_cost AS amount
          FROM ledger_line
         WHERE enterprise_id = ${enterpriseId} AND resource_mode = 'API'
           AND api_cost_status = 'PRICED_USAGE'
           AND settled_at >= ${start} AND settled_at < ${end}
        UNION ALL
        SELECT account_currency AS currency, -account_amount AS amount
          FROM provider_finance_event
         WHERE enterprise_id = ${enterpriseId} AND event_type = 'API_LEGACY_COST_ADJUSTMENT'
           AND occurred_at >= ${start} AND occurred_at < ${end}
      ) cost GROUP BY currency ORDER BY currency
    `.execute(db),
    sql<{ cash_cny: string }>`
      SELECT COALESCE(SUM(event.cash_paid_cny),0)::text AS cash_cny
        FROM provider_finance_event event
        JOIN provider_resource resource
          ON resource.enterprise_id = event.enterprise_id
         AND resource.id = event.provider_resource_id AND resource.mode = 'CODING_PLAN'
       WHERE event.enterprise_id = ${enterpriseId}
         AND event.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL')
         AND event.occurred_at >= ${start} AND event.occurred_at < ${end}
    `.execute(db),
    countFinanceGaps(db, enterpriseId, start, end),
  ]);
  const planCashCny = planCash.rows[0]?.cash_cny ?? "0";
  // 缺币种的遗留已计价行（API_COST_CURRENCY_MISSING 缺口）不计入币种合计，
  // 与权威月度汇总"跳过 null 币种、以缺口呈现"的口径一致。
  const spends = groupCurrencyAmounts([
    ...apiCosts.rows
      .filter((row) => row.currency !== null)
      .map((row) => ({ currency: row.currency, amount: row.amount })),
    ...(Number(planCashCny) !== 0 ? [{ currency: "CNY", amount: planCashCny }] : []),
  ]);
  const gaps = gapRows
    .filter((row) => Number(row.count) > 0)
    .map((row) => `${row.code}:${Number(row.count)}`);
  return {
    totalSpends: spends,
    incompleteReason: gaps.length > 0 ? gaps.join("、") : null,
  };
}

/** 余额桥接口径的上月同期费用：loadMonthlyOperatingCosts 支持任意窗口（期初/期末按窗口边界取快照）。 */
export async function loadWindowBridgeCosts(
  db: Kysely<Database>,
  enterpriseId: string,
  start: Date,
  end: Date,
): Promise<MonthlyOperatingCostSummary> {
  const costs = await loadMonthlyOperatingCosts(db, enterpriseId, start, end);
  return summarizeMonthlyOperatingCosts(costs.resources);
}

export function bridgeIncompleteReason(summary: MonthlyOperatingCostSummary): string | null {
  if (summary.totalSpends.length === 0) {
    return summary.apiSpendReason ?? "同期费用缺少可计算事实";
  }
  return summary.apiSpendStatus !== "CALCULABLE" && summary.apiSpendStatus !== "NOT_APPLICABLE"
    ? summary.apiSpendReason ?? summary.apiSpendStatus
    : null;
}
