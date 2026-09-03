import { expect, it } from "vitest";
import type { ResourceFinanceView, ResourceUsageOverview } from "@qianliu/database";

import { projectFinanceUtilization } from "../resource-insights/routes.js";
import { projectFinanceUsageOverview } from "../providers/finance-usage-overview.js";
import type { ResourceUtilizationRow } from "../resource-insights/query.js";

const apiFinance: ResourceFinanceView = { resourceId: "resource-1", mode: "API",
  accounts: [{ currency: "CNY", balanceState: "NORMAL", balance: "498.4",
    monthOpeningState: "NORMAL", monthOpeningBalance: "6.83",
    monthlyRecharge: "600", monthlyApiCost: "108.43" }],
  monthlyPlanCashCny: "0", currentPeriod: null };

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
