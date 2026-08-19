import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useUsageOverview } from "../../api/v2-hooks";
import { formatCount, formatMoney } from "../../lib/format";
import { usageQualityText } from "../../lib/usage-quality";
import { ErrorState } from "../states/ErrorState";
import { LoadingState } from "../states/LoadingState";
import { UsageSubjectPicker } from "./UsageSubjectPicker";

export function UsageOverviewPanel() {
  const [params, setParams] = useSearchParams();
  const subjectType = params.get("subject_type") === "PROJECT" ? "PROJECT" : "EMPLOYEE";
  const period = (["TODAY", "WEEK", "MONTH"].includes(params.get("period") ?? "") ? params.get("period") : "MONTH") as "TODAY" | "WEEK" | "MONTH";
  const subjectId = params.get("subject_id") ?? "";
  const [defaultAnchor] = useState(() => new Date().toISOString());
  const anchor = params.get("anchor") ?? defaultAnchor;
  const apiQuery = useMemo(() => { const query = new URLSearchParams({ subject_type: subjectType, period, anchor }); if (subjectId) query.set("subject_id", subjectId); return query.toString(); }, [subjectType, period, anchor, subjectId]);
  const query = useUsageOverview(apiQuery);
  const set = (key: string, value: string) => { const next = new URLSearchParams(params); next.set("tab", "overview"); if (value) next.set(key, value); else next.delete(key); if (key === "subject_type") next.delete("subject_id"); setParams(next, { replace: true }); };
  if (query.isLoading) return <LoadingState label="正在汇总周期用量…" rows={5}/>;
  if (query.error || !query.data) return <ErrorState message={query.error?.message ?? "周期用量加载失败"} onRetry={() => void query.refetch()}/>;
  const data = query.data;
  const metrics = [["活跃主体", formatCount(String(data.metrics.activeSubjects))], ["请求数", formatCount(data.metrics.requestCount)], ["真实 Token", formatCount(data.metrics.realTokens)], ["API 费用", `¥${formatMoney(data.metrics.apiCost)}`], ["套餐扣减", formatCount(data.metrics.deductedQuota)]];
  const quality = usageQualityText(data.metrics);
  const max = Math.max(1, ...data.trend.map((item) => Number(item.realTokens)));
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-3 rounded-xl border border-ql-border-zone bg-ql-surface-subtle p-3">
      <select aria-label="用量主体类型" className="ql-input" onChange={(event) => set("subject_type", event.target.value)} value={subjectType}><option value="EMPLOYEE">员工</option><option value="PROJECT">项目</option></select>
      <select aria-label="用量周期" className="ql-input" onChange={(event) => set("period", event.target.value)} value={period}><option value="TODAY">今日</option><option value="WEEK">本周</option><option value="MONTH">本月</option></select>
      <UsageSubjectPicker onChange={(value) => set("subject_id", value)} subjectType={subjectType} value={subjectId} />
      <input aria-label="用量锚点" className="ql-input" onChange={(event) => set("anchor", new Date(`${event.target.value}T12:00:00+08:00`).toISOString())} type="date" value={anchor.slice(0, 10)}/>
    </div>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">{metrics.map(([label, value]) => <article className="rounded-xl border border-ql-border-zone bg-ql-surface p-4" key={label}><p className="text-[12px] text-ql-fg-tertiary">{label}</p><strong className="mt-2 block font-mono text-[24px]">{value}</strong>{label === "真实 Token" ? <p className="mt-1 text-[10px] text-ql-fg-tertiary">{quality}</p> : null}</article>)}</div>
    <section className="rounded-xl border border-ql-border-zone bg-ql-surface p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="text-[15px] font-semibold">趋势</h2><p className="mt-1 text-[11px] text-ql-fg-tertiary">{new Date(data.range.from).toLocaleString("zh-CN")} — {new Date(data.range.to).toLocaleString("zh-CN")} · {data.timezone}</p></div><span className={`text-right text-[11px] ${data.stale ? "text-ql-warning" : "text-ql-fg-tertiary"}`}>{data.source === "LIVE_LEDGER" ? "实时账本" : data.stale ? "聚合数据已滞后" : "聚合读模型"}<span className="block">数据时间 {new Date(data.generatedAt).toLocaleString("zh-CN")}</span></span></div><div className="mt-4 flex h-44 items-end gap-1 overflow-x-auto" aria-label="用量趋势图">{data.trend.map((item) => <div className="flex min-w-6 flex-1 flex-col items-center justify-end gap-1" key={item.bucketStart}><span className="text-[10px] text-ql-fg-tertiary">{Number(item.realTokens) ? formatCount(item.realTokens) : ""}</span><div className="w-full rounded-t bg-ql-action" style={{ height: `${Math.max(2, Number(item.realTokens) / max * 120)}px` }}/><span className="whitespace-nowrap text-[10px] text-ql-fg-tertiary">{item.label}</span></div>)}</div></section>
    <section className="overflow-hidden rounded-xl border border-ql-border-zone bg-ql-surface"><div className="flex items-center justify-between p-4"><h2 className="text-[15px] font-semibold">消耗排名</h2><Link className="text-[12px] text-ql-action" to={`?tab=details&subject_type=${data.detailQuery.subjectType}&settled_only=${String(data.detailQuery.settledOnly)}&from=${encodeURIComponent(data.detailQuery.from)}&to_exclusive=${encodeURIComponent(data.detailQuery.toExclusive)}${data.detailQuery.principalId ? `&principal_id=${data.detailQuery.principalId}` : ""}${data.detailQuery.projectId ? `&project_id=${data.detailQuery.projectId}` : ""}`}>查看请求明细</Link></div><div className="overflow-x-auto"><table className="w-full text-left text-[12px]"><thead><tr className="border-y border-ql-border-zone bg-ql-surface-subtle text-ql-fg-tertiary"><th className="p-3">排名</th><th>主体</th><th>部门</th><th className="text-right">请求</th><th className="text-right">真实 Token</th><th className="pr-3 text-right">API 费用</th></tr></thead><tbody>{data.ranking.map((item, index) => <tr className="border-b border-ql-border-zone" key={item.subjectId}><td className="p-3">{index + 1}</td><td><button className="text-ql-action" onClick={() => set("subject_id", item.subjectId)} type="button">{item.subjectName}</button></td><td>{item.departmentLabel ?? "—"}</td><td className="text-right">{formatCount(item.requestCount)}</td><td className="text-right font-mono">{formatCount(item.realTokens)}</td><td className="pr-3 text-right">¥{formatMoney(item.apiCost)}</td></tr>)}</tbody></table>{data.ranking.length === 0 ? <p className="p-6 text-center text-[13px] text-ql-fg-tertiary">本周期暂无已结算用量</p> : null}</div></section>
  </div>;
}
