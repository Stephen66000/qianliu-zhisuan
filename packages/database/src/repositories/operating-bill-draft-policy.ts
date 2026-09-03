import { Decimal } from "decimal.js";
import type { OperatingBillGap, OperatingBillProviderRow } from "./operating-bill-types.js";

export const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });

export interface ResourceFactRow {
  resource_id: string; provider_code: string; provider_name: string; resource_name: string;
  mode: "API" | "CODING_PLAN"; resource_status: string; snapshot_id: string | null;
  snapshot_version: number | null; snapshot_at: Date | null; snapshot_source: string | null;
  currency: string | null; current_balance: string | null; recharge_amount: string | null;
  package_cost: string | null; total_quota: string | null; used_quota: string | null;
  remaining_quota: string | null; quota_unit: string | null; effective_from: Date | null;
  effective_until: Date | null; next_reset_at: Date | null; budget_id: string | null;
  budget_version: number | null; budget_status: "ACTIVE" | "CLEARED" | null;
  budget_amount: string | null; budget_currency: string | null; budget_at: Date | null;
}

export interface ResourceRangeRow {
  provider_resource_id: string; first_at: Date | null; last_at: Date | null; request_count: string;
}

export function decimal(value: string | null | undefined): Decimal {
  return new MoneyDecimal(value ?? "0");
}

export function amount(value: Decimal): string {
  return value.toDecimalPlaces(8).toFixed(8);
}

export function integerText(value: Decimal): string {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0);
}

export function assessPlanResource(
  row: ResourceFactRow,
  activePrincipalCount: number,
  packageCost: Decimal,
  periodEnd: Date,
): Pick<OperatingBillProviderRow, "planAssessment" | "idleEntitlementCost" | "assessmentBasis"> {
  const totalQuota = decimal(row.total_quota);
  if (row.mode !== "CODING_PLAN" || row.effective_from === null || row.effective_until === null
    || row.total_quota === null || row.used_quota === null || !totalQuota.gt(0)) {
    return { planAssessment: null, idleEntitlementCost: null, assessmentBasis: null };
  }
  const used = decimal(row.used_quota);
  const boundary = [row.effective_until, row.next_reset_at, periodEnd]
    .filter((value): value is Date => value !== null)
    .reduce((earliest, value) => value < earliest ? value : earliest, periodEnd);
  const planAssessment = activePrincipalCount === 0 || used.eq(0)
    ? "UNUSED"
    : used.gte(totalQuota) && row.snapshot_at && row.snapshot_at < boundary
      ? "EXHAUSTED_EARLY"
      : used.gte(totalQuota) ? "FULL" : "UNDERUSED";
  return {
    planAssessment,
    idleEntitlementCost: amount(packageCost.mul(MoneyDecimal.max(0, new MoneyDecimal(1).minus(used.div(totalQuota))))),
    assessmentBasis: `已用 ${row.used_quota}/${row.total_quota} ${row.quota_unit ?? "原生额度"}；闲置金额按固定费用×未使用比例折算，不代表厂商退款`,
  };
}

export function gapForResource(row: ResourceFactRow, range?: ResourceRangeRow): OperatingBillGap | null {
  const detail = {
    providerResourceId: row.resource_id,
    snapshotId: row.snapshot_id,
    snapshotVersion: row.snapshot_version,
    requestRangeFrom: range?.first_at?.toISOString() ?? null,
    requestRangeTo: range?.last_at?.toISOString() ?? null,
  };
  if (!row.snapshot_id) {
    return { code: "OPERATING_SNAPSHOT_MISSING", message: `${row.resource_name} 缺少字段：经营快照；请求范围 ${detail.requestRangeFrom ?? "无请求"} ~ ${detail.requestRangeTo ?? "无请求"}`, field: "operating_snapshot", ...detail };
  }
  if (row.mode === "API" && (!row.currency || row.current_balance === null)) {
    return { code: "API_BALANCE_MISSING", message: `${row.resource_name} 缺少字段：${!row.currency ? "currency" : "current_balance"}；快照 v${row.snapshot_version}`, field: !row.currency ? "currency" : "current_balance", ...detail };
  }
  if (row.mode === "CODING_PLAN" && (row.package_cost === null || row.total_quota === null || row.used_quota === null || row.quota_unit === null)) {
    const field = row.package_cost === null ? "package_cost" : row.total_quota === null ? "total_quota" : row.used_quota === null ? "used_quota" : "quota_unit";
    return { code: "PLAN_FACT_MISSING", message: `${row.resource_name} 缺少字段：${field}；快照 v${row.snapshot_version}`, field, ...detail };
  }
  if (row.mode === "CODING_PLAN" && (row.effective_from === null || row.effective_until === null)) {
    const field = row.effective_from === null ? "effective_from" : "effective_until";
    return { code: "PLAN_PERIOD_MISSING", message: `${row.resource_name} 缺少字段：${field}；不能计算订阅周期利用率`, field, ...detail };
  }
  return null;
}

export function isEffectivePackage(row: ResourceFactRow, start: Date, end: Date): boolean {
  return row.mode === "CODING_PLAN" && row.package_cost !== null && row.effective_from !== null
    && row.effective_until !== null && row.effective_from < end && row.effective_until > start;
}
