/**
 * W18 首页看板 —— 八项指标 + 资源摘要 + 超额列表 + 三态。
 *
 * 口径全部来自后端 GET /dashboard（TRD §12），前端只展示不重算。
 * 结构（仪表盘补充 §1-2）：Canvas → Zone（1-4 个，间距 20px）→ Card；
 * 核心区一页最多一个 = "当下关注"（超额与最早耗尽）。
 * 只显示当前自然月，不放同比/环比/趋势（TRD §12 行 746）。
 */
import { Inbox } from "lucide-react";

import { useDashboard } from "../api/hooks";
import { EarliestExhaustionCard } from "../components/dashboard/EarliestExhaustionCard";
import { MetricCard } from "../components/dashboard/MetricCard";
import { OverageList } from "../components/dashboard/OverageList";
import { ResourceBreakdown } from "../components/dashboard/ResourceBreakdown";
import { Zone } from "../components/dashboard/Zone";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatMoney } from "../lib/format";

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
        <Zone focus title="当下关注">
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
          <MetricCard label="本月 API 费用（元）" value={formatMoney(data.monthlyApiCost)} />
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
            label="最早耗尽资源"
            value={data.earliestExhaustion ? data.earliestExhaustion.resourceName : "无"}
          />
          <MetricCard
            label="预测可信度"
            value={
              data.earliestExhaustion
                ? data.earliestExhaustion.confidence
                : "—"
            }
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
