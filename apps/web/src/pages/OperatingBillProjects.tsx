import { BriefcaseBusiness } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useState } from "react";

import { useOperatingBillProjects } from "../api/operating-bill-accounts";
import { usePrincipals, useProviders } from "../api/hooks";
import { useAssignOperatingBillProject } from "../api/operating-bills";
import {
  AccountCell,
  AccountFilters,
  AccountPagination,
  accountCount,
  accountMoney,
  accountQuota,
  AccountTable,
  accountTime,
  MetricGrid,
  UsageQualityTag,
} from "../components/operating-bill/AccountShared";
import {
  BillCard,
  buttonPrimary,
  inputClass,
  SectionHeading,
} from "../components/operating-bill/BillShared";
import {
  operatingBillMonth,
  OperatingBillShell,
} from "../components/operating-bill/OperatingBillShell";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

const headers = [
  "项目",
  "负责人",
  "请求时点归属部门",
  "使用厂商",
  "本月总 Token",
  "输入 Token",
  "输出 Token",
  "缓存 Token",
  "额度扣减",
  "账本 API 计价",
  "套餐分摊",
  "归集成本",
  "活跃 / 请求",
  "最近使用（北京时间）",
  "用量口径",
];
const PAGE_LIMIT = 25;

function pageOffset(value: string | null): number {
  const parsed = Number(value ?? "0");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : 0;
}

export function OperatingBillProjectsPage() {
  const [params, setParams] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const providerCode = params.get("provider_code") ?? "";
  const search = params.get("search") ?? "";
  const offset = pageOffset(params.get("offset"));
  const query = useOperatingBillProjects(month, {
    providerCode: providerCode || undefined,
    search: search.trim() || undefined,
    limit: PAGE_LIMIT,
    offset,
  });
  const providers = useProviders();
  useRedirectOnUnauthorized(query.error ?? providers.error);

  const setFilter = (key: "provider_code" | "search", value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("offset");
    setParams(next, { replace: true });
  };
  const setOffset = (value: number) => {
    const next = new URLSearchParams(params);
    if (value > 0) next.set("offset", String(value));
    else next.delete("offset");
    setParams(next, { replace: true });
  };

  return (
    <OperatingBillShell active="projects" month={month} status={query.data?.status}>
      <div className="space-y-4">
        <BillCard>
          <SectionHeading
            action={
              <AccountFilters
                onProviderChange={(value) => setFilter("provider_code", value)}
                onSearchChange={(value) => setFilter("search", value)}
                providerCode={providerCode}
                providers={(providers.data?.providers ?? []).map((provider) => ({
                  providerCode: provider.code,
                  providerName: provider.name,
                }))}
                search={search}
                searchLabel="搜索项目"
              />
            }
            description="每个请求只归属一个项目；未设置归属的请求独立列示"
            title="项目账 · 哪个项目产生了多少成本"
          />
        </BillCard>
        {providers.error ? (
          <ErrorState message={`厂商筛选加载失败：${providers.error.message}`} onRetry={() => void providers.refetch()} />
        ) : null}
        {query.isLoading ? (
          <LoadingState label="正在汇总项目月度账单…" rows={6} />
        ) : query.error || !query.data ? (
          <ErrorState message={query.error?.message ?? "项目账加载失败"} onRetry={() => void query.refetch()} />
        ) : (
          <>
          {query.data.status === "DRAFT" ? (
            <ProjectAssignment month={month} onAssigned={() => void query.refetch()} />
          ) : null}
          <MetricGrid totals={query.data.totals} />
          <BillCard className="overflow-hidden">
            {query.data.rows.length === 0 ? (
              <EmptyState
                description="当前月份或筛选条件没有项目用量；未归属请求也会在此独立列示。"
                icon={BriefcaseBusiness}
                title="没有项目账单记录"
              />
            ) : (
              <AccountTable headers={headers} leadingTextColumns={4}>
                {query.data.rows.map((row) => {
                  const totals = row.totals;
                  return <tr className="border-b border-ql-border-zone" key={row.subjectId ?? "__unassigned_project__"}>
                    <AccountCell>
                      <span className="font-medium text-ql-fg">{row.subjectName}</span>
                      {row.isUnassigned ? (
                        <span className="ml-2 text-[11px] text-ql-warning">未归属</span>
                      ) : null}
                    </AccountCell>
                    <AccountCell>{row.projectOwner?.personName ?? "—"}</AccountCell>
                    <AccountCell>
                      {row.projectDepartments.map((department) => department.departmentName).join("、")
                        || (row.subjectId ? "待归属" : "—")}
                    </AccountCell>
                    <AccountCell>
                      {row.providers.map((provider) => provider.providerName).join("、") || "—"}
                    </AccountCell>
                    <AccountCell numeric>{accountCount(totals.totalTokens, totals.usageQuality)}</AccountCell>
                    <AccountCell numeric>{accountCount(totals.inputTokens, totals.usageQuality)}</AccountCell>
                    <AccountCell numeric>{accountCount(totals.outputTokens, totals.usageQuality)}</AccountCell>
                    <AccountCell numeric>{accountCount(totals.cacheTokens, totals.usageQuality)}</AccountCell>
                    <AccountCell numeric>{accountQuota(totals.deductedQuota)}</AccountCell>
                    <AccountCell numeric>{accountMoney(totals.apiCost)}</AccountCell>
                    <AccountCell numeric>{accountMoney(totals.packageAllocatedCost)}</AccountCell>
                    <AccountCell numeric>{accountMoney(totals.totalAllocatedCost)}</AccountCell>
                    <AccountCell numeric>{totals.activeDays} 天 / {totals.requestCount} 次</AccountCell>
                    <AccountCell numeric>{accountTime(totals.lastUsedAt)}</AccountCell>
                    <AccountCell numeric><UsageQualityTag quality={totals.usageQuality} /></AccountCell>
                  </tr>;
                })}
              </AccountTable>
            )}
            <AccountPagination
              limit={query.data.limit}
              offset={query.data.offset}
              onOffsetChange={setOffset}
              total={query.data.total}
            />
          </BillCard>
          </>
        )}
      </div>
    </OperatingBillShell>
  );
}

