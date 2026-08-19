import { describe, expect, it } from "vitest";

import { summarizeUsageQuality } from "./usage-quality.js";

const counts = (overrides: Partial<Parameters<typeof summarizeUsageQuality>[1]> = {}) => ({
  providerReportedCount: 0,
  estimatedCount: 0,
  accountAggregatedCount: 0,
  mixedCount: 0,
  unknownCount: 0,
  ...overrides,
});

describe("POOL20-045 usage quality", () => {
  it("空集不冒充全部厂商上报", () => {
    expect(summarizeUsageQuality(0, counts())).toBe("NO_DATA");
  });

  it("区分账户聚合、维度混合、跨来源混合和未知", () => {
    expect(summarizeUsageQuality(2, counts({ accountAggregatedCount: 2 })))
      .toBe("ACCOUNT_AGGREGATED");
    expect(summarizeUsageQuality(1, counts({ mixedCount: 1 }))).toBe("MIXED");
    expect(summarizeUsageQuality(2, counts({ providerReportedCount: 1, estimatedCount: 1 })))
      .toBe("MIXED");
    expect(summarizeUsageQuality(1, counts({ unknownCount: 1 }))).toBe("UNKNOWN");
    expect(summarizeUsageQuality(2, counts({ unknownCount: 1, accountAggregatedCount: 1 })))
      .toBe("UNKNOWN");
    expect(summarizeUsageQuality(2, counts({ estimatedCount: 2 }))).toBe("ESTIMATED");
    expect(summarizeUsageQuality(2, counts({ providerReportedCount: 2 })))
      .toBe("PROVIDER_REPORTED");
    expect(summarizeUsageQuality(2, counts({ providerReportedCount: 1 }))).toBe("UNKNOWN");
  });
});
