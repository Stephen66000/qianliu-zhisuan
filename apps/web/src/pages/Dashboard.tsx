/**
 * 首页看板 —— 2.0 八项本月概览 + 员工周期用量。
 *
 * 口径全部来自后端 GET /dashboard（TRD §12），前端只展示不重算。
 * 结构（仪表盘补充 §1-2）：Canvas → Zone（1-4 个，间距 20px）→ Card；
 * 固定顺序：本月概览 → 资源摘要 → 员工消耗 Token；“需要处理”留在资源摘要内。
 */
import { Inbox } from "lucide-react";
import { Link } from "react-router-dom";

import { useDashboard } from "../api/hooks";
import type { DashboardSummary } from "../api/types";
import { DashboardEmployeeUsagePanel } from "../components/dashboard/DashboardEmployeeUsagePanel";
import { EarliestExhaustionCard } from "../components/dashboard/EarliestExhaustionCard";
import { MetricCard } from "../components/dashboard/MetricCard";
import { OverageList } from "../components/dashboard/OverageList";
import { ResourceBreakdown } from "../components/dashboard/ResourceBreakdown";
import { Zone } from "../components/dashboard/Zone";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { useFeatureFlags } from "../feature-flags";
import { formatCount, formatDateTimeShort, formatMoney, formatRatioAsPercent } from "../lib/format";

