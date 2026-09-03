import { SecretValue } from "@qianliu/provider-adapters";
import type { ErrorClassification } from "@qianliu/domain";
import { shouldAttemptUpstreamFailover } from "../upstream-failover-policy.js";
import { resolveAdapter } from "./adapter-registry.js";
import { persistAttemptUsageEvidence } from "./attempt-usage-settlement.js";
import { prepareSelectedAttempt } from "./pipeline-attempt-preparation.js";
import { attemptDiagnosticUpdate } from "./upstream-error-diagnostic.js";
import { mapToClassification } from "./runtime-controls.js";
import type {
  AttemptStepResult,
  PipelineContext,
  PipelineExecutionState,
} from "./real-pipeline-types.js";

export async function executeSelectedAttempt(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<AttemptStepResult> {
  const prepared = await prepareSelectedAttempt(context, state);
  if (prepared.kind === "STOP") return prepared.result;
  const {
    candidate,
    probeLease,
    resourceConfig,
    invocationAuthorization,
    attempt,
    leaseId,
    grantId,
    reservedEstimate,
    reservedProjectedRemaining,
  } = prepared.value;
  const { deps, body, principal, requestId } = context;
  const adapter = resolveAdapter(candidate.providerCode, deps.caller);
  state.invokedResourceIds.add(candidate.resourceId);
  const outcome = await adapter.invoke({
    providerCode: candidate.providerCode as "deepseek" | "zhipu" | "kimi",
    resourceId: candidate.resourceId,
    mode: candidate.mode,
    upstreamModel: candidate.upstreamModel,
    concurrencyLimit: resourceConfig?.concurrencyLimit ?? 0,
    secret: resourceConfig?.secret ?? new SecretValue(""),
  }, {
    requestId,
    unifiedModel: body.model,
    stream: body.stream ?? false,
    capability: context.capability,
    body: context.capability === "responses" ? body.responsesRequest : context.effectiveBody,
    abort: context.downstreamAbort.signal,
    ...(context.streamWriter
      ? { onStreamChunk: (payload: Record<string, unknown>) => context.streamWriter!.writeChunk(payload) }
      : {}),
  }, state.attemptNo);

  const classification = outcome.error ? mapToClassification(outcome) : null;
  const persistedDeductedQuota = await persistAttemptUsageEvidence({
    ledgerRepo: deps.ledgerRepo,
    outcome,
    requestId,
    enterpriseId: principal.enterpriseId,
    principalId: context.principalId,
    attemptId: attempt.id,
    attemptNo: state.attemptNo,
    attemptStartedAt: attempt.started_at.getTime(),
    resourceId: candidate.resourceId,
    resourceMode: candidate.mode,
    upstreamModel: candidate.upstreamModel,
    billingRule: invocationAuthorization.billingRule,
  });
  await deps.ledgerRepo.updateAttemptResult(attempt.id, {
    http_status: outcome.status,
    response_committed: outcome.committed,
    first_byte_at: outcome.firstByteAt ? new Date(outcome.firstByteAt) : null,
    finished_at: new Date(),
    error_classification: classification,
    error_code: outcome.error ?? null,
    failure_layer: outcome.failureLayer ?? null,
    ...attemptDiagnosticUpdate(outcome),
    switch_reason: null,
  });
  if (candidate.mode === "CODING_PLAN" && grantId) {
    const actualDeducted = outcome.committed && !outcome.error ? persistedDeductedQuota ?? 0n : 0n;
    if (outcome.committed && !outcome.error) {
      const availableBeforeRequest = reservedEstimate + reservedProjectedRemaining > 0n
        ? reservedEstimate + reservedProjectedRemaining
        : 0n;
      state.requestOverage ||= actualDeducted > 0n && actualDeducted > availableBeforeRequest;
    }
    state.pendingQuotaSettlements.push({
      grant_id: grantId,
      reserved_estimate: reservedEstimate,
      actual_deducted: actualDeducted,
    });
  }
  if (leaseId) state.pendingLeaseIds.push(leaseId);
  if (resourceConfig) {
    state.deferredResourceEffects.push({ outcome, classification, resource: resourceConfig, probeLease });
  }
  state.finalOutcome = outcome;
  state.finalOutcomeProviderCode = candidate.providerCode;

  if (candidate.mode === "CODING_PLAN" && classification === "UPSTREAM_BILLING_BLOCKED") return "BREAK";
  if (!shouldAttemptUpstreamFailover(outcome, classification as ErrorClassification | null)) return "BREAK";
  state.triedResourceIds.add(candidate.resourceId);
  await deps.ledgerRepo.updateAttemptResult(attempt.id, { switch_reason: classification });
  return "CONTINUE";
}
