import type { ProviderResourceItem } from "../../api/types";
import { formatCount, formatMoney, formatShanghaiDate } from "../../lib/format";

export function ResourceFinanceColumn({ resource }: { resource: ProviderResourceItem }) {
  const finance = resource.finance;
  if (finance) {
    if (resource.mode === "API") {
      const account = finance.accounts.length === 1 ? finance.accounts[0] : null;
      if (!account) return <span>资金账户币种不唯一</span>;
      return (
        <span className="block leading-5">
          <span className="block">本月充值 {account.currency} {formatMoney(account.monthlyRecharge)}</span>
          <span className="block">余额 {account.balanceState === "NORMAL" && account.balance !== null ? `${account.currency} ${formatMoney(account.balance)}` : account.balanceState}</span>
          <span className="block">本月 API 成本 {account.currency} {formatMoney(account.monthlyApiCost)}</span>
        </span>
      );
    }
    return (
      <span className="block leading-5">
        <span className="block">当前订阅金额 {finance.currentPeriod?.fixedFeeAmount
          ? `${finance.currentPeriod.fixedFeeCurrency ?? ""} ${formatMoney(finance.currentPeriod.fixedFeeAmount)}`
          : "待补"}</span>
        <span className="block">本月订阅实付 ¥{formatMoney(finance.monthlyPlanCashCny)}</span>
      </span>
    );
  }
  return <span>{resource.mode === "API" ? "资金账本未启用" : "—"}</span>;
}

export function ResourceQuotaColumn({ resource }: { resource: ProviderResourceItem }) {
  if (resource.mode === "API") {
    return <span>—</span>;
  }
  const finance = resource.finance;
  const allocated = resource.allocated_quota ?? finance?.currentPeriod?.totalQuota ?? resource.operating_snapshot?.total_quota;
  const quotaUnit = finance?.currentPeriod?.quotaUnit ?? resource.operating_snapshot?.quota_unit ?? "TOKEN";
  if (finance) {
    return (
      <span className="block leading-5">
        <span className="block">分配额度 {allocated
          ? `${formatCount(allocated)} ${quotaUnit}`
          : "待补"}</span>
        <span className="block">周期真实 Token {finance.currentPeriod ? formatCount(finance.currentPeriod.trueTokens) : "无有效周期"}</span>
        <span className="block">{finance.currentPeriod ? `${formatShanghaiDate(finance.currentPeriod.periodStart)} ～ ${formatShanghaiDate(finance.currentPeriod.periodEndExclusive)}` : "—"}</span>
      </span>
    );
  }
  if (!resource.operating_snapshot) return <span>{allocated ? `分配额度 ${formatCount(allocated)} ${quotaUnit}` : "未录入/未同步"}</span>;
  return (
    <span className="block leading-5">
      <span className="block">分配额度 {allocated ? `${formatCount(allocated)} ${quotaUnit}` : "未知"}</span>
      <span className="block">系统已用 {resource.operating_snapshot.used_quota ? formatCount(resource.operating_snapshot.used_quota) : "未知"}</span>
      <span className="block">剩余 {resource.operating_snapshot.remaining_quota ? formatCount(resource.operating_snapshot.remaining_quota) : "未知"} {resource.operating_snapshot.quota_unit ?? ""}</span>
    </span>
  );
}

export function ResourceFinanceDisplay({ resource }: { resource: ProviderResourceItem }) {
  return (
    <>
      <ResourceFinanceColumn resource={resource} />
      <ResourceQuotaColumn resource={resource} />
    </>
  );
}

export const ISOLATED = new Set(["CREDENTIAL_INVALID", "EXHAUSTED", "EXPIRED", "UNAVAILABLE", "RATE_LIMITED"]);

export const MODE_LABEL: Record<ProviderResourceItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "套餐",
};
