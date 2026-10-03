/**
 * CPQW：明确耗尽故障的窗口归属（计划§2 时间优先级）——纯读取。
 *
 * 归属规则：
 *   - WINDOW_EXHAUSTED（响应明示 5 小时）→ FIVE_HOUR；时间优先级为
 *     同窗口上游未来 reset_at → 明确窗口耗尽响应的 Retry-After →
 *     同资源同窗口 SUCCESS、remaining<=0、最后成功不超过 10 分钟的快照。
 *   - QUOTA_EXHAUSTED（套餐耗尽但响应不指明窗口）→ 以新鲜快照中
 *     remaining<=0 的窗口归属；没有任何可归属窗口时保持未知（不猜周额度）。
 * 非法日期、负间隔、跨资源、失败快照与过去时间一律不作为预计时间。
 */
import type { Kysely } from "kysely";
import type { Outcome } from "@qianliu/contracts";
import type { Database } from "@qianliu/database";
import type { QuotaExhaustionObservation } from "@qianliu/domain";

/** 首次快照兜底的新鲜度窗口（计划 P2-1：只限制首次快照兜底）。 */
export const QUOTA_SNAPSHOT_FRESHNESS_MS = 10 * 60_000;

interface FreshWindowFact {
  window_type: "FIVE_HOUR" | "WEEKLY";
  remaining_value: string | null;
  reset_at: Date | null;
  collected_at: Date;
}

async function freshZeroWindows(
  db: Kysely<Database>,
  enterpriseId: string,
  resourceId: string,
  now: Date,
): Promise<FreshWindowFact[]> {
  const rows = await db.selectFrom("provider_quota_window")
    .select(["window_type", "remaining_value", "reset_at", "collected_at"])
    .where("enterprise_id", "=", enterpriseId)
    .where("provider_resource_id", "=", resourceId)
    .where("is_current", "=", true)
    .where("sync_status", "=", "SUCCESS")
    .where("collected_at", ">=", new Date(now.getTime() - QUOTA_SNAPSHOT_FRESHNESS_MS))
    .execute() as FreshWindowFact[];
  return rows.filter((row) => row.remaining_value !== null && Number(row.remaining_value) <= 0);
}

function futureReset(resetAt: Date | string | null | undefined, now: Date): string | null {
  if (!resetAt) return null;
  const time = typeof resetAt === "string" ? Date.parse(resetAt) : resetAt.getTime();
  return Number.isFinite(time) && time > now.getTime()
    ? (typeof resetAt === "string" ? resetAt : new Date(time).toISOString())
    : null;
}

function responseReset(outcome: Outcome, now: Date): { resetAt: string; source: "UPSTREAM_RESET_AT" | "UPSTREAM_RETRY_AFTER" } | null {
  const resetAt = futureReset(outcome.recoverAt, now);
  if (!resetAt) return null;
  return { resetAt, source: outcome.upstreamRecoverAtSource === "RETRY_AFTER" ? "UPSTREAM_RETRY_AFTER" : "UPSTREAM_RESET_AT" };
}

export async function attributeQuotaExhaustion(input: {
  db: Kysely<Database>;
  enterpriseId: string;
  resourceId: string;
  outcome: Outcome;
  now: Date;
}): Promise<QuotaExhaustionObservation[]> {
  const kind = input.outcome.upstreamErrorKind;
  if (kind !== "WINDOW_EXHAUSTED" && kind !== "QUOTA_EXHAUSTED") return [];
  const freshZeros = await freshZeroWindows(input.db, input.enterpriseId, input.resourceId, input.now);
  const snapshotObservation = (windowType: "FIVE_HOUR" | "WEEKLY"): QuotaExhaustionObservation | null => {
    const fact = freshZeros.find((row) => row.window_type === windowType);
    if (!fact) return null;
    const resetAt = futureReset(fact.reset_at, input.now);
    return { windowType, resetAt, resetSource: resetAt ? "PROVIDER_SNAPSHOT" : null };
  };

  if (kind === "WINDOW_EXHAUSTED") {
    const observations: QuotaExhaustionObservation[] = [];
    const fromResponse = responseReset(input.outcome, input.now);
    const snapshot = snapshotObservation("FIVE_HOUR");
    observations.push({
      windowType: "FIVE_HOUR",
      resetAt: fromResponse?.resetAt ?? snapshot?.resetAt ?? null,
      resetSource: fromResponse?.source ?? snapshot?.resetSource ?? null,
    });
    // 同刻周窗口也确为零（新鲜快照）→ 写明两项。
    const weekly = snapshotObservation("WEEKLY");
    if (weekly) observations.push(weekly);
    return observations;
  }

  // QUOTA_EXHAUSTED：只能以新鲜零值快照归属窗口；无法归属时保持未知套餐阻断。
  if (freshZeros.length === 0) {
    const fromResponse = responseReset(input.outcome, input.now);
    return [{ resetAt: fromResponse?.resetAt ?? null, resetSource: fromResponse?.source ?? null }];
  }
  return (["FIVE_HOUR", "WEEKLY"] as const)
    .map((windowType) => snapshotObservation(windowType))
    .filter((observation): observation is QuotaExhaustionObservation => observation !== null);
}
