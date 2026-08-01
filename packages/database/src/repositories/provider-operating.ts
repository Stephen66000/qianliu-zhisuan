import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { Database } from "../kysely.js";
import type { ProviderResourceOperatingSnapshot } from "./provider-repository.js";

export const DEFAULT_RESET_TIMEZONE = "Asia/Shanghai";

export type ResetCycle = "NONE" | "DAILY" | "WEEKLY" | "MONTHLY";

export interface QuotaPeriod {
  start: Date;
  end: Date | null;
}

export interface CurrentProviderOperatingSnapshot extends ProviderResourceOperatingSnapshot {
  quota_period_start: Date | null;
  quota_period_end: Date | null;
  calculated_at: Date;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function normalizedCycle(value: string | null): ResetCycle {
  const upper = value?.toUpperCase();
  return upper === "DAILY" || upper === "WEEKLY" || upper === "MONTHLY"
    ? upper
    : "NONE";
}

function fixedPeriod(anchor: Date, now: Date, durationMs: number): QuotaPeriod {
  const elapsed = now.getTime() - anchor.getTime();
  const index = Math.floor(elapsed / durationMs);
  const start = new Date(anchor.getTime() + index * durationMs);
  return { start, end: new Date(start.getTime() + durationMs) };
}

function daysInLocalMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function shanghaiParts(value: Date) {
  const local = new Date(value.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth(),
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    millisecond: local.getUTCMilliseconds(),
  };
}

function monthlyCandidate(anchor: Date, monthIndex: number): Date {
  const parts = shanghaiParts(anchor);
  const absoluteMonth = parts.year * 12 + parts.month + monthIndex;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  const day = Math.min(parts.day, daysInLocalMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ) - SHANGHAI_OFFSET_MS,
  );
}

function monthlyPeriod(anchor: Date, now: Date): QuotaPeriod {
  const anchorParts = shanghaiParts(anchor);
  const nowParts = shanghaiParts(now);
  let index =
    nowParts.year * 12 + nowParts.month - (anchorParts.year * 12 + anchorParts.month);
  let start = monthlyCandidate(anchor, index);
  if (start.getTime() > now.getTime()) {
    index -= 1;
    start = monthlyCandidate(anchor, index);
  }
  return { start, end: monthlyCandidate(anchor, index + 1) };
}

export function calculateQuotaPeriod(input: {
  resetCycle: string | null;
  resetAnchorAt: Date | null;
  effectiveFrom: Date | null;
  collectedAt: Date;
  now: Date;
}): QuotaPeriod {
  const cycle = normalizedCycle(input.resetCycle);
  const anchor = input.resetAnchorAt ?? input.effectiveFrom ?? input.collectedAt;
  if (cycle === "DAILY") return fixedPeriod(anchor, input.now, 24 * 60 * 60 * 1000);
  if (cycle === "WEEKLY") return fixedPeriod(anchor, input.now, 7 * 24 * 60 * 60 * 1000);
  if (cycle === "MONTHLY") return monthlyPeriod(anchor, input.now);
  return { start: input.effectiveFrom ?? input.collectedAt, end: null };
}

export async function projectCurrentOperatingSnapshots(
  db: Kysely<Database>,
  enterpriseId: string,
  snapshots: ProviderResourceOperatingSnapshot[],
  resourceModes: Map<string, string>,
  now: Date = new Date(),
): Promise<CurrentProviderOperatingSnapshot[]> {
  return Promise.all(snapshots.map(async (snapshot) => {
    const systemCalculated =
      resourceModes.get(snapshot.provider_resource_id) === "CODING_PLAN" &&
      snapshot.usage_calculation === "SYSTEM_LEDGER";
    if (!systemCalculated) {
      return {
        ...snapshot,
        quota_period_start: null,
        quota_period_end: snapshot.next_reset_at,
        calculated_at: snapshot.collected_at,
      };
    }

    const period = calculateQuotaPeriod({
      resetCycle: snapshot.reset_cycle,
      resetAnchorAt: snapshot.reset_anchor_at,
      effectiveFrom: snapshot.effective_from,
      collectedAt: snapshot.collected_at,
      now,
    });
    const result = await sql<{
      used_quota: string;
      remaining_quota: string | null;
      latest_usage_at: Date | null;
    }>`
      SELECT COALESCE(SUM(deducted_quota::numeric), 0)::numeric(30, 8)::text AS used_quota,
             CASE WHEN ${snapshot.total_quota}::numeric IS NULL THEN NULL
                  ELSE GREATEST(
                    ${snapshot.total_quota}::numeric -
                    COALESCE(SUM(deducted_quota::numeric), 0),
                    0
                  )::numeric(30, 8)::text
             END AS remaining_quota,
             MAX(created_at) AS latest_usage_at
        FROM ledger_line
       WHERE enterprise_id = ${enterpriseId}
         AND provider_resource_id = ${snapshot.provider_resource_id}
         AND deducted_quota IS NOT NULL
         AND created_at >= ${period.start}
         ${period.end ? sql`AND created_at < ${period.end}` : sql``}
    `.execute(db);
    const row = result.rows[0]!;
    const calculatedAt = row.latest_usage_at && row.latest_usage_at > snapshot.collected_at
      ? row.latest_usage_at
      : snapshot.collected_at;
    return {
      ...snapshot,
      used_quota: row.used_quota,
      remaining_quota: row.remaining_quota,
      next_reset_at: period.end,
      quota_period_start: period.start,
      quota_period_end: period.end,
      calculated_at: calculatedAt,
    };
  }));
}
