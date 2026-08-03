/** 用量账本：请求级事实、企业内组合筛选、URL 可复现和路由下钻。 */
import { useState } from "react";
import { Inbox, Search, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import {
  usePrincipals,
  useProviderResources,
  useProviders,
  useUnifiedModels,
  useUsage,
} from "../api/hooks";
import type { Principal, UsageQueryParams } from "../api/types";
import { PageShell } from "../components/layout/PageShell";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { UsageRow } from "../components/usage/UsageRow";
import { formatCount } from "../lib/format";

const PAGE_SIZE = 20;

const AGENT_LABEL: Record<string, string> = {
  WORKBUDDY: "WorkBuddy", CODEX: "Codex", ZCODE: "Z Code", CLAUDE_CODE: "Claude Code",
  QIANLIU_IDE: "仟流 IDE", OTHER: "其他", UNKNOWN: "未知",
};


function toApiDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optionalSearchParam(params: URLSearchParams, name: string): string | undefined {
  return params.get(name) || undefined;
}

function searchParamValue(params: URLSearchParams, name: string): string {
  return params.get(name) ?? "";
}

const inputClass =
  "h-9 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg outline-none focus:border-ql-action focus:ring-1 focus:ring-ql-action";

function ProjectFilter({ principals, value, onChange }: {
  principals: Principal[];
  value: string;
  onChange: (value: string) => void;
}) {
  return <label>
    <span className="mb-1 block text-[12px] text-ql-fg-secondary">项目</span>
    <select aria-label="项目" className={`${inputClass} w-full`} onChange={(event) => onChange(event.target.value)} value={value}>
      <option value="">全部项目</option>
      {principals.filter((principal) => principal.type === "PROJECT").map((principal) => (
        <option key={principal.id} value={principal.id}>{principal.name}</option>
      ))}
    </select>
  </label>;
}

// Declarative filter/table states are mutually exclusive UI flows.
// eslint-disable-next-line complexity
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
    project_id: optionalSearchParam(searchParams, "project_id"),
    client_id: searchParams.get("client_id") || undefined,
    agent_family: searchParams.get("agent_family") || undefined,
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
  const principalItems = principalsQuery.data?.principals ?? [];
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
              {principalItems.map((principal) => (
                <option key={principal.id} value={principal.id}>{principal.name}</option>
              ))}
            </select>
          </label>
          <ProjectFilter principals={principalItems} value={searchParamValue(searchParams, "project_id")} onChange={(value) => setFilter("project_id", value)} />
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">Agent</span>
            <select aria-label="Agent" className={`${inputClass} w-full`} onChange={(event) => setFilter("agent_family", event.target.value)} value={searchParams.get("agent_family") ?? ""}>
              <option value="">全部 Agent</option>
              {Object.entries(AGENT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
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
