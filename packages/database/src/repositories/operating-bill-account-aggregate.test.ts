import { describe, expect, it } from "vitest";
import {
  addAccountFact,
  finishAccountSummary,
  finishAccountTotals,
  newAccountAccumulator,
  summarizeUsageQuality,
  usageShare,
  type OperatingBillAccountFact,
} from "./operating-bill-account-aggregate.js";
import {
  InvalidOperatingBillMonthError,
  operatingBillMonthRange,
} from "./operating-bill-month.js";

function fact(overrides: Partial<OperatingBillAccountFact> = {}): OperatingBillAccountFact {
  return {
    requestId: "request-1",
    sourcePrincipalId: "employee-1",
    sourcePrincipalName: "于滔",
    sourcePrincipalType: "EMPLOYEE",
    projectId: null,
    projectName: null,
    projectOwnerPersonId: null,
    projectOwnerName: null,
    projectDepartmentId: null,
    projectDepartmentName: null,
    providerCode: "deepseek",
    providerName: "DeepSeek",
    unifiedModelId: "model-1",
    currentAlias: "ql-deepseek-v4-flash",
    historicalAlias: "ql-deepseek-v4-flash",
    requestStatus: "SUCCEEDED",
    usedAt: new Date("2026-08-01T15:59:59.000Z"),
    activeDates: ["2026-08-01"],
    qualities: ["PROVIDER_REPORTED"],
    inputTokens: "100",
    outputTokens: "20",
    cacheTokens: "30",
    reasoningTokens: "4",
    deductedQuota: "50",
    apiCost: "1.25",
    packageAllocatedCost: "2.75",
    ...overrides,
  };
}

