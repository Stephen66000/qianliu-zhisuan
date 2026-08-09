import type { EmployeeModelPoolQuota } from "../employee-model-rule-types.js";

export function resolvePoolQuota(
  version: { pool_quotas: EmployeeModelPoolQuota[] | null; quota_value: bigint | null; allow_overage: boolean; valid_until: Date | null },
  providerCode: string,
): { quota_value: bigint; allow_overage: boolean; valid_until: Date | null } {
  const providerQuota = version.pool_quotas === null
    ? undefined
    : version.pool_quotas.find((item) => item.provider_code === providerCode);
  return providerQuota ? {
    quota_value: BigInt(providerQuota.quota_value), allow_overage: providerQuota.allow_overage,
    valid_until: providerQuota.valid_until ? new Date(providerQuota.valid_until) : null,
  } : {
    quota_value: version.quota_value ?? 0n, allow_overage: version.allow_overage, valid_until: version.valid_until,
  };
}
