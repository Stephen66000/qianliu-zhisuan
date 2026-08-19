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

  it("多币种充值与负桥接均 fail-closed", () => {
    const mixed = calculateMonthlyOperatingCostResource({
      row: row(), recharges: [
        { provider_resource_id: "api-1", currency: "CNY", amount: "10" },
        { provider_resource_id: "api-1", currency: "USD", amount: "1" },
      ], ledgerApiCost: "0", periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(mixed).toMatchObject({ apiSpend: null, rechargeAmount: null, apiSpendStatus: "CURRENCY_MISMATCH" });
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
    expect(calculateMonthlyOperatingCostResource({
      row: row(override), recharges: [], ledgerApiCost: "0",
      periodStart: new Date("2026-07-31T16:00:00Z"),
    })).toMatchObject({ apiSpend: null, apiSpendStatus: status });
  });

  it("API-only 套餐费用为零；API 与套餐币种不一致时禁止总计", () => {
    expect(summarizeMonthlyOperatingCosts([apiResource()])).toMatchObject({
      apiSpend: "10.00000000", packageCost: "0.00000000", totalSpend: "10.00000000", currency: "CNY",
    });
    const plan = planResource({ currency: "USD" });
    expect(summarizeMonthlyOperatingCosts([apiResource(), plan])).toMatchObject({
      apiSpendStatus: "CURRENCY_MISMATCH", packageCost: null, totalSpend: null,
    });
  });

  it("空企业、纯套餐、套餐缺值与账本未知分别保持零值或未知传播", () => {
    expect(summarizeMonthlyOperatingCosts([])).toMatchObject({
      apiSpend: "0.00000000", packageCost: null, totalSpend: null,
      openingBalance: "0.00000000", endingBalance: "0.00000000", rechargeAmount: null,
      apiSpendStatus: "NOT_APPLICABLE",
    });
    expect(summarizeMonthlyOperatingCosts([planResource()])).toMatchObject({
      apiSpend: "0.00000000", packageCost: "30.00000000", totalSpend: "30.00000000", currency: "CNY",
    });
    expect(summarizeMonthlyOperatingCosts([
      planResource(), planResource({ resourceId: "plan-2", packageCost: null }),
    ])).toMatchObject({ packageCost: null, totalSpend: null });
    expect(summarizeMonthlyOperatingCosts([
      apiResource(), { ...apiResource(), resourceId: "api-2", ledgerApiCost: null },
    ])).toMatchObject({ apiSpend: "20.00000000", ledgerApiCost: null, totalSpend: "20.00000000" });
  });

  it("API 不可计算时即使同币种套餐已知也不生成月度总花费", () => {
    const missingApi = calculateMonthlyOperatingCostResource({
      row: row({ opening_balance: null }), recharges: [], ledgerApiCost: "1",
      periodStart: new Date("2026-07-31T16:00:00Z"),
    });
    expect(summarizeMonthlyOperatingCosts([missingApi, planResource()])).toMatchObject({
      apiSpend: null, packageCost: "30.00000000", totalSpend: null,
      openingBalance: null, endingBalance: null, apiSpendStatus: "OPENING_BALANCE_MISSING",
    });
  });
});
