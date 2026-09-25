import { describe, expect, it, vi } from "vitest";

import { invalidateProviderFinanceCaches } from "./provider-finance";

/**
 * 回归（I1 复审 P2-6）：激活成功后的统一缓存刷新曾漏掉
 * `resource-utilization` / `resource-purchases` / `procurement-review`
 * 三个命名空间——激活改变资源级资金事实后，这三个视图会继续展示陈旧数据。
 */
describe("invalidateProviderFinanceCaches", () => {
  it("失效全部受资金事实影响的命名空间，含资源利用/采购/采购复核", () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    invalidateProviderFinanceCaches({ invalidateQueries });

    const invalidatedKeys = invalidateQueries.mock.calls
      .map((call) => call[0]?.queryKey)
      .filter(Boolean);
    expect(invalidatedKeys).toContainEqual(["provider-finance"]);
    expect(invalidatedKeys).toContainEqual(["provider-resources"]);
    expect(invalidatedKeys).toContainEqual(["operating-bill"]);
    expect(invalidatedKeys).toContainEqual(["operating-analysis"]);
    expect(invalidatedKeys).toContainEqual(["dashboard"]);
    // P2-6 回归：以下三个键在修复前缺失。
    expect(invalidatedKeys).toContainEqual(["resource-utilization"]);
    expect(invalidatedKeys).toContainEqual(["resource-purchases"]);
    expect(invalidatedKeys).toContainEqual(["procurement-review"]);

    // 各月分页前缀（operating-bill-*）通过 predicate 失效，覆盖任意月份。
    const predicateCall = invalidateQueries.mock.calls.find((call) => call[0]?.predicate);
    expect(predicateCall).toBeDefined();
    const predicate = predicateCall![0].predicate as (query: { queryKey: readonly unknown[] }) => boolean;
    expect(predicate({ queryKey: ["operating-bill-projects", "2026-09"] })).toBe(true);
    expect(predicate({ queryKey: ["provider-finance", "summary"] })).toBe(false);
  });
});