function ProjectAssignment({ month, onAssigned }: { month: string; onAssigned: () => void }) {
  const [requestId, setRequestId] = useState("");
  const [projectId, setProjectId] = useState("");
  const principals = usePrincipals();
  const assign = useAssignOperatingBillProject(month);
  useRedirectOnUnauthorized(principals.error ?? assign.error);
  if (principals.isLoading) return <LoadingState label="正在加载可归属项目…" />;
  if (principals.error) {
    return <ErrorState message={principals.error.message} onRetry={() => void principals.refetch()} />;
  }
  return (
    <BillCard>
      <SectionHeading
        description="归属变更按请求唯一生效；未设置的成本保留在“未归属项目”"
        title="请求归属项目"
      />
      <div className="grid gap-3 px-4 pb-4 md:grid-cols-[1fr_1fr_auto]">
        <input
          aria-label="待归属请求 ID"
          className={inputClass}
          onChange={(event) => setRequestId(event.target.value)}
          placeholder="请求 UUID（可从用量账本复制）"
          value={requestId}
        />
        <select
          aria-label="归属项目"
          className={inputClass}
          onChange={(event) => setProjectId(event.target.value)}
          value={projectId}
        >
          <option value="">选择项目</option>
          {(principals.data?.principals ?? [])
            .filter((principal) => principal.type === "PROJECT" && principal.status === "ACTIVE")
            .map((principal) => <option key={principal.id} value={principal.id}>{principal.name}</option>)}
        </select>
        <button
          className={buttonPrimary}
          disabled={!requestId || !projectId || assign.isPending}
          onClick={() => assign.mutate(
            {
              ai_request_id: requestId,
              project_principal_id: projectId,
              reason: "经营账单项目归属",
            },
            {
              onSuccess: () => {
                setRequestId("");
                onAssigned();
              },
            },
          )}
          type="button"
        >
          保存归属
        </button>
        {assign.error ? (
          <p className="text-[12px] text-ql-danger md:col-span-3">{assign.error.message}</p>
        ) : null}
      </div>
    </BillCard>
  );
}
