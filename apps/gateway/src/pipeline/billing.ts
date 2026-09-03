import type { GatewayLedgerRepository } from "@qianliu/database";
import {
  computeApiCostFromRule,
  computeDeductedQuota,
  computeDispatchSaving,
  configuredTimeWindows,
  findMatchedTimeWindow,
  matchMultiplierRule,
  matchPriceRule,
  type BillingRule,
  type BillingRuleWindow,
  type RoutingCandidateInput,
} from "@qianliu/domain";

export interface BillingOutcome {
  apiCost: string | null;
  currency: string | null;
  deductedQuota: string | null;
  ruleId: string | null;
  ruleVersion: string | null;
  multiplier: string | null;
  ruleSnapshot: Record<string, unknown> | null;
}

export async function computeBilling(
  ledgerRepo: GatewayLedgerRepository,
  enterpriseId: string,
  resourceId: string,
  upstreamModel: string,
  mode: "API" | "CODING_PLAN",
  attemptStartedAt: number,
  usage: { input: number; output: number; cache: number },
): Promise<BillingOutcome> {
  const rules = (await ledgerRepo.listActiveBillingRules(enterpriseId, new Date(attemptStartedAt))).map(
    (rule): BillingRule => ({
      id: rule.id,
      ruleType: rule.rule_type as BillingRule["ruleType"],
      ruleVersion: rule.rule_version,
      providerResourceId: rule.provider_resource_id,
      upstreamModel: rule.upstream_model,
      effectiveFrom: rule.effective_from.getTime(),
      effectiveTo: rule.effective_to ? rule.effective_to.getTime() : null,
      timezone: rule.timezone,
      daysOfWeek: rule.days_of_week,
      startTime: rule.start_time,
      endTime: rule.end_time,
      timeWindows: rule.time_windows?.map((window) => ({
        timezone: window.timezone,
        daysOfWeek: window.days_of_week,
        startTime: window.start_time,
        endTime: window.end_time,
      })) ?? null,
      multiplier: rule.multiplier,
      cacheHitPrice: rule.cache_hit_price,
      cacheMissPrice: rule.cache_miss_price,
      outputPrice: rule.output_price,
      currency: rule.currency,
      priority: rule.priority,
    }),
  );

  if (mode === "CODING_PLAN") {
    const match = matchMultiplierRule(rules, resourceId, upstreamModel, attemptStartedAt);
    return computeBillingFromRule(match?.rule ?? null, mode, attemptStartedAt, usage);
  }

  const priceRule = matchPriceRule(
    rules.filter((rule) => rule.cacheHitPrice !== null
      || rule.cacheMissPrice !== null
      || rule.outputPrice !== null),
    resourceId,
    upstreamModel,
    attemptStartedAt,
  );
  return computeBillingFromRule(priceRule, mode, attemptStartedAt, usage);
}

/** 使用 Adapter 前已冻结的精确规则结算，禁止上游返回后重新读取可变规则。 */
export function computeBillingFromRule(
  rule: BillingRule | null,
  mode: "API" | "CODING_PLAN",
  attemptStartedAt: number,
  usage: { input: number; output: number; cache: number },
): BillingOutcome {
  if (mode === "CODING_PLAN") {
    const multiplier = rule?.multiplier ?? null;
    const rawTotal = usage.input + usage.output;
    return {
      apiCost: null,
      currency: null,
      deductedQuota: multiplier === null ? null : computeDeductedQuota(rawTotal, multiplier),
      ruleId: rule?.id ?? null,
      ruleVersion: rule?.ruleVersion ?? null,
      multiplier,
      ruleSnapshot: rule
        ? billingRuleSnapshot(rule, findMatchedTimeWindow(rule, attemptStartedAt))
        : null,
    };
  }

  const apiCost = rule
    ? computeApiCostFromRule(rule, usage.input, usage.output, usage.cache)
    : null;
  return {
    apiCost,
    currency: rule?.currency ?? null,
    deductedQuota: null,
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.ruleVersion ?? null,
    multiplier: null,
    ruleSnapshot: rule
      ? billingRuleSnapshot(rule, findMatchedTimeWindow(rule, attemptStartedAt))
      : null,
  };
}

