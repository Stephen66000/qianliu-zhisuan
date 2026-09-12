import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProviderResourceItem } from "../../api/types";
import { ResourceFinanceColumn, ResourceFinanceDisplay, ResourceQuotaColumn } from "./resource-page-display";

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

describe("ResourceFinanceColumn & ResourceQuotaColumn 列拆分测试", () => {
  it("套餐资源拆分为资金列（订阅金额与实付）与额度列（订阅额度、真实 Token、服务周期）", () => {
    const resource: ProviderResourceItem = {
      id: "plan-1", provider_id: "kimi", name: "Kimi 套餐", mode: "CODING_PLAN",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
      operating_snapshot: null, finance: {
        resourceId: "plan-1", providerCode: "kimi", mode: "CODING_PLAN", accounts: [], monthlyPlanCashCny: "0",
        currentPeriod: {
          id: "p-1", productName: "Kimi", periodStart: "2026-08-18T16:00:00Z",
          periodEndExclusive: "2026-09-18T16:00:00Z", fixedFeeAmount: "199", fixedFeeCurrency: "CNY",
          fixedCashPaidCny: "0", totalQuota: "3000000000", quotaUnit: "TOKEN",
          trueTokens: "223157358", deductedQuota: null, deductedQuotaComplete: false, requestCount: "100",
        },
      },
    };

    const { unmount: unmountFinance } = render(<ResourceFinanceColumn resource={resource} />);
    expect(screen.getByText("当前订阅金额 CNY 199.00")).toBeInTheDocument();
    expect(screen.getByText("本月订阅实付 ¥0.00")).toBeInTheDocument();
    expect(screen.queryByText(/当前订阅额度/)).not.toBeInTheDocument();
    unmountFinance();

    render(<ResourceQuotaColumn resource={resource} />);
    expect(screen.getByText("当前订阅额度 3,000,000,000 TOKEN")).toBeInTheDocument();
    expect(screen.getByText("周期真实 Token 223,157,358")).toBeInTheDocument();
    expect(screen.getByText("2026-08-19 ～ 2026-09-19")).toBeInTheDocument();
    expect(screen.queryByText(/当前订阅金额/)).not.toBeInTheDocument();
  });

  it("API 资源资金列展示充值、余额、成本，额度列展示破折号", () => {
    const resource: ProviderResourceItem = {
      id: "api-1", provider_id: "deepseek", name: "DeepSeek API", mode: "API",
      credential_type: "API_KEY", credential_fingerprint: "fp", credential_version: 1,
      status: "ACTIVE", consecutive_failures: 0, cooldown_until: null, last_probe_at: null,
      credential_refresh_status: "NOT_NEEDED", refresh_error_classification: null,
      credential_expires_at: null, resource_pool_id: null, upstream_models: [], concurrency_limit: null,
      version: 1, created_at: "2026-08-18T16:00:00Z", updated_at: "2026-08-18T16:00:00Z",
      operating_snapshot: null, finance: {
        resourceId: "api-1", providerCode: "deepseek", mode: "API", accounts: [{
          currency: "CNY", balanceState: "NORMAL", balance: "435.50",
          monthOpeningState: "NORMAL", monthOpeningBalance: "10.00",
          monthlyRecharge: "600.00", monthlyApiCost: "171.33",
        }], monthlyPlanCashCny: "0", currentPeriod: null,
      },
    };

    const { unmount: unmountFinance } = render(<ResourceFinanceColumn resource={resource} />);
    expect(screen.getByText("本月充值 CNY 600.00")).toBeInTheDocument();
    expect(screen.getByText("余额 CNY 435.50")).toBeInTheDocument();
    expect(screen.getByText("本月 API 成本 CNY 171.33")).toBeInTheDocument();
    unmountFinance();

    render(<ResourceQuotaColumn resource={resource} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
