/**
 * W18 首页看板 —— 八项指标 + 资源摘要 + 超额列表 + 三态。
 *
 * 口径全部来自后端 GET /dashboard（TRD §12），前端只展示不重算。
 * 结构（仪表盘补充 §1-2）：Canvas → Zone（1-4 个，间距 20px）→ Card；
 * 核心区一页最多一个 = "需要处理"（有效主体超额与最早耗尽）。
 * 只显示当前自然月，不放同比/环比/趋势（TRD §12 行 746）。
 */
import { Inbox } from "lucide-react";
import { Link } from "react-router-dom";

import { useDashboard } from "../api/hooks";
import type { DashboardSummary } from "../api/types";
import { EarliestExhaustionCard } from "../components/dashboard/EarliestExhaustionCard";
import { MetricCard } from "../components/dashboard/MetricCard";
import { OverageList } from "../components/dashboard/OverageList";
import { ResourceBreakdown } from "../components/dashboard/ResourceBreakdown";
import { Zone } from "../components/dashboard/Zone";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatCount, formatMoney, formatRatioAsPercent } from "../lib/format";

export function DashboardPage() {
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

      {/* 核心区（一页最多一个）：当下需要关注的信号 —— 超额 + 最早耗尽 */}
      {hasAttention ? (
        <Zone
          description="仅显示当前有效主体的额度超额，以及厂商资源耗尽风险；正常使用中的主体不会出现在这里。"
          focus
          title="需要处理"
        >
          <div className="flex flex-col gap-4">
            {data.earliestExhaustion ? (
              <EarliestExhaustionCard value={data.earliestExhaustion} />
            ) : null}
            {data.overageList.length > 0 ? <OverageList items={data.overageList} /> : null}
          </div>
        </Zone>
      ) : null}

      {/* 本月概览：八项指标（④⑥ 数据源 gap → null 空状态，不伪造） */}
      <Zone description="当前自然月，不含同比/环比" title="本月概览">
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <MetricCard label="厂商资源账号" unit="个" value={String(data.resourceAccountCount)} />
          <MetricCard
            hint={`当前正在使用 ${data.currentInUseCount} 人`}
            label="本账期活跃人数"
            unit="人"
            value={String(data.activeEmployeeCount)}
          />
          <MetricCard
            emptyText="数据源待接入"
            label="本月套餐支付（元）"
            value={data.monthlyPackagePayment === null ? null : formatMoney(data.monthlyPackagePayment)}
          />
          <MetricCard
            hint="仅 API 模式调用的系统账本；厂商当前账期费用在下方资源摘要单列"
            label="本月 API 调用费用（元）"
            value={formatMoney(data.monthlyApiCost)}
          />
          <MetricCard
            emptyText="数据源待接入"
            label="本月充值（元）"
            value={data.monthlyRechargeAmount === null ? null : formatMoney(data.monthlyRechargeAmount)}
          />
          <MetricCard
            accent
            label="本月调度节省（元）"
            value={formatMoney(data.monthlyDispatchSaving)}
          />
          <MetricCard
            hint={
              data.earliestExhaustion
                ? `可信度 ${CONFIDENCE_LABEL[data.earliestExhaustion.confidence] ?? data.earliestExhaustion.confidence}`
                : undefined
            }
            label="最早耗尽资源"
            value={data.earliestExhaustion
              ? data.earliestExhaustion.resourceName
              : data.resourceBreakdown.some((item) => item.forecastConfidence !== null)
                ? "暂无可计算结果"
                : "暂无预测快照"}
          />
          <MetricCard
            hint="各厂商+模式资源状态聚合见下方资源摘要"
            label="资源状态"
            value={resourceHealthSummary(data.resourceBreakdown)}
          />
        </div>
      </Zone>

      {/* 资源摘要（按厂商+模式） */}
      <Zone title="资源摘要">
        {noResources ? (
          /* PRD §10.4：新企业没有厂商资源 → 说明为什么为空 + 下一步 */
          <EmptyState
            description="尚未登记可用 AI 资源，无法产生模型和路由候选。请前往「厂商资源」登记 DeepSeek API、智谱或 Kimi 资源。"
            icon={Inbox}
            title="尚未登记厂商资源"
          />
        ) : (
          <ResourceBreakdown items={data.resourceBreakdown} />
        )}
      </Zone>

      <Zone
        description="当前上海自然月；总量包含全部主体，员工排行只统计员工。总 Token = 输入 + 输出，缓存和推理为子集，不重复相加。"
        title="员工 Token 消耗"
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
          {data.monthlyTokenUsage.employeeRanking.length === 0 ? (
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
