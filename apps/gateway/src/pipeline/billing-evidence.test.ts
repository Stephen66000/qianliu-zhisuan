import { expect, it, vi } from "vitest";
import type { GatewayLedgerRepository } from "@qianliu/database";
import type { RoutingCandidateInput } from "@qianliu/domain";
import { computeBilling, computeBillingFromRule, calculateDispatchSaving, dispatchCounterfactualEvidence,
  dispatchSavingFields } from "./billing.js";

type Row = Awaited<ReturnType<GatewayLedgerRepository["listActiveBillingRules"]>>[number];
function row(patch: Partial<Row> = {}): Row {
  return { id: "price", rule_type: "API_PRICE", rule_version: "v1", pricing_mode: "MULTIPLIER",
    provider_resource_id: "baseline", upstream_model: "model", effective_from: new Date(0), effective_to: null,
    timezone: null, days_of_week: null, start_time: null, end_time: null, time_windows: null,
    multiplier: "3", cache_hit_price: "0.000001", cache_miss_price: "0.000002", output_price: "0.000004",
    currency: "CNY", priority: 1, ...patch };
}
function repository(rows: Row[]) {
  // Mock only the persistence read boundary. All matching, arithmetic and snapshots below are real.
  const listActiveBillingRules = vi.fn().mockResolvedValue(rows);
  return { listActiveBillingRules, ledger: { listActiveBillingRules } as unknown as GatewayLedgerRepository };
}
const usage = { input: 1000000, output: 100000, cache: 200000 };
const candidate: RoutingCandidateInput = { resourceId: "baseline", upstreamModel: "model", providerCode: "deepseek",
  mode: "API", status: "ACTIVE", priority: 1, weight: 1, probe: false };

it("兼容读取保留pricing_mode，API倍率仍为6.60而非基础2.20", async () => {
  const { ledger, listActiveBillingRules } = repository([row()]);
  const result = await computeBilling(ledger, "enterprise", "baseline", "model", "API", 1000, usage);
  expect(listActiveBillingRules).toHaveBeenCalledWith("enterprise", new Date(1000));
  expect(result).toMatchObject({ apiCost: "6.60000000", currency: "CNY", multiplier: "3", deductedQuota: null,
    ruleSnapshot: { pricingMode: "MULTIPLIER", baseRuleId: "price", effectiveMultiplier: "3" } });
});

it("套餐兼容读取、无可用价格和缺失规则保持各自null语义", async () => {
  const plan = repository([row({ rule_type: "MODEL_TIER", pricing_mode: "ABSOLUTE",
    cache_hit_price: null, cache_miss_price: null, output_price: null })]);
  expect(await computeBilling(plan.ledger, "enterprise", "baseline", "model", "CODING_PLAN", 1000,
    { input: 10, output: 4, cache: 8 })).toMatchObject({ apiCost: null, deductedQuota: "42", multiplier: "3" });
  const unpriced = repository([row({ cache_hit_price: null, cache_miss_price: null, output_price: null })]);
  expect(await computeBilling(unpriced.ledger, "enterprise", "baseline", "model", "API", 1000, usage))
    .toMatchObject({ apiCost: null, ruleId: null, ruleSnapshot: null });
  expect(computeBillingFromRule(null, "CODING_PLAN", 1000, usage))
    .toMatchObject({ deductedQuota: null, multiplier: null, ruleSnapshot: null });
});

it("旧反事实调用未传冻结规则时仍正确读取倍率并计算节省", async () => {
  const { ledger, listActiveBillingRules } = repository([row()]);
  const result = await calculateDispatchSaving({ finalAction: "SWITCH", switchTargetId: "cheaper",
    baselineCandidate: candidate, invokedResourceIds: new Set(["cheaper"]), transactionUsage: usage,
    actualCost: "2.20000000", actualPricingEvidenceComplete: true, ledgerRepo: ledger,
    enterpriseId: "enterprise", requestStartedAt: 1000 });
  expect(listActiveBillingRules).toHaveBeenCalledTimes(1);
  expect(result.counterfactualCost).toBe("6.60000000");
  expect(result.saving.saving).toBe("4.40000000");
  expect(dispatchCounterfactualEvidence(candidate, result.counterfactualBilling))
    .toMatchObject({ baselineResourceId: "baseline", counterfactualBillingRuleId: "price", counterfactualRuleVersion: "v1" });
  expect(dispatchSavingFields(result.saving)).toMatchObject({ dispatchSaving: "4.40000000", savingCalculable: true });
});

it.each([
  ["package_cost_not_comparable", { baselineCandidate: { ...candidate, mode: "CODING_PLAN" as const } }],
  ["usage_evidence_missing", { transactionUsage: null }],
  ["baseline_price_rule_missing", { baselineRule: null }],
  ["actual_price_rule_missing", { actualPricingEvidenceComplete: false }],
])("反事实缺口 %s 不生成虚假节省", async (reason, patch) => {
  const { ledger } = repository([row()]);
  const result = await calculateDispatchSaving({ finalAction: "SWITCH", switchTargetId: "cheaper",
    baselineCandidate: candidate, invokedResourceIds: new Set(["cheaper"]), transactionUsage: usage,
    actualCost: "2.20000000", actualPricingEvidenceComplete: true, ledgerRepo: ledger,
    enterpriseId: "enterprise", requestStartedAt: 1000, ...patch });
  expect(result.saving).toEqual({ saving: "NOT_CALCULABLE", reason });
  expect(dispatchSavingFields(result.saving)).toEqual({ dispatchSaving: null, savingCalculable: false, notCalculableReason: reason });
});
