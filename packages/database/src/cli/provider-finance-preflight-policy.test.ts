import { describe, expect, it } from "vitest";

import {
  providerFinancePreflightExitCode,
  providerFinancePreflightMode,
} from "./provider-finance-preflight-policy.js";

describe("provider finance preflight command policy", () => {
  it.each([
    [false, false, "DRY_RUN"],
    [true, false, "APPLY_USAGE_BACKFILL"],
    [false, true, "RESOLVE_LEGACY_API_COST"],
    [true, true, "APPLY_USAGE_BACKFILL_AND_RESOLVE_LEGACY_API_COST"],
  ] as const)("reports write mode truthfully", (apply, resolve, expected) => {
    expect(providerFinancePreflightMode(apply, resolve)).toBe(expected);
  });

  it("returns a failing process code for every NO_GO decision", () => {
    expect(providerFinancePreflightExitCode("NO_GO")).toBe(2);
    expect(providerFinancePreflightExitCode("GO_CANDIDATE")).toBe(0);
  });
});
