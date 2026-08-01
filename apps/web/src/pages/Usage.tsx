/** 用量账本：请求级事实、企业内组合筛选、URL 可复现和路由下钻。 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Inbox, Search, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import {
  usePrincipals,
  useProviderResources,
  useProviders,
  useUnifiedModels,
  useUsage,
} from "../api/hooks";
import type { UsageQueryParams, UsageRecord } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { formatCount, formatDateTimeFull, formatDuration, formatMoney } from "../lib/format";
import { RequestDrilldown } from "./RequestDrilldown";

const PAGE_SIZE = 20;

const STATUS_LABEL: Record<string, string> = {
  PENDING: "等待中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  IN_PROGRESS: "进行中",
  CANCELLED: "已取消",
};

function StatusCell({ status }: { status: string }) {
  if (status === "FAILED") {
    return <StatusTag tone="danger">{STATUS_LABEL[status] ?? status}</StatusTag>;
  }
  return <StatusTag tone="neutral">{STATUS_LABEL[status] ?? status}</StatusTag>;
}

/** API 实际费用："0" = 套餐内（TRD §10.2 PACKAGE_INCLUDED，不写数值 0）。 */
function ApiCostCell({ record }: { record: UsageRecord }) {
  if (record.totalApiCost === "0" || record.totalApiCost === "0.00000000") {
    return <span className="text-ql-fg-secondary">套餐内</span>;
  }
  return <span>{formatMoney(record.totalApiCost)}</span>;
}

function toApiDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 单行 + 可展开路由过程下钻（W20）。 */
function UsageRow({
  record,
  expanded,
  onToggle,
}: {
  record: UsageRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-ql-border-zone text-[13px] leading-5 text-ql-fg hover:bg-ql-surface-subtle">
        <td className="py-2.5 pr-2">
          <button
            aria-expanded={expanded}
            aria-label={expanded ? "收起路由过程" : "展开路由过程"}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ql-fg-tertiary hover:bg-ql-surface-muted hover:text-ql-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ql-action"
            onClick={onToggle}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="h-4 w-4" />
            ) : (
              <ChevronRight aria-hidden className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="max-w-[10rem] truncate py-2.5 pr-4 font-mono text-[12px] text-ql-fg-secondary">
          {record.requestId}
        </td>
        <td className="whitespace-nowrap py-2.5 pr-4 font-medium">{record.principalName}</td>
        <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
          {record.clientId ?? "—"}
        </td>
        <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">{record.unifiedModel}</td>
        <td className="min-w-[9rem] py-2.5 pr-4 text-ql-fg-secondary">
          {record.finalProviderResourceName ? (
            <>
              <span className="block text-ql-fg">{record.finalProviderResourceName}</span>
              <span className="block text-[12px]">
                {record.finalProviderName ?? record.finalProviderCode ?? "未知厂商"}
              </span>
            </>
          ) : "—"}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalInputTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalOutputTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalCacheTokens)}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          {formatCount(record.totalDeductedQuota)}
          {record.overage === true ? <span className="ml-1 text-[11px] text-ql-danger">超额</span> : null}
        </td>
        <td className="py-2.5 pr-4 text-right [font-variant-numeric:tabular-nums]">
          <ApiCostCell record={record} />
        </td>
        <td className="py-2.5 pr-4">
          <StatusCell status={record.status} />
        </td>
        <td className="whitespace-nowrap py-2.5 pr-4 text-ql-fg-secondary">
          {formatDateTimeFull(record.startedAt)}
        </td>
        <td className="py-2.5 text-right [font-variant-numeric:tabular-nums]">
          {record.durationMs === null ? "—" : formatDuration(record.durationMs)}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-ql-border-zone">
          <td className="bg-ql-surface-subtle p-3" colSpan={14}>
            <RequestDrilldown requestId={record.requestId} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

const inputClass =
  "h-9 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg outline-none focus:border-ql-action focus:ring-1 focus:ring-ql-action";

