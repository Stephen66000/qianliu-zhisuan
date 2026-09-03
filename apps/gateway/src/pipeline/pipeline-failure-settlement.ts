import { finalizeFailedRequestFromPersistedFactsIfAny } from "./attempt-usage-settlement.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

export async function publishFailedRequest(
  context: PipelineContext,
  state: PipelineExecutionState,
  errorClassification: string,
  errorCode: string,
): Promise<void> {
  const finalized = await finalizeFailedRequestFromPersistedFactsIfAny({
    ledgerRepo: context.deps.ledgerRepo,
    requestId: context.requestId,
    enterpriseId: context.principal.enterpriseId,
    principalId: context.principalId,
    errorClassification,
    errorCode,
    quotaSettlements: state.pendingQuotaSettlements,
    releaseLeaseIds: state.pendingLeaseIds,
    overage: state.requestOverage,
  });
  if (!finalized) {
    await context.deps.ledgerRepo.updateRequestStatus(
      context.requestId, "FAILED", errorClassification, errorCode,
    );
  }
}
