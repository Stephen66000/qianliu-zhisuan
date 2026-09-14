import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useUsageOverview } from "../../api/v2-hooks";
import { formatCount, formatMoney } from "../../lib/format";
import { ErrorState } from "../states/ErrorState";
import { LoadingState } from "../states/LoadingState";
import { usageInputClass } from "./UsageSearchField";
import { UsageSubjectPicker } from "./UsageSubjectPicker";

export function UsageOverviewPanel() {
  const [params, setParams] = useSearchParams();
  const subjectType = params.get("subject_type") === "PROJECT" ? "PROJECT" : "EMPLOYEE";
  const period = (["TODAY", "WEEK", "MONTH"].includes(params.get("period") ?? "") ? params.get("period") : "MONTH") as "TODAY" | "WEEK" | "MONTH";
  const subjectId = params.get("subject_id") ?? "";
  const [defaultAnchor] = useState(() => new Date().toISOString());
  const anchor = params.get("anchor") ?? defaultAnchor;
  const apiQuery = useMemo(() => { const query = new URLSearchParams({ subject_type: subjectType, period, anchor }); if (subjectId) query.set("subject_id", subjectId); return query.toString(); }, [subjectType, period, anchor, subjectId]);
  const query = useUsageOverview(apiQuery, 0);
  const set = (key: string, value: string) => { const next = new URLSearchParams(params); next.set("tab", "overview"); if (value) next.set(key, value); else next.delete(key); if (key === "subject_type") next.delete("subject_id"); setParams(next, { replace: true }); };
  const chooseRange = (nextPeriod: string, date: string) => {
    const nextAnchor = new Date(`${date}T12:00:00+08:00`).toISOString();
    if (period === nextPeriod && anchor === nextAnchor) { void query.refetch(); return; }
    const next = new URLSearchParams(params);
    next.set("tab", "overview"); next.set("period", nextPeriod); next.set("anchor", nextAnchor);
    setParams(next, { replace: true });
  };
  const today = () => new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  if (query.isLoading) return <LoadingState label="正在汇总周期用量…" rows={5}/>;
  if (query.error || !query.data) return <ErrorState message={query.error?.message ?? "周期用量加载失败"} onRetry={() => void query.refetch()}/>;
  const data = query.data;
  const metrics = [["活跃主体", formatCount(String(data.metrics.activeSubjects))], ["请求数", formatCount(data.metrics.requestCount)], ["token使用量", formatCount(data.metrics.realTokens)], ["API 费用", `¥${formatMoney(data.metrics.apiCost)}`], ["套餐扣减", formatCount(data.metrics.deductedQuota)]];
  const max = Math.max(1, ...data.trend.map((item) => Number(item.realTokens)));
  return <div className="space-y-3">
    <div className="rounded-lg border border-ql-border-zone bg-ql-surface-subtle p-3">
      <div className="grid grid-cols-2 items-start gap-2 lg:grid-cols-[88px_180px_148px_minmax(0,1fr)]">
        <select aria-label="用量主体类型" className={usageInputClass} onChange={(event) => set("subject_type", event.target.value)} value={subjectType}><option value="EMPLOYEE">员工</option><option value="PROJECT">项目</option></select>
        <div aria-label="用量周期" className="flex h-9 items-center gap-1" role="group">{([["TODAY", "今日"], ["WEEK", "本周"], ["MONTH", "本月"]] as const).map(([value, label]) => <button aria-pressed={period === value} className={`h-full flex-1 rounded border text-[12px] ${period === value ? "border-ql-action text-ql-action" : "border-ql-border-zone"}`} key={value} onClick={() => chooseRange(value, today())} type="button">{label}</button>)}</div>
        <input aria-label="用量锚点" className={`${usageInputClass} col-span-2 lg:col-span-1`} onChange={(event) => { if (event.target.value) chooseRange("TODAY", event.target.value); }} type="date" value={Number.isFinite(Date.parse(anchor)) ? new Date(Date.parse(anchor) + 8 * 60 * 60_000).toISOString().slice(0, 10) : today()}/>
        <div className="col-span-2 min-w-0 lg:col-span-1"><UsageSubjectPicker compact onChange={(value) => set("subject_id", value)} subjectType={subjectType} value={subjectId} /></div>
      </div>
    </div>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">{metrics.map(([label, value]) => <article className="min-w-0 rounded-lg border border-ql-border-zone bg-ql-surface px-3 py-2" key={label}><p className="text-[12px] text-ql-fg-tertiary">{label}</p><strong className="mt-1 block break-all font-mono text-[clamp(12px,1.4vw,20px)] font-semibold leading-7">{value}</strong></article>)}</div>
    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-3"><div className="flex items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">趋势</h2><p className="mt-1 text-[11px] text-ql-fg-tertiary">{new Date(data.range.from).toLocaleString("zh-CN")} — {new Date(data.range.to).toLocaleString("zh-CN")} · {data.timezone}</p></div><span className="text-right text-[11px] text-ql-fg-tertiary">数据时间 {new Date(data.generatedAt).toLocaleString("zh-CN")}</span></div><div className="mt-2 flex h-24 items-end gap-1 overflow-x-auto" aria-label="用量趋势图">{data.trend.map((item) => <div className="flex min-w-6 flex-1 flex-col items-center justify-end gap-1" key={item.bucketStart}><span className="text-[10px] text-ql-fg-tertiary">{Number(item.realTokens) ? formatCount(item.realTokens) : ""}</span><div className="w-full rounded-t bg-ql-action" style={{ height: `${Math.max(2, Number(item.realTokens) / max * 56)}px` }}/><span className="whitespace-nowrap text-[10px] text-ql-fg-tertiary">{item.label}</span></div>)}</div></section>
    <section className="overflow-hidden rounded-xl border border-ql-border-zone bg-ql-surface"><div className="flex items-center justify-between px-3 py-2"><h2 className="text-[15px] font-semibold">消耗排名</h2><Link className="text-[12px] text-ql-action" to={`?tab=details&subject_type=${data.detailQuery.subjectType}&settled_only=${String(data.detailQuery.settledOnly)}&status=SUCCEEDED&from=${encodeURIComponent(data.detailQuery.from)}&to_exclusive=${encodeURIComponent(data.detailQuery.toExclusive)}${data.detailQuery.principalId ? `&principal_id=${data.detailQuery.principalId}` : ""}${data.detailQuery.projectId ? `&project_id=${data.detailQuery.projectId}` : ""}`}>查看请求明细</Link></div><div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-y border-ql-border-zone bg-ql-surface-subtle text-ql-fg-tertiary"><th className="px-3 py-2">排名</th><th>主体</th><th>部门</th><th className="text-right">请求</th><th className="text-right">分配额度</th><th className="text-right">token使用量</th><th className="text-right">token使用率</th><th className="text-right">剩余额度</th><th className="pr-3 text-right">API 费用</th></tr></thead><tbody>{data.ranking.map((item, index) => {
      const allocatedQuotaNum = item.allocatedQuota ? Number(item.allocatedQuota) : 0;
      const usedTokensNum = Number(item.realTokens ?? 0);
      const usageRate = allocatedQuotaNum > 0 ? `${((usedTokensNum / allocatedQuotaNum) * 100).toFixed(1)}%` : "—";
      const remainingQuota = allocatedQuotaNum > 0 ? formatCount(String(Math.max(0, allocatedQuotaNum - usedTokensNum))) : "不限";
      return <tr className="border-b border-ql-border-zone" key={item.subjectId}><td className="px-3 py-2">{index + 1}</td><td><button className="text-ql-action" onClick={() => set("subject_id", item.subjectId)} type="button">{item.subjectName}</button></td><td>{item.departmentLabel ?? "—"}</td><td className="text-right">{formatCount(item.requestCount)}</td><td className="text-right font-mono">{allocatedQuotaNum > 0 ? formatCount(item.allocatedQuota!) : "不限"}</td><td className="text-right font-mono">{formatCount(item.realTokens)}</td><td className="text-right font-mono">{usageRate}</td><td className="text-right font-mono">{remainingQuota}</td><td className="pr-3 text-right">¥{formatMoney(item.apiCost)}</td></tr>;
    })}</tbody></table>{data.ranking.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本周期暂无已结算用量</p> : null}</div></section>
  </div>;
}
