/**
 * W18 资源摘要（按厂商+模式分组）—— PRD §10.2 资源摘要。
 *
 * 厂商经营快照与主体 Grant 分列，前端只展示后端口径，不重算。
 * API 速度按金额/小时，套餐速度按额度/小时；不可计算原因不伪装成“无风险”。
 */
import type { ResourceBreakdownItem } from "../../api/types";
import type { ReactNode } from "react";
import { formatCount, formatDateTimeShort, formatDecimal, formatMoney, formatRatePerHour } from "../../lib/format";
import { resourceStatusLabel } from "../../lib/resource-status";
import { StatusTag } from "./StatusTag";

interface ResourceBreakdownProps {
  items: ResourceBreakdownItem[];
}

const MODE_LABEL: Record<ResourceBreakdownItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "Coding Plan",
};

export function ResourceBreakdown({ items }: ResourceBreakdownProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
            <th className="py-2 pr-4 font-medium">厂商</th>
            <th className="py-2 pr-4 font-medium">模式</th>
            <th className="py-2 pr-4 text-right font-medium">账号数</th>
            <th className="py-2 pr-4 text-right font-medium">分配额度</th>
            <th className="py-2 pr-4 text-right font-medium">已用额度</th>
            <th className="py-2 pr-4 text-right font-medium">剩余额度 / 当前余额</th>
            <th className="py-2 pr-4 text-right font-medium">当前订阅金额</th>
            <th className="py-2 pr-4 text-right font-medium">本月花费</th>
            <th className="py-2 pr-4 text-right font-medium">本月 Token</th>
            <th className="py-2 pr-4 text-right font-medium">消耗速度</th>
            <th className="py-2 pr-4 font-medium">预计耗尽</th>
            <th className="py-2 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle"
              key={`${item.providerCode}-${item.mode}`}
            >
              <td className="py-2.5 pr-4 font-medium">{item.providerName}</td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">{MODE_LABEL[item.mode]}</td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.accountCount}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.allocatedQuota === null ? "—" : formatCount(item.allocatedQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.mode === "API" ? "—" : item.usedQuota === null ? "—" : formatCount(item.usedQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.mode === "API"
                  ? item.currentBalance === null ? "余额待补"
                    : `${item.currency ?? ""} ${formatMoney(item.currentBalance)}`
                  : item.remainingQuota === null ? "—" : formatCount(item.remainingQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.mode === "API" ? "—" : (
                  <>{item.packageCost === null
                    ? "套餐费用待补"
                    : `${item.currency ?? ""} ${formatMoney(item.packageCost)}`}
                    <span className="block text-[11px] text-ql-fg-tertiary">
                      订阅周期 {subscriptionPeriod(item)}
                    </span></>
                )}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.monthlyCost === null
                  ? item.monthlyCostReason ?? (item.mode === "API" ? "API 花费不可计算" : "套餐费用待补")
                  : (
                    <>
                      {`${item.currency ?? ""} ${formatMoney(item.monthlyCost)}`}
                      {item.mode === "CODING_PLAN" && Number(item.monthlyCost) === 0 && Number(item.packageCost ?? 0) > 0 ? (
                        <span className="block text-[11px] text-ql-fg-tertiary">
                          本期尚未到续费扣款日
                        </span>
                      ) : null}
                    </>
                  )}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {monthlyTokenText(item)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {usageRateText(item)}
              </td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">
                {forecastExhaustionText(item)}
              </td>
              <td className="py-2.5">
                <a href="/resources?tab=supply-health#resource-health" title={item.abnormalResources.map((resource) =>
                  `${resource.resourceName}：${resourceStatusLabel(resource.status, item.mode)}`
                ).join("；") || "全部资源正常"}>
                  <StatusTag tone={statusTone(item.status)}>
                    {resourceStatusLabel(item.status, item.mode)}
                  </StatusTag>
                  {item.abnormalResources.length > 0 ? (
                    <span className="mt-1 block max-w-36 text-[11px] text-ql-fg-tertiary">
                      {item.abnormalResources.map((resource) => resource.resourceName).join("、")}
                    </span>
                  ) : null}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function subscriptionPeriod(item: ResourceBreakdownItem): string {
  if (!item.subscriptionPeriodStart && !item.subscriptionPeriodEnd) return "待补";
  const day = (value: string | null) => value ? value.slice(0, 10) : "未知";
  return `${day(item.subscriptionPeriodStart)}～${day(item.subscriptionPeriodEnd)}`;
}

function monthlyTokenText(item: ResourceBreakdownItem): ReactNode {
  if (item.monthlyTotalTokens === null) return <span title="账本计量质量未知">不可计算（计量未知）</span>;
  const unknown = item.monthlyUnknownCount ?? 0;
  return (
    <span title={`输入 ${item.monthlyInputTokens ?? "—"}；输出 ${item.monthlyOutputTokens ?? "—"}；缓存 ${item.monthlyCacheTokens ?? "—"}；推理 ${item.monthlyReasoningTokens ?? "—"}`}>
      {formatCount(item.monthlyTotalTokens)}
      <span className="block text-[11px] text-ql-fg-tertiary">
        {unknown > 0 ? `已记录；另有 ${unknown} 笔计量未知` : qualityLabel(item.monthlyUsageQuality)}
      </span>
    </span>
  );
}

function qualityLabel(quality: ResourceBreakdownItem["monthlyUsageQuality"]): string {
  if (quality === "EXACT") return "精确计量";
  if (quality === "ESTIMATED") return "估算计量";
  return "计量未知";
}

function usageRateText(item: ResourceBreakdownItem): ReactNode {
  if (item.mode !== "API") return forecastRateText(item);
  if (item.tokenRate24h === null && item.costRate24h === null) return "最近24小时无可用数据";
  return (
    <>
      {item.tokenRate24h === null ? "Token 不可计算" : `${formatTokenRate(item.tokenRate24h)} Token/小时`}
      {item.costRate24h === null ? null : (
        <span className="block text-[11px] text-ql-fg-tertiary">
          {item.currency ?? "金额"} {formatMoney(item.costRate24h)}/小时
        </span>
      )}
    </>
  );
}

function formatTokenRate(value: string): string {
  return formatDecimal(value);
}

function statusTone(status: string): "neutral" | "warning" | "danger" {
  if (status === "HEALTHY" || status === "ACTIVE") return "neutral";
  if (status === "DEGRADED" || status === "RATE_LIMITED") return "warning";
  return "danger";
}

function forecastRateText(item: ResourceBreakdownItem): string {
  if (item.forecastConfidence === null) return "暂无预测快照";
  if (item.currentRate24h !== null) {
    const rate = formatRatePerHour(item.currentRate24h);
    return item.currentRateUnit === "CURRENCY_PER_HOUR"
      ? `${item.currency ?? "金额"} ${rate}`
      : `${rate} ${item.quotaUnit ?? "额度"}`;
  }
  if (item.forecastNotCalculableReason === "remaining_quota_unknown") return "余额未知";
  if (item.forecastNotCalculableReason === "no_consumption_rate") {
    return item.forecastDataPoints === 0 ? "暂无用量数据" : "当前速度为零/数据不足";
  }
  return "数据不足/不可计算";
}

function forecastExhaustionText(item: ResourceBreakdownItem): string {
  if (item.forecastExhaustAt !== null) return formatDateTimeShort(item.forecastExhaustAt);
  if (item.forecastConfidence === null) return "暂无预测快照";
  if (item.forecastNotCalculableReason === "remaining_quota_unknown") return "余额未知";
  if (item.forecastNotCalculableReason === "no_consumption_rate") return "按当前数据不可计算";
  return "数据不足/不可计算";
}
