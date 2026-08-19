import { describe, expect, it } from "vitest";

import {
  calculateMonthlyOperatingCostResource,
  summarizeMonthlyOperatingCosts,
  type MonthlyOperatingCostResource,
  type MonthlyOperatingCostResourceRow,
} from "./monthly-operating-cost.js";

function row(overrides: Partial<MonthlyOperatingCostResourceRow> = {}): MonthlyOperatingCostResourceRow {
  return {
    resource_id: "api-1", provider_code: "provider", provider_name: "厂商", resource_name: "API",
    mode: "API", opening_snapshot_id: "open-1", opening_snapshot_version: 1,
    opening_balance: "100", opening_currency: "CNY", opening_at: new Date("2026-07-31T16:00:00Z"),
    ending_snapshot_id: "end-1", ending_snapshot_version: 2, ending_balance: "90",
    ending_currency: "CNY", ending_at: new Date("2026-08-20T00:00:00Z"), package_cost: null,
    service_period_start: null, service_period_end: null, ...overrides,
    manual_opening_id: overrides.manual_opening_id ?? null,
    manual_opening_version: overrides.manual_opening_version ?? null,
    opening_source: overrides.opening_source
      ?? (overrides.manual_opening_id ? "MANUAL" : "OPERATING_SNAPSHOT"),
  };
}

function apiResource(): MonthlyOperatingCostResource {
  return calculateMonthlyOperatingCostResource({
    row: row(), recharges: [], ledgerApiCost: "10",
    periodStart: new Date("2026-07-31T16:00:00Z"),
  });
}

function planResource(overrides: Partial<MonthlyOperatingCostResource> = {}): MonthlyOperatingCostResource {
  return {
    ...apiResource(), resourceId: "plan-1", resourceName: "Plan", mode: "CODING_PLAN", currency: "CNY",
    openingBalance: null, endingBalance: null, rechargeAmount: "0.00000000", apiSpend: "0.00000000",
    apiSpendStatus: "NOT_APPLICABLE", packageCost: "30.00000000", ...overrides,
  };
}

