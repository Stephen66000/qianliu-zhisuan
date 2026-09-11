import { describe, expect, it } from "vitest";

import { countFinanceGaps } from "./provider-finance-gaps.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";

describe("countFinanceGaps（资金完整性缺口切账边界）", () => {
  it("查询区间完全在切账点之前（例如 2026 年 8 月）：直接返回 0 缺口，不将历史旧数据误判为缺口", async () => {
    // 构造一个不连数据库的 mock db；如果走到 SQL 查询则会抛异常
    const dummyDb = {
      // no-op
    } as never;

    const start = new Date("2026-07-31T16:00:00.000Z"); // 2026-08-01 00:00:00+08:00
    const end = new Date("2026-08-11T11:23:00.000Z");   // 2026-08-11 19:23:00+08:00

    expect(end.getTime()).toBeLessThan(PROVIDER_FINANCE_CUTOVER.getTime());

    const result = await countFinanceGaps(dummyDb, "mock-enterprise-id", start, end);

    expect(result).toEqual([
      { code: "API_USAGE_COST_UNKNOWN", count: "0" },
      { code: "API_COST_CURRENCY_MISSING", count: "0" },
      { code: "API_COST_CURRENCY_CONFLICT", count: "0" },
      { code: "OPENING_BALANCE_MISSING", count: "0" },
      { code: "SUBSCRIPTION_PERIOD_MISSING", count: "0" },
      { code: "CASH_PAID_CNY_MISSING", count: "0" },
    ]);

    // 过滤出 >0 的缺口数应为空
    const activeGaps = result.filter((row) => Number(row.count) > 0);
    expect(activeGaps).toHaveLength(0);
  });
});
