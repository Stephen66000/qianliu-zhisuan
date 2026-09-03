import { summarizeLedgerUsageQuality } from "@qianliu/database";
import { availabilitySignalSummary, clampProviderWindowRecoveryAt, type ErrorClassification } from "@qianliu/domain";
import {
  calculateDispatchSaving,
  dispatchCounterfactualEvidence,
  dispatchSavingFields,
} from "./billing.js";
import { summarizePricingEvidence } from "./pricing-evidence.js";
import {
  latestProviderQuotaResetAt,
  mapToClassification,
  runBestEffort,
} from "./runtime-controls.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

/** 冻结请求级账本并在终态之后执行资源健康与 Runtime Assurance 副作用。 */
export async function settlePipelineRequest(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<void> {
  const { deps, request, requestId, principal, principalId, requestStartedAt } = context;
  let transactionApiCost: string | null = null;
  let transactionUsage: { input: number; output: number; cache: number } | null = null;
  let actualPricingEvidenceComplete = false;
  let actualPricingEvidence: Array<Record<string, unknown>> = [];
  if (state.finalOutcome) {
    const lines = await deps.ledgerRepo.listLedgerLines(requestId);
    const persistedAttempts = await deps.ledgerRepo.listAttempts(requestId);
    const sumIn = lines.reduce((acc, line) => acc + BigInt(line.raw_input_tokens), 0n);
    const sumOut = lines.reduce((acc, line) => acc + BigInt(line.raw_output_tokens), 0n);
    const sumCache = lines.reduce((acc, line) => acc + BigInt(line.raw_cache_tokens), 0n);
    const sumReasoning = lines.reduce((acc, line) => acc + BigInt(line.raw_reasoning_tokens), 0n);
    const sumDeducted = lines.reduce((acc, line) => acc + BigInt(line.deducted_quota ?? 0), 0n);
    transactionUsage = { input: Number(sumIn), output: Number(sumOut), cache: Number(sumCache) };
    const pricingEvidence = summarizePricingEvidence(lines);
    transactionApiCost = pricingEvidence.actualCost;
    actualPricingEvidenceComplete = pricingEvidence.complete;
    actualPricingEvidence = pricingEvidence.items;
    const usageQuality = summarizeLedgerUsageQuality(lines);
    await deps.ledgerRepo.finalizeLedgerSettlementIfAbsent({
      ai_request_id: requestId,
      enterprise_id: principal.enterpriseId,
      principal_id: principalId,
      total_input_tokens: sumIn,
      total_output_tokens: sumOut,
      total_cache_tokens: sumCache,
      total_reasoning_tokens: sumReasoning,
      total_deducted_quota: sumDeducted,
      total_api_cost: transactionApiCost ?? "0.00000000",
      usage_quality: usageQuality,
      attempt_count: persistedAttempts.length,
      overage: state.requestOverage,
      request_status: state.finalOutcome.committed && !state.finalOutcome.error ? "SUCCEEDED" : "FAILED",
      error_classification: state.finalOutcome.error ? mapToClassification(state.finalOutcome) : null,
      error_code: state.finalOutcome.error ?? null,
      quota_settlements: state.pendingQuotaSettlements,
      release_lease_ids: state.pendingLeaseIds,
    });
    if (deps.dispatchRepo && state.dispatchFinalAction !== null && state.dispatchDispatchInput !== null) {
      await runBestEffort(request.log, "enrich post-settlement dispatch evidence", async () => {
        const { counterfactualBilling, counterfactualCost, saving } = await calculateDispatchSaving({
          finalAction: state.dispatchFinalAction!,
          switchTargetId: state.dispatchSwitchTargetId,
          baselineCandidate: state.dispatchBaselineCandidate,
          invokedResourceIds: state.invokedResourceIds,
          transactionUsage,
          actualCost: transactionApiCost,
          actualPricingEvidenceComplete,
          ledgerRepo: deps.ledgerRepo,
          enterpriseId: principal.enterpriseId,
          requestStartedAt,
        });
        const evidence = {
          enterpriseId: principal.enterpriseId,
          aiRequestId: requestId,
          dispatchInput: {
            now: state.dispatchDispatchInput!.now,
            unifiedModel: state.dispatchDispatchInput!.unifiedModel,
            selectedResourceId: state.dispatchDispatchInput!.selectedResourceId,
            resourceMode: state.dispatchDispatchInput!.resourceMode,
            priceMultiplier: state.dispatchDispatchInput!.priceMultiplier,
            remainingQuotaRatio: state.dispatchDispatchInput!.remainingQuotaRatio,
            forecastExhaustRisk: state.dispatchDispatchInput!.forecastExhaustRisk,
            principalId: state.dispatchDispatchInput!.principalId,
            matchedTimezone: state.dispatchMatchedPolicy?.matchTimezone ?? null,
            matchedDaysOfWeek: state.dispatchMatchedPolicy?.matchDaysOfWeek ?? null,
            matchedStartTime: state.dispatchMatchedPolicy?.matchStartTime ?? null,
            matchedEndTime: state.dispatchMatchedPolicy?.matchEndTime ?? null,
            ...dispatchCounterfactualEvidence(state.dispatchBaselineCandidate, counterfactualBilling),
            executedResourceIds: [...state.invokedResourceIds],
            usageEvidence: transactionUsage,
            actualPricingEvidence,
            savingCalculationVersion: "pool-021-v1",
          },
          counterfactualCost,
          actualCost: transactionApiCost,
          ...dispatchSavingFields(saving),
        };
        try {
          await deps.dispatchRepo!.enrichDecisionSettlementEvidence(evidence);
        } catch {
          await deps.dispatchRepo!.enrichDecisionSettlementEvidence(evidence);
        }
      });
    }
  }

  for (const effect of state.deferredResourceEffects) {
    const { outcome, classification, resource, probeLease } = effect;
    if (outcome.upstreamErrorKind === "WINDOW_EXHAUSTED") {
      const recoveryCheckedAt = Date.now();
      const recoverAt = outcome.recoverAt ?? await latestProviderQuotaResetAt(
        deps.db, principal.enterpriseId, resource.resourceId, new Date(), "FIVE_HOUR",
      );
      if (recoverAt) {
        const parsedRecoverAt = Date.parse(recoverAt);
        if (Number.isFinite(parsedRecoverAt)) {
          const boundedRecoverAt = clampProviderWindowRecoveryAt(recoveryCheckedAt, parsedRecoverAt);
          outcome.recoverAt = new Date(boundedRecoverAt).toISOString();
          outcome.retryAfterMs = boundedRecoverAt - recoveryCheckedAt;
        }
      }
    }
    const availabilitySignal = outcome.unifiedAvailabilitySignal;
    const providerId = resource.providerId;
    if (outcome.error && availabilitySignal && deps.runtimeAssuranceRepo && providerId) {
      const signalResult = await runBestEffort(
        request.log,
        "record post-settlement runtime assurance signal",
        () => deps.runtimeAssuranceRepo!.recordSignal({
          enterpriseId: principal.enterpriseId,
          providerId,
          providerResourceId: resource.resourceId,
          unifiedModelId: resource.unifiedModelId ?? null,
          upstreamModel: resource.upstreamModel,
          signal: availabilitySignal,
          upstreamCode: outcome.upstreamCode ?? outcome.error,
          sanitizedSummary: availabilitySignalSummary(availabilitySignal),
          upstreamRecoverAt: outcome.recoverAt ? new Date(outcome.recoverAt) : null,
          aiRequestId: requestId,
          principalId,
          now: new Date(requestStartedAt),
          mode: deps.runtimeAssuranceMode ?? "OBSERVE",
          wecomNotify: deps.runtimeAssuranceWecomNotify ?? false,
        }),
      );
      if (signalResult) state.finalSignalResult = signalResult;
    }
    if (outcome.committed && !outcome.error) {
      await runBestEffort(request.log, "record post-settlement resource success", () =>
        deps.poolRepo.recordSuccess(resource.resourceId));
    } else if (classification) {
      await runBestEffort(request.log, "record post-settlement resource failure", () =>
        deps.poolRepo.recordFailure(
          resource.resourceId,
          classification as ErrorClassification,
          new Date(),
          {
            retryAfterMs: outcome.retryAfterMs,
            cooldownUntil: outcome.upstreamErrorKind === "WINDOW_EXHAUSTED" && outcome.recoverAt
              ? new Date(outcome.recoverAt).getTime()
              : undefined,
          },
        ));
    }
    if (probeLease) {
      await runBestEffort(request.log, "release post-settlement half-open probe", () =>
        deps.poolRepo.releaseHalfOpenProbe(resource.resourceId, probeLease.acquiredAt));
    }
  }
}
