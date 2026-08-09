import { ChevronDown, ChevronRight, FileSearch, MoveLeft } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  type OperatingBillModelRow,
  useOperatingBillEmployee,
  useOperatingBillEmployeeRequests,
} from "../api/operating-bill-accounts";
import { useProviders } from "../api/hooks";
import {
  AccountCell,
  accountCount,
  accountMoney,
  accountPercentage,
  accountQuota,
  AccountTable,
  accountTime,
  MetricGrid,
  UsageQualityTag,
} from "../components/operating-bill/AccountShared";
import { BillCard, buttonSecondary, inputClass } from "../components/operating-bill/BillShared";
import {
  operatingBillMonth,
  OperatingBillShell,
} from "../components/operating-bill/OperatingBillShell";
import { StatusTag } from "../components/dashboard/StatusTag";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

const modelHeaders = [
  "正式 alias",
  "历史 alias",
  "总 Token",
  "输入",
  "输出",
  "缓存",
  "请求数",
  "API 成本",
  "套餐分摊",
  "使用占比",
  "用量口径",
  "请求明细",
];

export function OperatingBillEmployeeDetailPage() {
  const { principalId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const providerCode = params.get("provider_code") ?? "";
  const employeeSearch = params.get("search") ?? "";
  const query = useOperatingBillEmployee(month, principalId, providerCode || undefined);
  const providers = useProviders();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [requestModel, setRequestModel] = useState<string | null>(null);
  const pageError = query.error ?? providers.error;
  useRedirectOnUnauthorized(pageError);

  const visibleProviders = query.data?.providers ?? [];
  const changeProvider = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("provider_code", value);
    else next.delete("provider_code");
    setParams(next, { replace: true });
  };
  const toggleProvider = (code: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    return next;
  });
  const backSearch = new URLSearchParams({ month });
  if (providerCode) backSearch.set("provider_code", providerCode);
  if (employeeSearch) backSearch.set("search", employeeSearch);

  return (
    <OperatingBillShell active="employees" month={month} status={query.data?.status}>
      {query.isLoading || providers.isLoading ? (
        <LoadingState label="正在加载员工账详情…" rows={6} />
      ) : pageError || !query.data ? (
        <ErrorState
          message={pageError?.message ?? "员工账详情加载失败"}
          onRetry={() => { void query.refetch(); void providers.refetch(); }}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Link className={buttonSecondary} to={`/operating-bill/employees?${backSearch}`}>
                <MoveLeft className="h-4 w-4" />返回员工账
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[20px] font-semibold text-ql-fg">{query.data.employee.principalName}</h2>
                  <UsageQualityTag quality={query.data.totals.usageQuality} />
                </div>
                <p className="text-[12px] text-ql-fg-tertiary">先看厂商合计，再展开到当前正式模型 alias</p>
              </div>
            </div>
            <select
              aria-label="详情厂商"
              className={`${inputClass} min-w-40`}
              onChange={(event) => changeProvider(event.target.value)}
              value={providerCode}
            >
              <option value="">全部厂商</option>
              {(providers.data?.providers ?? []).map((provider) => (
                <option key={provider.code} value={provider.code}>
                  {provider.name}
                </option>
              ))}
            </select>
          </div>
          <MetricGrid totals={query.data.totals} />
          {query.data.gaps.length > 0 ? (
            <div className="rounded-xl border border-ql-warning bg-ql-warning-soft px-4 py-3 text-[12px] text-ql-warning">
              {query.data.gaps.length} 个历史 alias 暂未解析到稳定模型 ID：
              {query.data.gaps.map((gap) => gap.historicalAlias).join("、")}。历史名称保持原样，不改写。
            </div>
          ) : null}
          {visibleProviders.length === 0 ? (
            <BillCard>
              <EmptyState
                description="所选厂商没有该员工的账单事实，请切换厂商。"
                icon={FileSearch}
                title="没有厂商明细"
              />
            </BillCard>
          ) : visibleProviders.map((provider) => {
            const isExpanded = expanded.has(provider.providerCode);
            return (
              <BillCard className="overflow-hidden" key={provider.providerCode}>
                <button
                  aria-expanded={isExpanded}
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-4 text-left hover:bg-ql-surface-subtle"
                  onClick={() => toggleProvider(provider.providerCode)}
                  type="button"
                >
                  <span className="flex items-center gap-2">
                    {isExpanded ? <ChevronDown className="h-4 w-4 text-ql-action" /> : <ChevronRight className="h-4 w-4 text-ql-action" />}
                    <span className="font-semibold text-ql-fg">{provider.providerName}</span>
                    <UsageQualityTag quality={provider.totals.usageQuality} />
                  </span>
                  <span className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ql-fg-secondary">
                    <span>总 Token <b className="text-ql-fg">{accountCount(provider.totals.totalTokens, provider.totals.usageQuality)}</b></span>
                    <span>请求 <b className="text-ql-fg">{provider.totals.requestCount}</b></span>
                    <span>API 成本 <b className="text-ql-fg">{accountMoney(provider.totals.apiCost)}</b></span>
                    <span>套餐分摊 <b className="text-ql-fg">{accountMoney(provider.totals.packageAllocatedCost)}</b></span>
                  </span>
                </button>
                {isExpanded ? (
                  provider.models.length === 0 ? (
                    <EmptyState
                      description="该厂商有汇总事实，但没有可解析的模型记录。"
                      icon={FileSearch}
                      title="没有模型明细"
                    />
                  ) : (
                    <AccountTable headers={modelHeaders}>
                      {provider.models.map((model) => {
                        const modelKey = `${provider.providerCode}:${model.unifiedModelId
                          ?? model.historicalAliases[0]
                          ?? "unresolved"}`;
                        const modelAlias = model.identityStatus === "UNRESOLVED"
                          ? "未解析模型"
                          : model.currentAlias ?? "未解析模型";
                        const historicalAliases = model.historicalAliases.filter((alias) => alias !== model.currentAlias);
                        const requestsOpen = requestModel === modelKey;
                        return (
                          <Fragment key={modelKey}>
                            <tr className="border-b border-ql-border-zone">
                              <AccountCell>
                                <span className="font-medium text-ql-fg">{modelAlias}</span>
                                {model.identityStatus === "UNRESOLVED" ? <span className="block text-[11px] text-ql-warning">身份未解析</span> : null}
                              </AccountCell>
                              <AccountCell>{historicalAliases.join("、") || "—"}</AccountCell>
                              <AccountCell numeric>{accountCount(model.totals.totalTokens, model.totals.usageQuality)}</AccountCell>
                              <AccountCell numeric>{accountCount(model.totals.inputTokens, model.totals.usageQuality)}</AccountCell>
                              <AccountCell numeric>{accountCount(model.totals.outputTokens, model.totals.usageQuality)}</AccountCell>
                              <AccountCell numeric>{accountCount(model.totals.cacheTokens, model.totals.usageQuality)}</AccountCell>
                              <AccountCell numeric>{model.totals.requestCount}</AccountCell>
                              <AccountCell numeric>{accountMoney(model.totals.apiCost)}</AccountCell>
                              <AccountCell numeric>{accountMoney(model.totals.packageAllocatedCost)}</AccountCell>
                              <AccountCell numeric>
                                {accountPercentage(model.usageShare, model.totals.usageQuality)}
                              </AccountCell>
                              <AccountCell numeric><UsageQualityTag quality={model.totals.usageQuality} /></AccountCell>
                              <AccountCell numeric>
                                {model.unifiedModelId === null ? (
                                  <span className="text-ql-warning">模型身份未解析</span>
                                ) : (
                                  <button
                                    aria-expanded={requestsOpen}
                                    className="text-ql-action hover:underline"
                                    onClick={() => setRequestModel(requestsOpen ? null : modelKey)}
                                    type="button"
                                  >
                                    {requestsOpen ? "收起请求明细" : "查看请求明细"}
                                  </button>
                                )}
                              </AccountCell>
                            </tr>
                            {requestsOpen && model.unifiedModelId ? (
                              <tr>
                                <td className="bg-ql-surface-subtle p-4" colSpan={modelHeaders.length}>
                                  <ModelRequests
                                    key={`${month}:${provider.providerCode}:${model.unifiedModelId}`}
                                    model={model}
                                    month={month}
                                    principalId={principalId}
                                    providerCode={provider.providerCode}
                                    unifiedModelId={model.unifiedModelId}
                                  />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </AccountTable>
                  )
                ) : null}
              </BillCard>
            );
          })}
        </div>
      )}
    </OperatingBillShell>
  );
}

function ModelRequests({
  month,
  principalId,
  providerCode,
  model,
  unifiedModelId,
}: {
  month: string;
  principalId: string;
  providerCode: string;
  model: OperatingBillModelRow;
  unifiedModelId: string;
}) {
  const limit = 20;
  const [page, setPage] = useState(1);
  const query = useOperatingBillEmployeeRequests({
    month,
    principalId,
    unifiedModelId,
    providerCode,
    limit,
    offset: (page - 1) * limit,
  });
  useRedirectOnUnauthorized(query.error);
  if (query.isLoading) return <LoadingState label="正在加载真实请求证据…" />;
  if (query.error || !query.data) {
    return <ErrorState message={query.error?.message ?? "请求明细加载失败"} onRetry={() => void query.refetch()} />;
  }
  if (query.data.items.length === 0) {
    return (
      <div className="space-y-3">
        <EmptyState description="该模型当前页没有 usage / settlement 请求事实。" icon={FileSearch} title="没有请求明细" />
        {page > 1 ? (
          <div className="flex justify-end">
            <button className={buttonSecondary} onClick={() => setPage((value) => value - 1)} type="button">
              返回上一页
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  const pages = Math.max(1, Math.ceil(query.data.total / limit));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-ql-fg">{model.currentAlias ?? model.historicalAliases[0] ?? "未解析模型"} · 请求证据</p>
        <p className="text-[12px] text-ql-fg-tertiary">共 {query.data.total} 条 · 第 {page} / {pages} 页</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-ql-border-zone bg-ql-surface">
        <table className="w-full min-w-[82rem] text-left text-[12px]">
          <thead className="bg-ql-surface-muted text-ql-fg-tertiary">
            <tr>{["request ID", "模型 alias", "总 Token", "输入 / 输出 / 缓存", "额度扣减", "API 成本", "套餐分摊", "状态", "用量口径", "时间"].map((header) => <th className="px-3 py-2 font-medium" key={header}>{header}</th>)}</tr>
          </thead>
          <tbody>
            {query.data.items.map((item) => (
              <tr className="border-t border-ql-border-zone" key={item.requestId}>
                <td className="px-3 py-2 font-mono text-ql-fg">{item.requestId}</td>
                <td className="px-3 py-2 text-ql-fg-secondary">
                  {item.currentAlias ?? "当前 alias 未解析"}
                  {item.modelAliasAtRequest !== item.currentAlias ? <span className="block text-[11px] text-ql-fg-tertiary">历史：{item.modelAliasAtRequest}</span> : null}
                </td>
                <td className="px-3 py-2 tabular-nums">{accountCount(item.tokens.totalTokens, item.usageQuality)}</td>
                <td className="px-3 py-2 tabular-nums">{accountCount(item.tokens.inputTokens, item.usageQuality)} / {accountCount(item.tokens.outputTokens, item.usageQuality)} / {accountCount(item.tokens.cacheTokens, item.usageQuality)}</td>
                <td className="px-3 py-2 tabular-nums">{accountQuota(item.costs.deductedQuota)}</td>
                <td className="px-3 py-2 tabular-nums">{accountMoney(item.costs.apiCost)}</td>
                <td className="px-3 py-2 tabular-nums">{accountMoney(item.costs.packageAllocatedCost)}</td>
                <td className="px-3 py-2"><RequestStatus status={item.status} /></td>
                <td className="px-3 py-2"><UsageQualityTag quality={item.usageQuality} /></td>
                <td className="px-3 py-2 whitespace-nowrap text-ql-fg-secondary">{accountTime(item.usedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end gap-2">
        <button className={buttonSecondary} disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">上一页</button>
        <button className={buttonSecondary} disabled={page >= pages} onClick={() => setPage((value) => value + 1)} type="button">下一页</button>
      </div>
    </div>
  );
}

function RequestStatus({ status }: { status: string }) {
  const labels: Record<string, string> = {
    SUCCEEDED: "成功",
    FAILED: "失败",
    RUNNING: "进行中",
    CANCELLED: "已取消",
  };
  return <StatusTag tone={status === "SUCCEEDED" ? "success" : status === "FAILED" ? "danger" : "neutral"}>{labels[status] ?? status}</StatusTag>;
}
