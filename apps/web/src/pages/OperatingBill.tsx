import { Navigate, useSearchParams } from "react-router-dom";
import { useOperatingBill } from "../api/operating-bills";
import { useOperatingAnalysis } from "../api/operating-analysis";
import { buttonSecondary } from "../components/operating-bill/BillShared";
import { operatingBillMonth, OperatingBillShell, type OperatingBillSection } from "../components/operating-bill/OperatingBillShell";
import { OperatingPlans } from "../components/operating-bill/OperatingPlans";
import { OperatingProcurement } from "../components/operating-bill/OperatingProcurement";
import { OperatingTrends } from "../components/operating-bill/OperatingTrends";
import { accountTime } from "../components/operating-bill/AccountShared";
import { ErrorState } from "../components/states/ErrorState";
import { LoadingState } from "../components/states/LoadingState";
import { useRedirectOnUnauthorized } from "../components/useRedirectOnUnauthorized";
import { useFeatureFlags } from "../feature-flags";
import { OperatingBillOverview } from "./OperatingBillOverview";
export { parseSnapshotCsv } from "./OperatingBillOverview";

type TabId = Exclude<
  OperatingBillSection,
  "employees" | "projects" | "departments"
>;
function isTabId(value: string | null): value is TabId {
  return (
    value === "overview" || value === "plans" || value === "procurement" || value === "reconciliation" || value === "value"
  );
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
    (tab === "procurement" && flags.FEATURE_PROCUREMENT_REVIEW);
  const bill = useOperatingBill(month, tab === "overview");
  const analysis = useOperatingAnalysis(month, reporting);
  useRedirectOnUnauthorized(bill.error ?? analysis.error);
  if (requested === "subjects")
    return <Navigate replace to={`/operating-bill/employees?month=${month}`} />;
  if (tab === "procurement" && !flags.FEATURE_PROCUREMENT_REVIEW)
    return <Navigate replace to={`/operating-bill?month=${month}`} />;
  const refresh = () => {
    void analysis.refetch();
    if (tab === "overview") void bill.refetch();
  };
  const error = analysis.error ?? (tab === "overview" ? bill.error : null);
  return (
    <OperatingBillShell active={tab} month={month}>
      {!reporting ? (
        <div
          role="region"
          aria-label={tab === "value" ? "价值确认" : "对账与导出"}
        />
      ) : analysis.isLoading || (tab === "overview" && bill.isLoading) ? (
        <LoadingState label="正在汇总经营账单…" rows={5} />
      ) : !analysis.data || (tab === "overview" && !bill.data) ? (
        <ErrorState
          message={error?.message ?? "经营账单加载失败"}
          onRetry={refresh}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-end gap-3 text-[12px] text-ql-fg-secondary">
            <span>
              更新于{" "}
              {accountTime(
                tab === "overview" &&
                  bill.data &&
                  bill.data.generatedAt < analysis.data.generatedAt
                  ? bill.data.generatedAt
                  : analysis.data.generatedAt,
              )}
            </span>
            <button
              className={buttonSecondary}
              onClick={refresh}
              disabled={analysis.isFetching}
              type="button"
            >
              刷新
            </button>
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
                planUtilization={analysis.data.summary.planUtilization}
                payments={analysis.data.payments}
              />
              <OperatingTrends data={analysis.data} />
            </>
          ) : tab === "plans" ? (
            <OperatingPlans data={analysis.data} />
          ) : (
            <OperatingProcurement data={analysis.data} />
          )}
        </div>
      )}
    </OperatingBillShell>
  );
}
