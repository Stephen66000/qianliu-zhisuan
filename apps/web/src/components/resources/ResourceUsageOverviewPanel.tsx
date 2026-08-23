import { BarChart3 } from "lucide-react";

import { useResourceUsageOverview } from "../../api/hooks";
import type { ResourceModelUsageDetail } from "../../api/types";
import { formatCount, formatDateTimeShort, formatMoney } from "../../lib/format";
import { ResourceBreakdown } from "../dashboard/ResourceBreakdown";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";
import { useRedirectOnUnauthorized } from "../useRedirectOnUnauthorized";

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "正常",
  DEGRADED: "降级",
  RATE_LIMITED: "限流冷却",
  UNAVAILABLE: "不可用",
  EXHAUSTED: "额度耗尽",
  EXPIRED: "已过期",
  CREDENTIAL_INVALID: "凭证失效",
};

export function ResourceUsageOverviewPanel() {
  const query = useResourceUsageOverview();
  useRedirectOnUnauthorized(query.error);
  const data = query.data;
  return (
    <QueryGate
      emptyDescription="登记资源并产生已结算账本后显示厂商与模型用量。"
      emptyIcon={BarChart3}
      emptyTitle="暂无用量总览数据"
      error={query.error}
      isEmpty={data?.providerSummaries.length === 0}
      isLoading={query.isLoading}
      loadingRows={6}
      onRetry={() => void query.refetch()}
    >
      {data ? (
        <div className="space-y-5">
          <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
            <div className="mb-3">
              <h2 className="text-[15px] font-semibold text-ql-fg">厂商总体使用情况</h2>
              <p className="mt-1 text-[12px] text-ql-fg-tertiary">
                按厂商与模式汇总额度、费用、本月 Token、消耗速度和耗尽状态。
              </p>
            </div>
            <ResourceBreakdown items={data.providerSummaries} />
          </section>

          <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
            <div className="mb-3">
              <h2 className="text-[15px] font-semibold text-ql-fg">模型使用明细</h2>
              <p className="mt-1 text-[12px] text-ql-fg-tertiary">
                每行对应一个具体模型和具体资源；Coding Plan 剩余额度与耗尽时间属于共享资源。
              </p>
            </div>
            {data.modelDetails.length === 0 ? (
              <p className="py-5 text-center text-[13px] text-ql-fg-tertiary">暂无已登记模型</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[70rem] border-collapse text-left text-[12px]">
                  <thead>
                    <tr className="border-b border-ql-border text-ql-fg-tertiary">
                      <th className="py-2 pr-4 font-medium">模型</th>
                      <th className="py-2 pr-4 font-medium">所属厂商 / 资源</th>
                      <th className="py-2 pr-4 text-right font-medium">所属资源余额 / 剩余额度</th>
                      <th className="py-2 pr-4 text-right font-medium">本月花费</th>
                      <th className="py-2 pr-4 text-right font-medium">本月 Token</th>
                      <th className="py-2 pr-4 text-right font-medium">最近 24 小时速度</th>
                      <th className="py-2 pr-4 font-medium">所属资源预计耗尽</th>
                      <th className="py-2 font-medium">状态</th>
                    </tr>
                  </thead>
                  <tbody>{data.modelDetails.map((item) => (
                    <ModelUsageRow item={item} key={`${item.resourceId}:${item.unifiedModelId ?? item.modelAlias}`} />
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </QueryGate>
  );
}

function ModelUsageRow({ item }: { item: ResourceModelUsageDetail }) {
  return (
    <tr className="border-b border-ql-border-zone align-top text-ql-fg last:border-b-0 hover:bg-ql-surface-subtle">
      <td className="py-2.5 pr-4 font-medium">
        {item.modelAlias}
        {item.historicalUnattributed ? (
          <span className="block text-[10px] font-normal text-ql-fg-tertiary">历史旧标识 / 未归属具体模型</span>
        ) : null}
      </td>
      <td className="py-2.5 pr-4">
        {item.providerName} · {item.resourceName}
        <span className="block text-[10px] text-ql-fg-tertiary">
          {item.mode === "API" ? "API" : "Coding Plan"}
        </span>
      </td>
      <td className="py-2.5 pr-4 text-right font-mono">
        {item.remainingQuota === null
          ? "—"
          : item.mode === "API"
            ? `${item.currency ?? "CNY"} ${formatMoney(item.remainingQuota)}`
            : `${formatCount(item.remainingQuota)} ${item.quotaUnit ?? ""}`}
        {item.remainingQuota !== null ? (
          <span className="block font-sans text-[10px] text-ql-fg-tertiary">共享资源</span>
        ) : null}
      </td>
      <td className="py-2.5 pr-4 text-right">
        {item.monthlyCost === null
          ? <span className="text-ql-fg-tertiary">{item.monthlyCostReason ?? "不可计算"}</span>
          : <>{`${item.currency ?? ""} ${formatMoney(item.monthlyCost)}`}
            {item.monthlyCostReason ? (
              <span className="block text-[10px] text-ql-fg-tertiary">{item.monthlyCostReason}</span>
            ) : null}</>}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono">
        {modelTokenText(item)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono">
        {item.consumptionRate24h === null
          ? <span className="font-sans text-ql-fg-tertiary">{item.consumptionRateReason ?? "不可计算"}</span>
          : `${formatRate(item.consumptionRate24h)} ${item.consumptionRateUnit === "QUOTA_PER_HOUR" ? item.quotaUnit ?? "额度" : "Token"}/小时`}
      </td>
      <td className="py-2.5 pr-4">
        {item.forecastExhaustAt
          ? formatDateTimeShort(item.forecastExhaustAt)
          : item.forecastNotCalculableReason ?? "不可计算"}
        {item.forecastConfidence ? (
          <span className="block text-[10px] text-ql-fg-tertiary">可信度 {item.forecastConfidence}</span>
        ) : null}
      </td>
      <td className="py-2.5">
        <StatusTag tone={statusTone(item.status)}>{STATUS_LABEL[item.status] ?? item.status}</StatusTag>
      </td>
    </tr>
  );
}

function formatRate(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
    : value;
}

function modelTokenText(item: ResourceModelUsageDetail) {
  const unknown = item.unknownCount ?? 0;
  if (item.monthlyTotalTokens === null) return "Token 未知";
  if (item.monthlyTotalTokens === "0" && unknown > 0) {
    return <>
      <span className="font-sans">暂无成功计量</span>
      <span className="block font-sans text-[10px] text-ql-fg-tertiary">{unknown} 笔计量未知</span>
    </>;
  }
  return <>
    {formatCount(item.monthlyTotalTokens)}
    <span className="block font-sans text-[10px] text-ql-fg-tertiary">
      {unknown > 0 ? `已记录；另有 ${unknown} 笔计量未知` : qualityLabel(item.usageQuality)}
    </span>
  </>;
}

function qualityLabel(quality: ResourceModelUsageDetail["usageQuality"]): string {
  if (quality === "EXACT") return "精确计量";
  if (quality === "ESTIMATED") return "估算计量";
  return "计量未知";
}

function statusTone(status: string): "neutral" | "warning" | "danger" {
  if (status === "ACTIVE") return "neutral";
  if (status === "DEGRADED" || status === "RATE_LIMITED") return "warning";
  return "danger";
}
