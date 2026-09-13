/** 用量账本：请求级事实、企业内组合筛选、URL 可复现和路由下钻。 */
import { useState } from "react";
import { Download, Inbox, X } from "lucide-react";
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
import { UsageOverviewPanel } from "../components/usage/UsageOverviewPanel";
import { useFeatureFlags } from "../feature-flags";

import { UsageKeywordSearch } from "../components/usage/UsageSearchField";

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

function formatForDateTimeLocal(isoString: string | null): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
}

function optionalSearchParam(params: URLSearchParams, name: string): string | undefined {
  return params.get(name) || undefined;
}

function searchParamValue(params: URLSearchParams, name: string): string {
  return params.get(name) ?? "";
}

const inputClass =
  "h-9 min-w-0 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg outline-none focus:border-ql-action focus:ring-1 focus:ring-ql-action";

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

const DETAIL_FILTERS = ["search", "principal_id", "project_id", "client_id", "agent_family", "provider_id", "provider_resource_id", "unified_model", "status", "from", "to", "to_exclusive", "overage_only", "settled_only", "page"];

export function UsagePage() {
  const flags = useFeatureFlags();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab");
  const legacyDetails = !tab && DETAIL_FILTERS.some((key) => params.has(key));
  if (!flags.FEATURE_USAGE_OVERVIEW_V2 || tab === "details" || legacyDetails) return <UsageDetailsPage />;
  return <PageShell title="用量账本">
    <div className="mb-3 flex gap-2 border-b border-ql-border">
      <button className="border-b-2 border-ql-brand px-4 py-2 text-[13px] text-ql-brand" type="button">用量概览</button>
      <button className="border-b-2 border-transparent px-4 py-2 text-[13px] text-ql-fg-secondary" onClick={() => { const next = new URLSearchParams(params); next.set("tab", "details"); setParams(next, { replace: true }); }} type="button">请求明细</button>
    </div>
    <UsageOverviewPanel />
  </PageShell>;
}

