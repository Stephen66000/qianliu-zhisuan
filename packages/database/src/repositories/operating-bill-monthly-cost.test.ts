import { describe, expect, it } from "vitest";

import { apiBalanceGaps } from "./operating-bill-monthly-cost.js";

describe("POOL20-043 余额桥接缺口字段", () => {
  // WP2-S5（AFR-07＋WP2 plan §4.5）：OPENING_BALANCE_MISSING 状态位已停产——运行时
  // 不会再产生该行（API_OPENING_BALANCE_MISSING 映射恒空）；本用例保留验证映射结构
  //（结构按合同保留，历史冻结快照形状/其余状态照旧）。
  it.each([
    ["OPENING_BALANCE_MISSING", "opening_balance"],
    ["ENDING_BALANCE_MISSING", "ending_balance"],
    ["CURRENCY_MISMATCH", "currency"],
    ["NEGATIVE_BALANCE_BRIDGE", "api_spend"],
  ])("%s 指向准确字段 %s", (status, field) => {
    const gaps = apiBalanceGaps({
      mode: "API", resource_id: "resource-1", resource_name: "API 资源",
      snapshot_id: "snapshot-1", snapshot_version: 2,
    }, {
      apiSpendStatus: status,
      apiSpendReason: `reason:${status}`,
    } as never);
    expect(gaps).toEqual([expect.objectContaining({
      code: `API_${status}`, field, message: expect.stringContaining(`reason:${status}`),
    })]);
  });

  it("非 API、已可计算与缺月度事实时不生成错误缺口", () => {
    const base = {
      resource_id: "resource-1", resource_name: "资源",
      snapshot_id: null, snapshot_version: null,
    };
    expect(apiBalanceGaps({ ...base, mode: "CODING_PLAN" }, undefined)).toEqual([]);
    expect(apiBalanceGaps({ ...base, mode: "API" }, {
      apiSpendStatus: "CALCULABLE",
    } as never)).toEqual([]);
    expect(apiBalanceGaps({ ...base, mode: "API" }, undefined)).toEqual([
      expect.objectContaining({
        code: "API_BALANCE_BRIDGE_MISSING", field: "balance_bridge",
        message: expect.stringContaining("余额桥接不可计算"),
      }),
    ]);
  });
});
