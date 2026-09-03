export type ProviderFinancePreflightMode =
  | "DRY_RUN"
  | "APPLY_USAGE_BACKFILL"
  | "RESOLVE_LEGACY_API_COST"
  | "APPLY_USAGE_BACKFILL_AND_RESOLVE_LEGACY_API_COST";

export function providerFinancePreflightMode(
  applyUsageBackfill: boolean,
  resolveLegacyApiCost: boolean,
): ProviderFinancePreflightMode {
  if (applyUsageBackfill && resolveLegacyApiCost) {
    return "APPLY_USAGE_BACKFILL_AND_RESOLVE_LEGACY_API_COST";
  }
  if (applyUsageBackfill) return "APPLY_USAGE_BACKFILL";
  if (resolveLegacyApiCost) return "RESOLVE_LEGACY_API_COST";
  return "DRY_RUN";
}

export function providerFinancePreflightExitCode(decision: "GO_CANDIDATE" | "NO_GO"): 0 | 2 {
  return decision === "GO_CANDIDATE" ? 0 : 2;
}
