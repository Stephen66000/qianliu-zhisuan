import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { get } from "../api/client";
import type {
  OperatingBillEmployeeRow,
  OperatingBillMetricTotals,
} from "../api/operating-bill-accounts";
import { OperatingBillShell, operatingBillMonth } from "../components/operating-bill/OperatingBillShell";
import {
  AccountCell,
  AccountTable,
  MetricGrid,
} from "../components/operating-bill/AccountShared";
import {
  extractProviderColumns,
  getSubjectUsageHeaders,
  SubjectUsageCells,
} from "../components/operating-bill/SubjectUsageCells";
import {
  BillCard,
  SectionHeading,
} from "../components/operating-bill/BillShared";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";

export interface DepartmentAccounts {
  month: string;
  status: "DRAFT" | "CLOSED";
  rows: OperatingBillEmployeeRow[];
  totals: OperatingBillMetricTotals;
}
export function useDepartmentAccounts(month: string) {
  return useQuery({
    queryKey: ["operating-department-accounts", month],
    queryFn: ({ signal }) =>
      get<DepartmentAccounts>(
        `/operating-bills/${month}/department-accounts`,
        signal,
      ),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
}
export function OperatingBillDepartmentsPage() {
  const [params] = useSearchParams(),
    month = operatingBillMonth(params.get("month"));
  const query = useDepartmentAccounts(month);
  useRedirectOnUnauthorized(query.error);
  return (
    <OperatingBillShell active="departments" month={month}>
      {query.isLoading ? (
        <LoadingState label="正在汇总部门账…" rows={5} />
      ) : !query.data ? (
        <ErrorState message={query.error?.message ?? "部门账加载失败"} onRetry={() => void query.refetch()}/>
      ) : (
        <div className="space-y-4">
          {query.error ? (
            <p role="alert" className="text-ql-danger">
              刷新失败，当前显示上次读取的数据：{query.error.message}
            </p>
          ) : null}
          {query.data.rows.some(
            (row) => row.isUnassigned && (Number(row.totals.totalTokens) > 0 || Number(row.totals.apiCost) > 0),
          ) ? (
            <div className="flex justify-end"><Link className="text-[13px] text-ql-action underline" to="/principals">补齐历史归属</Link></div>
          ) : null}
          <MetricGrid totals={query.data.totals} />
          {(() => {
            const dynamicProviders = extractProviderColumns(query.data.rows);
            return (
              <BillCard>
                <SectionHeading title="部门账" />
                <AccountTable
                  headers={["部门", ...getSubjectUsageHeaders(dynamicProviders)]}
                  leadingTextColumns={1}
                >
                  {query.data.rows.map((row) => (
                    <tr
                      className="border-b border-ql-border-zone"
                      key={row.subjectId ?? "unassigned"}
                    >
                      <AccountCell>{row.subjectName}</AccountCell>
                      <SubjectUsageCells providers={dynamicProviders} row={row} />
                    </tr>
                  ))}
                </AccountTable>
                {query.data.rows.length === 0 ? (
                  <p className="p-6 text-center">本月暂无部门用量</p>
                ) : null}
              </BillCard>
            );
          })()}
        </div>
      )}
    </OperatingBillShell>
  );
}
