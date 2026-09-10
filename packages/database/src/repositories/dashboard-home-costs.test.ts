/**
 * 标准版首页费用同期纯函数单测（V14-C4 G01/G02）——
 * bridgeIncompleteReason 决定"有已知金额但不完整"时是否禁止比较（R03-G01 指认的
 * 关键分支），以合成月度经营汇总直接驱动三分支；不依赖数据库。
 */
import { describe, expect, it } from "vitest";

import type { MonthlyOperatingCostSummary } from "./monthly-operating-cost.js";
import { bridgeIncompleteReason } from "./dashboard-home-costs.js";

function summary(overrides: Partial<MonthlyOperatingCostSummary>): MonthlyOperatingCostSummary {
  return {
    apiSpend: null,
    ledgerApiCost: null,
    packageCost: null,
    totalSpend: null,
    openingBalance: null,
    rechargeAmount: null,
    endingBalance: null,
    currency: null,
    openingBalances: [],
    rechargeAmounts: [],
    endingBalances: [],
    apiSpends: [],
    packageCosts: [],
    totalSpends: [],
    apiSpendStatus: "CALCULABLE",
    apiSpendReason: null,
    ...overrides,
  };
}

describe("bridgeIncompleteReason（余额桥接完整性三分支）", () => {
  it("无已知金额：透出 API 缺口原因", () => {
    const result = bridgeIncompleteReason(summary({
      totalSpends: [],
      apiSpendReason: "待补期末余额",
      apiSpendStatus: "ENDING_BALANCE_MISSING",
    }));
    expect(result).toBe("待补期末余额");
  });

  it("无已知金额且无原因：给明确缺口文案，不冒充 0", () => {
    const result = bridgeIncompleteReason(summary({ totalSpends: [] }));
    expect(result).toBe("同期费用缺少可计算事实");
  });

  it("有已知金额但 API 不完整：透出已知部分、不再连坐标记缺口（HOME-SIMPLIFY C6）", () => {
    // 口径修正：总额不完整时已知金额（套餐/API 已计价）保留透出，缺口不再重复标记——
    // 组合器回退已知部分后，金额本身即"已知部分"，incompleteReason 只在无任何已知金额时给出。
    const result = bridgeIncompleteReason(summary({
      totalSpends: [{ currency: "CNY", amount: "300.00000000" }],
      packageCosts: [{ currency: "CNY", amount: "300.00000000" }],
      apiSpends: [],
      apiSpendStatus: "ENDING_BALANCE_MISSING",
      apiSpendReason: "待补期末余额",
      packageCost: "300.00000000",
    }));
    expect(result).toBeNull();
  });

  it("有已知金额且 API 不完整但无原因：同样透出已知部分、不臆造缺口", () => {
    const result = bridgeIncompleteReason(summary({
      totalSpends: [{ currency: "CNY", amount: "300.00000000" }],
      apiSpendStatus: "CURRENCY_MISMATCH",
      apiSpendReason: null,
    }));
    expect(result).toBeNull();
  });

  it("完整可计算：返回 null（允许比较）", () => {
    const result = bridgeIncompleteReason(summary({
      totalSpends: [{ currency: "CNY", amount: "370.00000000" }],
      apiSpends: [{ currency: "CNY", amount: "70.00000000" }],
      packageCosts: [{ currency: "CNY", amount: "300.00000000" }],
      apiSpendStatus: "CALCULABLE",
    }));
    expect(result).toBeNull();
  });

  it("无 API 资源（NOT_APPLICABLE）：有套餐金额时允许比较", () => {
    const result = bridgeIncompleteReason(summary({
      totalSpends: [{ currency: "CNY", amount: "300.00000000" }],
      packageCosts: [{ currency: "CNY", amount: "300.00000000" }],
      apiSpendStatus: "NOT_APPLICABLE",
    }));
    expect(result).toBeNull();
  });
});
