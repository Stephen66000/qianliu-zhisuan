import type { UsageAggregateRepository } from "@qianliu/database";

export interface UsageAggregateTickResult {
  dirtyHourBuckets: number;
  dirtyDayBuckets: number;
  recentBuckets: number;
  rowsWritten: number;
  rowsRemoved: number;
}

/**
 * W20-04 Worker 单次任务：常规 tick 只重建 dirty 小时桶；每日任务额外消费
 * dirty 日桶并完整补算最近 7 个企业本地自然日。
 */
export async function runUsageAggregateTick(input: {
  repository: UsageAggregateRepository;
  now?: Date;
  includeDaily?: boolean;
  dirtyLimit?: number;
}): Promise<UsageAggregateTickResult> {
  await input.repository.markCurrentHoursDirty(input.now ?? new Date());
  const dirtyHours = await input.repository.rebuildDirtyBuckets(
    "HOUR", input.dirtyLimit ?? 200,
  );
  const dirtyDays = input.includeDaily
    ? await input.repository.rebuildDirtyBuckets("DAY", input.dirtyLimit ?? 200)
    : [];
  const recent = input.includeDaily
    ? await input.repository.rebuildRecentSevenDays(input.now ?? new Date(), 7)
    : [];
  const all = [...dirtyHours, ...dirtyDays, ...recent];
  return {
    dirtyHourBuckets: dirtyHours.length,
    dirtyDayBuckets: dirtyDays.length,
    recentBuckets: recent.length,
    rowsWritten: all.reduce((total, item) => total + item.rowsWritten, 0),
    rowsRemoved: all.reduce((total, item) => total + item.rowsRemoved, 0),
  };
}
