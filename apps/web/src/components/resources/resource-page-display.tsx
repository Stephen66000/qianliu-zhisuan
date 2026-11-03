import { Button } from "../ui/Button";
import type { ProviderOfficialBalanceState, ProviderResourceItem } from "../../api/types";
import { useRefreshOfficialBalance } from "../../api/hooks";
import { currencyMoney } from "../../lib/currency";
import { formatCount, formatDateTimeFull, formatMoney, formatShanghaiDate } from "../../lib/format";

/**
 * WP3 C2 / OAB-01..04：API 资源的资金列改消费 `official_balance`（官方来源）——
 * 内部本月充值/余额/成本三行与"资金账本未启用"提示退役（D5/AFR-07）。
 * 状态主标记＋expired/last_attempt_failed 布尔叠加；null 余额显示"暂无官方数据"，
 * 绝不显示为 0（AT-OAB-08）；UNSUPPORTED 整区"暂不支持官方余额同步"（OAB-02）；
 * 刷新按钮仅受支持资源显示，冷却消费 next_refresh_at（不前端推算 P3）。
 * CODING_PLAN 分支保持订阅金额/实付（W5/W6 域，零改动）。
 */
export const OFFICIAL_BALANCE_STATUS_LABEL: Record<
  ProviderOfficialBalanceState["status"],
  string
> = {
  OK: "已同步",
  FAILED: "同步失败",
  EXPIRED: "数据过期",
  NEVER_SYNCED: "未同步",
  UNSUPPORTED: "暂不支持",
  SYNCING: "同步中",
};

export function ResourceFinanceColumn({ resource }: { resource: ProviderResourceItem }) {
  const finance = resource.finance;
  if (resource.mode === "API") {
    return <OfficialBalanceColumn resource={resource} />;
  }
  if (finance) {
    return (
      <span className="block leading-5">
        <span className="block">当前订阅金额 {finance.currentPeriod?.fixedFeeAmount
          ? `${finance.currentPeriod.fixedFeeCurrency ?? ""} ${formatMoney(finance.currentPeriod.fixedFeeAmount)}`
          : "待补"}</span>
        <span className="block">本月订阅实付 ¥{formatMoney(finance.monthlyPlanCashCny)}</span>
      </span>
    );
  }
  return <span>—</span>;
}

/** OAB-04 叠加标记：主状态之外的 expired / last_attempt_failed 布尔补充表达。 */
function officialBalanceOverlayTags(balance: ProviderOfficialBalanceState): string[] {
  const tags: string[] = [];
  if (balance.expired && balance.status !== "EXPIRED") tags.push("数据过期");
  if (balance.last_attempt_failed && balance.status !== "FAILED") tags.push("同步失败");
  return tags;
}

function OfficialBalanceColumn({ resource }: { resource: ProviderResourceItem }) {
  const refresh = useRefreshOfficialBalance(resource.id);
  const balance = resource.official_balance ?? null;
  const nextRefreshAt = balance?.next_refresh_at ?? null;
  const cooldownSeconds = nextRefreshAt === null ? 0
    : Math.max(0, Math.ceil((new Date(nextRefreshAt).getTime() - Date.now()) / 1000));
  const cooling = cooldownSeconds > 0;
  const refreshError = refresh.error instanceof Error ? refresh.error.message : null;

  if (balance && !balance.supported) {
    return <span className="block leading-5">暂不支持官方余额同步</span>;
  }

  const overlayTags = balance ? officialBalanceOverlayTags(balance) : [];
  const statusTag = balance && balance.status !== "OK"
    ? OFFICIAL_BALANCE_STATUS_LABEL[balance.status] : null;
  return (
    <span className="block leading-5">
      <span className="block">
        {balance !== null && balance.total_balance !== null
          ? `官方余额 ${currencyMoney(balance.total_balance, balance.currency)}`
          : "暂无官方数据"}
      </span>
      {statusTag !== null || overlayTags.length > 0 ? (
        <span className="block text-ql-fg-tertiary">
          {[statusTag, ...overlayTags].filter(Boolean).join(" · ")}
        </span>
      ) : null}
      {balance?.last_success_at ? (
        <span className="block text-ql-fg-tertiary">
          最近成功 {formatDateTimeFull(balance.last_success_at)}
        </span>
      ) : null}
      {balance?.supported ? (
        <span className="mt-0.5 block">
          <Button
            loading={refresh.isPending}
            loadingText="刷新中…"
            variant="ghost"
            size="sm"
            data-write-action
            disabled={refresh.isPending || cooling}
            onClick={() => refresh.mutate()}
            title={cooling ? `冷却中，约 ${cooldownSeconds} 秒后可再次刷新` : undefined}
            type="button"
          >
            刷新余额
          </Button>
          {cooling ? <span className="ml-1 text-[12px] text-ql-fg-tertiary">冷却 {cooldownSeconds}s</span> : null}
          {refreshError ? <span className="block text-[12px] text-ql-danger">{refreshError}</span> : null}
        </span>
      ) : null}
    </span>
  );
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
