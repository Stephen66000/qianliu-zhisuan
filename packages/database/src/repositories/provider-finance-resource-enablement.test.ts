/**
 * 资源级资金启用判定（PFH-07 / 计划 §6.3-3）负路径单测。
 *
 * 纯判定与数据库解耦，因此这里可以逐个钉住失败关闭条件：缺必要币种期初、公式漂移、
 * 余额为负、以及「零事实币种」这一绝不能放行的边界。
 */
import { describe, expect, it } from "vitest";
import type { ActivationCurrency } from "@qianliu/domain";

import {
  evaluateResourceEnablementDecision,
  type ResourceBalanceEvidence,
} from "./provider-finance-resource-enablement.js";

function balance(patch: Partial<ResourceBalanceEvidence> & { currency: ActivationCurrency }): ResourceBalanceEvidence {
  return {
    hasOpeningBalance: true, formulaMatches: true, negative: false,
    computedBalance: "100.00000000", reportedBalance: "100.00000000", ...patch,
  };
}

describe("资源级资金启用判定", () => {
  it("必要币种齐备、公式守恒且非负时无阻断项", () => {
    const blockers = evaluateResourceEnablementDecision({
      requiredCurrencies: ["CNY"],
      openingCurrencies: ["CNY"],
      balances: [balance({ currency: "CNY" })],
    });
    expect(blockers).toEqual([]);
  });

  it("缺少必要币种期初时失败关闭", () => {
    const blockers = evaluateResourceEnablementDecision({
      requiredCurrencies: ["CNY", "USD"],
      openingCurrencies: ["CNY"],
      balances: [balance({ currency: "CNY" }), balance({ currency: "USD", hasOpeningBalance: false })],
    });
    expect(blockers).toEqual([{
      code: "MISSING_OPENING_BALANCE", currency: "USD", detail: "必要币种账户缺少期初余额",
    }]);
  });

  it("余额公式漂移时失败关闭，并给出重算与已落库对照", () => {
    const blockers = evaluateResourceEnablementDecision({
      requiredCurrencies: ["CNY"],
      openingCurrencies: ["CNY"],
      balances: [balance({
        currency: "CNY", formulaMatches: false,
        computedBalance: "100.00000000", reportedBalance: "120.00000000",
      })],
    });
    expect(blockers).toEqual([{
      code: "BALANCE_FORMULA_MISMATCH", currency: "CNY",
      detail: "重算 100.00000000 ≠ 已落库 120.00000000",
    }]);
  });

  it("余额为负时失败关闭（公式一致也必须拦）", () => {
    const blockers = evaluateResourceEnablementDecision({
      requiredCurrencies: ["CNY"],
      openingCurrencies: ["CNY"],
      balances: [balance({ currency: "CNY", negative: true, computedBalance: "-5.00000000",
        reportedBalance: "-5.00000000" })],
    });
    expect(blockers).toEqual([
      { code: "NEGATIVE_BALANCE", currency: "CNY", detail: "-5.00000000" },
    ]);
  });

  it("零事实币种（未登记任何必要币种期初）绝不放行到可调度状态", () => {
    const blockers = evaluateResourceEnablementDecision({
      requiredCurrencies: [], openingCurrencies: [], balances: [],
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.code).toBe("REQUIRED_CURRENCY_UNRESOLVED");
    expect(blockers[0]!.currency).toBeNull();
  });

  it("重复币种去重且判定顺序稳定（不依赖输入顺序）", () => {
    const forward = evaluateResourceEnablementDecision({
      requiredCurrencies: ["USD", "CNY", "CNY", "USD"],
      openingCurrencies: [],
      balances: [],
    });
    const reversed = evaluateResourceEnablementDecision({
      requiredCurrencies: ["CNY", "USD"],
      openingCurrencies: [],
      balances: [],
    });
    expect(forward.map((row) => row.currency)).toEqual(["CNY", "USD"]);
    expect(forward).toEqual(reversed);
  });
});