describe("POOL-043 账户聚合纯函数", () => {
  it("空账返回精确零值，不与 UNKNOWN 用量混淆", () => {
    expect(finishAccountTotals(newAccountAccumulator())).toEqual({
      inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
      totalTokens: "0", deductedQuota: "0", apiCost: "0.00000000",
      packageAllocatedCost: "0.00000000", totalAllocatedCost: "0.00000000",
      activeDays: 0, requestCount: 0, lastUsedAt: null, usageQuality: "EXACT",
    });
  });

  it("SQL 汇总行复用同一数值精度、未知传播与空账口径", () => {
    expect(finishAccountSummary({
      inputTokens: "9007199254740993", outputTokens: "7", cacheTokens: "2",
      reasoningTokens: "1", deductedQuota: "5", apiCost: "1.2",
      packageAllocatedCost: "2.3", qualities: ["PROVIDER_REPORTED"],
      activeDays: 2, requestCount: 3, lastUsedAt: new Date("2026-08-02T00:00:00Z"),
    })).toEqual({
      inputTokens: "9007199254740993", outputTokens: "7", cacheTokens: "2",
      reasoningTokens: "1", totalTokens: "9007199254741000", deductedQuota: "5",
      apiCost: "1.20000000", knownApiCost: "1.20000000", packageAllocatedCost: "2.30000000",
      totalAllocatedCost: "3.50000000", usageQuality: "EXACT",
      activeDays: 2, requestCount: 3, lastUsedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(finishAccountSummary({
      inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
      deductedQuota: null, apiCost: null, packageAllocatedCost: null, qualities: ["UNKNOWN"],
      activeDays: 1, requestCount: 1, lastUsedAt: null,
    })).toMatchObject({ totalTokens: null, deductedQuota: null, apiCost: null,
      packageAllocatedCost: null, totalAllocatedCost: null, usageQuality: "UNKNOWN" });
    expect(finishAccountSummary({
      inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
      deductedQuota: null, apiCost: null, packageAllocatedCost: null, qualities: [],
      activeDays: 0, requestCount: 0, lastUsedAt: null,
    })).toMatchObject({ totalTokens: "0", totalAllocatedCost: "0.00000000", usageQuality: "EXACT" });
  });

  it("汇总大整数、金额、北京时间活跃日、去重请求与最近使用", () => {
    const accumulator = newAccountAccumulator();
    addAccountFact(accumulator, fact({ inputTokens: "9007199254740993" }));
    addAccountFact(accumulator, fact({
      providerCode: "kimi",
      usedAt: new Date("2026-08-01T16:00:01.000Z"),
      activeDates: ["2026-08-02"],
      inputTokens: "7", outputTokens: "3", cacheTokens: "2", reasoningTokens: "1",
      deductedQuota: "5", apiCost: "0.75", packageAllocatedCost: "0.25",
    }));
    expect(finishAccountTotals(accumulator)).toEqual({
      inputTokens: "9007199254741000",
      outputTokens: "23",
      cacheTokens: "32",
      reasoningTokens: "5",
      totalTokens: "9007199254741023",
      deductedQuota: "55",
      apiCost: "2.00000000",
      knownApiCost: "2.00000000",
      packageAllocatedCost: "3.00000000",
      totalAllocatedCost: "5.00000000",
      activeDays: 2,
      requestCount: 1,
      lastUsedAt: "2026-08-01T16:00:01.000Z",
      usageQuality: "EXACT",
    });
  });

  it("UNKNOWN 不伪装 Token，费用事实各自传播未知", () => {
    const accumulator = newAccountAccumulator();
    addAccountFact(accumulator, fact({
      qualities: ["UNKNOWN"], inputTokens: "0", outputTokens: "0", cacheTokens: "0",
      reasoningTokens: "0", deductedQuota: null, apiCost: null, packageAllocatedCost: null,
    }));
    expect(finishAccountTotals(accumulator)).toMatchObject({
      inputTokens: null, outputTokens: null, cacheTokens: null, reasoningTokens: null,
      totalTokens: null, deductedQuota: null, apiCost: null,
      packageAllocatedCost: null, totalAllocatedCost: null, usageQuality: "UNKNOWN",
    });
  });

  it("不同计量口径合并为 MIXED，数值保留但必须由 UI 标注", () => {
    const accumulator = newAccountAccumulator();
    addAccountFact(accumulator, fact({ qualities: ["PROVIDER_REPORTED"] }));
    addAccountFact(accumulator, fact({ requestId: "request-2", qualities: ["ESTIMATED"] }));
    expect(finishAccountTotals(accumulator)).toMatchObject({
      inputTokens: "200", totalTokens: "240", requestCount: 2, usageQuality: "MIXED",
    });
  });

  it("API 成本或套餐分摊任一未知时，归集成本不得用已知一侧冒充", () => {
    for (const costs of [
      { apiCost: null, packageAllocatedCost: "2.75" },
      { apiCost: "1.25", packageAllocatedCost: null },
    ]) {
      const accumulator = newAccountAccumulator();
      addAccountFact(accumulator, fact(costs));
      expect(finishAccountTotals(accumulator).totalAllocatedCost).toBeNull();
      expect(finishAccountSummary({
        inputTokens: "1", outputTokens: "1", cacheTokens: "0", reasoningTokens: "0",
        deductedQuota: "0", qualities: ["PROVIDER_REPORTED"], activeDays: 1,
        requestCount: 1, lastUsedAt: null, ...costs,
      }).totalAllocatedCost).toBeNull();
    }
  });

  it("晚到的旧事实不覆盖最近时间，并以 48 位精度汇总超大 Token", () => {
    const accumulator = newAccountAccumulator();
    addAccountFact(accumulator, fact({
      inputTokens: "9999999999999999999999999999999999999999",
      outputTokens: "9", usedAt: new Date("2026-08-03T00:00:00Z"),
    }));
    addAccountFact(accumulator, fact({
      requestId: "request-2", inputTokens: "1", outputTokens: "0",
      usedAt: new Date("2026-08-01T00:00:00Z"),
    }));
    expect(finishAccountTotals(accumulator)).toMatchObject({
      inputTokens: "10000000000000000000000000000000000000000",
      totalTokens: "10000000000000000000000000000000000000009",
      lastUsedAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it.each([
    [["PROVIDER_REPORTED"], "EXACT"],
    [["UPSTREAM_REPORTED"], "EXACT"],
    [["ESTIMATED"], "ESTIMATED"],
    [["ACCOUNT_AGGREGATED"], "ACCOUNT_AGGREGATED"],
    [["UNKNOWN"], "UNKNOWN"],
    [[], "UNKNOWN"],
    [["MIXED:PROVIDER_REPORTED+ESTIMATED"], "MIXED"],
    [["provider_reported", "estimated"], "MIXED"],
    [["UNKNOWN", "ESTIMATED"], "MIXED"],
    [["UPSTREAM_REPORTED", "UNKNOWN"], "MIXED"],
    [["ACCOUNT_AGGREGATED", "PROVIDER_REPORTED"], "MIXED"],
  ])("质量集合 %j 归一为 %s", (qualities, expected) => {
    expect(summarizeUsageQuality(qualities)).toBe(expected);
  });

  it("使用占比只在两端 Token 可知且分母大于零时计算", () => {
    const base = {
      inputTokens: "0", outputTokens: "0", cacheTokens: "0", reasoningTokens: "0",
      totalTokens: "25", deductedQuota: "0", apiCost: "0", packageAllocatedCost: "0",
      totalAllocatedCost: "0", activeDays: 1, requestCount: 1, lastUsedAt: null,
      usageQuality: "EXACT" as const,
    };
    expect(usageShare(base, { ...base, totalTokens: "200" })).toBe("12.50");
    expect(usageShare({ ...base, totalTokens: null }, base)).toBeNull();
    expect(usageShare(base, { ...base, totalTokens: null })).toBeNull();
    expect(usageShare(base, { ...base, totalTokens: "0" })).toBeNull();
    expect(usageShare(base, { ...base, totalTokens: "-1" })).toBeNull();
  });

  it("账期固定为北京时间自然月并拒绝越界或非规范输入", () => {
    expect(operatingBillMonthRange("2026-08")).toEqual({
      start: new Date("2026-08-01T00:00:00+08:00"),
      end: new Date("2026-09-01T00:00:00+08:00"),
      monthDate: "2026-08-01",
    });
    expect(operatingBillMonthRange("2026-12").end)
      .toEqual(new Date("2027-01-01T00:00:00+08:00"));
    expect(operatingBillMonthRange("2000-01").monthDate).toBe("2000-01-01");
    expect(operatingBillMonthRange("2200-12").monthDate).toBe("2200-12-01");
    for (const invalid of [
      "2026-8", "2026-00", "1999-12", "2201-01", "bad", "x2026-08", "2026-08x",
    ]) {
      expect(() => operatingBillMonthRange(invalid)).toThrow(InvalidOperatingBillMonthError);
    }
  });
});
