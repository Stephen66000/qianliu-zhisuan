import type { ProviderResourceItem } from "../../api/types";
import { formatCount, formatMoney, formatShanghaiDate } from "../../lib/format";

export function ResourceFinanceDisplay({ resource }: { resource: ProviderResourceItem }) {
  const finance = resource.finance;
  if (finance) {
    if (resource.mode === "API") {
      const account = finance.accounts.length === 1 ? finance.accounts[0] : null;
      if (!account) return <span>资金账户币种不唯一</span>;
      return <span className="block leading-5">
        <span className="block">本月充值 {account.currency} {formatMoney(account.monthlyRecharge)}</span>
        <span className="block">余额 {account.balanceState === "NORMAL" && account.balance !== null ? `${account.currency} ${formatMoney(account.balance)}` : account.balanceState}</span>
        <span className="block">本月 API 成本 {account.currency} {formatMoney(account.monthlyApiCost)}</span>
      </span>;
    }
    return <span className="block leading-5">
      <span className="block">当前订阅金额 {finance.currentPeriod?.fixedFeeAmount
        ? `${finance.currentPeriod.fixedFeeCurrency ?? ""} ${formatMoney(finance.currentPeriod.fixedFeeAmount)}`
        : "待补"}</span>
      <span className="block">当前订阅额度 {finance.currentPeriod?.totalQuota
        ? `${formatCount(finance.currentPeriod.totalQuota)} ${finance.currentPeriod.quotaUnit ?? ""}`
        : "待补"}</span>
      <span className="block">本月订阅实付 ¥{formatMoney(finance.monthlyPlanCashCny)}</span>
      <span className="block">周期已扣减 {finance.currentPeriod
        ? finance.currentPeriod.deductedQuota === null ? "事实不完整"
          : formatCount(finance.currentPeriod.deductedQuota)
        : "无有效周期"}</span>
      <span className="block">周期真实 Token {finance.currentPeriod ? formatCount(finance.currentPeriod.trueTokens) : "无有效周期"}</span>
      <span className="block">{finance.currentPeriod ? `${formatShanghaiDate(finance.currentPeriod.periodStart)} ～ ${formatShanghaiDate(finance.currentPeriod.periodEndExclusive)}` : "—"}</span>
    </span>;
  }
  if (!resource.operating_snapshot) return <>未录入/未同步</>;
  return resource.mode === "CODING_PLAN" ? <span className="block leading-5">
    <span className="block">总额度 {resource.operating_snapshot.total_quota ? formatCount(resource.operating_snapshot.total_quota) : "未知"}</span>
    <span className="block">系统已用 {resource.operating_snapshot.used_quota ? formatCount(resource.operating_snapshot.used_quota) : "未知"}</span>
    <span className="block">剩余 {resource.operating_snapshot.remaining_quota ? formatCount(resource.operating_snapshot.remaining_quota) : "未知"} {resource.operating_snapshot.quota_unit ?? ""}</span>
  </span> : <span>资金账本未启用</span>;
}

export const ISOLATED = new Set(["CREDENTIAL_INVALID", "EXHAUSTED", "EXPIRED", "UNAVAILABLE", "RATE_LIMITED"]);

export const MODE_LABEL: Record<ProviderResourceItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "套餐",
};
