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
    code: fact.code === "API_USAGE_COST_UNKNOWN" ? "API_COST_UNKNOWN" : fact.code,
    message: `${names.get(fact.providerResourceId) ?? fact.providerResourceId} 本期费用事实存在缺口：${fact.count} 条账本、${fact.requestCount} 个请求；范围 ${rangeLabel(fact)}`,
    providerResourceId: fact.providerResourceId,
    field: fact.code === "API_USAGE_COST_UNKNOWN" || fact.code === "API_USAGE_COST_NOT_MIGRATED"
      ? "ledger_line.api_cost" : "ledger_line.api_cost_currency",
    requestRangeFrom: fact.requestRangeFrom.toISOString(), requestRangeTo: fact.requestRangeTo.toISOString(),
  }));
}

/** Balance uncertainty is cumulative; it must never become the current month's expense uncertainty. */
export function balanceQualityGaps(
  views: ResourceFinanceView[], historicalFacts: ApiCostGapFact[], names: Map<string, string>,
): OperatingBillSnapshot["gaps"] {
  const stateCode = {
    MISSING_OPENING_BALANCE: "API_OPENING_BALANCE_MISSING",
    INCOMPLETE_USAGE_COST: "API_BALANCE_COST_UNKNOWN",
    NEGATIVE_RECONCILIATION_REQUIRED: "API_NEGATIVE_RECONCILIATION_REQUIRED",
    LEGACY_ARCHIVED: "API_LEGACY_ARCHIVED",
  } as const;
  const stateLabel = {
    MISSING_OPENING_BALANCE: "尚未登记资金期初",
    INCOMPLETE_USAGE_COST: "因费用待核实，余额暂无法确认",
    NEGATIVE_RECONCILIATION_REQUIRED: "内部账本计算为负余额，需要核对充值与消耗记录",
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
      if (account.balanceState !== "NORMAL") gaps.push({
        code: stateCode[account.balanceState], providerResourceId: view.resourceId,
        field: `balance:${account.currency}`,
        message: `${name} 的 ${account.currency} 资金账户${stateLabel[account.balanceState]}${history}`,
        ...range,
      });
      if (account.monthOpeningState === "INCOMPLETE_USAGE_COST") gaps.push({
        code: "API_MONTH_OPENING_COST_UNKNOWN", providerResourceId: view.resourceId,
        field: `month_opening_balance:${account.currency}`,
        message: `${name} 的 ${account.currency} 月初结转因历史费用未计全暂不可计算${history}`,
        ...range,
      });
      return gaps;
    });
  });
}