export function DashboardPage() {
  const featureFlags = useFeatureFlags();
  const query = useDashboard();
  useRedirectOnUnauthorized(query.error);

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-5">
        <DashboardHeader />
        <LoadingState label="正在加载本月看板数据…" rows={4} />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="flex flex-col gap-5">
        <DashboardHeader />
        <ErrorState
          message={query.error?.message ?? "看板数据加载失败"}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const data = query.data;
  const noResources = data.resourceAccountCount === 0;
  const hasAttention = data.overageList.length > 0 || data.earliestExhaustion !== null;

  return (
    <div className="flex flex-col gap-5">
      <DashboardHeader />

      <Zone
        description="八个指标统一展示；本月总支出 = 套餐支出 + API 花费。"
        title="本月概览"
      >
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <MetricCard
            hint="输入 + 输出，缓存和推理不重复累计"
            label="真实 Token 消耗"
            value={formatCount(data.monthlyTokenUsage.totalTokens)}
          />
          <MetricCard
            emptyText="数据源待接入"
            label="本月总支出"
            unit="元"
            value={data.monthlyTotalSpend === null ? null : formatMoney(data.monthlyTotalSpend)}
          />
          <MetricCard
            emptyText="数据源待接入"
            label="套餐支出"
            unit="元"
            value={data.monthlyPackagePayment === null ? null : formatMoney(data.monthlyPackagePayment)}
          />
          <MetricCard
            emptyText="待补期初余额"
            hint="期初余额 + 本月充值 - 期末余额；账本计价仅用于核对"
            label="API 花费"
            unit="元"
            value={data.monthlyApiCost === null ? null : formatMoney(data.monthlyApiCost)}
          />
          <MetricCard
            hint={`当前正在使用 ${data.currentInUseCount} 人`}
            label="活跃人数"
            unit="人"
            value={String(data.activeEmployeeCount)}
          />
          <MetricCard label="厂商接入账号" unit="个" value={String(data.resourceAccountCount)} />
          <MetricCard
            emptyText="数据源待接入"
            label="本月充值"
            unit="元"
            value={data.monthlyRechargeAmount === null ? null : formatMoney(data.monthlyRechargeAmount)}
          />
          <MetricCard
            hint={dispatchSavingHint(data)}
            label="本月调度节省"
            unit="元"
            value={formatMoney(data.monthlyDispatchSaving)}
          />
        </div>
      </Zone>

      <Zone
        description="完整保留 1.0 经营字段；“按模型查看”仍在本月 Token 单元格内下钻。"
        title="资源摘要"
      >
        <div className="space-y-4">
          <div className="grid gap-3 text-[13px] text-ql-fg-secondary md:grid-cols-2">
            <p className="rounded-lg bg-ql-surface-subtle px-3 py-2" data-testid="dashboard-earliest-exhaustion">
              {earliestExhaustionSummary(data)}
            </p>
            <p className="rounded-lg bg-ql-surface-subtle px-3 py-2" data-testid="dashboard-resource-status">
              资源状态：{resourceHealthSummary(data.resourceBreakdown)}
            </p>
          </div>

          {hasAttention ? (
            <section
              aria-labelledby="dashboard-attention-title"
              className="rounded-xl border border-ql-border p-5 shadow-ql-zone-focus"
            >
              <header className="mb-3">
                <h3 className="text-[15px] font-semibold text-ql-fg" id="dashboard-attention-title">
                  需要处理
                </h3>
                <p className="mt-0.5 text-[12px] text-ql-fg-tertiary">
                  仅显示当前有效主体的额度超额与资源耗尽风险；正常主体不会出现在这里。
                </p>
              </header>
              <div className="flex flex-col gap-4">
                {data.earliestExhaustion ? (
                  <EarliestExhaustionCard value={data.earliestExhaustion} />
                ) : null}
                {data.overageList.length > 0 ? <OverageList items={data.overageList} /> : null}
              </div>
            </section>
          ) : null}

          {noResources ? (
            <EmptyState
              description="尚未登记可用 AI 资源，无法产生模型和路由候选。请前往「厂商资源」登记 DeepSeek API、智谱或 Kimi 资源。"
              icon={Inbox}
              title="尚未登记厂商资源"
            />
          ) : (
            <ResourceBreakdown items={data.resourceBreakdown} />
          )}
        </div>
      </Zone>

      <Zone
        description="当前上海自然月；总量包含全部主体，员工排行只统计员工。总 Token = 输入 + 输出，缓存和推理为子集，不重复相加。"
        title="员工消耗 Token"
      >
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <div className="rounded-xl border border-ql-border bg-ql-surface-subtle p-4">
            <p className="text-[12px] text-ql-fg-tertiary">本月消耗 Token 总数</p>
            <p className="mt-2 font-mono text-[24px] font-semibold text-ql-fg">
              {formatCount(data.monthlyTokenUsage.totalTokens)}
            </p>
            <dl className="mt-3 space-y-1 text-[12px] text-ql-fg-secondary">
              <div className="flex justify-between"><dt>输入</dt><dd>{formatCount(data.monthlyTokenUsage.totalInputTokens)}</dd></div>
              <div className="flex justify-between"><dt>输出</dt><dd>{formatCount(data.monthlyTokenUsage.totalOutputTokens)}</dd></div>
              <div className="flex justify-between"><dt>缓存（输入子集）</dt><dd>{formatCount(data.monthlyTokenUsage.totalCacheTokens)}</dd></div>
              <div className="flex justify-between"><dt>推理（输出子集）</dt><dd>{formatCount(data.monthlyTokenUsage.totalReasoningTokens)}</dd></div>
            </dl>
          </div>
          {featureFlags.FEATURE_USAGE_OVERVIEW_V2 && data.employeeUsageOverview ? (
            <DashboardEmployeeUsagePanel initial={data.employeeUsageOverview} />
          ) : data.monthlyTokenUsage.employeeRanking.length === 0 ? (
            <EmptyState
              description="本月尚无员工已结算 Token；项目和测试主体不会进入员工排行。"
              icon={Inbox}
              title="暂无员工消耗"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[12px]">
                <thead><tr className="border-b border-ql-border text-ql-fg-tertiary">
                  <th className="p-2">排名</th><th className="p-2">员工</th>
                  <th className="p-2 text-right">输入</th><th className="p-2 text-right">输出</th>
                  <th className="p-2 text-right">缓存</th><th className="p-2 text-right">总量</th>
                  <th className="p-2 text-right">占全体</th>
                </tr></thead>
                <tbody>{data.monthlyTokenUsage.employeeRanking.map((item, index) => (
                  <tr className="border-b border-ql-border-zone" key={item.principalId}>
                    <td className="p-2">{index + 1}</td><td className="p-2 font-medium">{item.principalName}</td>
                    <td className="p-2 text-right font-mono">{formatCount(item.inputTokens)}</td>
                    <td className="p-2 text-right font-mono">{formatCount(item.outputTokens)}</td>
                    <td className="p-2 text-right font-mono">{formatCount(item.cacheTokens)}</td>
                    <td className="p-2 text-right font-mono font-semibold">{formatCount(item.totalTokens)}</td>
                    <td className="p-2 text-right">{formatRatioAsPercent(item.share)}</td>
                  </tr>
                ))}</tbody>
              </table>
              <div className="mt-3 text-right"><Link className="text-[13px] text-ql-action" to="/usage">
                查看完整用量账本
              </Link></div>
            </div>
          )}
        </div>
      </Zone>
    </div>
  );
}

