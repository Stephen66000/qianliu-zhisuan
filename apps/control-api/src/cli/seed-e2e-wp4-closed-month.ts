import type { Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { IDS } from "./seed-e2e-ids.js";
import { WP4_IDS } from "./seed-e2e-wp4-ids.js";

/** 上海时区的上一个月（YYYY-MM），供已关账历史月夹具。 */
function previousShanghaiMonth(now: Date): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth(); // 0-based
  const targetYear = month === 0 ? year - 1 : year;
  const targetMonth = month === 0 ? 12 : month;
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
}

/**
 * §3 已关账历史月夹具：CLOSED operating_bill_period＋冻结 operating_bill_version 快照
 * （含期初/充值/期末旧资金轨迹值），供历史横幅与三卡保留断言。
 * 由 seed-e2e-wp4.ts 在 F01/USD/F02 夹具之后、§4 strict_writes 夹具之前原序调用。
 */
export async function seedWp4ClosedMonth(
  db: Kysely<Database>,
  enterpriseId: string,
  adminId: string,
  principalId: string,
  now: Date,
): Promise<void> {
  const closedMonth = previousShanghaiMonth(now);
  const closedMonthStart = `${closedMonth}-01`;
  const nextMonthStart = (() => {
    const year = Number(closedMonth.slice(0, 4));
    const month = Number(closedMonth.slice(5, 7));
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  })();
  const frozenSnapshot = {
    month: closedMonth,
    timezone: "Asia/Shanghai",
    periodStart: `${closedMonthStart}T00:00:00+08:00`,
    periodEnd: `${nextMonthStart}T00:00:00+08:00`,
    status: "CLOSED",
    version: 1,
    generatedAt: now.toISOString(),
    closedAt: now.toISOString(),
    closedBy: adminId,
    closeNote: "E2E 合成关账：历史口径保留夹具（WP4）",
    summary: {
      totalCost: "396.00000000",
      apiCost: "96.00000000",
      ledgerApiCost: "96.00000000",
      openingBalance: "1000.00000000",
      monthlyRecharge: "100.00000000",
      apiSpendStatus: "CALCULABLE",
      apiSpendReason: null,
      packageCost: "300.00000000",
      endingBalance: "1004.00000000",
      endingBalanceCurrency: "CNY",
      openingBalances: [{ currency: "CNY", amount: "1000.00000000" }],
      rechargeAmounts: [{ currency: "CNY", amount: "100.00000000" }],
      endingBalances: [{ currency: "CNY", amount: "1004.00000000" }],
      apiSpends: [{ currency: "CNY", amount: "96.00000000" }],
      packageCosts: [{ currency: "CNY", amount: "300.00000000" }],
      totalSpends: [{ currency: "CNY", amount: "396.00000000" }],
      planUtilization: "42.0",
      activePrincipalCount: 1,
      confirmedValueAmount: "0",
      confirmedNonMonetaryCount: 0,
      unallocatedCost: "0",
    },
    providers: [
      {
        providerResourceId: WP4_IDS.okResource, providerCode: "DeepSeek",
        providerName: "DeepSeek WP4 E2E", resourceName: "DeepSeek 官方余额 E2E",
        mode: "API", currency: "CNY", openingBalanceCurrency: "CNY",
        rechargeAmounts: [{ currency: "CNY", amount: "100.00000000" }],
        endingBalanceCurrency: "CNY", apiSpendCurrency: "CNY",
        apiCost: "96.00000000", ledgerApiCost: "96.00000000",
        openingBalance: "1000.00000000", rechargeAmount: "100.00000000",
        apiSpendStatus: "CALCULABLE", apiSpendReason: null,
        packageCost: "0", totalCost: "96.00000000", endingBalance: "1004.00000000",
        totalQuota: null, usedQuota: null, remainingQuota: null, quotaUnit: null,
        utilization: null, activePrincipalCount: 1, status: "ACTIVE",
        planAssessment: null, idleEntitlementCost: null, assessmentBasis: null,
        purchases: [], servicePeriodStart: null, servicePeriodEnd: null,
        operatingSnapshotSource: null,
        requestRange: { from: null, to: null, count: 0 },
        factFingerprint: "wp4-e2e-closed-month-api",
        confirmation: { status: "NOT_APPLICABLE", note: "E2E 合成夹具",
          confirmedBy: null, confirmedAt: null, version: 1, matchesCurrentFacts: false },
      },
      {
        providerResourceId: IDS.isolatedResource, providerCode: "zhipu",
        providerName: "智谱 E2E", resourceName: "E2E 待恢复资源",
        mode: "CODING_PLAN", currency: "CNY",
        apiCost: "0", packageCost: "300.00000000", packageCostCurrency: "CNY",
        totalCost: "300.00000000", endingBalance: null,
        totalQuota: "100000", usedQuota: "42000", remainingQuota: "58000",
        quotaUnit: "TOKEN", utilization: "42.0", activePrincipalCount: 1,
        status: "CREDENTIAL_INVALID", planAssessment: "UNDERUSED",
        idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款",
        purchases: [], servicePeriodStart: null, servicePeriodEnd: null,
        operatingSnapshotSource: null,
        requestRange: { from: null, to: null, count: 0 },
        factFingerprint: "wp4-e2e-closed-month-plan",
        confirmation: { status: "NOT_APPLICABLE", note: "E2E 合成夹具",
          confirmedBy: null, confirmedAt: null, version: 1, matchesCurrentFacts: false },
      },
    ],
    subjects: [
      {
        principalId, principalName: "E2E 固定员工", principalType: "EMPLOYEE",
        providers: ["DeepSeek WP4 E2E", "智谱 E2E"],
        inputTokens: "1600", outputTokens: "300", cacheTokens: "400",
        reasoningTokens: "0", totalTokens: "2300", deductedQuota: "42000",
        apiCost: "96.00000000", packageAllocatedCost: "300.00000000",
        totalAllocatedCost: "396.00000000", activeDays: 2, requestCount: 2,
      },
    ],
    values: [],
    gaps: [],
    sourceFacts: { ledgerLineCount: 0, operatingSnapshotIds: [] },
  };
  const [period] = await db.insertInto("operating_bill_period").values({
    enterprise_id: enterpriseId, period_month: closedMonthStart,
    status: "CLOSED", current_version: 1, created_by: adminId,
  }).returning("id").execute();
  await db.insertInto("operating_bill_version").values({
    enterprise_id: enterpriseId, period_id: period!.id, version: 1,
    snapshot: frozenSnapshot, close_note: "E2E 合成关账：历史口径保留夹具（WP4）",
    closed_by: adminId, closed_at: now,
  }).execute();
  await db.insertInto("operating_bill_event").values({
    enterprise_id: enterpriseId, period_id: period!.id, action: "CLOSED",
    version: 1, reason: "E2E 合成关账", actor_admin_id: adminId, metadata: { source: "wp4-e2e-seed" },
  }).execute();
}
