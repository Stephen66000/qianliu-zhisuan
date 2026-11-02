import { describe, expect, it } from "vitest";
import { usageQualityLabel, usageQualityText, type UsageQualityFacts } from "./usage-quality";

const counts = { providerReportedCount: 3, estimatedCount: 2, accountAggregatedCount: 4, mixedCount: 1, unknownCount: 5 };

describe("计量质量不能被呈现为同一种精确用量", () => {
  it.each<[UsageQualityFacts["usageQuality"], string]>([
    ["NO_DATA", "本周期暂无已结算计量"],
    ["PROVIDER_REPORTED", "全部为厂商上报计量"],
    ["ESTIMATED", "含 2 笔估算计量"],
    ["ACCOUNT_AGGREGATED", "含 4 笔账户聚合计量，非逐请求精确值"],
    ["MIXED", "混合计量：厂商 3、估算 2、账户聚合 4、维度不完整 1"],
    ["UNKNOWN", "含 5 笔计量未知，数值只代表已记录 Token"],
  ])("%s 保留其质量和数量说明", (usageQuality, text) => {
    expect(usageQualityText({ ...counts, usageQuality })).toBe(text);
  });

  it("中文标签覆盖现有质量且不把未登记枚举伪装成已知质量", () => {
    expect(["NO_DATA", "PROVIDER_REPORTED", "ESTIMATED", "ACCOUNT_AGGREGATED", "MIXED", "UNKNOWN"]
      .map(usageQualityLabel)).toEqual(["暂无计量", "厂商上报", "估算", "账户聚合", "混合计量", "未知"]);
    expect(usageQualityLabel("NEW_SOURCE_QUALITY")).toBe("NEW_SOURCE_QUALITY");
  });
});
