import { BarChart3 } from "lucide-react";
import { useResourceUsageOverview } from "../../api/hooks";
import type { ResourceModelUsageDetail } from "../../api/types";
import { formatCount, formatDateTimeShort, formatDecimal, formatMoney } from "../../lib/format";
import { resourceStatusLabel } from "../../lib/resource-status";
import { ResourceBreakdown } from "../dashboard/ResourceBreakdown";
import { StatusTag } from "../dashboard/StatusTag";
import { QueryGate } from "../states/QueryGate";
import { ExpandableTableRow, RowDetail } from "../ui/ExpandableTableRow";
import { useRedirectOnUnauthorized } from "../useRedirectOnUnauthorized";

export function ResourceUsageOverviewPanel() {
  const query = useResourceUsageOverview();
  useRedirectOnUnauthorized(query.error);
  const data = query.data;
  return <QueryGate emptyDescription="登记资源并产生已结算账本后显示厂商与模型用量。" emptyIcon={BarChart3}
    emptyTitle="暂无用量总览数据" error={query.error} isEmpty={data?.providerSummaries.length === 0}
    isLoading={query.isLoading} loadingRows={6} onRetry={() => void query.refetch()}>
    {data ? <div className="space-y-5">
      <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ql-fg">厂商总体使用情况</h2>
          <span className="rounded-md bg-ql-surface-subtle px-2.5 py-1 text-[13px] text-ql-fg-secondary">
            统计周期：{data.generatedAt ? `${data.generatedAt.slice(0, 4)}年${data.generatedAt.slice(5, 7)}月（当月自然月）` : "当月自然月"}
          </span>
        </div>
        <ResourceBreakdown items={data.providerSummaries} scope={data.generatedAt} />
      </section>
      <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ql-fg">模型使用明细</h2>
          <span className="text-[13px] text-ql-fg-tertiary">包含当月已上架模型及产生过调用的历史模型</span>
        </div>
        {data.modelDetails.length === 0 ? <p className="py-5 text-center text-[13px] text-ql-fg-tertiary">暂无已登记模型</p> :
          <div className="overflow-x-auto"><table className="w-full min-w-[36rem] border-collapse text-left text-[13px]">
            <thead><tr className="whitespace-nowrap border-b border-ql-border text-ql-fg-tertiary">
              <th className="py-2 pr-3 font-medium">模型</th><th className="py-2 pr-3 font-medium">所属厂商 / 资源</th>
              <th className="py-2 pr-3 text-right font-medium">本月花费</th><th className="py-2 pr-3 text-right font-medium">本月 Token</th>
              <th className="py-2 font-medium" title="所属资源预计耗尽">状态 / 预计耗尽</th>
            </tr></thead>
            <tbody>{data.modelDetails.map((item) => <ModelUsageRow item={item} key={`${data.generatedAt}:${item.resourceId}:${item.unifiedModelId ?? item.modelAlias}`} />)}</tbody>
          </table></div>}
      </section>
    </div> : null}
  </QueryGate>;
}

function exhaustion(item: ResourceModelUsageDetail) {
  return item.forecastExhaustAt ? formatDateTimeShort(item.forecastExhaustAt) : item.forecastNotCalculableReason ?? "不可计算";
}

function ModelUsageRow({ item }: { item: ResourceModelUsageDetail }) {
  return <ExpandableTableRow columns={5} label={`${item.modelAlias} · ${item.resourceName}`}
    leading={<><span className="font-medium">{item.modelAlias}</span>{item.historicalUnattributed ?
      <span className="ml-1 whitespace-nowrap rounded-md bg-ql-surface-subtle px-1.5 py-0.5 text-[12px] text-ql-fg-tertiary">已下架</span> : null}</>}
    details={<>
      <RowDetail label="最近 24 小时速度">{item.consumptionRate24h === null ? item.consumptionRateReason ?? "不可计算"
        : `${formatDecimal(item.consumptionRate24h)} ${item.consumptionRateUnit === "QUOTA_PER_HOUR" ? item.quotaUnit ?? "额度" : "Token"}/小时`}</RowDetail>
      <RowDetail label="所属资源预计耗尽">{exhaustion(item)}{item.forecastConfidence ?
        <span className="block text-ql-fg-tertiary">可信度 {item.forecastConfidence}</span> : null}</RowDetail>
    </>}>
    <td className="py-2.5 pr-3 break-words">{item.providerName} · {item.resourceName}<span className="block text-ql-fg-tertiary">{item.mode === "API" ? "API" : "Coding Plan"}</span></td>
    <td className="py-2.5 pr-3 text-right">{item.mode === "CODING_PLAN" ? "不涉及" : item.monthlyCost === null ?
      <span className="text-ql-fg-tertiary">{item.monthlyCostReason ?? "不可计算"}</span> : <>{`${item.currency ?? ""} ${formatMoney(item.monthlyCost)}`}
        {item.monthlyCostReason ? <span className="block text-ql-fg-tertiary">{item.monthlyCostReason}</span> : null}</>}</td>
    <td className="py-2.5 pr-3 text-right font-mono">{modelTokenText(item)}</td>
    <td className="py-2.5"><span className="mb-1 block text-ql-fg-secondary">预计耗尽：{exhaustion(item)}</span>
      <StatusTag tone={item.historicalUnattributed ? "neutral" : statusTone(item.status)}>{item.historicalUnattributed ? "已下架" : resourceStatusLabel(item.status, item.mode)}</StatusTag>
    </td>
  </ExpandableTableRow>;
}

function modelTokenText(item: ResourceModelUsageDetail) {
  const unknown = item.unknownCount ?? 0;
  if (item.monthlyTotalTokens === null) return "Token 未知";
  if (item.monthlyTotalTokens === "0" && unknown > 0) return <><span className="font-sans">暂无成功计量</span><span className="block font-sans text-[13px] text-ql-fg-tertiary">{unknown} 笔计量未知</span></>;
  return <>{formatCount(item.monthlyTotalTokens)}{unknown > 0 ? <span className="block font-sans text-[13px] text-ql-fg-tertiary">已记录；另有 {unknown} 笔计量未知</span> : null}</>;
}

function statusTone(status: string): "neutral" | "warning" | "danger" {
  if (status === "ACTIVE") return "neutral";
  if (status === "DEGRADED" || status === "RATE_LIMITED") return "warning";
  return "danger";
}