export function UsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const parsedPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage - 1 : 0;

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    next.delete("page");
    setExpandedId(null);
    setSearchParams(next, { replace: true });
  };
  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 0) next.delete("page");
    else next.set("page", String(nextPage + 1));
    setSearchParams(next, { replace: true });
  };

  const usageParams: UsageQueryParams = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    search: searchParams.get("search") || undefined,
    principal_id: searchParams.get("principal_id") || undefined,
    client_id: searchParams.get("client_id") || undefined,
    provider_id: searchParams.get("provider_id") || undefined,
    provider_resource_id: searchParams.get("provider_resource_id") || undefined,
    unified_model: searchParams.get("unified_model") || undefined,
    status: searchParams.get("status") || undefined,
    from: toApiDate(searchParams.get("from")),
    to: toApiDate(searchParams.get("to")),
    overage_only: searchParams.get("overage_only") === "true" || undefined,
  };
  const query = useUsage(usageParams);
  const principalsQuery = usePrincipals();
  const providersQuery = useProviders();
  const resourcesQuery = useProviderResources();
  const modelsQuery = useUnifiedModels();
  useRedirectOnUnauthorized(query.error);

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedProviderId = searchParams.get("provider_id") ?? "";
  const visibleResources = (resourcesQuery.data?.resources ?? []).filter(
    (resource) => !selectedProviderId || resource.provider_id === selectedProviderId,
  );
  const hasFilters = [...searchParams.keys()].some((key) => key !== "page");

  return (
    <PageShell description="按数据库事实定位请求；筛选条件保存在当前 URL，可刷新或复制复现" title="用量账本">
      <div className="mb-4 rounded-xl border border-ql-border-zone bg-ql-surface-subtle p-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="relative xl:col-span-2">
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">请求 ID / 主体名称</span>
            <Search aria-hidden className="absolute bottom-2.5 left-3 h-4 w-4 text-ql-fg-tertiary" />
            <input
              aria-label="搜索请求 ID 或主体名称"
              className={`${inputClass} w-full pl-9`}
              onChange={(event) => setFilter("search", event.target.value)}
              placeholder="输入完整或部分内容"
              type="search"
              value={searchParams.get("search") ?? ""}
            />
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">主体</span>
            <select
              aria-label="主体"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("principal_id", event.target.value)}
              value={searchParams.get("principal_id") ?? ""}
            >
              <option value="">全部主体</option>
              {(principalsQuery.data?.principals ?? []).map((principal) => (
                <option key={principal.id} value={principal.id}>{principal.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">工具 / 客户端</span>
            <input
              aria-label="工具或客户端"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("client_id", event.target.value)}
              placeholder="如 WorkBuddy"
              value={searchParams.get("client_id") ?? ""}
            />
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">厂商</span>
            <select
              aria-label="厂商筛选"
              className={`${inputClass} w-full`}
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value) next.set("provider_id", event.target.value);
                else next.delete("provider_id");
                next.delete("provider_resource_id");
                next.delete("page");
                setSearchParams(next, { replace: true });
              }}
              value={selectedProviderId}
            >
              <option value="">全部厂商</option>
              {(providersQuery.data?.providers ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">厂商资源</span>
            <select
              aria-label="厂商资源"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("provider_resource_id", event.target.value)}
              value={searchParams.get("provider_resource_id") ?? ""}
            >
              <option value="">全部资源</option>
              {visibleResources.map((resource) => (
                <option key={resource.id} value={resource.id}>{resource.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">统一模型</span>
            <select
              aria-label="统一模型"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("unified_model", event.target.value)}
              value={searchParams.get("unified_model") ?? ""}
            >
              <option value="">全部模型</option>
              {(modelsQuery.data?.models ?? []).map((model) => (
                <option key={model.id} value={model.alias}>{model.display_name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">状态</span>
            <select
              aria-label="状态"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("status", event.target.value)}
              value={searchParams.get("status") ?? ""}
            >
              <option value="">全部状态</option>
              <option value="SUCCEEDED">成功</option>
              <option value="FAILED">失败 / 拒绝</option>
              <option value="IN_PROGRESS">进行中</option>
              <option value="CANCELLED">已取消</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">开始时间（从）</span>
            <input
              aria-label="开始时间"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("from", event.target.value)}
              type="datetime-local"
              value={searchParams.get("from") ?? ""}
            />
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">结束时间（到）</span>
            <input
              aria-label="结束时间"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("to", event.target.value)}
              type="datetime-local"
              value={searchParams.get("to") ?? ""}
            />
          </label>
          <label className="flex h-9 items-center gap-2 self-end text-[13px] text-ql-fg">
            <input
              aria-label="只看超额"
              checked={searchParams.get("overage_only") === "true"}
              onChange={(event) => setFilter("overage_only", event.target.checked ? "true" : "")}
              type="checkbox"
            />
            只看超额
          </label>
          <button
            className="flex h-9 items-center justify-center gap-1 self-end rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!hasFilters}
            onClick={() => {
              setExpandedId(null);
              setSearchParams({}, { replace: true });
            }}
            type="button"
          >
            <X aria-hidden className="h-4 w-4" />
            清除筛选
          </button>
        </div>
      </div>
      {query.isLoading ? (
        <LoadingState label="正在加载账本记录…" rows={6} />
      ) : query.error || !query.data ? (
        <ErrorState
          message={query.error?.message ?? "账本记录加载失败"}
          onRetry={() => void query.refetch()}
        />
      ) : query.data.records.length === 0 ? (
        /* PRD §10.4：用量账本为空 → 说明为什么为空 + 下一步，不得混入测试数据 */
        <EmptyState
          description="当前筛选条件没有账本记录。可清除筛选或发起真实调用；本页不展示模拟数据。"
          icon={Inbox}
          title="没有账本记录"
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-ql-border text-[12px] leading-[18px] text-ql-fg-tertiary">
                  <th aria-label="展开" className="py-2 pr-2 font-medium" />
                  <th className="py-2 pr-4 font-medium">请求 ID</th>
                  <th className="py-2 pr-4 font-medium">发起主体</th>
                  <th className="py-2 pr-4 font-medium">工具/客户端</th>
                  <th className="py-2 pr-4 font-medium">模型</th>
                  <th className="py-2 pr-4 font-medium">最终厂商/资源</th>
                  <th className="py-2 pr-4 text-right font-medium">输入 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">输出 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">缓存 Token</th>
                  <th className="py-2 pr-4 text-right font-medium">扣减额度</th>
                  <th className="py-2 pr-4 text-right font-medium">API 费用（元）</th>
                  <th className="py-2 pr-4 font-medium">状态</th>
                  <th className="py-2 pr-4 font-medium">开始时间</th>
                  <th className="py-2 text-right font-medium">耗时</th>
                </tr>
              </thead>
              <tbody>
                {query.data.records.map((record) => {
                  const expanded = expandedId === record.requestId;
                  return (
                    <UsageRow
                      expanded={expanded}
                      key={record.requestId}
                      onToggle={() => setExpandedId(expanded ? null : record.requestId)}
                      record={record}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">
              共 {formatCount(String(total))} 条 · 第 {page + 1} / {totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <button
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
                disabled={page === 0}
                onClick={() => setPage(Math.max(0, page - 1))}
                type="button"
              >
                上一页
              </button>
              <button
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
                disabled={page + 1 >= totalPages}
                onClick={() => setPage(page + 1)}
                type="button"
              >
                下一页
              </button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
