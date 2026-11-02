import type { Kysely } from "kysely";
import { employeeQuotaMonth, employeeQuotaBalance } from "@qianliu/domain";
import type { Database } from "../kysely.js";
import type { EmployeeQuotaPeriod } from "../employee-quota-types.js";
export type QuotaDb = Kysely<Database>;
export interface EmployeeQuotaScope {
  enterpriseId: string;
  principalId: string;
  provider: string;
  now?: Date;
}
export async function currentScope(db: QuotaDb, input: EmployeeQuotaScope) {
  const now = input.now ?? new Date();
  const enterprise = await db
    .selectFrom("enterprise")
    .select(["timezone", "employee_quota_monthly_from"])
    .where("id", "=", input.enterpriseId)
    .executeTakeFirstOrThrow();
  const principal = await db
    .selectFrom("principal")
    .select(["type", "status", "archived_at"])
    .where("enterprise_id", "=", input.enterpriseId)
    .where("id", "=", input.principalId)
    .executeTakeFirst();
  if (
    !principal ||
    principal.type !== "EMPLOYEE" ||
    !enterprise.employee_quota_monthly_from ||
    enterprise.employee_quota_monthly_from > now
  )
    return null;
  const established = await db
    .selectFrom("principal_quota_period")
    .select(["timezone", "period_start", "period_end"])
    .where("enterprise_id", "=", input.enterpriseId)
    .orderBy("period_start", "desc")
    .limit(1)
    .executeTakeFirst();
  const timezone =
    established &&
    now >= established.period_start &&
    now < established.period_end
      ? established.timezone
      : enterprise.timezone;
  const month = employeeQuotaMonth(now, timezone);
  // Validate the first activation once. Existing periods retain the original timezone proof.
  if (!established) {
    const activation = employeeQuotaMonth(
      enterprise.employee_quota_monthly_from,
      timezone,
    );
    if (+activation.periodStart !== +enterprise.employee_quota_monthly_from)
      throw new Error("quota_activation_not_month_start");
  }
  return { now, month, principal };
}
export async function activePool(
  db: QuotaDb,
  input: EmployeeQuotaScope,
  now: Date,
) {
  const grants = await db
    .selectFrom("principal_grant")
    .selectAll()
    .where("enterprise_id", "=", input.enterpriseId)
    .where("principal_id", "=", input.principalId)
    .where("provider", "=", input.provider)
    .where("pool_model_alias", "=", "*")
    .where("status", "=", "ACTIVE")
    .where("valid_from", "<=", now)
    .where((eb) =>
      eb.or([eb("valid_until", "is", null), eb("valid_until", ">", now)]),
    )
    .orderBy("id", "asc")
    .forUpdate()
    .execute();
  if (grants.length > 1) throw new Error("quota_ambiguous_active_pool");
  return grants[0];
}

