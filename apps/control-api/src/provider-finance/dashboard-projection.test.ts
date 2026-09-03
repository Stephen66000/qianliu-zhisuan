import { describe, expect, it } from "vitest";
import type { DashboardSummary, MonthlyFinanceSummary } from "@qianliu/database";

import { projectDashboardFinance, shanghaiDateAt, shanghaiMonthAt } from "./dashboard-projection.js";

const base = {
  monthlyPackagePayment: "999", monthlyPackagePayments: [], monthlyApiCost: "999",
  monthlyApiCosts: [], monthlyApiSpendReason: "old", monthlyTotalSpend: "999",
  monthlyTotalSpends: [], monthlyRechargeAmount: "999", monthlyRechargeAmounts: [],
} as unknown as DashboardSummary;

it("projects the unique finance ledger into dashboard money fields", () => {
  const finance = {
    complete: true, codingPlanFixedCostCny: "199.00000000",
    apiOperatingCosts: [{ currency: "CNY", amount: "108.43000000" }],
    apiRecharges: [{ currency: "CNY", amount: "600.00000000" }], gaps: [],
  } as unknown as MonthlyFinanceSummary;
  expect(projectDashboardFinance(base, finance)).toMatchObject({
    monthlyPackagePayment: "199.00000000",
    monthlyApiCost: "108.43000000",
    monthlyTotalSpend: "307.43000000",
    monthlyRechargeAmount: "600.00000000",
  });
});

describe("Shanghai month", () => {
  it("uses the local natural month at UTC boundaries", () => {
    expect(shanghaiMonthAt(new Date("2026-09-30T16:00:00.000Z"))).toBe("2026-10");
  });

  it("renders Shanghai midnight as the registered local date", () => {
    expect(shanghaiDateAt("2026-08-18T16:00:00.000Z")).toBe("2026-08-19");
  });
});
