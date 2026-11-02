import type { EmployeeQuotaPeriod } from "../employee-quota-types.js";
import type { QuotaDb } from "./employee-quota-period-repository.js";
export interface ReadEmployeeQuotaPeriodsInput {
  enterpriseId: string;
  principalIds?: string[];
  periodKey: string;
  asOf?: Date;
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Recover only explicitly audited policy; current grants cannot prove an earlier balance. */
async function readPolicyAtCutoff(
  db: QuotaDb,
  row: EmployeeQuotaPeriod,
  cutoff: Date,
): Promise<Pick<EmployeeQuotaPeriod, "limit_value" | "allow_overage"> | null> {
  if (row.limit_updated_at < cutoff)
    return {
      limit_value: BigInt(row.limit_value),
      allow_overage: row.allow_overage,
    };
  const logs = await db
    .selectFrom("operation_log")
    .select(["id", "change_summary"])
    .where("enterprise_id", "=", row.enterprise_id)
    .where("action", "=", "principal_quota.change")
    .where("result", "=", "SUCCESS")
    .execute();
  const candidates = logs
    .map((log) => objectValue(log.change_summary))
    .filter((event): event is Record<string, unknown> => Boolean(event))
    .filter(
      (event) =>
        event.schemaVersion === 1 &&
        event.principalId === row.principal_id &&
        event.provider === row.provider &&
        typeof event.effectiveAt === "string" &&
        +new Date(event.effectiveAt) >= +cutoff,
    )
    .sort(
      (a, b) =>
        +new Date(String(a.effectiveAt)) - +new Date(String(b.effectiveAt)),
    );
  const first = candidates[0];
  const before = objectValue(first?.before);
  const period = objectValue(before?.period);
  if (
    !period ||
    period.periodId !== row.id ||
    typeof period.limit !== "string" ||
    !/^\d+$/.test(period.limit) ||
    typeof period.allowOverage !== "boolean"
  )
    return null;
  return {
    limit_value: BigInt(period.limit),
    allow_overage: period.allowOverage,
  };
}

export async function readQuotaPeriodsInTransaction(
  db: QuotaDb,
  input: ReadEmployeeQuotaPeriodsInput,
): Promise<EmployeeQuotaPeriod[]> {
  if (input.principalIds?.length === 0) return [];
  let query = db
    .selectFrom("principal_quota_period")
    .innerJoin(
      "principal",
      "principal.id",
      "principal_quota_period.principal_id",
    )
    .selectAll("principal_quota_period")
    .where("principal_quota_period.enterprise_id", "=", input.enterpriseId)
    .where("principal.enterprise_id", "=", input.enterpriseId)
    .where("principal.type", "=", "EMPLOYEE")
    .where("period_key", "=", input.periodKey);
  if (input.principalIds)
    query = query.where("principal_id", "in", input.principalIds);
  const rows = await query
    .orderBy("principal_id", "asc")
    .orderBy("provider", "asc")
    .execute();
  if (!input.asOf) return rows;
  const cutoff = input.asOf;
  // Current materialized limits can only be used if they existed at the business cutoff.
  // Otherwise require a typed audit snapshot; missing historical policy remains UNKNOWN.
  return Promise.all(
    rows
      .filter((row) => row.created_at < cutoff)
      .map(async (row) => {
        const usages = await db
          .selectFrom("principal_quota_usage")
          .selectAll()
          .where("enterprise_id", "=", input.enterpriseId)
          .where("period_id", "=", row.id)
          .where("created_at", "<", cutoff)
          .execute();
        let used = 0n,
          reserved = 0n;
        const historicalPolicy = await readPolicyAtCutoff(db, row, cutoff);
        let quality: "COMPLETE" | "UNKNOWN" = historicalPolicy
          ? "COMPLETE"
          : "UNKNOWN";
        for (const usage of usages) {
          // Attribution is by reservation time; late settlement is known at fact-read time.
          if (usage.actual !== null) used += BigInt(usage.actual);
          else {
            reserved += BigInt(usage.estimate);
            quality = "UNKNOWN";
          }
        }
        return {
          ...row,
          ...historicalPolicy,
          used_value: used,
          reserved_value: reserved,
          quality,
        };
      }),
  );
}
