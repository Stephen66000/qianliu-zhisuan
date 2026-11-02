import { SecretValue } from "@qianliu/provider-adapters";
import type { ErrorClassification } from "@qianliu/domain";
import { shouldAttemptUpstreamFailover } from "../upstream-failover-policy.js";
import { resolveAdapter } from "./adapter-registry.js";
import { persistAttemptUsageEvidence } from "./attempt-usage-settlement.js";
import { prepareSelectedAttempt, type PreparedAttempt } from "./pipeline-attempt-preparation.js";
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
    monthlyQuota,
    reservedEstimate,
    resourceVersion,
    credentialVersion,
  } = prepared.value;
  const { deps, body, principal, requestId } = context;
  const adapter = resolveAdapter(candidate.adapterType ?? candidate.providerCode, deps.caller);
  state.invokedResourceIds.add(candidate.resourceId);
  const outcome = await adapter.invoke({
    providerCode: candidate.providerCode as "deepseek" | "zhipu" | "kimi",
    resourceId: candidate.resourceId,
    mode: candidate.mode,
    upstreamModel: candidate.upstreamModel,
    concurrencyLimit: resourceConfig?.concurrencyLimit ?? 0,
    baseUrl: resourceConfig?.baseUrl,
    endpoints: resourceConfig?.endpoints,
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

  const classification = outcome.error ? mapToClassification(outcome, candidate.mode) : null;
  let persistedRaw = 0n;
  let persistedQuality = "UNKNOWN";
  const persistedDeductedQuota = await persistAttemptUsageEvidence({
    ledgerRepo: deps.ledgerRepo,
    outcome,
    requestId,
    enterpriseId: principal.enterpriseId,
    principalId: context.principalId,
    attemptId: attempt.id,
    attemptNo: state.attemptNo,
    attemptStartedAt: invocationAuthorization.pricingAt,
    resourceId: candidate.resourceId,
    resourceMode: candidate.mode,
    upstreamModel: candidate.upstreamModel,
    billingRule: invocationAuthorization.billingRule,
    ...(monthlyQuota && grantId ? { monthlyAccounting: { ...monthlyQuota, grantId, reservedEstimate, leaseId,
      attemptResult: { http_status: outcome.status, response_committed: outcome.committed,
        first_byte_at: outcome.firstByteAt ? new Date(outcome.firstByteAt) : null, finished_at: new Date(),
        error_classification: classification, error_code: outcome.error ?? null, switch_reason: null } } } : {}),
    onPersistedQuotaUsage: ({ raw, quality }) => { persistedRaw = raw; persistedQuality = quality; },
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
  recordAttemptQuotaSettlement(state, prepared.value, persistedDeductedQuota, persistedRaw, persistedQuality);
  if (leaseId) state.pendingLeaseIds.push(leaseId);
  if (resourceConfig) {
    state.deferredResourceEffects.push({
      outcome, classification, resource: resourceConfig, probeLease,
      resourceVersion, credentialVersion,
    });
  }
  state.finalOutcome = outcome;
  state.finalOutcomeProviderCode = candidate.providerCode;
  state.finalOutcomeClassification = classification;

  if (candidate.mode === "CODING_PLAN" && classification === "UPSTREAM_BILLING_BLOCKED") return "BREAK";
  if (!shouldAttemptUpstreamFailover(outcome, classification as ErrorClassification | null)) return "BREAK";
  state.triedResourceIds.add(candidate.resourceId);
  await deps.ledgerRepo.updateAttemptResult(attempt.id, { switch_reason: classification });
  return "CONTINUE";
}

function recordAttemptQuotaSettlement(
  state: PipelineExecutionState, prepared: PreparedAttempt, persistedDeductedQuota: bigint | null,
  persistedRaw: bigint, persistedQuality: string,
): void {
  const { candidate, grantId, monthlyQuota, reservedEstimate, reservedProjectedRemaining } = prepared;
  if ((monthlyQuota || candidate.mode === "CODING_PLAN") && grantId) {
    // Measured consumption belongs to this attempt even if its response failed.
    // UNKNOWN stays null in the ledger; only its unconsumed reservation is returned here.
    const actualDeducted = monthlyQuota && candidate.mode === "API"
      ? persistedRaw : persistedDeductedQuota ?? 0n;
    if (monthlyQuota ? persistedQuality !== "UNKNOWN" : persistedDeductedQuota !== null) {
      const pendingAdjustment = monthlyQuota ? 0n : state.pendingQuotaSettlements
        .filter((item) => item.grant_id === grantId && item.period_id === undefined
          && item.usage_status !== "UNKNOWN")
        .reduce((sum, item) => sum + item.reserved_estimate - item.actual_deducted, 0n);
      const available = reservedEstimate + reservedProjectedRemaining + pendingAdjustment;
      const availableBeforeRequest = available > 0n ? available : 0n;
      state.requestOverage ||= actualDeducted > 0n && actualDeducted > availableBeforeRequest;
    }
    state.pendingQuotaSettlements.push({
      grant_id: grantId,
      reserved_estimate: reservedEstimate,
      actual_deducted: actualDeducted,
      ...(monthlyQuota ? { period_id: monthlyQuota.periodId, usage_id: monthlyQuota.usageId,
        usage_status: persistedQuality === "UNKNOWN" || (candidate.mode === "CODING_PLAN" && persistedDeductedQuota === null)
          ? "UNKNOWN" as const : undefined, usage_quality: persistedQuality } : {}),
    });
  }
}
