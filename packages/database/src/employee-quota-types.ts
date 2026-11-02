import type { Generated, Selectable } from "kysely";
export type EmployeeQuotaBasis = "RAW_TOKEN" | "PLAN_QUOTA";
export interface PrincipalQuotaPeriodTable {
  id: Generated<string>;
  enterprise_id: string;
  principal_id: string;
  provider: string;
  period_key: string;
  period_start: Date;
  period_end: Date;
  timezone: string;
  quota_basis: EmployeeQuotaBasis;
  limit_value: bigint;
  allow_overage: boolean;
  used_value: Generated<bigint>;
  reserved_value: Generated<bigint>;
  quality: Generated<"COMPLETE" | "UNKNOWN">;
  open_grant_version: number;
  limit_updated_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface PrincipalQuotaUsageTable {
  id: Generated<string>;
  enterprise_id: string;
  request_id: string;
  attempt_no: number;
  upstream_attempt_id: string | null;
  period_id: string;
  grant_id: string;
  grant_version: number;
  quota_basis: EmployeeQuotaBasis;
  estimate: bigint;
  actual: bigint | null;
  status: Generated<"RESERVED" | "SETTLED" | "RELEASED" | "UNKNOWN">;
  usage_quality: Generated<string>;
  created_at: Generated<Date>;
  settled_at: Date | null;
}
export type EmployeeQuotaPeriod = Selectable<PrincipalQuotaPeriodTable>;
export type EmployeeQuotaUsage = Selectable<PrincipalQuotaUsageTable>;
export interface EmployeeQuotaSettlement {
  grant_id: string;
  reserved_estimate: bigint;
  actual_deducted: bigint;
  period_id?: string;
  usage_id?: string;
  usage_quality?: string;
  usage_status?: "UNKNOWN" | "RELEASED";
}
