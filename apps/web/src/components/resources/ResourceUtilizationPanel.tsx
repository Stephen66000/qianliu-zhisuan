import { useEffect, useState } from "react";
import {
  useResourceMonthlyBudget,
  useResourceUtilization,
  useSaveResourceMonthlyBudget,
} from "../../api/v2-hooks";
import type { ProviderResourceItem } from "../../api/types";
import { formatMoney } from "../../lib/format";
import { QueryGate } from "../states/QueryGate";
import { Gauge } from "lucide-react";
import type { ResourceUtilization } from "../../api/v2-types";

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

function utilizationDisplay(row: ResourceUtilization) {
  const value = row.utilizationRate === null
    ? "— / 未设置"
    : `${(Number(row.utilizationRate) * 100).toFixed(1)}%`;
  const basis = row.notCalculableReason
    ? utilizationReason(row.notCalculableReason)
    : row.mode === "CODING_PLAN" && row.utilizationBasis
    ? "订阅周期累计"
    : row.utilizationBasis ?? row.utilizationStatus;
  return <>{value}<span className="block text-[11px] text-ql-fg-tertiary">{basis}</span></>;
}

function subscriptionDisplay(row: ResourceUtilization, month: string) {
  if (row.mode !== "CODING_PLAN") {
    return <>自然月<span className="block text-[10px] text-ql-fg-tertiary">{month}</span></>;
  }
  return <>{row.servicePeriodStart?.slice(0, 10) ?? "未知"}～{row.servicePeriodEnd?.slice(0, 10) ?? "未知"}<span className="block text-[10px] text-ql-fg-tertiary">按登记事实展示，不推断月订阅</span></>;
}

function utilizationBasisDisplay(row: ResourceUtilization): string {
  if (row.notCalculableReason) return utilizationReason(row.notCalculableReason);
  if (row.mode === "API") return `预算 ¥${formatMoney(row.budgetAmount ?? "0")}`;
  return `${row.utilizationStatus} · 订阅周期累计`;
}

function utilizationReason(reason: string): string {
  if (reason === "SUBSCRIPTION_PERIOD_START_NOT_AVAILABLE") return "缺少订阅开始日期";
  if (reason === "SUBSCRIPTION_PERIOD_END_NOT_AVAILABLE") return "缺少订阅结束日期";
  if (reason === "SUBSCRIPTION_QUOTA_FACT_NOT_AVAILABLE") return "缺少订阅额度事实";
  if (reason === "MONTHLY_BUDGET_NOT_CONFIGURED") return "未设置月预算";
  return reason;
}

function freshnessDisplay(row: ResourceUtilization) {
  const updatedAt = row.dataAt ? new Date(row.dataAt).toLocaleString("zh-CN") : "数据时间未知";
  const windows = row.quotaWindows.length
    ? row.quotaWindows.map((item) => `${item.type} ${item.syncStatus}`).join(" · ")
    : "厂商未提供";
  return <>{updatedAt}<span className="block text-[10px] text-ql-fg-tertiary">窗口新鲜度：{windows}</span></>;
}

