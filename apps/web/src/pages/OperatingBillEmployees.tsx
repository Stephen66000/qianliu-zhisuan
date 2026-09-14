import { UsersRound } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { useOperatingBillEmployees } from "../api/operating-bill-accounts";
import { useProviders } from "../api/hooks";
import {
  AccountCell,
  AccountFilters,
  AccountPagination,
  AccountTable,
  MetricGrid,
} from "../components/operating-bill/AccountShared";
import { BillCard, SectionHeading } from "../components/operating-bill/BillShared";
import {
  operatingBillMonth,
  OperatingBillShell,
} from "../components/operating-bill/OperatingBillShell";
import {
  extractProviderColumns,
  getSubjectUsageHeaders,
  SubjectUsageCells,
} from "../components/operating-bill/SubjectUsageCells";
import { EmptyState } from "../components/states/EmptyState";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

const PAGE_LIMIT = 25;

function pageOffset(value: string | null): number {
  const parsed = Number(value ?? "0");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : 0;
}

export function OperatingBillEmployeesPage() {
  const [params, setParams] = useSearchParams();
  const month = operatingBillMonth(params.get("month"));
  const providerCode = params.get("provider_code") ?? "";
  const search = params.get("search") ?? "";
  const offset = pageOffset(params.get("offset"));
  const query = useOperatingBillEmployees(month, {
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
    <OperatingBillShell active="employees" month={month} status={query.data?.status}>
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
                searchLabel="搜索员工"
              />
            }
            title="员工账"
          />
        </BillCard>
        {providers.error ? (
          <ErrorState message={`厂商筛选加载失败：${providers.error.message}`} onRetry={() => void providers.refetch()} />
        ) : null}
        {query.isLoading ? (
          <LoadingState label="正在汇总员工月度账单…" rows={6} />
        ) : query.error || !query.data ? (
          <ErrorState message={query.error?.message ?? "员工账加载失败"} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <MetricGrid totals={query.data.totals} />
            {(() => {
              const dynamicProviders = extractProviderColumns(query.data.rows);
              return (
                <BillCard className="overflow-hidden">
                  {query.data.rows.length === 0 ? (
                    <EmptyState
                      description="当前月份或筛选条件没有员工用量；可切换月份或清除筛选。"
                      icon={UsersRound}
                      title="没有员工账单记录"
                    />
                  ) : (
                    <AccountTable
                      headers={["员工", ...getSubjectUsageHeaders(dynamicProviders)]}
                      leadingTextColumns={1}
                    >
                      {query.data.rows.map((row) => {
                        const detail = new URLSearchParams({ month });
                        if (providerCode) detail.set("provider_code", providerCode);
                        if (search) detail.set("search", search);
                        return (
                          <tr className="border-b border-ql-border-zone" key={row.subjectId ?? row.subjectName}>
                            <AccountCell>
                              {row.subjectId ? (
                                <Link
                                  className="font-medium text-ql-action hover:underline"
                                  to={`/operating-bill/employees/${encodeURIComponent(row.subjectId)}?${detail}`}
                                >
                                  {row.subjectName}
                                </Link>
                              ) : (
                                <span className="font-medium text-ql-fg">
                                  {row.subjectName}
                                </span>
                              )}
                            </AccountCell>
                            <SubjectUsageCells providers={dynamicProviders} row={row} />
                          </tr>
                        );
                      })}
                    </AccountTable>
                  )}
                </BillCard>
              );
            })()}
            <AccountPagination
              limit={query.data.limit}
              offset={query.data.offset}
              onOffsetChange={setOffset}
              total={query.data.total}
            />
          </>
        )}
      </div>
    </OperatingBillShell>
  );
}
