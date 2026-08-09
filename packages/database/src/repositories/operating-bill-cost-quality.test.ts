import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import {
  addKnownCost,
  addSubjectApiCost,
  knownAmount,
  nullableAmount,
  nullableTotal,
  resourceCost,
  sumKnownCosts,
  unknownApiCostGaps,
} from "./operating-bill-cost-quality.js";

describe("POOL-043 API 成本未知传播", () => {
  it("同资源任一未知明细吸收已知成本，并生成明确缺口", () => {
    const totals = new Map<string, Decimal | null>();
    addKnownCost(totals, "api-a", "1.25");
    addKnownCost(totals, "api-a", "0.75");
    expect(nullableAmount(resourceCost(totals, "api-a"))).toBe("2.00000000");

    addKnownCost(totals, "api-a", null);
    addKnownCost(totals, "api-a", "9.00");
    expect(resourceCost(totals, "api-a")).toBeNull();
    expect(sumKnownCosts(totals)).toBeNull();
    expect(unknownApiCostGaps(totals, new Map([
      ["api-a", { resource_name: "DeepSeek API" }],
    ]))).toEqual([{
      code: "API_COST_UNKNOWN",
      message: "DeepSeek API 存在未知 API 成本",
      providerResourceId: "api-a",
    }]);
  });

  it("无调用资源保持精确零，全部已知资源才允许汇总总成本", () => {
    const totals = new Map<string, Decimal | null>();
    expect(nullableAmount(resourceCost(totals, "unused"))).toBe("0.00000000");
    expect(nullableAmount(sumKnownCosts(totals))).toBe("0.00000000");
    expect(unknownApiCostGaps(totals, new Map())).toEqual([]);

    addKnownCost(totals, "api-a", "1.25");
    addKnownCost(totals, "api-b", "0.75");
    expect(nullableAmount(sumKnownCosts(totals))).toBe("2.00000000");
    expect(unknownApiCostGaps(totals, new Map())).toEqual([]);
    expect(nullableTotal(sumKnownCosts(totals), new Decimal("3"))).toBe("5.00000000");
    expect(nullableTotal(null, new Decimal("3"))).toBeNull();
  });

  it("未知成本缺资源名称时回退稳定资源 ID，且只报告未知项", () => {
    const totals = new Map<string, Decimal | null>([
      ["known-resource", new Decimal("1.25")],
      ["missing-resource", null],
    ]);
    expect(unknownApiCostGaps(totals, new Map())).toEqual([{
      code: "API_COST_UNKNOWN",
      message: "missing-resource 存在未知 API 成本",
      providerResourceId: "missing-resource",
    }]);
  });

  it("大额与八位小数累计保持 48 位财务精度", () => {
    const totals = new Map<string, Decimal | null>();
    addKnownCost(totals, "api-a", "1234567890123456789012345678.12345678");
    addKnownCost(totals, "api-a", "0.00000001");
    expect(nullableAmount(sumKnownCosts(totals)))
      .toBe("1234567890123456789012345678.12345679");
  });

  it("主体成本 known flag 一旦遇到未知值就不再伪装精确", () => {
    const target = { api: new Decimal(0), apiKnown: true };
    addSubjectApiCost(target, "1.5");
    expect(knownAmount(target.api, target.apiKnown)).toBe("1.50000000");
    addSubjectApiCost(target, null);
    addSubjectApiCost(target, "0.5");
    expect(knownAmount(target.api, target.apiKnown)).toBeNull();
    expect(nullableAmount(null)).toBeNull();
  });
});
