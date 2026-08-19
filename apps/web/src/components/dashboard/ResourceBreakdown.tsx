/**
 * W18 资源摘要（按厂商+模式分组）—— PRD §10.2 资源摘要。
 *
 * 厂商经营快照与主体 Grant 分列，前端只展示后端口径，不重算。
 * API 速度按金额/小时，套餐速度按额度/小时；不可计算原因不伪装成“无风险”。
 */
import type { ResourceBreakdownItem } from "../../api/types";
import type { ReactNode } from "react";
import { formatCount, formatDateTimeShort, formatMoney, formatRatePerHour } from "../../lib/format";
import { StatusTag } from "./StatusTag";

interface ResourceBreakdownProps {
  items: ResourceBreakdownItem[];
}

const MODE_LABEL: Record<ResourceBreakdownItem["mode"], string> = {
  API: "API",
  CODING_PLAN: "套餐",
};

const STATUS_LABEL: Record<string, string> = {
  HEALTHY: "正常",
  ACTIVE: "正常",
  DEGRADED: "降级",
  RATE_LIMITED: "限流冷却",
  UNAVAILABLE: "不可用",
  EXHAUSTED: "额度耗尽",
  EXPIRED: "已过期",
  CREDENTIAL_INVALID: "凭证失效",
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
            <th className="py-2 pr-4 text-right font-medium">厂商总额度</th>
            <th className="py-2 pr-4 text-right font-medium">厂商已用额度</th>
            <th className="py-2 pr-4 text-right font-medium">厂商剩余额度</th>
            <th className="py-2 pr-4 text-right font-medium">已分配给主体</th>
            <th className="py-2 pr-4 text-right font-medium">经营余额 / 套餐</th>
            <th className="py-2 pr-4 text-right font-medium">本月花费</th>
            <th className="py-2 pr-4 text-right font-medium">本月 Token</th>
            <th className="py-2 pr-4 text-right font-medium">消耗速度</th>
            <th className="py-2 pr-4 text-right font-medium">余额可承载 Token</th>
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
                {item.totalQuota === null ? "未录入/未同步" : `${formatCount(item.totalQuota)} ${item.quotaUnit ?? ""}`}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.usedQuota === null ? "—" : formatCount(item.usedQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.remainingQuota === null ? "—" : formatCount(item.remainingQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.allocatedQuota === null ? "—" : formatCount(item.allocatedQuota)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {item.mode === "API" ? (
                  <>{item.currentBalance === null
                    ? "余额待补"
                    : `${item.currency ?? ""} ${formatMoney(item.currentBalance)}`}
                    <span className="block text-[11px] text-ql-fg-tertiary">
                      API 花费 {item.monthlyCost === null
                        ? item.monthlyCostReason ?? "不可计算"
                        : `${item.currency ?? ""} ${formatMoney(item.monthlyCost)}`}
                    </span></>
                ) : (
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
                  : `${item.currency ?? ""} ${formatMoney(item.monthlyCost)}`}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {monthlyTokenText(item)}
                {item.modelTokenBreakdown.length > 0 ? (
                  <details className="mt-1 text-left text-[11px] text-ql-fg-tertiary">
                    <summary className="cursor-pointer text-ql-accent">按模型查看</summary>
                    <div className="mt-1 min-w-56 space-y-1">
                      {item.modelTokenBreakdown.map((model) => (
                        <div key={model.unifiedModelId ?? model.modelAlias}>
                          <span className="font-medium text-ql-fg-secondary">{model.modelAlias}</span>
                          <span className="ml-2">{model.totalTokens === null ? "Token 未知" : formatCount(model.totalTokens)}</span>
                          <span className="ml-2">{qualityLabel(model.usageQuality)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {usageRateText(item)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {balanceTokenEstimateText(item)}
              </td>
              <td className="py-2.5 pr-4 text-ql-fg-secondary">
                {forecastExhaustionText(item)}
              </td>
              <td className="py-2.5">
                <a href="/resources" title={item.abnormalResources.map((resource) =>
                  `${resource.resourceName}：${STATUS_LABEL[resource.status] ?? resource.status}`
                ).join("；") || "全部资源正常"}>
                  <StatusTag tone={statusTone(item.status)}>
                    {STATUS_LABEL[item.status] ?? item.status}
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
  return (
    <span title={`输入 ${item.monthlyInputTokens ?? "—"}；输出 ${item.monthlyOutputTokens ?? "—"}；缓存 ${item.monthlyCacheTokens ?? "—"}；推理 ${item.monthlyReasoningTokens ?? "—"}`}>
      {formatCount(item.monthlyTotalTokens)}
      <span className="block text-[11px] text-ql-fg-tertiary">{qualityLabel(item.monthlyUsageQuality)}</span>
      <span className="block text-[11px] text-ql-fg-tertiary">
        入 {formatCount(item.monthlyInputTokens ?? "0")} · 出 {formatCount(item.monthlyOutputTokens ?? "0")}
      </span>
      <span className="block text-[11px] text-ql-fg-tertiary">
        缓存 {formatCount(item.monthlyCacheTokens ?? "0")} · 推理 {formatCount(item.monthlyReasoningTokens ?? "0")}
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
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

const ESTIMATE_REASON: Record<string, string> = {
  BALANCE_MISSING: "余额未同步",
  RECENT_USAGE_MISSING: "最近24小时无用量",
  USAGE_UNKNOWN: "最近用量计量未知",
  CURRENT_PRICE_RULE_MISSING: "当前有效价格缺失",
  PRICE_CURRENCY_MISMATCH: "余额与价格币种不一致",
  CURRENT_PRICE_ZERO: "当前价格为零",
};

function balanceTokenEstimateText(item: ResourceBreakdownItem): ReactNode {
  if (item.mode !== "API") return "—";
  if (item.estimatedBalanceTokens === null) {
    return `不可计算：${ESTIMATE_REASON[item.balanceTokenEstimateReason ?? ""] ?? "数据不足"}`;
  }
  return (
    <span title={item.balanceTokenEstimateBasis ?? undefined}>
      约 {formatCount(item.estimatedBalanceTokens)}
      <span className="block text-[11px] text-ql-fg-tertiary">
        估算 · {item.balanceTokenEstimateConfidence ?? "LOW"}
      </span>
    </span>
  );
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
