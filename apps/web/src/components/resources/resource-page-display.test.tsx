import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ProviderResourceItem } from "../../api/types";
import { ResourceFinanceDisplay } from "./resource-page-display";

it.each(["kimi", "zhipu"])("%s 扣减缺失仍保留周期真实 Token", (providerCode) => {
  const resource: ProviderResourceItem = {
    id: "plan", provider_id: providerCode, name: "Plan", mode: "CODING_PLAN",
    credential_type: "API_KEY", credential_fingerprint: "safe-fingerprint", credential_version: 1,
    status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
    credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
    credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
    version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
    operating_snapshot: null, finance: {
    resourceId: "plan", providerCode, mode: "CODING_PLAN", accounts: [], monthlyPlanCashCny: "199",
    currentPeriod: { id: "period", productName: "Plan", periodStart: "2026-08-18T16:00:00Z",
      periodEndExclusive: "2026-09-18T16:00:00Z", fixedFeeAmount: "199", fixedFeeCurrency: "CNY",
      fixedCashPaidCny: "199", totalQuota: "300000000", quotaUnit: "TOKEN",
      trueTokens: "9000000", deductedQuota: null, deductedQuotaComplete: false, requestCount: "100" },
  } };
  render(<ResourceFinanceDisplay resource={resource} />);
  expect(screen.getByText("周期真实 Token 9,000,000")).toBeInTheDocument();
  expect(screen.queryByText(/周期已扣减|事实不完整/)).not.toBeInTheDocument();
  expect(screen.getByText("2026-08-19 ～ 2026-09-19")).toBeInTheDocument();
});
