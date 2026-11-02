import { describe, expect, it } from "vitest";
import type { DashboardSummary, MonthlyFinanceSummary } from "@qianliu/database";

import { projectDashboardFinance, shanghaiDateAt, shanghaiMonthAt } from "./dashboard-projection.js";

/**
 * 断言迁移依据（WP1 S3b 合同 §1.1 / WP0 contracts.md C1 / ACE-06/07）：
 * /dashboard finance 开路径对首页 API 费用字段（monthlyApiCost(s)/Reason）的资金读模型
 * 覆盖移除——API 分量改由 getSummary 已经 applyApiCostEstimationToSpend 供给的同源估算值
 * 透传；资金读模型仅保留套餐分量（packagePayment 系列，含 complete 缺口表达）与
 * recharge 系列；totalSpend(s) 由套餐分量 + 估算 API 分量按币种重新合计。
 */
const estimationSummary = {
  monthlyPackagePayment: "999", monthlyPackagePayments: [],
  monthlyApiCost: "1.05000000",
  monthlyApiCosts: [{ currency: "CNY", amount: "1.05000000" }],
  monthlyApiSpendReason: null,
  monthlyTotalSpend: "1.05000000",
  monthlyTotalSpends: [{ currency: "CNY", amount: "1.05000000" }],
  monthlyRechargeAmount: "999", monthlyRechargeAmounts: [],
} as unknown as DashboardSummary;

const finance = {
  complete: true, codingPlanFixedCostCny: "199.00000000",
  apiOperatingCosts: [{ currency: "CNY", amount: "108.43000000" }],
  apiRecharges: [{ currency: "CNY", amount: "600.00000000" }], gaps: [],
} as unknown as MonthlyFinanceSummary;

it("finance 开路径透传同源估算 API 金额，仅覆盖套餐与充值并重算总额", () => {
  expect(projectDashboardFinance(estimationSummary, finance)).toMatchObject({
    monthlyPackagePayment: "199.00000000",
    monthlyApiCost: "1.05000000",
    monthlyApiCosts: [{ currency: "CNY", amount: "1.05000000" }],
    monthlyApiSpendReason: null,
    monthlyTotalSpend: "200.05000000",
    monthlyTotalSpends: [{ currency: "CNY", amount: "200.05000000" }],
    monthlyRechargeAmount: "600.00000000",
  });
});

it("finance 开/关两路首页 API 金额同值；套餐缺口（complete=false）只影响套餐与总额", () => {
  const projected = projectDashboardFinance(estimationSummary, finance);
  // 开路径 API 字段与关路径（getSummary 原值）逐字段相等（ACE-06：全部消费视图同源）。
  expect(projected.monthlyApiCost).toBe(estimationSummary.monthlyApiCost);
  expect(projected.monthlyApiCosts).toEqual(estimationSummary.monthlyApiCosts);
  expect(projected.monthlyApiSpendReason).toBe(estimationSummary.monthlyApiSpendReason);

  const incomplete = { ...finance, complete: false } as unknown as MonthlyFinanceSummary;
  const projectedIncomplete = projectDashboardFinance(estimationSummary, incomplete);
  expect(projectedIncomplete.monthlyApiCost).toBe(estimationSummary.monthlyApiCost);
  expect(projectedIncomplete.monthlyPackagePayment).toBeNull();
  expect(projectedIncomplete.monthlyTotalSpend).toBeNull();
  expect(projectedIncomplete.monthlyRechargeAmount).toBeNull();
});

it("混币估算分量不与套餐混加：总额 scalar 为 null，分列保留各币种", () => {
  const mixed = {
    ...estimationSummary,
    monthlyApiCost: null,
    monthlyApiCosts: [
      { currency: "CNY", amount: "1.05000000" },
      { currency: "USD", amount: "2.00000000" },
    ],
    monthlyApiSpendReason: "币种不一致：CNY、USD",
    monthlyTotalSpend: null,
    monthlyTotalSpends: [],
  } as unknown as DashboardSummary;
  // 总额语义与 applyApiCostEstimationToSpend 一致：API 分量不可合并为单一金额时，
  // totalSpend/totalSpends 不产出（不混币相加），开/关两路同值。
  expect(projectDashboardFinance(mixed, finance)).toMatchObject({
    monthlyApiCost: null,
    monthlyTotalSpend: null,
    monthlyTotalSpends: [],
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
