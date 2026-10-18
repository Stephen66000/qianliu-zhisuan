import { useEffect, useState } from "react";
import {
  useResourceMonthlyBudget,
  useResourceUtilization,
  useSaveResourceMonthlyBudget,
} from "../../api/v2-hooks";
import type { ProviderResourceItem } from "../../api/types";
import { formatCount, formatDecimal, formatMoney } from "../../lib/format";
import { QueryGate } from "../states/QueryGate";
import { Gauge } from "lucide-react";
import type { ResourceUtilization } from "../../api/v2-types";
import { ExpandableTableRow, RowDetail } from "../ui/ExpandableTableRow";
import { Button } from "../ui/Button";

function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);
}

function utilizationDisplay(row: ResourceUtilization) {
  const fact = row.tokenUtilization;
  if (!fact) return <span title="暂无利用率数据">—</span>;
  const reason = fact.unavailableReason === "INSUFFICIENT_HISTORY" ? "暂无完整历史自然月"
    : fact.unavailableReason === "ZERO_BASELINE" ? "历史月均为 0" : null;
  const average = fact.trailingThreeMonthAverageTokens === null ? "—" : formatDecimal(fact.trailingThreeMonthAverageTokens);
  const monthLabel = fact.baselineMonthCount > 0 ? `近 ${fact.baselineMonthCount} 个完整月` : "历史完整月";
  const months = fact.baselineMonths.length > 0 ? `（${fact.baselineMonths.join("、")}）` : "";
  const title = `本月真实 Token ${formatCount(fact.currentMonthTokens)} / ${monthLabel}月均 Token ${average}${months}${reason ? `；${reason}` : ""}`;
  return <span title={title}>{fact.rate === null ? "—" : utilizationPercent(fact.rate)}</span>;
}

/** One-decimal percent, rounded half-up in decimal rather than through binary floating point. */
function utilizationPercent(rate: string): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(rate);
  if (!match) return "—";
  const fraction = match[2] ?? "";
  const tenths = BigInt(match[1]!) * 1000n + BigInt((fraction + "000").slice(0, 3));
  const rounded = (fraction[3] ?? "0") >= "5" ? tenths + 1n : tenths;
  return `${rounded / 10n}.${rounded % 10n}%`;
}

function subscriptionDisplay(row: ResourceUtilization) {
  if (row.mode !== "CODING_PLAN") {
    return "—";
  }
  return <>{row.servicePeriodStart?.slice(0, 10) ?? "未知"}～{row.servicePeriodEnd?.slice(0, 10) ?? "未知"}</>;
}