function billingRuleSnapshot(
  rule: BillingRule,
  matchedWindow: BillingRuleWindow | null,
): Record<string, unknown> {
  return {
    ruleType: rule.ruleType,
    ruleVersion: rule.ruleVersion,
    effectiveFrom: new Date(rule.effectiveFrom).toISOString(),
    effectiveTo: rule.effectiveTo === null ? null : new Date(rule.effectiveTo).toISOString(),
    timezone: rule.timezone,
    daysOfWeek: rule.daysOfWeek,
    startTime: rule.startTime,
    endTime: rule.endTime,
    timeWindows: configuredTimeWindows(rule),
    matchedWindow,
    multiplier: rule.multiplier,
    cacheHitPrice: rule.cacheHitPrice,
    cacheMissPrice: rule.cacheMissPrice,
    outputPrice: rule.outputPrice,
    currency: rule.currency,
    priority: rule.priority,
  };
}

export function dispatchCounterfactualEvidence(
  baselineCandidate: RoutingCandidateInput | null,
  billing: BillingOutcome | null,
) {
  return {
    baselineResourceId: baselineCandidate?.resourceId ?? null,
    counterfactualBillingRuleId: billing?.ruleId ?? null,
    counterfactualRuleVersion: billing?.ruleVersion ?? null,
    counterfactualRuleSnapshot: billing?.ruleSnapshot ?? null,
  };
}

export function dispatchSavingFields(saving: ReturnType<typeof computeDispatchSaving>) {
  return saving.saving === "NOT_CALCULABLE"
    ? { dispatchSaving: null, savingCalculable: false, notCalculableReason: saving.reason }
    : { dispatchSaving: saving.saving, savingCalculable: true, notCalculableReason: saving.reason };
}

export async function calculateDispatchSaving(input: {
  finalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE";
  switchTargetId: string | null;
  baselineCandidate: RoutingCandidateInput | null;
  invokedResourceIds: Set<string>;
  transactionUsage: { input: number; output: number; cache: number } | null;
  actualCost: string | null;
  actualPricingEvidenceComplete: boolean;
  ledgerRepo: GatewayLedgerRepository;
  enterpriseId: string;
  requestStartedAt: number;
}) {
  const actionExecuted = input.finalAction === "SWITCH"
    && input.switchTargetId !== null
    && input.baselineCandidate !== null
    && input.switchTargetId !== input.baselineCandidate.resourceId
    && input.invokedResourceIds.has(input.switchTargetId);
  const counterfactualBilling = actionExecuted
    && input.baselineCandidate?.mode === "API"
    && input.transactionUsage
    ? await computeBilling(
        input.ledgerRepo,
        input.enterpriseId,
        input.baselineCandidate.resourceId,
        input.baselineCandidate.upstreamModel,
        "API",
        input.requestStartedAt,
        input.transactionUsage,
      )
    : null;
  const counterfactualCost = counterfactualBilling?.ruleId ? counterfactualBilling.apiCost : null;
  let saving = computeDispatchSaving({
    finalAction: input.finalAction,
    counterfactualCost,
    actualCost: input.actualPricingEvidenceComplete ? input.actualCost : null,
    actionExecuted,
  });
  if (actionExecuted && input.baselineCandidate?.mode !== "API") {
    saving = { saving: "NOT_CALCULABLE", reason: "package_cost_not_comparable" };
  } else if (actionExecuted && input.transactionUsage === null) {
    saving = { saving: "NOT_CALCULABLE", reason: "usage_evidence_missing" };
  } else if (actionExecuted && !counterfactualBilling?.ruleId) {
    saving = { saving: "NOT_CALCULABLE", reason: "baseline_price_rule_missing" };
  } else if (actionExecuted && !input.actualPricingEvidenceComplete) {
    saving = { saving: "NOT_CALCULABLE", reason: "actual_price_rule_missing" };
  }
  return { counterfactualBilling, counterfactualCost, saving };
}
