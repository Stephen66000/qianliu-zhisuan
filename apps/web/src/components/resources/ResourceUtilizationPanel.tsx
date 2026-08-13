import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "../../api/client";
import { QUERY_KEYS } from "../../api/hooks";
import { V2_KEYS, useResourceUtilization } from "../../api/v2-hooks";
import type { ProviderResourceItem } from "../../api/types";
import { formatMoney } from "../../lib/format";
import { QueryGate } from "../states/QueryGate";
import { Gauge } from "lucide-react";

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

export function ResourceUtilizationPanel({ resources }: { resources: ProviderResourceItem[] }) {
  const [month, setMonth] = useState(currentMonth);
  const [budgetTarget, setBudgetTarget] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const query = useResourceUtilization(month);
  const client = useQueryClient();
  const saveBudget = useMutation({
    mutationFn: () => {
      const resource = resources.find((item) => item.id === budgetTarget);
      if (!resource) throw new Error("资源不存在");
      return patch(`/provider-resources/${resource.id}`, {
        expected_version: resource.version,
        monthly_budget_amount: budget || null,
        monthly_budget_currency: budget ? "CNY" : null,
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: QUERY_KEYS.providerResources });
      await client.invalidateQueries({ queryKey: V2_KEYS.utilization(month) });
      setBudgetTarget(null); setBudget("");
    },
  });
  const rows = query.data?.resources ?? [];
  return <section className="mb-5 rounded-xl border border-ql-border-zone bg-ql-surface p-4" id="resource-utilization">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-[15px] font-semibold">资源利用事实</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">API 按实际费用 / 月预算；Coding Plan 分别展示厂商 5 小时和周窗口。闲置状态固定未判定。</p></div>
      <input aria-label="资源利用月份" className="ql-input" onChange={(event) => setMonth(event.target.value)} type="month" value={month}/>
    </div>
    <QueryGate emptyDescription="登记并产生资源事实后显示利用率。" emptyIcon={Gauge} emptyTitle="暂无资源利用数据" error={query.error} isEmpty={rows.length === 0} isLoading={query.isLoading} onRetry={() => void query.refetch()}>
      <div className="overflow-x-auto"><table className="w-full min-w-[88rem] text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="py-2">资源</th><th>形态 / 原生窗口</th><th className="text-right">请求 / 真实 Token</th><th className="text-right">费用 / 余额</th><th>利用率</th><th>耗尽 / 恢复 / 速度</th><th>最近使用 / 无调用</th><th>判断依据 / 数据时间</th><th>预算</th></tr></thead><tbody>{rows.map((row) => {
        const resource = resources.find((item) => item.id === row.resourceId);
        const forecastStale = row.forecastStatus === "STALE" || row.forecastNotCalculableReason === "FORECAST_STALE";
        const usageUrl = `/usage?provider_resource_id=${row.resourceId}&settled_only=true`;
        return <tr className="border-b border-ql-border-zone align-top" key={row.resourceId}>
          <td className="py-2 font-medium">{row.providerName} · {row.resourceName}<span className="mt-1 block whitespace-nowrap text-[10px]"><a className="text-ql-action" href={usageUrl}>账本明细</a>{row.mode === "CODING_PLAN" ? <> · <a className="text-ql-action" href="#quota-windows">额度窗口</a></> : null} · <a className="text-ql-action" href="#supply-forecasts">供给预测</a> · <a className="text-ql-action" href="#resource-health">资源健康</a></span></td>
          <td>{row.mode === "API" ? "API" : <div>Coding Plan{(["FIVE_HOUR", "WEEKLY"] as const).map((type) => { const window = row.quotaWindows.find((item) => item.type === type); return <span className="block whitespace-nowrap text-[10px] text-ql-fg-tertiary" key={type}>{type === "FIVE_HOUR" ? "5 小时" : "周"}：{window?.usedValue ?? "—"}/{window?.limitValue ?? "—"} {window?.unit ?? ""}{window ? ` · ${window.syncStatus}` : " · 厂商未提供"}</span>; })}</div>}</td>
          <td className="text-right font-mono">{row.requestCount} / {Number(row.realTokens).toLocaleString()}</td>
          <td className="text-right font-mono">{row.mode === "API" ? <>¥{formatMoney(row.apiCost)}<span className="block text-[10px] text-ql-fg-tertiary">余额 {row.currentBalance === null ? "未知" : `¥${formatMoney(row.currentBalance)}`}</span></> : <>{row.packageCost === null ? "套餐费用未知" : `¥${formatMoney(row.packageCost)}`}<span className="block text-[10px] text-ql-fg-tertiary">扣减 {Number(row.deductedQuota).toLocaleString()}</span></>}</td>
          <td>{row.utilizationRate === null ? "— / 未设置" : `${(Number(row.utilizationRate) * 100).toFixed(1)}%`}<span className="block text-[11px] text-ql-fg-tertiary">{row.utilizationBasis ?? row.utilizationStatus}</span></td>
          <td>{forecastStale ? "—" : row.forecastExhaustAt ? new Date(row.forecastExhaustAt).toLocaleString("zh-CN") : "—"}<span className="block text-[11px] text-ql-fg-tertiary">{forecastStale ? "STALE · 预测超过 15 分钟" : row.forecastNotCalculableReason ?? `恢复 ${row.nextRecoverAt ? new Date(row.nextRecoverAt).toLocaleString("zh-CN") : "—"} · 覆盖 ${row.coverageHours ?? "—"}h`}</span><span className="block text-[10px] text-ql-fg-tertiary">1h / 24h / 7d：{row.rate1h ?? "—"} / {row.rate24h ?? "—"} / {row.rate7d ?? "—"} · {row.forecastConfidence ?? "NOT_CALCULABLE"}</span></td>
          <td>{row.lastSettledRequestAt ? new Date(row.lastSettledRequestAt).toLocaleString("zh-CN") : "从未调用"}<span className="block text-[11px] text-ql-fg-tertiary">{row.continuousNoCallDays === null ? "无调用天数未知" : `连续 ${row.continuousNoCallDays} 天无调用`} · 未判定</span></td>
          <td>{row.notCalculableReason ?? (row.mode === "API" ? `预算 ¥${formatMoney(row.budgetAmount ?? "0")}` : `${row.utilizationStatus} · 厂商原生窗口`)}<span className="block text-[10px] text-ql-fg-tertiary">{row.dataAt ? new Date(row.dataAt).toLocaleString("zh-CN") : "数据时间未知"}</span></td>
          <td>{row.mode === "API" && resource ? budgetTarget === row.resourceId ? <div className="flex gap-1"><input aria-label={`${row.resourceName}月预算`} className="ql-input w-24" min="0.00000001" onChange={(event) => setBudget(event.target.value)} step="0.01" type="number" value={budget}/><button className="text-ql-action" disabled={saveBudget.isPending} onClick={() => saveBudget.mutate()} type="button">保存</button></div> : <button className="text-ql-action" onClick={() => { setBudgetTarget(row.resourceId); setBudget(row.budgetAmount ?? ""); }} type="button">{row.budgetAmount ? "修改" : "设置"}</button> : "—"}</td>
        </tr>;
      })}</tbody></table></div>
    </QueryGate>{saveBudget.error ? <p className="mt-2 text-[12px] text-ql-danger">{saveBudget.error.message}</p> : null}
  </section>;
}
