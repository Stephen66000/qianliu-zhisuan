import type { EmployeeQuotaSettlement } from "../employee-quota-types.js";
import type { QuotaDb } from "./employee-quota-period-repository.js";
/** Use only within the caller's terminal transaction. */
export async function settleEmployeeQuotaInTransaction(
  db: QuotaDb,
  input: {
    enterpriseId: string;
    principalId?: string;
    requestId?: string;
    usageId: string;
    periodId: string;
    actual: bigint | null;
    usageQuality?: string;
    release?: boolean;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  if (input.actual !== null && input.actual < 0n)
    throw new Error("negative_quota_actual");
  const usage = await db
    .selectFrom("principal_quota_usage")
    .selectAll()
    .where("id", "=", input.usageId)
    .where("enterprise_id", "=", input.enterpriseId)
    .where("period_id", "=", input.periodId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const period = await db
    .selectFrom("principal_quota_period")
    .selectAll()
    .where("id", "=", input.periodId)
    .where("enterprise_id", "=", input.enterpriseId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (
    (input.principalId && period.principal_id !== input.principalId) ||
    (input.requestId && usage.request_id !== input.requestId)
  )
    throw new Error("quota_settlement_scope_conflict");
  const target = input.release
    ? "RELEASED"
    : input.actual === null
      ? "UNKNOWN"
      : "SETTLED";
  if (usage.status === "SETTLED" || usage.status === "RELEASED") {
    if (usage.status !== target || BigInt(usage.actual!) !== input.actual)
      throw new Error("quota_settlement_replay_conflict");
    return;
  }
  if (target === "UNKNOWN") {
    await db
      .updateTable("principal_quota_usage")
      .set({
        status: "UNKNOWN",
        usage_quality: input.usageQuality ?? "UNKNOWN",
      })
      .where("id", "=", usage.id)
      .execute();
    await db
      .updateTable("principal_quota_period")
      .set({ quality: "UNKNOWN", updated_at: now })
      .where("id", "=", period.id)
      .execute();
    return;
  }
  const actual = input.actual!;
  if (input.release && actual !== 0n) throw new Error("quota_release_nonzero");
  const reserved = BigInt(period.reserved_value) - BigInt(usage.estimate);
  if (reserved < 0n) throw new Error("quota_reserved_invariant");
  await db
    .updateTable("principal_quota_usage")
    .set({
      status: target,
      actual,
      settled_at: now,
      usage_quality: input.usageQuality ?? "UNKNOWN",
    })
    .where("id", "=", usage.id)
    .execute();
  const unresolved = await db
    .selectFrom("principal_quota_usage")
    .select("id")
    .where("enterprise_id", "=", input.enterpriseId)
    .where("period_id", "=", period.id)
    .where("status", "in", ["RESERVED", "UNKNOWN"])
    .executeTakeFirst();
  await db
    .updateTable("principal_quota_period")
    .set({
      used_value: BigInt(period.used_value) + actual,
      reserved_value: reserved,
      quality: unresolved ? "UNKNOWN" : "COMPLETE",
      updated_at: now,
    })
    .where("id", "=", period.id)
    .execute();
}

export async function settleMonthlyQuotaItems(
  db: QuotaDb,
  input: { enterprise_id: string; principal_id: string; ai_request_id: string },
  items: EmployeeQuotaSettlement[],
  now: Date,
) {
  for (const item of [...items].sort(
    (a, b) =>
      (a.period_id ?? "").localeCompare(b.period_id ?? "") ||
      (a.usage_id ?? "").localeCompare(b.usage_id ?? ""),
  )) {
    if (!item.period_id || !item.usage_id)
      throw new Error("quota_monthly_reference_incomplete");
    const usage = await db
      .selectFrom("principal_quota_usage")
      .select(["grant_id", "estimate"])
      .where("enterprise_id", "=", input.enterprise_id)
      .where("id", "=", item.usage_id)
      .executeTakeFirstOrThrow();
    if (
      usage.grant_id !== item.grant_id ||
      BigInt(usage.estimate) !== item.reserved_estimate
    )
      throw new Error("quota_monthly_reservation_conflict");
    await settleEmployeeQuotaInTransaction(db, {
      enterpriseId: input.enterprise_id,
      principalId: input.principal_id,
      requestId: input.ai_request_id,
      usageId: item.usage_id,
      periodId: item.period_id,
      actual: item.usage_status === "UNKNOWN" ? null : item.actual_deducted,
      usageQuality: item.usage_quality,
      release: item.usage_status === "RELEASED",
      now,
    });
  }
}
