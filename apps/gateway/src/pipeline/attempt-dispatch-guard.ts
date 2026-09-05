import { billingPriceMultiplier, decideDispatch, type BillingRule, type RoutingCandidateInput } from "@qianliu/domain";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

/** Recheck the actual candidate at the same timestamp as its frozen price, including retries. */
export async function attemptDispatchGuard(context: PipelineContext, state: PipelineExecutionState,
  candidate: RoutingCandidateInput, rule: BillingRule, at: number, attemptId: string) {
  if (!context.deps.dispatchRepo) return null;
  const operating = await context.deps.dispatchRepo.resolveResourceOperatingInput(
    context.principal.enterpriseId, candidate.resourceId, at, candidate.upstreamModel);
  const policies = await context.deps.dispatchRepo.listPublishedPolicies(context.principal.enterpriseId);
  // A global SWITCH already executed for this candidate is satisfied; do not bounce back.
  const remainingPolicies = policies.filter((policy) => !(policy.action === "SWITCH"
    && policy.id === state.dispatchMatchedPolicy?.id && policy.policyVersion === state.dispatchMatchedPolicy?.policyVersion
    && state.dispatchSwitchTargetId === candidate.resourceId)
    && !(policy.action === "SWITCH" && policy.id === state.dispatchSatisfiedSwitch?.policyId
      && policy.policyVersion === state.dispatchSatisfiedSwitch?.policyVersion && candidate.resourceId === state.dispatchSatisfiedSwitch?.targetId));
  const decision = decideDispatch(remainingPolicies, {
    ...operating, priceMultiplier: billingPriceMultiplier(rule), now: at,
    unifiedModel: context.body.model, selectedResourceId: candidate.resourceId,
    resourceMode: candidate.mode, principalId: context.principalId,
  }, new Set(state.routeEligibleCandidates.filter((item) => !state.triedResourceIds.has(item.resourceId)).map((item) => item.resourceId)));
  await context.deps.ledgerRepo.updateAttemptResult(attemptId, { dispatch_check: {
    checkedAt: new Date(at).toISOString(), resourceId: candidate.resourceId, upstreamModel: candidate.upstreamModel,
    ruleId: rule.id, ruleVersion: rule.ruleVersion, priceMultiplier: billingPriceMultiplier(rule),
    policyId: decision.matchedPolicy?.id ?? null, policyVersion: decision.matchedPolicy?.policyVersion ?? null,
    action: decision.finalAction, reason: decision.reasonCode, switchTargetResourceId: decision.switchTargetResourceId,
  } });
  if (decision.finalAction === "REJECT" || decision.finalAction === "RATE_LIMIT"
    || decision.finalAction === "SWITCH") return decision;
  return null;
}
