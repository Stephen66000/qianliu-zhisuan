import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { sumDecimalTexts } from "./dashboard-helpers.js";
import type { CurrentProviderOperatingSnapshot } from "./provider-operating.js";
import type { ResourceMode } from "./dashboard-types.js";

/**
 * buildResourceBreakdown 的经营快照聚合段（按 provider+mode 汇总当前经营快照）。
 * 原样搬运自 dashboard-breakdown.ts：金额口径（同币种/同配额单位才可加）逐字不变，
 * 语义零变化。
 */

function hasCompleteSnapshots(resourceCount: number, snapshotCount: number): boolean {
  return resourceCount > 0 && snapshotCount === resourceCount;
}

export async function sumProviderOperatingSnapshot(
  db: Kysely<Database>,
  enterpriseId: string,
  providerCode: string,
  mode: ResourceMode,
  currentOperatingSnapshots: CurrentProviderOperatingSnapshot[],
): Promise<{
  total: string | null;
  used: string | null;
  remaining: string | null;
  quotaUnit: string | null;
  currency: string | null;
  recharge: string | null;
  balance: string | null;
  periodCost: string | null;
  snapshotAt: string | null;
}> {
  const resources = await db
    .selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select("provider_resource.id")
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .where("provider.code", "=", providerCode)
    .where("provider_resource.mode", "=", mode)
    .where("provider_resource.status", "<>", "DELETED")
    .execute();
  const resourceIds = new Set(resources.map((resource) => resource.id));
  const snapshots = currentOperatingSnapshots
    .filter((snapshot) => resourceIds.has(snapshot.provider_resource_id));
  const complete = hasCompleteSnapshots(resourceIds.size, snapshots.length);
  const values = (key: "total_quota" | "used_quota" | "remaining_quota" |
    "recharge_amount" | "current_balance" | "current_period_cost") =>
    snapshots.map((snapshot) => snapshot[key]).filter((value): value is string => value !== null);
  const quotaUnits = new Set(snapshots.map((snapshot) => snapshot.quota_unit).filter(Boolean));
  const currencies = new Set(snapshots.map((snapshot) => snapshot.currency).filter(Boolean));
  const allHave = (key: Parameters<typeof values>[0]) =>
    complete && values(key).length === resourceIds.size;
  const sameQuotaUnit = complete && quotaUnits.size === 1;
  const sameCurrency = complete && currencies.size === 1 &&
    snapshots.every((snapshot) => snapshot.currency !== null);
  const quotaMode = mode === "CODING_PLAN";
  const amountMode = mode === "API";
  const latestCalculatedAt = snapshots.reduce<Date | null>(
    (latest, snapshot) => !latest || snapshot.calculated_at > latest
      ? snapshot.calculated_at
      : latest,
    null,
  );
  return {
    total: quotaMode && sameQuotaUnit && allHave("total_quota")
      ? sumDecimalTexts(values("total_quota")) : null,
    used: quotaMode && sameQuotaUnit && allHave("used_quota")
      ? sumDecimalTexts(values("used_quota")) : null,
    remaining: quotaMode && sameQuotaUnit && allHave("remaining_quota")
      ? sumDecimalTexts(values("remaining_quota")) : null,
    quotaUnit: quotaMode && sameQuotaUnit ? [...quotaUnits][0] ?? null : null,
    currency: amountMode && sameCurrency ? [...currencies][0] ?? null : null,
    recharge: amountMode && sameCurrency && allHave("recharge_amount")
      ? sumDecimalTexts(values("recharge_amount")) : null,
    balance: amountMode && sameCurrency && allHave("current_balance")
      ? sumDecimalTexts(values("current_balance")) : null,
    periodCost: amountMode && sameCurrency && allHave("current_period_cost")
      ? sumDecimalTexts(values("current_period_cost")) : null,
    snapshotAt: latestCalculatedAt?.toISOString() ?? null,
  };
}
