import { finalizeRejectedAttemptBeforeUpstream } from "./attempt-usage-settlement.js";
import { runBestEffort } from "./runtime-controls.js";
import type { PreparedAttempt } from "./pipeline-attempt-preparation.js";
import type { PipelineContext, PipelineExecutionState } from "./real-pipeline-types.js";

/** No upstream call has occurred. Finalize the failed check and all outstanding accounting atomically. */
export async function finalizeDispatchCheckFailure(
  context: PipelineContext,
  state: PipelineExecutionState,
  prepared: Pick<PreparedAttempt, "candidate" | "attempt" | "grantId" | "reservedEstimate" | "leaseId" | "probeLease">,
): Promise<void> {
  const { candidate, attempt, grantId, reservedEstimate, leaseId, probeLease } = prepared;
  const errorCode = "dispatch_check_failed_before_upstream";
  // Do not serialize arbitrary DB/transport error messages: they may contain query parameters.
  context.request.log.error({ requestId: context.requestId, attemptId: attempt.id, errorCode },
    "final dispatch check failed before upstream invocation");
  try {
    await finalizeRejectedAttemptBeforeUpstream({
      ledgerRepo: context.deps.ledgerRepo,
      requestId: context.requestId,
      enterpriseId: context.principal.enterpriseId,
      principalId: context.principalId,
      attemptId: attempt.id,
      attemptNo: state.attemptNo,
      resourceId: candidate.resourceId,
      resourceMode: candidate.mode,
      errorCode,
      attemptResult: {
        http_status: 500, response_committed: false, finished_at: new Date(),
        error_classification: "INTERNAL", error_code: errorCode, switch_reason: null,
      },
      quotaSettlements: [...state.pendingQuotaSettlements,
        ...(grantId ? [{ grant_id: grantId, reserved_estimate: reservedEstimate, actual_deducted: 0n }] : [])],
      releaseLeaseIds: [...state.pendingLeaseIds, ...(leaseId ? [leaseId] : [])],
      overage: state.requestOverage,
    });
  } finally {
    // Early RETURNED skips deferred effects. Release earlier probes too, with their own fencing tokens.
    const probes = [...state.deferredResourceEffects.map((effect) => effect.probeLease), probeLease];
    for (const probe of probes) {
      if (probe) await runBestEffort(context.request.log, "release failed dispatch check probe", () =>
        context.deps.poolRepo.releaseHalfOpenProbe(probe.resourceId, probe.acquiredAt));
    }
  }
  context.reply.code(500).header("x-request-id", context.traceId).send({ error: {
    message: "当前尝试在访问厂商前调度检查失败，请稍后重试",
    type: "internal_error", code: errorCode, retryable: true, request_id: context.requestId,
  } });
}
