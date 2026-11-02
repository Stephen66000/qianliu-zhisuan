import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { adjustEmployeeQuotaPeriod } from "./employee-quota-repository.js";
import type { EmployeeQuotaBasis } from "../employee-quota-types.js";

export interface QuotaGrantBefore {
  quota_value: bigint;
  allow_overage: boolean;
  status: string;
  version: number;
  quota_basis: EmployeeQuotaBasis | null;
}

export async function assertCurrentQuotaBasis(db: Kysely<Database>, input: {
  enterpriseId: string; principalId: string; provider: string; basis: EmployeeQuotaBasis | null;
  basisError: (message: string) => Error;
}) {
  const now = new Date();
  const period = await db.selectFrom("principal_quota_period").select("quota_basis")
    .where("enterprise_id", "=", input.enterpriseId).where("principal_id", "=", input.principalId)
    .where("provider", "=", input.provider).where("period_start", "<=", now).where("period_end", ">", now)
    .executeTakeFirst();
  if (period && period.quota_basis !== input.basis) {
    throw input.basisError(`厂商 ${input.provider} 的本月额度基础已冻结，重新开通不能改变计量方式`);
  }
}

/** Resolve one provider's unit before a bulk writer mutates its template. */
export async function employeeQuotaChangeContext(db: Kysely<Database>, input: {
  enterpriseId: string; principalId: string; provider: string; modes: string[]; grantId: string | null;
  basisError: (message: string) => Error;
}): Promise<{ basis: EmployeeQuotaBasis | null; before: QuotaGrantBefore | null }> {
  const policy = await db.selectFrom("enterprise").select("employee_quota_monthly_from")
    .where("id", "=", input.enterpriseId).executeTakeFirst();
  const modes = new Set(input.modes);
  const basis = modes.size === 1 ? (modes.has("API") ? "RAW_TOKEN" : "PLAN_QUOTA") : null;
  if (!policy?.employee_quota_monthly_from) return { basis, before: null };
  if (!basis) throw input.basisError(`厂商 ${input.provider} 同时包含 API 与套餐，须先明确月度额度基础`);
  await assertCurrentQuotaBasis(db, { ...input, basis });
  const before = input.grantId ? await db.selectFrom("principal_grant")
    .select(["quota_value", "allow_overage", "status", "version", "quota_basis"])
    .where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.grantId).executeTakeFirstOrThrow() : null;
  if (before?.quota_basis && basis !== before.quota_basis) {
    throw input.basisError(`厂商 ${input.provider} 的月度额度基础已确定，不能直接改为另一种计量方式`);
  }
  return { basis, before };
}

/** Called only after the existing writer holds its Key/provider locks and changes the template. */
export async function recordEmployeeQuotaChange(db: Kysely<Database>, input: {
  enterpriseId: string;
  principalId: string;
  provider: string;
  grantId: string;
  adminUserId: string;
  action: "SET" | "ADD" | "DISABLE" | undefined;
  before: QuotaGrantBefore | null;
  now?: Date;
}): Promise<void> {
  const enterprise = await db.selectFrom("enterprise").select("employee_quota_monthly_from")
    .where("id", "=", input.enterpriseId).executeTakeFirstOrThrow();
  if (!enterprise.employee_quota_monthly_from) return;
  const principal = await db.selectFrom("principal").select("type")
    .where("id", "=", input.principalId).where("enterprise_id", "=", input.enterpriseId).executeTakeFirstOrThrow();
  if (principal.type !== "EMPLOYEE") return;
  const now = input.now ?? new Date();
  const period = await adjustEmployeeQuotaPeriod(db, { ...input, now });
  const grant = await db.selectFrom("principal_grant").select([
    "quota_value", "allow_overage", "status", "version", "quota_basis",
  ]).where("enterprise_id", "=", input.enterpriseId).where("id", "=", input.grantId).executeTakeFirstOrThrow();
  const snapshot = (row: QuotaGrantBefore) => ({
    limit: String(row.quota_value), allowOverage: row.allow_overage,
    status: row.status, version: row.version, quotaBasis: row.quota_basis,
  });
  await db.insertInto("operation_log").values({
    enterprise_id: input.enterpriseId, admin_user_id: input.adminUserId, actor_source: "ADMIN",
    action: "principal_quota.change", target_type: "principal_grant", target_id: input.grantId,
    result: "SUCCESS", failure_reason: null,
    change_summary: JSON.stringify({
      schemaVersion: 1, principalId: input.principalId, provider: input.provider,
      operation: input.action ?? "SET", effectiveAt: now.toISOString(),
      policyEffectiveFrom: enterprise.employee_quota_monthly_from.toISOString(),
      before: { grant: input.before ? snapshot(input.before) : null, period: period?.before ?? null },
      after: { grant: snapshot(grant), period: period?.after ?? null },
    }) as unknown as Record<string, unknown>,
  }).execute();
}
