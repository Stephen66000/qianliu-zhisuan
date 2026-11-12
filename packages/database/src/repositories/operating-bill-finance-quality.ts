import type { OperatingBillGap, OperatingBillSnapshot } from "./operating-bill-types.js";
import type { ApiCostGapFact } from "./provider-finance-api-cost-gaps.js";
import type { ResourceFinanceView } from "./provider-finance-types.js";

const shanghaiTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const rangeLabel = (fact: ApiCostGapFact) =>
  `${shanghaiTime.format(fact.requestRangeFrom)} ~ ${shanghaiTime.format(fact.requestRangeTo)}（北京时间）`;

export function monthlyExpenseGaps(
  facts: ApiCostGapFact[], names: Map<string, string>,
): OperatingBillGap[] {
  return facts.map((fact) => ({
    ...(fact.code === "API_USAGE_COST_UNKNOWN" && fact.actionableRequestCount === "0"
      ? { requiresUsageReview: false } : {}),
    code: fact.code === "API_USAGE_COST_UNKNOWN" ? "API_COST_UNKNOWN" : fact.code,
    message: `${names.get(fact.providerResourceId) ?? fact.providerResourceId} 本期费用事实存在缺口：${fact.count} 条账本、${fact.requestCount} 个请求；范围 ${rangeLabel(fact)}`,
    providerResourceId: fact.providerResourceId,
    field: fact.code === "API_USAGE_COST_UNKNOWN" || fact.code === "API_USAGE_COST_NOT_MIGRATED"
      ? "ledger_line.api_cost" : "ledger_line.api_cost_currency",
    requestRangeFrom: fact.requestRangeFrom.toISOString(), requestRangeTo: fact.requestRangeTo.toISOString(),
  }));
}

/**
 * Balance uncertainty is cumulative; it must never become the current month's expense uncertainty.
 *
 * WP2-S5（AFR-07＋WP2 plan §4.5/§4.6，WP1 合同 §4 裁定 1）：API_OPENING_BALANCE_MISSING
 * （"尚未登记资金期初"）、API_BALANCE_COST_UNKNOWN（"余额暂无法确认"）、
 * API_NEGATIVE_RECONCILIATION_REQUIRED（"内部负余额"）、API_MONTH_OPENING_COST_UNKNOWN
 * （"月初结转不可计算"）等资金域质量码对当前期停产——内部余额及其待补提示随 API
 * 内部资金管理退役（AFR-07：移除 API 期初、充值、月末内部余额及其待补提示；历史
 * 资金信息不参与当前费用完整性判断）。API_LEGACY_ARCHIVED 保留（AFR-06 切账前
 * 历史反控制：费用不能由切账后账户的零金额推定，附月初前未计价历史说明）。
 */
export function balanceQualityGaps(
  views: ResourceFinanceView[], historicalFacts: ApiCostGapFact[], names: Map<string, string>,
): OperatingBillSnapshot["gaps"] {
  const stateLabel = {
    LEGACY_ARCHIVED: "属于历史账期，金额尚未纳入当前资金账核算",
  } as const;
  return views.filter((view) => view.mode === "API").flatMap((view) => {
    const fact = historicalFacts.find((item) => item.providerResourceId === view.resourceId
      && item.code === "API_USAGE_COST_UNKNOWN");
    const range = fact ? { requestRangeFrom: fact.requestRangeFrom.toISOString(),
      requestRangeTo: fact.requestRangeTo.toISOString() } : {};
    const history = fact
      ? `；月初之前有 ${fact.count} 条未计价账本、${fact.requestCount} 个请求，范围 ${rangeLabel(fact)}` : "";
    const name = names.get(view.resourceId) ?? view.resourceId;
    return view.accounts.flatMap((account) => {
      const gaps: OperatingBillGap[] = [];
      if (account.balanceState === "LEGACY_ARCHIVED") gaps.push({
        code: "API_LEGACY_ARCHIVED", providerResourceId: view.resourceId,
        field: `balance:${account.currency}`,
        message: `${name} 的 ${account.currency} 资金账户${stateLabel.LEGACY_ARCHIVED}${history}`,
        ...range,
      });
      return gaps;
    });
  });
}
