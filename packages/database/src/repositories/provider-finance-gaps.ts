import { loadSubscriptionCoverage, subscriptionExpenseGaps } from "./provider-finance-subscription-coverage.js";
import { API_COST_GAP_CODES, loadApiCostGaps } from "./provider-finance-api-cost-gaps.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
/**
 * 资金完整性缺口计数（权威口径单一来源，区间化；R01-F01 抽取为独立模块）。
 * 严格账本/激活预检使用本函数；月度汇总与首页同期使用下方现金费用视图。
 * 两者共用 API/现金事实规则；遗漏金额只能标记为缺口，
 * 不得视为已知 0。接受 Kysely 实例或事务（Transaction 满足 Kysely 接口）。
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

export async function countFinanceGaps(
  db: Kysely<Database>,
  enterpriseId: string,
  start: Date,
  end: Date,
): Promise<Array<{ code: string; count: string }>> {
  const effectiveStart = start < PROVIDER_FINANCE_CUTOVER ? PROVIDER_FINANCE_CUTOVER : start;
  if (effectiveStart >= end) {
    return [
      { code: "API_USAGE_COST_UNKNOWN", count: "0" },
      { code: "API_COST_CURRENCY_MISSING", count: "0" },
      { code: "API_COST_CURRENCY_CONFLICT", count: "0" },
      { code: "OPENING_BALANCE_MISSING", count: "0" },
      { code: "SUBSCRIPTION_PERIOD_MISSING", count: "0" },
      { code: "CASH_PAID_CNY_MISSING", count: "0" },
    ];
  }
  const [apiGaps, gapResult] = await Promise.all([
    loadApiCostGaps(db, enterpriseId, start, end),
    sql<{ code: string; count: string }>`
    SELECT 'OPENING_BALANCE_MISSING' AS code, COUNT(*)::text AS count FROM (
      SELECT DISTINCT line.provider_resource_id, line.api_cost_currency
        FROM ledger_line line
       WHERE line.enterprise_id=${enterpriseId}::uuid AND line.resource_mode='API'
         AND line.api_cost_status='PRICED_USAGE' AND line.api_cost_currency IS NOT NULL
         AND line.settled_at>=${effectiveStart} AND line.settled_at<${end}
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
       AND COALESCE(settled_at, created_at)>=${effectiveStart}
       AND COALESCE(settled_at, created_at)<${end}
    UNION ALL
    SELECT 'CASH_PAID_CNY_MISSING', COUNT(*)::text
      FROM provider_finance_event WHERE enterprise_id=${enterpriseId}::uuid
       AND event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
       AND cash_paid_cny IS NULL AND occurred_at>=${effectiveStart} AND occurred_at<${end}
  `.execute(db),
  ]);
  return [
    ...API_COST_GAP_CODES.map((code) => ({ code,
      count: apiGaps.filter((gap) => gap.code === code)
        .reduce((sum, gap) => sum + BigInt(gap.count), 0n).toString() })),
    ...gapResult.rows,
  ];
}

/** Cash expense completeness is distinct from persisted usage attribution quality.
 * The strict ledger/activation check above intentionally still requires stored links.
 * A unique paid period already represented in the cash reader needs no extra expense.
 */
export async function countOperatingExpenseGaps(
  db: Kysely<Database>, enterpriseId: string, start: Date, end: Date,
): Promise<Array<{ code: string; count: string }>> {
  const [gaps, coverage] = await Promise.all([
    countFinanceGaps(db, enterpriseId, start, end),
    loadSubscriptionCoverage(db, enterpriseId, start, end),
  ]);
  return [...gaps.filter((gap) => gap.code !== "SUBSCRIPTION_PERIOD_MISSING"),
    ...subscriptionExpenseGaps(coverage)];
}