describe("POOL20-043 月度经营金额", () => {
  it("按期初加充值减期末计算并保留快照证据", () => {
    expect(calculateMonthlyOperatingCostResource({
      row: row(), recharges: [{ provider_resource_id: "api-1", currency: "CNY", amount: "20" }],
      ledgerApiCost: "3", periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({
      apiSpend: "30.00000000", rechargeAmount: "20.00000000", apiSpendStatus: "CALCULABLE",
      openingSnapshotId: "open-1", endingSnapshotId: "end-1", ledgerApiCost: "3.00000000",
    });
  });

  it("手工期初事实优先并保留独立来源，不冒充经营快照", () => {
    expect(calculateMonthlyOperatingCostResource({
      row: row({
        opening_snapshot_id: null, opening_snapshot_version: null,
        manual_opening_id: "manual-open-1", manual_opening_version: 2,
        opening_balance: "120", opening_currency: "CNY",
      }),
      recharges: [], ledgerApiCost: "30", periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({
      apiSpend: "30.00000000", openingSnapshotId: null,
      openingBalanceFactId: "manual-open-1", openingBalanceFactVersion: 2,
      openingBalanceSource: "MANUAL",
    });
  });

  it("Coding Plan 走不适用分支并保留套餐事实", () => {
    expect(calculateMonthlyOperatingCostResource({
      row: row({
        resource_id: "plan-calculated", mode: "CODING_PLAN", opening_balance: null,
        opening_currency: null, opening_at: null, ending_balance: null,
        ending_currency: "CNY", ending_at: null, package_cost: "30",
      }),
      recharges: [], ledgerApiCost: null, periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({
      mode: "CODING_PLAN", currency: "CNY", openingBalance: null,
      rechargeAmount: "0.00000000", endingBalance: null, apiSpend: "0.00000000",
      apiSpendStatus: "NOT_APPLICABLE", apiSpendReason: null, packageCost: "30",
    });
  });

  it("多币种充值与负桥接均 fail-closed", () => {
    const mixed = calculateMonthlyOperatingCostResource({
      row: row(), recharges: [
        { provider_resource_id: "api-1", currency: "CNY", amount: "10" },
        { provider_resource_id: "api-1", currency: "USD", amount: "1" },
      ], ledgerApiCost: "0", periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(mixed).toMatchObject({ apiSpend: null, rechargeAmount: null, apiSpendStatus: "CURRENCY_MISMATCH" });
    expect(calculateMonthlyOperatingCostResource({
      row: row(), recharges: [{ provider_resource_id: "api-1", currency: "USD", amount: "1" }],
      ledgerApiCost: "0", periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({ apiSpend: null, rechargeAmount: null, apiSpendStatus: "CURRENCY_MISMATCH" });
    expect(calculateMonthlyOperatingCostResource({
      row: row({ ending_balance: "120" }), recharges: [], ledgerApiCost: "0",
      periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({ apiSpend: null, apiSpendStatus: "NEGATIVE_BALANCE_BRIDGE" });
  });

  it.each([
    [{ opening_balance: null }, "OPENING_BALANCE_MISSING"],
    [{ opening_currency: null }, "OPENING_BALANCE_MISSING"],
    [{ opening_at: null }, "OPENING_BALANCE_MISSING"],
    [{ ending_balance: null }, "ENDING_BALANCE_MISSING"],
    [{ ending_currency: null }, "ENDING_BALANCE_MISSING"],
    [{ ending_at: null }, "ENDING_BALANCE_MISSING"],
    [{ ending_at: new Date("2026-07-31T16:00:00Z") }, "ENDING_BALANCE_MISSING"],
    [{ opening_currency: "USD" }, "CURRENCY_MISMATCH"],
  ] as const)("缺失或冲突事实 %# 返回明确状态", (override, status) => {
    const result = calculateMonthlyOperatingCostResource({
      row: row(override), recharges: [], ledgerApiCost: "0",
      periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(result).toMatchObject({ apiSpend: null, apiSpendStatus: status });
    if ("ending_currency" in override && override.ending_currency === null) {
      expect(result.currency).toBe("CNY");
    }
  });

  it("API-only 套餐费用为零；API 与套餐币种不一致时禁止总计", () => {
    expect(summarizeMonthlyOperatingCosts([apiResource()])).toMatchObject({
      apiSpend: "10.00000000", ledgerApiCost: "10.00000000",
      packageCost: "0.00000000", totalSpend: "10.00000000", currency: "CNY",
    });
    expect(summarizeMonthlyOperatingCosts([{ ...apiResource(), packageCost: "999.00000000" }]))
      .toMatchObject({ packageCost: "0.00000000", totalSpend: "10.00000000" });
    const plan = planResource({ currency: "USD" });
    expect(summarizeMonthlyOperatingCosts([apiResource(), plan])).toMatchObject({
      apiSpendStatus: "CURRENCY_MISMATCH", packageCost: null, totalSpend: null,
    });
  });

  it("空企业、纯套餐、套餐缺值与账本未知分别保持零值或未知传播", () => {
    expect(summarizeMonthlyOperatingCosts([])).toMatchObject({
      apiSpend: "0.00000000", packageCost: null, totalSpend: null,
      openingBalance: "0.00000000", endingBalance: "0.00000000", rechargeAmount: null,
      currency: null, apiSpendStatus: "NOT_APPLICABLE",
    });
    expect(summarizeMonthlyOperatingCosts([planResource()])).toMatchObject({
      apiSpend: "0.00000000", packageCost: "30.00000000", totalSpend: "30.00000000", currency: "CNY",
    });
    expect(summarizeMonthlyOperatingCosts([
      planResource(), planResource({ resourceId: "plan-2", packageCost: null }),
    ])).toMatchObject({
      packageCost: null, totalSpend: null, currency: "CNY",
      apiSpendStatus: "NOT_APPLICABLE", apiSpendReason: null,
    });
    expect(summarizeMonthlyOperatingCosts([
      planResource(), planResource({ resourceId: "plan-missing", packageCost: null, currency: null }),
    ])).toMatchObject({
      packageCost: null, totalSpend: null, currency: "CNY",
      apiSpendStatus: "NOT_APPLICABLE", apiSpendReason: null,
    });
    expect(summarizeMonthlyOperatingCosts([
      apiResource(), { ...apiResource(), resourceId: "api-2", ledgerApiCost: null },
    ])).toMatchObject({ apiSpend: "20.00000000", ledgerApiCost: null, totalSpend: "20.00000000" });
    expect(summarizeMonthlyOperatingCosts([
      { ...apiResource(), ledgerApiCost: null },
      { ...apiResource(), resourceId: "api-2", ledgerApiCost: null },
    ])).toMatchObject({ ledgerApiCost: null });
  });

  it("API 不可计算时即使同币种套餐已知也不生成月度总花费", () => {
    const missingApi = calculateMonthlyOperatingCostResource({
      row: row({ opening_balance: null }), recharges: [], ledgerApiCost: "1",
      periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(summarizeMonthlyOperatingCosts([missingApi, planResource()])).toMatchObject({
      apiSpend: null, packageCost: "30.00000000", totalSpend: null,
      openingBalance: null, endingBalance: "90.00000000", apiSpendStatus: "OPENING_BALANCE_MISSING",
    });
    expect(summarizeMonthlyOperatingCosts([apiResource(), missingApi])).toMatchObject({
      apiSpend: null, packageCost: "0.00000000", totalSpend: null,
      apiSpendStatus: "OPENING_BALANCE_MISSING",
    });
  });

  it("无当月充值是精确零，不被缺失的余额币种抹成未知", () => {
    const missingBalance = calculateMonthlyOperatingCostResource({
      row: row({
        resource_id: "api-missing", opening_balance: null, opening_currency: null,
        opening_at: null, ending_balance: null, ending_currency: null, ending_at: null,
      }),
      recharges: [], ledgerApiCost: "0", periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(summarizeMonthlyOperatingCosts([apiResource(), missingBalance]).rechargeAmount)
      .toBe("0.00000000");
    const nonzeroMissingCurrency = {
      ...missingBalance, rechargeAmount: "5.00000000",
    };
    expect(summarizeMonthlyOperatingCosts([nonzeroMissingCurrency]).rechargeAmount).toBeNull();
    expect(summarizeMonthlyOperatingCosts([
      apiResource(), nonzeroMissingCurrency,
    ]).rechargeAmount).toBeNull();
    expect(summarizeMonthlyOperatingCosts([{
      ...missingBalance, openingBalance: "0.00000000", endingBalance: "0.00000000",
    }])).toMatchObject({
      openingBalance: null, rechargeAmount: "0.00000000", endingBalance: null,
    });
  });

  it("API、套餐及缺币种三种企业汇总冲突分别 fail-closed", () => {
    const usdApi = { ...apiResource(), resourceId: "api-usd", currency: "USD" };
    expect(summarizeMonthlyOperatingCosts([apiResource(), usdApi])).toMatchObject({
      apiSpendStatus: "CURRENCY_MISMATCH", apiSpend: null, totalSpend: null,
      openingBalance: null, rechargeAmount: "0.00000000", endingBalance: null, currency: null,
    });
    expect(summarizeMonthlyOperatingCosts([
      planResource(), planResource({ resourceId: "plan-usd", currency: "USD" }),
    ])).toMatchObject({ apiSpendStatus: "NOT_APPLICABLE", packageCost: null, totalSpend: null });
    expect(summarizeMonthlyOperatingCosts([planResource({ currency: null })])).toMatchObject({
      packageCost: null, totalSpend: null, apiSpendReason: "余额、充值与套餐币种不一致",
    });
    expect(summarizeMonthlyOperatingCosts([{ ...apiResource(), currency: null }])).toMatchObject({
      apiSpendStatus: "CURRENCY_MISMATCH", apiSpend: null, packageCost: null,
      totalSpend: null, apiSpendReason: "余额、充值与套餐币种不一致",
    });
    expect(summarizeMonthlyOperatingCosts([
      planResource(), planResource({ resourceId: "plan-null-currency", currency: null }),
    ])).toMatchObject({
      packageCost: null, totalSpend: null, currency: "CNY",
      apiSpendReason: "余额、充值与套餐币种不一致",
    });
    expect(summarizeMonthlyOperatingCosts([{
      ...apiResource(), apiSpend: null, rechargeAmount: null, apiSpendStatus: "CURRENCY_MISMATCH",
    }])).toMatchObject({ apiSpendStatus: "CURRENCY_MISMATCH", apiSpend: null, packageCost: null });
    expect(summarizeMonthlyOperatingCosts([
      apiResource(), {
        ...apiResource(), resourceId: "api-incomplete-usd", currency: "USD", apiSpend: null,
        apiSpendStatus: "OPENING_BALANCE_MISSING", apiSpendReason: "待补期初余额",
      },
    ])).toMatchObject({
      apiSpendStatus: "CURRENCY_MISMATCH", apiSpend: null, totalSpend: null, currency: "CNY",
    });
    expect(summarizeMonthlyOperatingCosts([
      apiResource(), {
        ...apiResource(), resourceId: "api-incomplete-null", currency: null, apiSpend: null,
        apiSpendStatus: "OPENING_BALANCE_MISSING", apiSpendReason: "待补期初余额",
      },
    ])).toMatchObject({
      apiSpendStatus: "OPENING_BALANCE_MISSING", apiSpend: null, totalSpend: null,
      currency: "CNY", apiSpendReason: "待补期初余额",
    });
  });
});
