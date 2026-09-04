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

it("projects the same API balance and cost into utilization", () => {
  const row = { resourceId: "resource-1", mode: "API", budgetStatus: "ACTIVE",
    budgetAmount: "200", budgetCurrency: "CNY" } as ResourceUtilizationRow;
  expect(projectFinanceUtilization(row, apiFinance)).toMatchObject({
    currentBalance: "498.4", apiCost: "108.43", purchaseCashAmount: "600",
    utilizationRate: "0.54215000", budgetDifference: "91.57000000",
  });
});

it("projects the same balance into provider and model overview", () => {
  const overview = { providerSummaries: [{ providerCode: "deepseek", mode: "API" }],
    modelDetails: [{ resourceId: "resource-1", providerCode: "deepseek", mode: "API",
      remainingQuota: "old", currency: "USD" }] } as unknown as ResourceUsageOverview;
  const projected = projectFinanceUsageOverview(overview, [apiFinance]);
  expect(projected.providerSummaries[0]).toMatchObject({
    currentBalance: "498.40000000", monthlyCost: "108.43000000",
    rechargeAmount: "600.00000000", currency: "CNY",
  });
  expect(projected.modelDetails[0]).toMatchObject({ remainingQuota: "498.4", currency: "CNY" });
});

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
