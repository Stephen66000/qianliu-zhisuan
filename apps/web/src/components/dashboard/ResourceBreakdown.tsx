/**
 * W18 资源摘要（按厂商+模式分组）—— PRD §10.2 资源摘要。
 *
 * 厂商经营快照与主体 Grant 分列，前端只展示后端口径，不重算。
 * API 速度按金额/小时，套餐速度按额度/小时；不可计算原因不伪装成“无风险”。
 */
import type { ResourceBreakdownItem } from "../../api/types";
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
            <th className="py-2 pr-4 text-right font-medium">余额/本期费用</th>
            <th className="py-2 pr-4 text-right font-medium">本月费用（元）</th>
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
                {item.currentBalance === null
                  ? "未录入/未同步"
                  : `${item.currency ?? ""} ${formatMoney(item.currentBalance)}`}
                {item.currentPeriodCost === null
                  ? null
                  : <span className="block text-[11px] text-ql-fg-tertiary">本期 {formatMoney(item.currentPeriodCost)}</span>}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {formatMoney(item.monthlyCost)}
              </td>
              <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
                {forecastRateText(item)}
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
