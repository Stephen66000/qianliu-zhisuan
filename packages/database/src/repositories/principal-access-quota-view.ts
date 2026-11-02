import type { EmployeeQuotaBasis, EmployeeQuotaPeriod } from "../employee-quota-types.js";
import { employeeQuotaPeriodSnapshot } from "./employee-quota-repository.js";

export interface PrincipalAccessQuotaView {
  mode: "MONTHLY" | "LEGACY_PENDING_RECONCILIATION";
  period_key: string | null;
  period_start: string | null;
  period_end: string | null;
  timezone: string;
  quota_basis: EmployeeQuotaBasis | null;
  policy_effective_from: string | null;
  limit_value: string | null;
  used_value: string | null;
  reserved_value: string | null;
  available_value: string | null;
  overage_value: string | null;
  completeness: "COMPLETE" | "UNKNOWN" | "LEGACY_PENDING_RECONCILIATION";
}

/** This view never turns legacy counters into a purported current-month balance. */
export function principalAccessQuotaView(input: {
  period: EmployeeQuotaPeriod | null;
  basis: EmployeeQuotaBasis | null;
  timezone: string;
  effectiveFrom: Date | null;
}): PrincipalAccessQuotaView {
  if (!input.period) {
    return {
      mode: "LEGACY_PENDING_RECONCILIATION",
      period_key: null,
      period_start: null,
      period_end: null,
      timezone: input.timezone,
      quota_basis: input.basis,
      policy_effective_from: input.effectiveFrom?.toISOString() ?? null,
      limit_value: null,
      used_value: null,
      reserved_value: null,
      available_value: null,
      overage_value: null,
      completeness: "LEGACY_PENDING_RECONCILIATION",
    };
  }
  const snapshot = employeeQuotaPeriodSnapshot(input.period);
  const complete = snapshot.quality === "COMPLETE";
  return {
    mode: "MONTHLY",
    period_key: snapshot.periodKey,
    period_start: snapshot.periodStart,
    period_end: snapshot.periodEnd,
    timezone: snapshot.timezone,
    quota_basis: snapshot.quotaBasis,
    policy_effective_from: input.effectiveFrom?.toISOString() ?? null,
    limit_value: snapshot.limit,
    used_value: snapshot.used,
    reserved_value: snapshot.reserved,
    available_value: complete ? snapshot.available : null,
    overage_value: complete ? snapshot.overage : null,
    completeness: snapshot.quality,
  };
}
