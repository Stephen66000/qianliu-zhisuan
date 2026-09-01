import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useUsageOverview } from "../../api/v2-hooks";
import type { UsageOverview } from "../../api/v2-types";
import { formatCount, formatMoney, formatRatioAsPercent } from "../../lib/format";
import { ErrorState } from "../states/ErrorState";
import { LoadingState } from "../states/LoadingState";
import { UsageSubjectPicker } from "../usage/UsageSubjectPicker";

type UsagePeriod = "TODAY" | "WEEK" | "MONTH";

export function DashboardEmployeeUsagePanel({ initial }: { initial: UsageOverview }) {
  const [params, setParams] = useSearchParams();
  const [anchor] = useState(() => initial.anchor || new Date().toISOString());
  const rawPeriod = params.get("dashboard_usage_period");
  const period = (["TODAY", "WEEK", "MONTH"].includes(rawPeriod ?? "") ? rawPeriod : "TODAY") as UsagePeriod;
  const subjectId = params.get("dashboard_usage_subject_id") ?? "";
  const apiQuery = useMemo(() => {
    const query = new URLSearchParams({ subject_type: "EMPLOYEE", period, anchor });
    if (subjectId) query.set("subject_id", subjectId);
    return query.toString();
  }, [anchor, period, subjectId]);
  const query = useUsageOverview(apiQuery);
  const isInitialView = period === "TODAY" && !subjectId;
  const data = query.data ?? (isInitialView ? initial : undefined);

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };

  if (query.isLoading && !data) return <LoadingState label="正在加载员工用量趋势…" rows={4} />;
  if ((query.error || !data) && !isInitialView) {
    return <ErrorState message={query.error?.message ?? "员工用量趋势加载失败"} onRetry={() => void query.refetch()} />;
  }
  if (!data) return null;

  const max = Math.max(1, ...data.trend.map((item) => Number(item.realTokens)));
  const periodLabel = { TODAY: "今日", WEEK: "本周", MONTH: "本月" }[period];

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="首页员工用量周期"
          className="ql-input"
          onChange={(event) => setFilter("dashboard_usage_period", event.target.value)}
          value={period}
        >
          <option value="TODAY">今日</option>
          <option value="WEEK">本周</option>
          <option value="MONTH">本月</option>
        </select>
        <UsageSubjectPicker
          onChange={(value) => setFilter("dashboard_usage_subject_id", value)}
          searchLabel="搜索首页员工"
          selectLabel="首页指定员工"
          subjectType="EMPLOYEE"
          value={subjectId}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-[12px]">
        <div className="rounded-lg bg-ql-surface-subtle p-3"><span className="text-ql-fg-tertiary">活跃员工</span><strong className="mt-1 block font-mono text-[16px]">{data.metrics.activeSubjects}</strong></div>
        <div className="rounded-lg bg-ql-surface-subtle p-3"><span className="text-ql-fg-tertiary">请求</span><strong className="mt-1 block font-mono text-[16px]">{formatCount(data.metrics.requestCount)}</strong></div>
        <div className="rounded-lg bg-ql-surface-subtle p-3"><span className="text-ql-fg-tertiary">API 费用</span><strong className="mt-1 block font-mono text-[16px]">¥{formatMoney(data.metrics.apiCost)}</strong></div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-medium text-ql-fg">{subjectId ? `单员工${periodLabel}趋势` : `员工${periodLabel}趋势`}</p>
          <span className="text-[10px] text-ql-fg-tertiary">{data.timezone} · {data.source === "LIVE_LEDGER" ? "实时账本" : "聚合读模型"}</span>
        </div>
        <div aria-label="首页员工用量趋势图" className="mt-2 flex h-32 items-end gap-1 overflow-x-auto">
          {data.trend.map((item) => {
            const value = Number(item.realTokens);
            const hasUsage = value > 0;
            const valueLabel = hasUsage || item.collectionStatus === "COMPLETE"
              ? formatCount(item.realTokens)
              : "未采集";
            return <div className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1" key={item.bucketStart}>
              <span className="whitespace-nowrap text-[9px] text-ql-fg-secondary">{valueLabel}</span>
              <div className="flex h-[88px] w-full items-end justify-center">
                {hasUsage ? <div
                  aria-label={`${item.label} 消耗 ${valueLabel}`}
                  className="w-full rounded-t bg-ql-action"
                  title={`${item.label}: ${valueLabel}${item.collectionStatus === "MISSING" ? "（仍在采集）" : ""}`}
                  style={{ height: `${Math.max(6, value / max * 88)}px` }}
                /> : null}
              </div>
              <span className="whitespace-nowrap text-[9px] text-ql-fg-tertiary">{item.label}</span>
            </div>;
          })}
        </div>
      </div>

      {data.ranking.length === 0 ? (
        <p className="rounded-lg bg-ql-surface-subtle p-5 text-center text-[12px] text-ql-fg-tertiary">{periodLabel}暂无员工已结算用量</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead><tr className="border-b border-ql-border text-ql-fg-tertiary">
              <th className="p-2">排名</th><th className="p-2">员工</th>
              <th className="p-2 text-right">输入</th><th className="p-2 text-right">输出</th>
              <th className="p-2 text-right">缓存</th><th className="p-2 text-right">总量</th>
              <th className="p-2 text-right">占比</th>
            </tr></thead>
            <tbody>{data.ranking.map((item, index) => (
              <tr className="border-b border-ql-border-zone" key={item.subjectId}>
                <td className="p-2">{index + 1}</td>
                <td className="p-2"><button className="font-medium text-ql-action" onClick={() => setFilter("dashboard_usage_subject_id", item.subjectId)} type="button">{item.subjectName}</button></td>
                <td className="p-2 text-right font-mono">{formatCount(item.inputTokens)}</td>
                <td className="p-2 text-right font-mono">{formatCount(item.outputTokens)}</td>
                <td className="p-2 text-right font-mono">{formatCount(item.cacheTokens)}</td>
                <td className="p-2 text-right font-mono font-semibold">{formatCount(item.realTokens)}</td>
                <td className="p-2 text-right">{formatRatioAsPercent(item.share)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="text-right">
        <Link className="text-[13px] text-ql-action" to={`/usage?tab=overview&subject_type=EMPLOYEE&period=${period}&anchor=${encodeURIComponent(anchor)}${subjectId ? `&subject_id=${subjectId}` : ""}`}>查看完整员工用量</Link>
      </div>
    </div>
  );
}
