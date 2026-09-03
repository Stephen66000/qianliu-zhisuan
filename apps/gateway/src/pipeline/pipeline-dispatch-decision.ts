import { decideDispatch, type DispatchInput } from "@qianliu/domain";
import { dispatchCounterfactualEvidence } from "./billing.js";
import { dispatchPolicyWindow, dispatchResetAt } from "./runtime-controls.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

/** 首次 Attempt 冻结并应用经营调度判定。 */
export async function applyInitialDispatchDecision(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<void> {
  const { deps, principal, body, requestId, requestStartedAt } = context;
  if (state.attemptNo !== 1 || !deps.dispatchRepo || !state.winner) return;
  const availableIds = new Set(context.eligible.map((candidate) => candidate.resourceId));
  const resolved = deps.resolveDispatchInput
    ? await deps.resolveDispatchInput(
        principal.enterpriseId,
        principal.principalId,
        body.model,
        state.winner.input.resourceId,
        state.winner.input.mode,
        requestStartedAt,
      )
    : { priceMultiplier: "1", remainingQuotaRatio: null, forecastExhaustRisk: false };
  const dispatchInput: DispatchInput = {
    now: requestStartedAt,
    unifiedModel: body.model,
    selectedResourceId: state.winner.input.resourceId,
    resourceMode: state.winner.input.mode,
    priceMultiplier: resolved.priceMultiplier,
    remainingQuotaRatio: resolved.remainingQuotaRatio,
    forecastExhaustRisk: resolved.forecastExhaustRisk,
    principalId: principal.principalId,
  };
  state.dispatchBaselineCandidate = { ...state.winner.input };
  const policies = await deps.dispatchRepo.listPublishedPolicies(principal.enterpriseId);
  const decision = decideDispatch(policies, dispatchInput, availableIds);
  state.dispatchFinalAction = decision.finalAction;
  state.dispatchReasonCode = decision.reasonCode;
  state.dispatchMatchedPolicy = decision.matchedPolicy;
  state.dispatchSwitchTargetId = decision.switchTargetResourceId;
  state.dispatchDispatchInput = dispatchInput;

  try {
    await deps.dispatchRepo.createDecisionIfAbsent({
      enterpriseId: principal.enterpriseId,
      aiRequestId: requestId,
      dispatchInput: {
        now: dispatchInput.now,
        unifiedModel: dispatchInput.unifiedModel,
        selectedResourceId: dispatchInput.selectedResourceId,
        resourceMode: dispatchInput.resourceMode,
        priceMultiplier: dispatchInput.priceMultiplier,
        remainingQuotaRatio: dispatchInput.remainingQuotaRatio,
        forecastExhaustRisk: dispatchInput.forecastExhaustRisk,
        principalId: dispatchInput.principalId,
        matchedTimezone: decision.matchedPolicy?.matchTimezone ?? null,
        matchedDaysOfWeek: decision.matchedPolicy?.matchDaysOfWeek ?? null,
        matchedStartTime: decision.matchedPolicy?.matchStartTime ?? null,
        matchedEndTime: decision.matchedPolicy?.matchEndTime ?? null,
        policyWindow: dispatchPolicyWindow(decision.matchedPolicy),
        policyResetAt: dispatchResetAt(decision.matchedPolicy, requestStartedAt),
        ...dispatchCounterfactualEvidence(state.dispatchBaselineCandidate, null),
        executedResourceIds: [],
        usageEvidence: null,
        actualPricingEvidence: [],
        savingCalculationVersion: "pool-021-v1",
      },
      matchedPolicyId: decision.matchedPolicy?.id ?? null,
      matchedPolicyVersion: decision.matchedPolicy?.policyVersion ?? null,
      matchedPolicyAction: decision.matchedPolicy?.action ?? null,
      finalAction: decision.finalAction,
      reasonCode: decision.reasonCode,
      switchTargetResourceId: decision.switchTargetResourceId,
      counterfactualCost: null,
      actualCost: null,
      dispatchSaving: null,
      savingCalculable: false,
      notCalculableReason: decision.finalAction === "REJECT" || decision.finalAction === "RATE_LIMIT"
        ? "dispatch_terminated_before_attempt"
        : "pending_settlement",
    });
  } catch (error) {
    await deps.ledgerRepo.updateRequestStatus(
      requestId, "FAILED", "INTERNAL", "dispatch_decision_write_failure",
    );
    throw error;
  }

  if (decision.finalAction === "SWITCH" && decision.switchTargetResourceId) {
    const targetScored = state.lastScored.find(
      (candidate) => candidate.input.resourceId === decision.switchTargetResourceId,
    );
    if (targetScored) {
      targetScored.selected = true;
      state.winner.selected = false;
      state.winner.reasonCode = "DISPATCH_SWITCHED_AWAY";
      state.winner = targetScored;
    }
  }
  if (decision.finalAction === "REJECT" || decision.finalAction === "RATE_LIMIT") {
    state.dispatchTerminated = true;
  }
}
