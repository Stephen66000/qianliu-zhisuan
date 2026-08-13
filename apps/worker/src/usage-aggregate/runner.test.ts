import { describe, expect, it, vi } from "vitest";

import type {
  UsageAggregateGranularity,
  UsageAggregateRebuildResult,
  UsageAggregateRepository,
} from "@qianliu/database";
import { runUsageAggregateTick } from "./runner.js";

function result(granularity: UsageAggregateGranularity, written: number): UsageAggregateRebuildResult {
  return {
    enterpriseId: "00000000-0000-0000-0000-000000000001",
    bucketGranularity: granularity,
    bucketStart: new Date("2026-08-12T00:00:00.000Z"),
    timezone: "Asia/Shanghai",
    rowsWritten: written,
    rowsRemoved: 1,
    generatedAt: new Date("2026-08-12T00:01:00.000Z"),
  };
}

describe("runUsageAggregateTick", () => {
  it("普通 5 分钟 tick 只消费 dirty 小时桶", async () => {
    const rebuildDirtyBuckets = vi.fn(async () => [result("HOUR", 2)]);
    const rebuildRecentSevenDays = vi.fn(async () => [result("DAY", 3)]);
    const markCurrentHoursDirty = vi.fn(async () => 1);
    const repository = {
      rebuildDirtyBuckets, rebuildRecentSevenDays, markCurrentHoursDirty,
    } as unknown as UsageAggregateRepository;

    const output = await runUsageAggregateTick({ repository, includeDaily: false });

    expect(rebuildDirtyBuckets).toHaveBeenCalledOnce();
    expect(rebuildDirtyBuckets).toHaveBeenCalledWith("HOUR", 200);
    expect(markCurrentHoursDirty).toHaveBeenCalledOnce();
    expect(rebuildRecentSevenDays).not.toHaveBeenCalled();
    expect(output).toEqual({
      dirtyHourBuckets: 1,
      dirtyDayBuckets: 0,
      recentBuckets: 0,
      rowsWritten: 2,
      rowsRemoved: 1,
    });
  });

  it("每日 tick 消费 dirty 日桶并补最近 7 个本地自然日", async () => {
    const rebuildDirtyBuckets = vi.fn(async (granularity: UsageAggregateGranularity) => [
      result(granularity, granularity === "HOUR" ? 2 : 3),
    ]);
    const rebuildRecentSevenDays = vi.fn(async () => [result("DAY", 4), result("DAY", 5)]);
    const markCurrentHoursDirty = vi.fn(async () => 1);
    const repository = {
      rebuildDirtyBuckets, rebuildRecentSevenDays, markCurrentHoursDirty,
    } as unknown as UsageAggregateRepository;
    const now = new Date("2026-08-12T00:00:00.000Z");

    const output = await runUsageAggregateTick({ repository, includeDaily: true, now });

    expect(rebuildDirtyBuckets.mock.calls).toEqual([["HOUR", 200], ["DAY", 200]]);
    expect(markCurrentHoursDirty).toHaveBeenCalledWith(now);
    expect(rebuildRecentSevenDays).toHaveBeenCalledWith(now, 7);
    expect(output).toEqual({
      dirtyHourBuckets: 1,
      dirtyDayBuckets: 1,
      recentBuckets: 2,
      rowsWritten: 14,
      rowsRemoved: 4,
    });
  });
});