function recentUsageDisplay(row: ResourceUtilization) {
  if (!row.lastSettledRequestAt) return "暂无结算用量";
  const time = new Date(row.lastSettledRequestAt).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
  });
  if (row.continuousNoCallDays === 0) {
    return <>{time}<span className="block text-[13px] text-ql-success">今日有使用</span></>;
  }
  return <>{time}<span className="block text-[13px] text-ql-fg-tertiary">
    {row.continuousNoCallDays === null ? "距最近使用时间未知" : `距最近使用 ${row.continuousNoCallDays} 天`}
  </span></>;
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
      <div><h2 className="text-[15px] font-semibold">资源利用事实</h2></div>
      <input aria-label="资源利用月份" className="ql-input" onChange={(event) => { setMonth(event.target.value); closeBudget(); }} type="month" value={month}/>
    </div>
    <QueryGate emptyDescription="登记并产生资源事实后显示利用率。" emptyIcon={Gauge} emptyTitle="暂无资源利用数据" error={query.error} isEmpty={rows.length === 0} isLoading={query.isLoading} onRetry={() => void query.refetch()}>
      <div className="overflow-x-auto"><table className="w-full min-w-[36rem] text-left text-[13px] [&_th]:whitespace-nowrap [&_th]:pr-3 [&_td]:py-2.5 [&_td]:pr-3">
        <thead><tr className="border-b border-ql-border text-ql-fg-tertiary">
          <th scope="col" className="py-2">资源 / 形态</th><th scope="col" className="text-right">请求 / 真实 Token</th>
          <th scope="col" className="text-right">费用</th><th scope="col">利用率 / 无调用</th><th scope="col">预算 / 差额</th>
        </tr></thead>
        <tbody>{rows.map((row) => <ExpandableTableRow key={`${month}:${query.data?.generatedAt ?? ""}:${row.resourceId}`} columns={5}
          label={`${row.providerName} · ${row.resourceName}`}
          leading={<><span className="font-medium">{row.providerName} · {row.resourceName}</span><span className="block text-ql-fg-tertiary">{row.mode === "API" ? "API" : "Coding Plan"}</span></>}
          details={<>
            <RowDetail label="订阅周期">{subscriptionDisplay(row)}</RowDetail>
            <RowDetail label="分配额度">{row.mode !== "CODING_PLAN" ? "—" : row.allocatedQuota ? `${formatCount(row.allocatedQuota)} ${row.quotaUnit ?? ""}` : row.totalQuota === null ? "待补" : `${formatCount(row.totalQuota)} ${row.quotaUnit ?? ""}`}</RowDetail>
            <RowDetail label="最近使用 / 无调用">{recentUsageDisplay(row)}</RowDetail>
            <RowDetail label="利用率口径"><p className="text-ql-fg-secondary">本月真实 Token / 近最多三个完整自然月月均真实 Token</p>
              {row.tokenUtilization ? <p className="text-ql-fg-secondary">本月 {formatCount(row.tokenUtilization.currentMonthTokens)}；历史月均 {row.tokenUtilization.trailingThreeMonthAverageTokens === null ? "—" : formatDecimal(row.tokenUtilization.trailingThreeMonthAverageTokens)}；基准月 {row.tokenUtilization.baselineMonths.join("、") || "暂无完整历史自然月"}</p> : null}
            </RowDetail>
            <RowDetail label="预算差额">{row.mode !== "API" ? "—" : row.budgetDifference === null ? "不可计算" : `${row.budgetCurrency} ${formatMoney(row.budgetDifference)}`}</RowDetail>
          </>}
        >
          <td className="text-right font-mono">{row.requestCount} / {formatCount(row.realTokens)}</td>
          <td className="text-right font-mono">{row.mode === "API" ? row.apiCost === null ? "API 花费不可计算" : `${row.currency ?? "CNY"} ${formatMoney(row.apiCost)}` : row.packageCost === null ? "套餐费用未知" : `${row.currency ?? "CNY"} ${formatMoney(row.packageCost)}`}</td>
          <td>{utilizationDisplay(row)}<span className="block text-ql-fg-tertiary">{!row.lastSettledRequestAt ? "暂无结算用量" : row.continuousNoCallDays === null ? "距最近使用时间未知" : row.continuousNoCallDays === 0 ? "今日有使用" : `距最近使用 ${row.continuousNoCallDays} 天`}</span></td>
          <td>{row.mode === "API" ? <div>{row.budgetAmount ? <><span>{row.budgetCurrency} {formatMoney(row.budgetAmount)}</span><span className="block text-ql-fg-tertiary">差额 {row.budgetDifference === null ? "不可计算" : `${row.budgetCurrency} ${formatMoney(row.budgetDifference)}`}</span></> : <span className="block text-ql-fg-tertiary">未设置预算</span>}
            <Button data-write-action variant="ghost" size="sm" onClick={() => { setBudgetTarget(row.resourceId); setBudget(row.budgetAmount ?? ""); setBudgetCurrency(row.budgetCurrency ?? row.currency ?? "CNY"); }}>{row.budgetAmount ? "修改月预算" : "设置月预算"}</Button>
          </div> : "—"}</td>
        </ExpandableTableRow>)}</tbody>
      </table></div>
    </QueryGate>
    {budgetTarget && budgetRow ? <section data-write-action aria-label="API 资源月预算设置" className="mt-4 rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-[14px] font-semibold">设置 API 资源月预算</h3><p className="mt-1 text-[13px] text-ql-fg-tertiary">预算只用于当月经营利用率，不改变 Gateway 权限、员工额度或历史账单。</p></div>
        <Button size="sm" variant="ghost" onClick={closeBudget}>取消</Button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <label className="text-[13px]">资源<input className="ql-input mt-1 w-full" disabled value={`${budgetRow.providerName} · ${budgetRow.resourceName}`} /></label>
        <label className="text-[13px]">预算月份<input className="ql-input mt-1 w-full" disabled type="month" value={month} /></label>
        <label className="text-[13px]">金额<input aria-label="月预算金额" className="ql-input mt-1 w-full" min="0.00000001" onChange={(event) => setBudget(event.target.value)} step="0.01" type="number" value={budget} /></label>
        <label className="text-[13px]">币种<select aria-label="月预算币种" className="ql-input mt-1 w-full" onChange={(event) => setBudgetCurrency(event.target.value)} value={budgetCurrency}><option value="CNY">CNY</option><option value="USD">USD</option></select></label>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        {budgetQuery.data?.current?.status === "ACTIVE" ? <Button variant="secondary" disabled={saveBudget.isPending} onClick={() => submitBudget(true)}>清除本月预算</Button> : null}
        <Button loading={saveBudget.isPending} loadingText="保存中…" data-write-action variant="primary" disabled={!budget || saveBudget.isPending || budgetQuery.isLoading} onClick={() => submitBudget(false)} type="button">保存月预算</Button>
      </div>
      {saveBudget.error || budgetQuery.error ? <p className="mt-2 text-[13px] text-ql-danger">{(saveBudget.error ?? budgetQuery.error)?.message}</p> : null}
      {budgetQuery.data?.history.length ? <details className="mt-4 text-[13px]"><summary className="cursor-pointer text-ql-action">查看历史版本</summary><ul className="mt-2 space-y-1 text-ql-fg-secondary">{budgetQuery.data.history.map((item) => <li key={item.id}>v{item.version} · {item.status === "CLEARED" ? "已清除" : `${item.currency} ${formatMoney(item.amount ?? "0")}`} · {item.createdBy} · {new Date(item.createdAt).toLocaleString("zh-CN")}</li>)}</ul></details> : null}
    </section> : null}
  </section>;
}
