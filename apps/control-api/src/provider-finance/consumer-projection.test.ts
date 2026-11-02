import { expect, it } from "vitest";
import type { ResourceFinanceView, ResourceUsageOverview } from "@qianliu/database";

import { projectFinanceUtilization } from "../resource-insights/routes.js";
import { projectFinanceUsageOverview } from "../providers/finance-usage-overview.js";
import type { ResourceUtilizationRow } from "../resource-insights/query.js";

const apiFinance: ResourceFinanceView = { resourceId: "resource-1", providerCode: "deepseek", mode: "API",
  accounts: [{ currency: "CNY", balanceState: "NORMAL", balance: "498.4",
    monthOpeningState: "NORMAL", monthOpeningBalance: "6.83",
    monthlyRecharge: "600", monthlyApiCost: "108.43" }],
  monthlyPlanCashCny: "0", currentPeriod: null };

const planFinance: ResourceFinanceView = { resourceId: "plan-1", providerCode: "kimi", mode: "CODING_PLAN",
  accounts: [], monthlyPlanCashCny: "0", currentPeriod: {
    id: "period-1", productName: "Kimi Coding Plan",
    periodStart: "2026-08-18T16:00:00.000Z", periodEndExclusive: "2026-09-18T16:00:00.000Z",
    fixedFeeAmount: "199", fixedFeeCurrency: "CNY", fixedCashPaidCny: "199",
    totalQuota: "300000000", quotaUnit: "TOKEN",
    trueTokens: "9000000", deductedQuota: "9000000", deductedQuotaComplete: true,
    requestCount: "200",
  } };

// projectFinanceUtilization 属资源复盘路由（resource-insights/routes.ts），不在 S3a 合同
// 范围（其 API 余额/费用投影走资金读模型，处置归 WP2/WP4），既有断言原样保留。
it("projects the same API balance and cost into utilization", () => {
  const row = { resourceId: "resource-1", mode: "API", budgetStatus: "ACTIVE",
    budgetAmount: "200", budgetCurrency: "CNY" } as ResourceUtilizationRow;
  expect(projectFinanceUtilization(row, apiFinance)).toMatchObject({
    currentBalance: "498.4", apiCost: "108.43", purchaseCashAmount: "600",
    utilizationRate: "0.54215000", budgetDifference: "91.57000000",
  });
});

/**
 * S3a 迁移（依据：WP0 contracts.md §1 C1 约束“finance-usage-overview.ts 的 remainingQuota
 * 覆盖行为移除，余额走 C2”＋ACE-06“不把货币余额放进 Token/套餐剩余额度、全部消费视图
 * 采用同源费用”）：
 *   a) API 汇总行的 monthlyCost/monthlyCostReason/currency 由基础层 loadApiCostEstimation
 *      同源供给，本投影不得用资金账户 monthlyApiCost 覆盖；
 *   b) rechargeAmount/currentBalance 不再从资金账户覆盖 API 汇总行，保留基础层厂商经营
 *      快照事实（官方余额域走 C2）；
 *   c) API 模型行 remainingQuota/currency 不被账户余额覆盖。
 * 由此 finance 开（投影后）与 finance 关（基础层原样）两条路径的 API 字段同源同值。
 */
it("keeps API overview fields同源：finance projection must not override API cost or balance fields", () => {
  const baseOverview = {
    providerSummaries: [{ providerCode: "deepseek", mode: "API",
      monthlyCost: "12.34000000", monthlyCostReason: null, currency: "CNY",
      rechargeAmount: "80.00000000", currentBalance: "87.66000000" }],
    modelDetails: [{ resourceId: "resource-1", providerCode: "deepseek", mode: "API",
      remainingQuota: "87.66000000", currency: "CNY", monthlyCost: "12.34000000" }],
  } as unknown as ResourceUsageOverview;
  const projected = projectFinanceUsageOverview(baseOverview, [apiFinance]);
  // a+b) API 汇总行：资金账户的 108.43/600/498.4 不得覆盖同源估算与快照事实。
  expect(projected.providerSummaries[0]).toMatchObject({
    monthlyCost: "12.34000000", monthlyCostReason: null, currency: "CNY",
    rechargeAmount: "80.00000000", currentBalance: "87.66000000",
  });
  expect(projected.providerSummaries[0]).not.toMatchObject({ monthlyCost: "108.43000000" });
  // c) API 模型行：remainingQuota/currency 保持基础层快照值，不被账户余额 498.4/CNY 覆盖。
  expect(projected.modelDetails[0]).toMatchObject({
    remainingQuota: "87.66000000", currency: "CNY",
  });
  // finance 关路径＝基础层原样返回：与上面投影后的 API 字段逐字段相等（双路同源同值）。
  expect(baseOverview.providerSummaries[0]).toEqual(projected.providerSummaries[0]);
  expect(baseOverview.modelDetails[0]).toEqual(projected.modelDetails[0]);
});

/**
 * S3a 迁移：原用例断言“期初余额缺失时仍从资金账户透出 monthlyApiCost”——该前提随 C1
 * 约束退役（API 费用不再来自资金账户；同源估算不依赖期初/资金初始化，ACE-03）。改断言：
 * 账户月费用/币种不进入 API 行，基础层字段（含模型行 remainingQuota=null 的事实）原样透传。
 */
