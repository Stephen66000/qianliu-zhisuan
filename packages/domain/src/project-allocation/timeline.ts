/** 半开区间 [from, until) 工具：参与、权重、核算窗口共用同一时间语义（合同 §2）。 */
export interface TemporalInterval {
  from: Date;
  until: Date | null;
}

export function intervalCovers(interval: TemporalInterval, at: Date): boolean {
  const time = at.getTime();
  return interval.from.getTime() <= time
    && (interval.until === null || time < interval.until.getTime());
}

export function intervalsOverlap(left: TemporalInterval, right: TemporalInterval): boolean {
  const start = Math.max(left.from.getTime(), right.from.getTime());
  const leftEnd = left.until?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.until?.getTime() ?? Number.POSITIVE_INFINITY;
  return start < Math.min(leftEnd, rightEnd);
}

export function intervalContains(outer: TemporalInterval, inner: TemporalInterval): boolean {
  const outerEnd = outer.until?.getTime() ?? Number.POSITIVE_INFINITY;
  const innerEnd = inner.until?.getTime() ?? Number.POSITIVE_INFINITY;
  return outer.from.getTime() <= inner.from.getTime() && innerEnd <= outerEnd;
}

/** 有序边界并集（毫秒去重），用于逐段扫描权重和与展示分段。 */
export function collectBoundaries(intervals: TemporalInterval[]): number[] {
  const points = new Set<number>();
  for (const interval of intervals) {
    points.add(interval.from.getTime());
    if (interval.until !== null) points.add(interval.until.getTime());
  }
  return [...points].sort((left, right) => left - right);
}