export function ResourceUtilizationPanel({ resources: _resources }: { resources: ProviderResourceItem[] }) {
  const [month, setMonth] = useState(currentMonth);
  const [budgetTarget, setBudgetTarget] = useState<string | null>(null);
  const [budget, setBudget] = useState("");
  const [budgetCurrency, setBudgetCurrency] = useState("CNY");
  const query = useResourceUtilization(month);
  const budgetQuery = useResourceMonthlyBudget(budgetTarget, month);
  const saveBudget = useSaveResourceMonthlyBudget(budgetTarget, month);
  const currentBudget = budgetQuery.data?.current;
  useEffect(() => {
    const current = currentBudget;
    if (!current) return;
    setBudget(current.amount ?? "");
    setBudgetCurrency(current.currency ?? "CNY");
  }, [currentBudget]);
  const rows = query.data?.resources ?? [];
  const budgetRow = rows.find((row) => row.resourceId === budgetTarget) ?? null;
  const closeBudget = () => { setBudgetTarget(null); setBudget(""); setBudgetCurrency("CNY"); };
  const submitBudget = (clear = false) => saveBudget.mutate({
    amount: clear ? null : budget,
    currency: clear ? null : budgetCurrency,
    expected_version: budgetQuery.data?.current?.version ?? budgetRow?.budgetVersion ?? 0,
  }, { onSuccess: closeBudget });
  return <section className="mb-5 rounded-xl border border-ql-border-zone bg-ql-surface p-4" id="resource-utilization">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-[15px] font-semibold">资源利用事实</h2><p className="mt-1 text-[12px] text-ql-fg-tertiary">Coding Plan 业务利用率按订阅周期累计；5 小时和周窗口作为独立厂商权益事实保留。闲置状态固定未判定。</p></div>
      <input aria-label="资源利用月份" className="ql-input" onChange={(event) => setMonth(event.target.value)} type="month" value={month}/>
    </div>
    <QueryGate emptyDescription="登记并产生资源事实后显示利用率。" emptyIcon={Gauge} emptyTitle="暂无资源利用数据" error={query.error} isEmpty={rows.length === 0} isLoading={query.isLoading} onRetry={() => void query.refetch()}>
      <div className="overflow-x-auto"><table className="w-full min-w-[96rem] text-left text-[12px]"><thead><tr className="border-b border-ql-border text-ql-fg-tertiary"><th className="py-2">资源</th><th>形态 / 原生窗口</th><th className="text-right">请求 / 真实 Token</th><th className="text-right">费用 / 余额</th><th>套餐周期利用率</th><th>订阅周期</th><th>耗尽 / 恢复 / 速度</th><th>最近使用 / 无调用</th><th>判断依据</th><th>数据更新时间 / 新鲜度</th><th>预算</th></tr></thead><tbody>{rows.map((row) => {
        const forecastStale = row.forecastStatus === "STALE" || row.forecastNotCalculableReason === "FORECAST_STALE";
        const usageUrl = `/usage?provider_resource_id=${row.resourceId}&settled_only=true`;
        return <tr className="border-b border-ql-border-zone align-top" key={row.resourceId}>
          <td className="py-2 font-medium">{row.providerName} · {row.resourceName}<span className="mt-1 block whitespace-nowrap text-[10px]"><a className="text-ql-action" href={usageUrl}>账本明细</a>{row.mode === "CODING_PLAN" ? <> · <a className="text-ql-action" href="#quota-windows">额度窗口</a></> : null} · <a className="text-ql-action" href="#supply-forecasts">供给预测</a> · <a className="text-ql-action" href="#resource-health">资源健康</a></span></td>
          <td>{row.mode === "API" ? "API" : <div>Coding Plan{(["FIVE_HOUR", "WEEKLY"] as const).map((type) => { const window = row.quotaWindows.find((item) => item.type === type); return <span className="block whitespace-nowrap text-[10px] text-ql-fg-tertiary" key={type}>{type === "FIVE_HOUR" ? "5 小时" : "周"}：{window?.usedValue ?? "—"}/{window?.limitValue ?? "—"} {window?.unit ?? ""}{window ? ` · ${window.syncStatus}` : " · 厂商未提供"}</span>; })}</div>}</td>
          <td className="text-right font-mono">{row.requestCount} / {Number(row.realTokens).toLocaleString()}</td>
          <td className="text-right font-mono">{row.mode === "API" ? <>{row.apiCost === null ? "API 花费不可计算" : `¥${formatMoney(row.apiCost)}`}<span className="block text-[10px] text-ql-fg-tertiary">余额 {row.currentBalance === null ? "未知" : `¥${formatMoney(row.currentBalance)}`}</span></> : <>{row.packageCost === null ? "套餐费用未知" : `¥${formatMoney(row.packageCost)}`}<span className="block text-[10px] text-ql-fg-tertiary">扣减 {Number(row.deductedQuota).toLocaleString()}</span></>}</td>
          <td>{utilizationDisplay(row)}</td>
          <td>{subscriptionDisplay(row, month)}</td>
          <td>{forecastStale ? "—" : row.forecastExhaustAt ? new Date(row.forecastExhaustAt).toLocaleString("zh-CN") : "—"}<span className="block text-[11px] text-ql-fg-tertiary">{forecastStale ? "STALE · 预测超过 15 分钟" : row.forecastNotCalculableReason ?? `恢复 ${row.nextRecoverAt ? new Date(row.nextRecoverAt).toLocaleString("zh-CN") : "—"} · 覆盖 ${row.coverageHours ?? "—"}h`}</span><span className="block text-[10px] text-ql-fg-tertiary">1h / 24h / 7d：{row.rate1h ?? "—"} / {row.rate24h ?? "—"} / {row.rate7d ?? "—"} · {row.forecastConfidence ?? "NOT_CALCULABLE"}</span></td>
          <td>{row.lastSettledRequestAt ? new Date(row.lastSettledRequestAt).toLocaleString("zh-CN") : "从未调用"}<span className="block text-[11px] text-ql-fg-tertiary">{row.continuousNoCallDays === null ? "无调用天数未知" : `连续 ${row.continuousNoCallDays} 天无调用`} · 未判定</span></td>
          <td>{utilizationBasisDisplay(row)}</td>
          <td>{freshnessDisplay(row)}</td>
          <td>{row.mode === "API" ? <div>{row.budgetAmount ? <><span>{row.budgetCurrency} {formatMoney(row.budgetAmount)}</span><span className="block text-[10px] text-ql-fg-tertiary">差额 {row.budgetDifference === null ? "不可计算" : `${row.budgetCurrency} ${formatMoney(row.budgetDifference)}`}</span></> : null}<button className="block text-ql-action" onClick={() => { setBudgetTarget(row.resourceId); setBudget(row.budgetAmount ?? ""); setBudgetCurrency(row.budgetCurrency ?? row.currency ?? "CNY"); }} type="button">{row.budgetAmount ? "修改月预算" : "设置月预算"}</button></div> : "—"}</td>
        </tr>;
      })}</tbody></table></div>
    </QueryGate>
    {budgetTarget && budgetRow ? <section aria-label="API 资源月预算设置" className="mt-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-[14px] font-semibold">设置 API 资源月预算</h3><p className="mt-1 text-[11px] text-ql-fg-tertiary">预算只用于当月经营利用率，不改变 Gateway 权限、员工额度或历史账单。</p></div>
        <button className="text-[12px] text-ql-action" onClick={closeBudget} type="button">取消</button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <label className="text-[12px]">资源<input className="ql-input mt-1 w-full" disabled value={`${budgetRow.providerName} · ${budgetRow.resourceName}`} /></label>
        <label className="text-[12px]">预算月份<input className="ql-input mt-1 w-full" disabled type="month" value={month} /></label>
        <label className="text-[12px]">金额<input aria-label="月预算金额" className="ql-input mt-1 w-full" min="0.00000001" onChange={(event) => setBudget(event.target.value)} step="0.01" type="number" value={budget} /></label>
        <label className="text-[12px]">币种<select aria-label="月预算币种" className="ql-input mt-1 w-full" onChange={(event) => setBudgetCurrency(event.target.value)} value={budgetCurrency}><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        {budgetQuery.data?.current?.status === "ACTIVE" ? <button className="text-[12px] text-ql-danger" disabled={saveBudget.isPending} onClick={() => submitBudget(true)} type="button">清除本月预算</button> : null}
        <button className="rounded-lg bg-ql-action px-4 py-2 text-[12px] font-medium text-white disabled:opacity-50" disabled={!budget || saveBudget.isPending || budgetQuery.isLoading} onClick={() => submitBudget(false)} type="button">{saveBudget.isPending ? "保存中…" : "保存月预算"}</button>
      </div>
      {saveBudget.error || budgetQuery.error ? <p className="mt-2 text-[12px] text-ql-danger">{(saveBudget.error ?? budgetQuery.error)?.message}</p> : null}
      {budgetQuery.data?.history.length ? <details className="mt-4 text-[12px]"><summary className="cursor-pointer text-ql-action">查看历史版本</summary><ul className="mt-2 space-y-1 text-ql-fg-secondary">{budgetQuery.data.history.map((item) => <li key={item.id}>v{item.version} · {item.status === "CLEARED" ? "已清除" : `${item.currency} ${formatMoney(item.amount ?? "0")}`} · {item.createdBy} · {new Date(item.createdAt).toLocaleString("zh-CN")}</li>)}</ul></details> : null}
    </section> : null}
  </section>;
}
