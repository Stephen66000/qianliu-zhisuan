/**
 * 首页看板 —— 标准版两分区（HOME-STANDARD-20260910 WP03）。
 *
 * 分区 1「本月概览」：本月 Token、本月费用、本月活跃员工、本月活跃项目四张卡片，
 * Token 为本视窗唯一青色焦点；每卡提供上月同期参照（同期可比性规则见
 * standard-home-model.ts）。分区 2「接入资源」：完整厂商清单 + 调用状态 + 关注信息。
 * 数据全部来自 GET /dashboard/home 后端聚合（口径与各目的页同源，见 contract.md），
 * 前端只格式化；五个跳转以计划第 3 节为准，经真实路由工具生成。
 */
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { useStandardHome } from "../api/hooks";
import { OverviewMetricCard } from "../components/dashboard/OverviewMetricCard";
import { ProviderResourcesPanel } from "../components/dashboard/ProviderResourcesPanel";
import { Zone } from "../components/dashboard/Zone";
import { sectionUrl } from "../components/operating-bill/OperatingBillShell";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { useFeatureFlags } from "../feature-flags";
import { formatDateTimeShort } from "../lib/format";
import {
  buildOverviewCards,
  countDelta,
  overviewFootnote,
} from "../components/dashboard/standard-home-model";

export function DashboardPage() {
  const query = useStandardHome();
  const featureFlags = useFeatureFlags();
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
  const billOverviewUrl = sectionUrl("overview", data.month, null);
  const projectsUrl = sectionUrl("projects", data.month, null);
  // R01 开关边界：用量概览开关关闭时目的页落请求明细，入口降级为 /usage 默认页，不误导。
  const employeesUrl = featureFlags.FEATURE_USAGE_OVERVIEW_V2
    ? "/usage?tab=overview&subject_type=EMPLOYEE&period=MONTH"
    : "/usage";
  // R01-F01/F02 可比性与缺口文案集中构建（standard-home-model）。
  const cards = buildOverviewCards(data);

  return (
    <div className="flex flex-col gap-5">
      <DashboardHeader
        action={(
          <button
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg-secondary transition-colors hover:border-ql-border-strong hover:text-ql-fg focus-visible:outline-2 focus-visible:outline-ql-action disabled:opacity-60"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            type="button"
          >
            <RefreshCw aria-hidden className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} />
            刷新
          </button>
        )}
        asOf={data.asOf}
        month={data.month}
      />

      <Zone
        action={<ZoneLink label="查看经营账单" to={billOverviewUrl} />}
        description="四项指标与各自目的页同口径；同期为上月同一时点前的真实聚合，不折算。"
        title="本月概览"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewMetricCard
            accent
            delta={cards.token.delta}
            footnote={cards.token.footnote}
            hint={cards.token.hint}
            label="本月 Token 消耗"
            testId="home-token-card"
            to="/resources?tab=usage-overview"
            unit={cards.token.unit}
            value={cards.token.value}
          />
          <OverviewMetricCard
            additionalValues={cards.cost.additional}
            delta={cards.cost.delta}
            emptyText={cards.cost.emptyText ?? undefined}
            footnote={cards.cost.footnote}
            hint={cards.cost.hints.map((line) => (
              <span className="block" key={line}>{line}</span>
            ))}
            label="本月费用"
            testId="home-cost-card"
            to={billOverviewUrl}
            value={cards.cost.primary ?? ""}
          />
          <OverviewMetricCard
            delta={countDelta(data.activeEmployees.current, data.activeEmployees.previous.count, "人")}
            footnote={`上月同期 ${data.activeEmployees.previous.count} 人`}
            hint="本月有统计用量的员工去重数，不代表当前在线人数"
            label="本月活跃员工"
            testId="home-employee-card"
            to={employeesUrl}
            unit="人"
            value={String(data.activeEmployees.current)}
          />
          <OverviewMetricCard
            delta={countDelta(data.activeProjects.current, data.activeProjects.previous.count, "个")}
            footnote={`上月同期 ${data.activeProjects.previous.count} 个`}
            hint="本月有用量归属的项目去重数；未归属请求在项目账单独列示"
            label="本月活跃项目"
            testId="home-project-card"
            to={projectsUrl}
            unit="个"
            value={String(data.activeProjects.current)}
          />
        </div>
        <p className="mt-3 text-[12px] leading-[18px] text-ql-fg-tertiary">
          {overviewFootnote(data)}
        </p>
      </Zone>

      <Zone
        action={<ZoneLink label="管理资源" to="/resources?tab=supply-health" />}
        description="已接入厂商完整清单；调用状态与额度/余额同步状态分别判断。"
        title="接入资源"
      >
        <ProviderResourcesPanel resources={data.resources} />
      </Zone>
    </div>
  );
}

function ZoneLink({ label, to }: { label: string; to: string }) {
  return (
    <Link
      className="inline-flex min-h-8 items-center gap-1.5 text-[13px] text-ql-action hover:text-ql-action-hover focus-visible:outline-2 focus-visible:outline-ql-action"
      to={to}
    >
      {label}
    </Link>
  );
}

function DashboardHeader(props: { asOf?: string; month?: string; action?: ReactNode }) {
  const monthText = props.month
    ? `${Number(props.month.slice(0, 4))} 年 ${Number(props.month.slice(5, 7))} 月`
    : null;
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-9 text-ql-fg">首页看板</h1>
        <p className="mt-1 text-[13px] leading-5 text-ql-fg-tertiary">
          {monthText && props.asOf
            ? `${monthText} · 本月累计截至 ${formatDateTimeShort(props.asOf)}`
            : "本月经营与使用概览"}
        </p>
      </div>
      {props.action}
    </header>
  );
}
