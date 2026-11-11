import { loadSubscriptionCoverage, subscriptionExpenseGaps } from "./provider-finance-subscription-coverage.js";
import { API_COST_GAP_CODES, loadApiCostGaps } from "./provider-finance-api-cost-gaps.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";
/**
 * 资金完整性缺口计数（权威口径单一来源，区间化；R01-F01 抽取为独立模块）。
 * 严格账本/激活预检使用本函数；月度汇总与首页同期使用下方现金费用视图。
 * 两者共用 API/现金事实规则；遗漏金额只能标记为缺口，
 * 不得视为已知 0。接受 Kysely 实例或事务（Transaction 满足 Kysely 接口）。
 *
 * WP2-S5 缺口码统一（AFR-07＋WP2 plan §4.5，WP1 合同 §4 裁定 1 收口）：
 * OPENING_BALANCE_MISSING（API 期初缺口）随 API 内部资金管理退役而停产——恒 0，
 * 仅保留形状（消费方按 count>0 过滤，激活域消费点已由 S4 在 facts.ts 过滤）。
 * API_USAGE_COST_* 与 API_COST_CURRENCY_*（真实用量/价格缺口，AFR-07"仍展示真实
 * 存在的用量或价格缺口"）与 SUBSCRIPTION_PERIOD_MISSING/CASH_PAID_CNY_MISSING
 * （套餐/现金域，含历史 API_RECHARGE 现金证据）保留原计数。
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
    SELECT 'SUBSCRIPTION_PERIOD_MISSING' AS code, COUNT(*)::text AS count
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
    // OPENING_BALANCE_MISSING 恒 0（AFR-07）：形状保留，位置与退役前一致。
    { code: "OPENING_BALANCE_MISSING", count: "0" },
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
