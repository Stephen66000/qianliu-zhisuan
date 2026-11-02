import { describe, expect, it } from "vitest";
import type { EmployeeQuotaPeriod } from "../employee-quota-types.js";
import { principalAccessQuotaView } from "./principal-access-quota-view.js";

function period(patch: Partial<EmployeeQuotaPeriod> = {}): EmployeeQuotaPeriod {
  const start = new Date("2026-12-01T00:00:00+08:00");
  return {
    id: "period", enterprise_id: "enterprise", principal_id: "employee", provider: "deepseek",
    period_key: "2026-12", period_start: start, period_end: new Date("2027-01-01T00:00:00+08:00"),
    timezone: "Asia/Shanghai", quota_basis: "RAW_TOKEN", limit_value: 1000n,
    used_value: 400n, reserved_value: 100n, allow_overage: false, quality: "COMPLETE", open_grant_version: 1,
    limit_updated_at: start, created_at: start, updated_at: start, ...patch,
  };
}

const config = { basis: "RAW_TOKEN" as const, timezone: "Asia/Shanghai", effectiveFrom: new Date("2026-12-01T00:00:00+08:00") };

describe("access-configuration monthly quota view", () => {
  it("does not present legacy counters as an exact monthly balance", () => {
    expect(principalAccessQuotaView({ ...config, period: null })).toMatchObject({
      mode: "LEGACY_PENDING_RECONCILIATION", period_key: null, used_value: null,
      available_value: null, overage_value: null, completeness: "LEGACY_PENDING_RECONCILIATION",
    });
  });

  it("includes reserved usage in available quota and transmits exact integer strings", () => {
    expect(principalAccessQuotaView({ ...config, period: period() })).toMatchObject({
      mode: "MONTHLY", period_key: "2026-12", used_value: "400", reserved_value: "100",
      available_value: "500", overage_value: "0", quota_basis: "RAW_TOKEN",
    });
    expect(principalAccessQuotaView({ ...config, period: period({ limit_value: 9007199254740993n }) }).limit_value)
      .toBe("9007199254740993");
  });

  it("shows real overage separately without making negative available quota", () => {
    expect(principalAccessQuotaView({ ...config, period: period({ used_value: 1200n, reserved_value: 0n }) }))
      .toMatchObject({ used_value: "1200", available_value: "0", overage_value: "200" });
  });

  it("keeps unknown balances unknown rather than calling a partial sum exact", () => {
    expect(principalAccessQuotaView({ ...config, period: period({ quality: "UNKNOWN" }) }))
      .toMatchObject({ used_value: "400", reserved_value: "100", available_value: null, overage_value: null, completeness: "UNKNOWN" });
  });
});