it("keeps API cost同源 even when the funding account lacks opening balance but knows usage costs", () => {
  const missingOpeningFinance: ResourceFinanceView = {
    resourceId: "resource-1",
    providerCode: "deepseek",
    mode: "API",
    accounts: [{
      currency: "CNY",
      balanceState: "MISSING_OPENING_BALANCE",
      balance: null,
      monthOpeningState: "MISSING_OPENING_BALANCE",
      monthOpeningBalance: null,
      monthlyRecharge: "0",
      monthlyApiCost: "0.07",
    }],
    monthlyPlanCashCny: "0",
    currentPeriod: null,
  };
  const overview = {
    providerSummaries: [{ providerCode: "deepseek", mode: "API",
      monthlyCost: "0.05000000", monthlyCostReason: null, currency: "CNY",
      rechargeAmount: null, currentBalance: null }],
    modelDetails: [{ resourceId: "resource-1", providerCode: "deepseek", mode: "API",
      remainingQuota: null, currency: "CNY" }],
  } as unknown as ResourceUsageOverview;
  const projected = projectFinanceUsageOverview(overview, [missingOpeningFinance]);
  // 资金账户的 0.07/CNY 不覆盖 API 行；基础层估算值与快照事实（null 余额）原样保留。
  expect(projected.providerSummaries[0]).toMatchObject({
    monthlyCost: "0.05000000", monthlyCostReason: null, currency: "CNY",
    currentBalance: null, rechargeAmount: null,
  });
  expect(projected.modelDetails[0]).toMatchObject({ remainingQuota: null, currency: "CNY" });
});

// 套餐分支行为不变（C4/W5-W6 合同原样；S3a 未触碰 CODING_PLAN 分支）。
it("projects active carryover subscription cost and ledger quota independently from monthly cash", () => {
  const row = { resourceId: "plan-1", mode: "CODING_PLAN", totalQuota: "300000000",
    usedQuota: null, remainingQuota: null, currency: "CNY" } as ResourceUtilizationRow;
  expect(projectFinanceUtilization(row, planFinance)).toMatchObject({
    packageCost: "199", purchaseCashAmount: "0", totalQuota: "300000000",
    usedQuota: "9000000", remainingQuota: "291000000", utilizationRate: "0.03000000",
    utilizationBasis: "CODING_PLAN_SUBSCRIPTION_PERIOD", notCalculableReason: null,
    servicePeriodStart: "2026-08-19", servicePeriodEnd: "2026-09-19",
  });

  const overview = { providerSummaries: [{ providerCode: "kimi", mode: "CODING_PLAN",
    totalQuota: "300000000", usedQuota: "old", remainingQuota: "old", currency: null }],
    modelDetails: [{ resourceId: "plan-1", providerCode: "kimi", mode: "CODING_PLAN" }],
  } as unknown as ResourceUsageOverview;
  expect(projectFinanceUsageOverview(overview, [planFinance]).providerSummaries[0]).toMatchObject({
    packageCost: "199.00000000", monthlyCost: "0.00000000",
    usedQuota: "9000000.00000000", remainingQuota: "291000000.00000000",
    subscriptionPeriodStart: "2026-08-19", subscriptionPeriodEnd: "2026-09-19",
  });
});

it("does not mix current-period usage with another snapshot or mislabel CNY cash as foreign currency", () => {
  const incompleteFinance: ResourceFinanceView = { ...planFinance, currentPeriod: {
    ...planFinance.currentPeriod!, fixedFeeAmount: "30", fixedFeeCurrency: "USD",
    fixedCashPaidCny: "220", totalQuota: null, quotaUnit: null,
  } };
  const row = { resourceId: "plan-1", mode: "CODING_PLAN", totalQuota: "300000000",
    usedQuota: "old", remainingQuota: "old", currency: "USD" } as ResourceUtilizationRow;
  expect(projectFinanceUtilization(row, incompleteFinance)).toMatchObject({
    packageCost: "220", currency: "CNY", totalQuota: null, usedQuota: "9000000",
    remainingQuota: null, utilizationRate: null, utilizationBasis: null,
    notCalculableReason: "SUBSCRIPTION_QUOTA_FACT_NOT_AVAILABLE",
  });

  const overview = { providerSummaries: [{ providerCode: "kimi", mode: "CODING_PLAN",
    totalQuota: "300000000", usedQuota: "old", remainingQuota: "old", currency: "USD" }],
    modelDetails: [],
  } as unknown as ResourceUsageOverview;
  expect(projectFinanceUsageOverview(overview, [incompleteFinance]).providerSummaries[0])
    .toMatchObject({ packageCost: "220.00000000", currency: "CNY", totalQuota: null,
      usedQuota: "9000000.00000000", remainingQuota: null });

  const missingDeduction: ResourceFinanceView = { ...planFinance, currentPeriod: {
    ...planFinance.currentPeriod!, deductedQuota: null, deductedQuotaComplete: false,
  } };
  expect(projectFinanceUtilization(row, missingDeduction)).toMatchObject({
    usedQuota: null, remainingQuota: null, utilizationRate: null,
    totalQuota: "300000000",
    notCalculableReason: "SUBSCRIPTION_DEDUCTION_FACT_INCOMPLETE",
  });
});