// Declarative filter/table states are mutually exclusive UI flows.
// eslint-disable-next-line complexity
function UsageDetailsPage() {
  const featureFlags = useFeatureFlags();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const parsedPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage - 1 : 0;

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === "to" || name === "from") {
      next.delete("to_exclusive");
    }
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

  const applyQuickRange = (preset: "today" | "24h" | "7d" | "30d") => {
    const now = new Date();
    const next = new URLSearchParams(searchParams);
    let fromDate: Date;
    if (preset === "today") {
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    } else if (preset === "24h") {
      fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (preset === "7d") {
      fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else {
      fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    next.set("from", fromDate.toISOString());
    next.set("to", now.toISOString());
    next.delete("to_exclusive");
    next.delete("page");
    setExpandedId(null);
    setSearchParams(next, { replace: true });
  };

  const openExportConfirm = () => {
    setExportConfirmOpen(true);
  };

  const doExport = () => {
    const exportParams = new URLSearchParams();
    for (const [k, v] of searchParams.entries()) {
      if (k !== "tab" && k !== "page" && v) exportParams.set(k, v);
    }
    window.open(`/api/usage/export?${exportParams.toString()}`, "_blank");
    setExportConfirmOpen(false);
  };

  const usageParams: UsageQueryParams = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    search: searchParams.get("search") || undefined,
    principal_id: searchParams.get("principal_id") || undefined,
    project_id: optionalSearchParam(searchParams, "project_id"),
    subject_type: (searchParams.get("subject_type")?.toUpperCase() as UsageQueryParams["subject_type"]) || undefined,
    client_id: searchParams.get("client_id") || undefined,
    agent_family: searchParams.get("agent_family") || undefined,
    provider_id: searchParams.get("provider_id") || undefined,
    provider_resource_id: searchParams.get("provider_resource_id") || undefined,
    unified_model: searchParams.get("unified_model") || undefined,
    status: searchParams.get("status") || undefined,
    from: toApiDate(searchParams.get("from")),
    to: toApiDate(searchParams.get("to")),
    to_exclusive: toApiDate(searchParams.get("to_exclusive")),
    overage_only: searchParams.get("overage_only") === "true" || undefined,
    settled_only: searchParams.get("settled_only") === "true" || undefined,
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
  const hasFilters = [...searchParams.keys()].some((key) => key !== "page" && key !== "tab");

  /** 构建导出确认弹窗展示的筛选摘要行 */
  const exportSummaryRows: { label: string; value: string }[] = [];
  {
    const kw = searchParams.get("search");
    if (kw) exportSummaryRows.push({ label: "关键词", value: kw });

    const principalId = searchParams.get("principal_id");
    if (principalId) {
      const found = principalItems.find((p) => p.id === principalId);
      exportSummaryRows.push({ label: "主体", value: found?.name ?? principalId });
    }

    const projectId = searchParams.get("project_id");
    if (projectId) {
      const found = principalItems.find((p) => p.id === projectId);
      exportSummaryRows.push({ label: "项目", value: found?.name ?? projectId });
    }

    const agentFamily = searchParams.get("agent_family");
    if (agentFamily) exportSummaryRows.push({ label: "Agent", value: AGENT_LABEL[agentFamily] ?? agentFamily });

    const providerId = searchParams.get("provider_id");
    if (providerId) {
      const found = (providersQuery.data?.providers ?? []).find((p) => p.id === providerId);
      exportSummaryRows.push({ label: "厂商", value: found?.name ?? providerId });
    }

    const resourceId = searchParams.get("provider_resource_id");
    if (resourceId) {
      const found = (resourcesQuery.data?.resources ?? []).find((r) => r.id === resourceId);
      exportSummaryRows.push({ label: "厂商资源", value: found?.name ?? resourceId });
    }

    const unifiedModel = searchParams.get("unified_model");
    if (unifiedModel) {
      const found = (modelsQuery.data?.models ?? []).find((m) => m.alias === unifiedModel);
      exportSummaryRows.push({ label: "统一模型", value: found?.display_name ?? unifiedModel });
    }

    const status = searchParams.get("status");
    const STATUS_LABEL: Record<string, string> = {
      SUCCEEDED: "成功", FAILED: "失败 / 拒绝", IN_PROGRESS: "进行中", CANCELLED: "已取消",
    };
    if (status) exportSummaryRows.push({ label: "状态", value: STATUS_LABEL[status] ?? status });

    const from = searchParams.get("from");
    if (from) exportSummaryRows.push({ label: "开始时间", value: new Date(from).toLocaleString("zh-CN") });

    const to = searchParams.get("to") ?? searchParams.get("to_exclusive");
    if (to) exportSummaryRows.push({ label: "结束时间", value: new Date(to).toLocaleString("zh-CN") });

    if (searchParams.get("overage_only") === "true") exportSummaryRows.push({ label: "仅超额", value: "是" });
    if (searchParams.get("settled_only") === "true") exportSummaryRows.push({ label: "仅已结算", value: "是" });
  }

  return (
    <PageShell description="按主体、姓名或项目查找用量，查看每次请求的消耗明细" title="用量账本">

      <div className="mb-4 flex gap-2 border-b border-ql-border">{featureFlags.FEATURE_USAGE_OVERVIEW_V2 ? <button className="border-b-2 border-transparent px-4 py-2 text-[13px] text-ql-fg-secondary" onClick={() => setFilter("tab", "overview")} type="button">用量概览</button> : null}<button className="border-b-2 border-ql-brand px-4 py-2 text-[13px] text-ql-brand" type="button">请求明细</button></div>
      <div className="mb-4 rounded-xl border border-ql-border-zone bg-ql-surface-subtle p-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <UsageKeywordSearch key={searchParams.get("search") ?? ""} initialValue={searchParams.get("search") ?? ""} onSearch={(value) => setFilter("search", value)} />
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
              value={formatForDateTimeLocal(searchParams.get("from"))}
            />
          </label>
          <label>
            <span className="mb-1 block text-[12px] text-ql-fg-secondary">结束时间（到）</span>
            <input
              aria-label="结束时间"
              className={`${inputClass} w-full`}
              onChange={(event) => setFilter("to", event.target.value)}
              type="datetime-local"
              value={formatForDateTimeLocal(searchParams.get("to") || searchParams.get("to_exclusive"))}
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
          <div className="flex items-center gap-2 self-end">
            <button
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50"
              disabled={query.isLoading || total === 0}
              onClick={openExportConfirm}
              title="导出当前筛选条件的 CSV 明细"
              type="button"
            >
              <Download aria-hidden className="h-4 w-4" />
              导出明细
            </button>
            <button
              className="flex h-9 items-center justify-center gap-1 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg hover:border-ql-border-strong disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!hasFilters}
              onClick={() => {
                setExpandedId(null);
                setSearchParams({ tab: "details" }, { replace: true });
              }}
              type="button"
            >
              <X aria-hidden className="h-4 w-4" />
              清除筛选
            </button>
          </div>
          <div className="col-span-full flex flex-wrap items-center gap-1.5 border-t border-ql-border-zone pt-2.5">
            <span className="text-[12px] text-ql-fg-tertiary">快捷时间：</span>
            <button
              className="h-6 rounded border border-ql-border bg-ql-surface px-2 text-[11px] text-ql-fg-secondary hover:border-ql-border-strong hover:text-ql-fg"
              onClick={() => applyQuickRange("today")}
              type="button"
            >
              今天
            </button>
            <button
              className="h-6 rounded border border-ql-border bg-ql-surface px-2 text-[11px] text-ql-fg-secondary hover:border-ql-border-strong hover:text-ql-fg"
              onClick={() => applyQuickRange("24h")}
              type="button"
            >
              近 24 小时
            </button>
            <button
              className="h-6 rounded border border-ql-border bg-ql-surface px-2 text-[11px] text-ql-fg-secondary hover:border-ql-border-strong hover:text-ql-fg"
              onClick={() => applyQuickRange("7d")}
              type="button"
            >
              近 7 天
            </button>
            <button
              className="h-6 rounded border border-ql-border bg-ql-surface px-2 text-[11px] text-ql-fg-secondary hover:border-ql-border-strong hover:text-ql-fg"
              onClick={() => applyQuickRange("30d")}
              type="button"
            >
              近 30 天
            </button>
          </div>
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
                  <th className="py-2 pr-4 text-right font-medium">API 费用</th>
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
      {/* 导出确认弹窗 */}
      {exportConfirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-confirm-title"
          onClick={(e) => { if (e.target === e.currentTarget) setExportConfirmOpen(false); }}
        >
          <div className="w-full max-w-sm rounded-2xl border border-ql-border bg-ql-surface shadow-xl">
            <div className="border-b border-ql-border px-5 py-4">
              <h2 id="export-confirm-title" className="text-[15px] font-semibold text-ql-fg">
                确认导出明细
              </h2>
              <p className="mt-0.5 text-[12px] text-ql-fg-secondary">
                请确认以下导出范围，文件格式为 CSV
              </p>
            </div>
            <div className="px-5 py-4">
              {exportSummaryRows.length === 0 ? (
                <p className="text-[13px] text-ql-fg-secondary">
                  未设置任何筛选条件，将导出<span className="font-medium text-ql-fg">全部</span>请求明细（共 {formatCount(String(total))} 条）。
                </p>
              ) : (
                <ul className="space-y-2">
                  {exportSummaryRows.map((row) => (
                    <li key={row.label} className="flex items-baseline gap-2 text-[13px]">
                      <span className="w-20 shrink-0 text-ql-fg-secondary">{row.label}</span>
                      <span className="font-medium text-ql-fg">{row.value}</span>
                    </li>
                  ))}
                  <li className="flex items-baseline gap-2 text-[13px]">
                    <span className="w-20 shrink-0 text-ql-fg-secondary">命中条数</span>
                    <span className="font-medium text-ql-fg">{formatCount(String(total))} 条</span>
                  </li>
                </ul>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-ql-border px-5 py-3">
              <button
                className="h-8 rounded-lg border border-ql-border bg-ql-surface px-4 text-[13px] text-ql-fg hover:border-ql-border-strong"
                onClick={() => setExportConfirmOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="h-8 rounded-lg bg-ql-action px-4 text-[13px] font-medium text-white hover:bg-ql-action-hover"
                onClick={doExport}
                type="button"
              >
                确认导出
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
