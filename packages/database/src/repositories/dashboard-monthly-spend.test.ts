import { describe, expect, it } from "vitest";

import type { MonthlyOperatingCostResource } from "./monthly-operating-cost.js";
import { summarizeDashboardMonthlySpend } from "./dashboard-monthly-spend.js";

function resource(
  overrides: Partial<MonthlyOperatingCostResource> = {},
): MonthlyOperatingCostResource {
  return {
    resourceId: "api-1",
    providerCode: "provider",
    providerName: "厂商",
    resourceName: "API",
    mode: "API",
    currency: "CNY",
    openingBalanceCurrency: "CNY",
    rechargeAmounts: [],
    endingBalanceCurrency: "CNY",
    apiSpendCurrency: "CNY",
    packageCostCurrency: null,
    openingSnapshotId: "open-1",
    openingSnapshotVersion: 1,
    openingSnapshotAt: "2026-08-31T16:00:00.000Z",
    openingBalanceFactId: "open-1",
    openingBalanceFactVersion: 1,
    openingBalanceSource: "OPERATING_SNAPSHOT",
    endingSnapshotId: "end-1",
    endingSnapshotVersion: 2,
    endingSnapshotAt: "2026-09-20T00:00:00.000Z",
    openingBalance: "100",
    rechargeAmount: "20",
    endingBalance: "30",
    apiSpend: "90.00000000",
    ledgerApiCost: "12.50000000",
    apiSpendStatus: "CALCULABLE",
    apiSpendReason: null,
    packageCost: "0.00000000",
    servicePeriodStart: null,
    servicePeriodEnd: null,
    ...overrides,
  };
}

function plan(
  id: string,
  servicePeriodStart: string | null,
  packageCost = "299.00000000",
): MonthlyOperatingCostResource {
  return resource({
    resourceId: id,
    resourceName: id,
    mode: "CODING_PLAN",
    currency: "CNY",
    openingBalanceCurrency: null,
    endingBalanceCurrency: null,
    apiSpendCurrency: null,
    packageCostCurrency: "CNY",
    openingBalance: null,
    rechargeAmount: "0.00000000",
    endingBalance: null,
    apiSpend: "0.00000000",
    ledgerApiCost: "0.00000000",
    apiSpendStatus: "NOT_APPLICABLE",
    packageCost,
    servicePeriodStart,
    servicePeriodEnd: "2026-10-01",
  });
}

describe("0901 首页月度支出", () => {
  const start = new Date("2026-08-31T16:00:00.000Z");
  const end = new Date("2026-09-30T16:00:00.000Z");

  it("套餐只按本月订阅时间计入，API 使用已冻结账本费用", () => {
    expect(summarizeDashboardMonthlySpend([
      resource(),
      plan("old-plan", "2026-08-15", "199.00000000"),
      plan("new-plan", "2026-09-01"),
    ], start, end)).toEqual({
      packagePayment: "299.00000000",
      packagePayments: [{ currency: "CNY", amount: "299.00000000" }],
      apiCost: "12.50000000",
      apiCosts: [{ currency: "CNY", amount: "12.50000000" }],
      apiCostReason: null,
      totalSpend: "311.50000000",
      totalSpends: [{ currency: "CNY", amount: "311.50000000" }],
    });
  });

  it("无当月订阅时套餐支出为零，不沿用仍有效的旧套餐费用", () => {
    expect(summarizeDashboardMonthlySpend([
      plan("old-plan", "2026-08-15"),
    ], start, end)).toMatchObject({
      packagePayment: "0.00000000",
      packagePayments: [],
      apiCost: "0.00000000",
      totalSpend: "0.00000000",
    });
  });

  it("正金额缺少币种时 fail-closed", () => {
    expect(summarizeDashboardMonthlySpend([
      resource({ currency: null, ledgerApiCost: "12.50000000" }),
    ], start, end)).toMatchObject({
      apiCost: null,
      apiCosts: [],
      apiCostReason: "账本费用或币种事实不完整",
      totalSpend: null,
    });
  });
});