function dispatchSavingHint(data: DashboardSummary) {
  const noEffectiveValue = Number(data.monthlyDispatchSaving) === 0
    && data.dispatchSavingBreakdown.potentialPeakSavingAmount === null
    && Number(data.dispatchSavingBreakdown.avoidedPeakDeduction) === 0;
  if (noEffectiveValue) return "本月无可计算的实际切换";
  return <>
    <span className="block">{data.dispatchSavingBreakdown.realizedReason ?? `已实现 ${data.dispatchSavingBreakdown.realizedSwitchCount} 次切换`}</span>
    <span className="block">潜在峰值：{data.dispatchSavingBreakdown.potentialPeakSavingAmount === null ? data.dispatchSavingBreakdown.potentialReason : `¥${formatMoney(data.dispatchSavingBreakdown.potentialPeakSavingAmount)}`}</span>
    <span className="block">避免高峰扣减：{formatCount(data.dispatchSavingBreakdown.avoidedPeakDeduction)} 额度点</span>
    {data.dispatchSavingBreakdown.rejectedRequestCount > 0 ? <span className="block">拒绝 {data.dispatchSavingBreakdown.rejectedRequestCount} 次，不计入已实现节省</span> : null}
  </>;
}

function DashboardHeader() {
  return (
    <header>
      {/* 仪表盘补充 §4：区块标题降为 16px 不属于页面最大字；页面主标题用 page-title token */}
      <h1 className="text-[28px] font-bold leading-9 text-ql-fg">首页看板</h1>
      <p className="mt-1 text-[13px] leading-5 text-ql-fg-tertiary">
        本账期 = 当前自然月报表周期，与各厂商资源的额度重置周期相互独立
      </p>
    </header>
  );
}

const CONFIDENCE_LABEL: Record<string, string> = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

function earliestExhaustionSummary(data: DashboardSummary): string {
  const value = data.earliestExhaustion;
  if (value) {
    const result = value.forecastExhaustAt
      ? formatDateTimeShort(value.forecastExhaustAt)
      : value.notCalculableReason ?? "不可计算";
    const confidence = CONFIDENCE_LABEL[value.confidence] ?? value.confidence;
    return `最早耗尽资源：${value.resourceName} · ${result} · 可信度${confidence}`;
  }
  const hasForecast = data.resourceBreakdown.some((item) => item.forecastConfidence !== null);
  return `最早耗尽资源：${hasForecast ? "暂无可计算结果" : "暂无预测快照"}`;
}

/** 资源状态聚合（PRD §10.2「资源可用状态和额度状态」）：任一非 HEALTHY 提示数量。 */
function resourceHealthSummary(items: DashboardSummary["resourceBreakdown"]): string {
  if (items.length === 0) {
    return "无资源";
  }
  const unhealthy = items.filter((i) => i.status !== "HEALTHY").length;
  if (unhealthy === 0) return "全部正常";
  const worst = items.find((item) => item.status === "CREDENTIAL_INVALID")?.status ??
    items.find((item) => item.status === "EXPIRED")?.status ??
    items.find((item) => item.status === "EXHAUSTED")?.status ??
    items.find((item) => item.status === "UNAVAILABLE")?.status ??
    items.find((item) => item.status === "RATE_LIMITED")?.status ??
    items.find((item) => item.status === "DEGRADED")?.status;
  const label = {
    CREDENTIAL_INVALID: "凭证失效",
    EXPIRED: "已过期",
    EXHAUSTED: "额度耗尽",
    UNAVAILABLE: "不可用",
    RATE_LIMITED: "限流冷却",
    DEGRADED: "降级",
  }[worst ?? ""];
  return `${unhealthy} 项需关注${label ? ` · ${label}` : ""}`;
}