/** Current month only. Historical reads never initialize from today's authorization. */
export async function ensureCurrentQuotaPeriod(
  db: QuotaDb,
  input: EmployeeQuotaScope,
): Promise<EmployeeQuotaPeriod | null> {
  const scope = await currentScope(db, input);
  if (
    !scope ||
    scope.principal.status !== "ACTIVE" ||
    scope.principal.archived_at
  )
    return null;
  const grant = await activePool(db, input, scope.now);
  if (!grant) return null;
  if (!grant.quota_basis) throw new Error("quota_basis_not_configured");
  const frozen = await db
    .selectFrom("principal_quota_period")
    .selectAll()
    .where("enterprise_id", "=", input.enterpriseId)
    .where("principal_id", "=", input.principalId)
    .where("provider", "=", input.provider)
    .where("period_start", "<=", scope.now)
    .where("period_end", ">", scope.now)
    .forUpdate()
    .executeTakeFirst();
  if (frozen) {
    if (frozen.quota_basis !== grant.quota_basis)
      throw new Error("quota_basis_frozen_for_month");
    return frozen;
  }
  await db
    .insertInto("principal_quota_period")
    .values({
      enterprise_id: input.enterpriseId,
      principal_id: input.principalId,
      provider: input.provider,
      period_key: scope.month.periodKey,
      period_start: scope.month.periodStart,
      period_end: scope.month.periodEnd,
      timezone: scope.month.timezone,
      quota_basis: grant.quota_basis,
      limit_value: BigInt(grant.quota_value),
      allow_overage: grant.allow_overage,
      open_grant_version: grant.version,
      limit_updated_at: scope.now,
      created_at: scope.now,
      updated_at: scope.now,
    })
    .onConflict((oc) =>
      oc
        .columns(["enterprise_id", "principal_id", "provider", "period_key"])
        .doNothing(),
    )
    .execute();
  const period = await db
    .selectFrom("principal_quota_period")
    .selectAll()
    .where("enterprise_id", "=", input.enterpriseId)
    .where("principal_id", "=", input.principalId)
    .where("provider", "=", input.provider)
    .where("period_key", "=", scope.month.periodKey)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (period.quota_basis !== grant.quota_basis)
    throw new Error("quota_basis_frozen_for_month");
  // Existing period boundaries/timezone are frozen and cannot be silently reinterpreted.
  if (scope.now < period.period_start || scope.now >= period.period_end)
    throw new Error("quota_period_timezone_conflict");
  return period;
}

export function employeeQuotaPeriodSnapshot(period: EmployeeQuotaPeriod) {
  const balance = employeeQuotaBalance(
    BigInt(period.limit_value),
    BigInt(period.used_value),
    BigInt(period.reserved_value),
  );
  return {
    periodId: period.id,
    periodKey: period.period_key,
    periodStart: period.period_start.toISOString(),
    periodEnd: period.period_end.toISOString(),
    timezone: period.timezone,
    quotaBasis: period.quota_basis,
    limit: String(period.limit_value),
    allowOverage: period.allow_overage,
    used: String(period.used_value),
    reserved: String(period.reserved_value),
    available: String(balance.available),
    overage: String(balance.overage),
    quality: period.quality,
  };
}

/** Caller updates grant template first, and records returned before/after in the same operation_log transaction. */
export async function adjustEmployeeQuotaPeriod(
  db: QuotaDb,
  input: EmployeeQuotaScope,
) {
  const scope = await currentScope(db, input);
  if (!scope) return null;
  // Match reserve's grant-before-period order; caller also holds grant writes in this transaction.
  await activePool(db, input, scope.now);
  const existing = await db
    .selectFrom("principal_quota_period")
    .selectAll()
    .where("enterprise_id", "=", input.enterpriseId)
    .where("principal_id", "=", input.principalId)
    .where("provider", "=", input.provider)
    .where("period_start", "<=", scope.now)
    .where("period_end", ">", scope.now)
    .forUpdate()
    .executeTakeFirst();
  const before = existing ? employeeQuotaPeriodSnapshot(existing) : null;
  const period = await ensureCurrentQuotaPeriod(db, input);
  // Disabled/revoked pools retain the previous month's facts and do not create new allocations.
  if (!period) return existing ? { before, after: before } : null;
  const grant = await activePool(db, input, scope.now);
  if (!grant) throw new Error("quota_grant_disappeared");
  const updated = await db
    .updateTable("principal_quota_period")
    .set({
      limit_value: BigInt(grant.quota_value),
      allow_overage: grant.allow_overage,
      limit_updated_at:
        BigInt(period.limit_value) === BigInt(grant.quota_value) &&
        period.allow_overage === grant.allow_overage
          ? period.limit_updated_at
          : scope.now,
      updated_at: scope.now,
    })
    .where("id", "=", period.id)
    .where("enterprise_id", "=", input.enterpriseId)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { before, after: employeeQuotaPeriodSnapshot(updated) };
}
