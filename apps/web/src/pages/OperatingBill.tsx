import { Navigate, useSearchParams } from "react-router-dom";
import { useOperatingBill } from "../api/operating-bills";
import { useOperatingAnalysis } from "../api/operating-analysis";
import { operatingBillMonth, OperatingBillShell, type OperatingBillSection } from "../components/operating-bill/OperatingBillShell";
import { OperatingPlans } from "../components/operating-bill/OperatingPlans";
import { OperatingProcurement } from "../components/operating-bill/OperatingProcurement";
import { OperatingTrends } from "../components/operating-bill/OperatingTrends";
import { ValueRealizationSection } from "../components/operating-bill/ValueRealizationSection";
import { FinancialLedgerSection } from "../components/operating-bill/FinancialLedgerSection";
import { accountTime } from "../components/operating-bill/AccountShared";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { useFeatureFlags } from "../feature-flags";
import { OperatingBillOverview } from "./OperatingBillOverview";
import { Button } from "../components/ui/Button";
export { parseSnapshotCsv } from "./OperatingBillOverview";

type TabId = Exclude<
  OperatingBillSection,
  "employees" | "projects" | "departments"
>;
function isTabId(value: string | null): value is TabId {
  return (
    value === "overview" ||
    value === "finance" ||
    value === "value" ||
    value === "plans" ||
    value === "procurement"
  );
}
/** 需要等待 bill 数据的页签（WP4-S4）：总览渲染账单本体；采购复盘需要 status 做现行/历史分流。 */
function billRequiredFor(tab: TabId): boolean {
  return tab === "overview" || tab === "procurement";
}

/** 更新时间戳：总览页取账单/分析两者较旧者，其余页签取分析时间。 */
function ledgerTimestamp(
  tab: TabId,
  billGeneratedAt: string | undefined,
  analysisGeneratedAt: string,
): string {
  return tab === "overview" && billGeneratedAt !== undefined
    && billGeneratedAt < analysisGeneratedAt
    ? billGeneratedAt
    : analysisGeneratedAt;
}

export function OperatingBillPage() {
  const flags = useFeatureFlags();
  const [params] = useSearchParams();
  const month = operatingBillMonth(params.get("month")),
    requested = params.get("tab");
  const tab: TabId = isTabId(requested) ? requested : "overview";
  const reporting =
    tab === "overview" ||
    tab === "plans" ||
    tab === "value" ||
    tab === "finance" ||
    (tab === "procurement" && flags.FEATURE_PROCUREMENT_REVIEW);
  // WP4-S4：bill 查询全页签启用——CLOSED 历史标识横幅需要 status/version，
  // 采购复盘页需要 status 做现行/历史分流（D5／AFR-06）。
  const bill = useOperatingBill(month, true);
  const analysis = useOperatingAnalysis(month, reporting);
  useRedirectOnUnauthorized(bill.error ?? analysis.error);
  if (requested === "subjects")
    return <Navigate replace to={`/operating-bill/employees?month=${month}`} />;
  if (tab === "procurement" && !flags.FEATURE_PROCUREMENT_REVIEW)
    return <Navigate replace to={`/operating-bill?month=${month}`} />;
  const billRequired = billRequiredFor(tab);
  const refresh = () => {
    void analysis.refetch();
    if (billRequired) void bill.refetch();
  };
  const error = analysis.error ?? (tab === "overview" ? bill.error : null);
  return (
    <OperatingBillShell active={tab} month={month} status={bill.data?.status} version={bill.data?.version}>
      {analysis.isLoading || (billRequired && bill.isLoading) ? (
        <LoadingState label="正在汇总经营账单…" rows={5} />
      ) : !analysis.data || (billRequired && !bill.data) ? (
        <ErrorState
          message={error?.message ?? "经营账单加载失败"}
          onRetry={refresh}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-end gap-3 text-[13px] text-ql-fg-secondary">
            <span>
              更新于{" "}
              {accountTime(
                ledgerTimestamp(tab, bill.data?.generatedAt, analysis.data.generatedAt),
              )}
            </span>
            <Button
              variant="secondary"
              onClick={refresh}
              disabled={analysis.isFetching}
              type="button"
            >
              刷新
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-[13px] text-ql-danger">
              刷新失败，当前显示上次读取的数据：{error.message}
            </p>
          ) : null}
          {tab === "overview" ? (
            <>
              <OperatingBillOverview
                bill={bill.data!}
                monthTokens={analysis.data.summary.companyTokens}
                planUtilization={analysis.data.summary.planUtilization}
                payments={analysis.data.payments}
              />
              <OperatingTrends data={analysis.data} />
            </>
          ) : tab === "plans" ? (
            <OperatingPlans data={analysis.data} />
          ) : tab === "value" ? (
            <ValueRealizationSection analysis={analysis.data} month={month} />
          ) : tab === "finance" ? (
            <FinancialLedgerSection analysis={analysis.data} />
          ) : (
            <OperatingProcurement data={analysis.data} status={bill.data?.status} />
          )}
        </div>
      )}
    </OperatingBillShell>
  );
}
