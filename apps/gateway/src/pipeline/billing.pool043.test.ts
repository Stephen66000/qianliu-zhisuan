import { describe, expect, it } from "vitest";
import type { LedgerLine } from "@qianliu/database";

import { summarizePricingEvidence } from "./pricing-evidence.js";

function line(input: Partial<LedgerLine>): LedgerLine {
  return {
    resource_mode: "API",
    api_cost: "1.00000000",
    billing_rule_id: "rule-1",
    rule_version: "v1",
    provider_resource_id: "resource-1",
    billing_rule_snapshot: null,
    ...input,
  } as LedgerLine;
}

describe("POOL-043 请求级 API 费用证据", () => {
  it("全部 API 行费用已知时求和并标记完整", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: "1" }),
      line({ api_cost: "0.75000000", provider_resource_id: "resource-2" }),
    ])).toMatchObject({ actualCost: "1.75000000", complete: true });
  });

  it("任一 API 行费用未知时不返回部分和", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: null, billing_rule_id: null, rule_version: null }),
      line({ api_cost: "0.75000000" }),
    ])).toMatchObject({ actualCost: null, complete: false });
  });

  it("Coding Plan 行不污染 API cost-known，但不允许费用反事实混比", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: "0.75000000" }),
      line({ resource_mode: "CODING_PLAN", api_cost: null, billing_rule_id: null }),
    ])).toMatchObject({ actualCost: "0.75000000", complete: false });
    expect(summarizePricingEvidence([
      line({ resource_mode: "CODING_PLAN", api_cost: null, billing_rule_id: null }),
    ])).toMatchObject({ actualCost: null, complete: false });
  });

  it("非法 decimal8 费用事实 fail-closed", () => {
    expect(() => summarizePricingEvidence([line({ api_cost: "not-a-decimal" })]))
      .toThrow("invalid_decimal8:not-a-decimal");
  });

  it("F-020：混合币种的已计价行不产生单一原币总额，并标记混合", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: "1.00000000", api_cost_currency: "CNY", provider_resource_id: "resource-cny" }),
      line({ api_cost: "0.20000000", api_cost_currency: "USD", provider_resource_id: "resource-usd" }),
    ])).toMatchObject({
      actualCost: null, actualCostCurrency: null,
      mixedApiCostCurrency: true, complete: true,
    });
  });

  it("F-020：单一币种时返回币种，CP 行不影响币种判定", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: "1.00000000", api_cost_currency: "USD" }),
      line({ resource_mode: "CODING_PLAN", api_cost: null, billing_rule_id: null }),
    ])).toMatchObject({ actualCost: "1.00000000", actualCostCurrency: "USD", mixedApiCostCurrency: false });
  });

  it("F-020：零消费占位行（cost=0、currency=null）不参与混合币种判定（与复核 SQL 的 COUNT(DISTINCT) 语义一致）", () => {
    expect(summarizePricingEvidence([
      line({ api_cost: "0.00000000", api_cost_currency: null, provider_resource_id: "resource-zero" }),
      line({ api_cost: "0.66000000", api_cost_currency: "CNY", provider_resource_id: "resource-cny" }),
    ])).toMatchObject({
      actualCost: "0.66000000", actualCostCurrency: "CNY",
      mixedApiCostCurrency: false, unknownApiCost: false,
    });
  });
});
