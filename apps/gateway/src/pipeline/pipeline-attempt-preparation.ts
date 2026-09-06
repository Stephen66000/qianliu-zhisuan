import { OperatingBillClosedError, type UpstreamAttempt } from "@qianliu/database";
import { QUOTA_DECISION, ROUTING_POLICY, type RoutingCandidateInput } from "@qianliu/domain";
import {
  getCurrentInvocationAuthorization,
  type CurrentInvocationAuthorization,
} from "../auth/current-model-authorization.js";
import {
  finalizeRejectedAttemptBeforeUpstream,
  persistRejectedAttemptBeforeUpstreamEvidence,
} from "./attempt-usage-settlement.js";
import {
  hasCurrentKeyModelAuthorization,
  settleRevokedAttempt,
} from "./revoked-attempt-settlement.js";
import { publishFailedRequest } from "./pipeline-failure-settlement.js";
import { attemptDispatchGuard } from "./attempt-dispatch-guard.js";
import { finalizeDispatchCheckFailure } from "./dispatch-check-failure.js";
import {
  acquireConcurrencyLeaseWithWait,
  estimateRawTokens,
  latestProviderQuotaResetAt,
  runBestEffort,
} from "./runtime-controls.js";
import {
  invocationCandidateKey,
  type AttemptStepResult,
  type PipelineContext,
  type PipelineExecutionState,
  type RouteCandidateRow,
} from "./real-pipeline-types.js";

export interface PreparedAttempt {
  candidate: RoutingCandidateInput;
  probeLease: Awaited<ReturnType<PipelineContext["deps"]["poolRepo"]["acquireHalfOpenProbeLease"]>>;
  resourceConfig: RouteCandidateRow | undefined;
  invocationAuthorization: CurrentInvocationAuthorization;
  attempt: UpstreamAttempt;
  leaseId: string | null;
  grantId: string | null;
  reservedEstimate: bigint;
  reservedProjectedRemaining: bigint;
}

export type AttemptPreparationResult =
  | { kind: "READY"; value: PreparedAttempt }
  | { kind: "STOP"; result: AttemptStepResult };

type QuotaReservationResult =
  | { kind: "STOP"; result: AttemptStepResult }
  | {
      kind: "READY_QUOTA";
      leaseId: string;
      grantId: string | null;
      reservedEstimate: bigint;
      reservedProjectedRemaining: bigint;
    };

export async function prepareSelectedAttempt(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<AttemptPreparationResult> {
  const { deps, principal, body, request, reply, requestId, traceId } = context;
  const candidate = state.winner!.input;
  const grantStillActive = await deps.quotaRepo.hasActiveGrant({
    enterpriseId: principal.enterpriseId,
    principalId: context.principalId,
    provider: candidate.providerCode,
    modelAlias: body.model,
  });
  if (!grantStillActive) {
    state.grantRevokedDuringDispatch = true;
    state.triedResourceIds.add(candidate.resourceId);
    return { kind: "STOP", result: "CONTINUE" };
  }
  const probeLease = candidate.probe
    ? await deps.poolRepo.acquireHalfOpenProbeLease(
      candidate.resourceId, new Date(), context.halfOpenProbeLeaseMs,
    )
    : null;
  if (candidate.probe && probeLease === null) {
    state.halfOpenProbeBusy = true;
    state.triedResourceIds.add(candidate.resourceId);
    return { kind: "STOP", result: "CONTINUE" };
  }
  await freezeRouteCandidates(context, state);

  let leaseId: string | null = null;
  let grantId: string | null = null;
  let reservedEstimate = 0n;
  let reservedProjectedRemaining = 0n;
  if (candidate.mode === "CODING_PLAN") {
    const reserved = await reserveCodingPlanQuota(context, state, probeLease);
    if (reserved.kind === "STOP") return reserved;
    ({ leaseId, grantId, reservedEstimate, reservedProjectedRemaining } = reserved);
  }

  let attempt: UpstreamAttempt;
  try {
    attempt = await deps.ledgerRepo.createAttempt({
      ai_request_id: requestId,
      enterprise_id: principal.enterpriseId,
      attempt_no: state.attemptNo,
      provider_resource_id: candidate.resourceId,
      upstream_model: candidate.upstreamModel,
    });
  } catch (error) {
    await releaseAttemptReservations(context, candidate.resourceId, probeLease, grantId, reservedEstimate, leaseId);
    if (!(error instanceof OperatingBillClosedError)) throw error;
    await publishFailedRequest(context, state, "OPERATING_BILL_CLOSED", "operating_bill_closed");
    reply.code(409).header("x-request-id", traceId).send({
      error: {
        message: "当前账期已结账，本次请求未访问上游",
        type: "invalid_request_error",
        code: "operating_bill_closed",
        param: null,
        retryable: false,
        request_id: requestId,
      },
    });
    return { kind: "STOP", result: "RETURNED" };
  }

  const keyStillAuthorized = await hasCurrentKeyModelAuthorization(
    deps.db, principal.enterpriseId, context.principalId, principal.keyId, body.model,
  );
  if (!keyStillAuthorized) {
    await finalizeRejectedAttemptBeforeUpstream({
      ledgerRepo: deps.ledgerRepo,
      requestId,
      enterpriseId: principal.enterpriseId,
      principalId: context.principalId,
      attemptId: attempt.id,
      attemptNo: state.attemptNo,
      resourceId: candidate.resourceId,
      resourceMode: candidate.mode,
      errorCode: "key_or_model_authorization_revoked",
      attemptResult: {
        http_status: 403,
        response_committed: false,
        finished_at: new Date(),
        error_classification: "DOWNSTREAM_AUTH_OR_QUOTA",
        error_code: "key_or_model_authorization_revoked",
        switch_reason: null,
      },
      quotaSettlements: [
        ...state.pendingQuotaSettlements,
        ...(grantId ? [{ grant_id: grantId, reserved_estimate: reservedEstimate, actual_deducted: 0n }] : []),
      ],
      releaseLeaseIds: [...state.pendingLeaseIds, ...(leaseId ? [leaseId] : [])],
      overage: state.requestOverage,
    });
    if (probeLease) {
      await runBestEffort(request.log, "release revoked half-open probe", () =>
        deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt));
    }
    reply.code(403).header("x-request-id", traceId).send({
      error: {
        message: "Key 或模型授权在访问上游前已失效",
        type: "authentication_error",
        code: "key_or_model_authorization_revoked",
        param: "model",
        retryable: false,
        request_id: requestId,
      },
    });
    return { kind: "STOP", result: "RETURNED" };
  }

  const resourceConfig = context.candidateByInvocationKey.get(invocationCandidateKey(candidate));
  const invocationAuthorization = await getCurrentInvocationAuthorization(deps.db, {
    enterpriseId: principal.enterpriseId,
    principalId: context.principalId,
    keyId: principal.keyId,
    modelAlias: body.model,
    routeId: candidate.routeId ?? resourceConfig?.routeId,
    providerCode: candidate.providerCode,
    resourceId: candidate.resourceId,
    upstreamModel: candidate.upstreamModel,
    allowHalfOpenProbe: probeLease !== null,
    now: new Date(),
  });
  if (!invocationAuthorization) {
    const rejection = await settleRevokedAttempt({
      db: deps.db,
      ledgerRepo: deps.ledgerRepo,
      quotaRepo: deps.quotaRepo,
      poolRepo: deps.poolRepo,
      log: request.log,
      enterpriseId: principal.enterpriseId,
      principalId: context.principalId,
      keyId: principal.keyId,
      modelAlias: body.model,
      requestId,
      attemptId: attempt.id,
      attemptNo: state.attemptNo,
      candidate,
      candidates: state.routeEligibleCandidates,
      triedResourceIds: state.triedResourceIds,
      affinityResourceId: context.affinityResourceId,
      maxAttempts: context.maxAttempts,
      grantId,
      reservedEstimate,
      leaseId,
      pendingQuotaSettlements: state.pendingQuotaSettlements,
      pendingLeaseIds: state.pendingLeaseIds,
      requestOverage: state.requestOverage,
      probeLease,
    });
    if (rejection.kind === "FAILOVER") {
      state.routeEligibleCandidates = rejection.remainingCandidates;
      return { kind: "STOP", result: "CONTINUE" };
    }
    reply.code(rejection.statusCode).header("x-request-id", traceId).send({
      error: {
        message: rejection.message,
        type: rejection.type,
        code: rejection.errorCode,
        param: "model",
        retryable: rejection.retryable,
        request_id: requestId,
      },
    });
    return { kind: "STOP", result: "RETURNED" };
  }
  let dispatchBlock: Awaited<ReturnType<typeof attemptDispatchGuard>>;
  try {
    dispatchBlock = await attemptDispatchGuard(context, state, candidate,
      invocationAuthorization.billingRule, invocationAuthorization.pricingAt, attempt.id);
  } catch {
    await finalizeDispatchCheckFailure(context, state, { candidate, attempt, grantId, reservedEstimate, leaseId, probeLease });
    return { kind: "STOP", result: "RETURNED" };
  }
  if (dispatchBlock?.finalAction === "SWITCH" && dispatchBlock.switchTargetResourceId && state.attemptNo < context.maxAttempts) {
    await persistRejectedAttemptBeforeUpstreamEvidence({ ledgerRepo: deps.ledgerRepo, requestId,
      enterpriseId: principal.enterpriseId, principalId: context.principalId, attemptId: attempt.id,
      attemptNo: state.attemptNo, resourceId: candidate.resourceId, resourceMode: candidate.mode,
      attemptResult: { http_status: 409, response_committed: false, finished_at: new Date(),
        error_classification: "DOWNSTREAM_AUTH_OR_QUOTA", error_code: "dispatch_reselected_before_upstream",
        switch_reason: dispatchBlock.reasonCode },
      quotaSettlements: grantId ? [{ grant_id: grantId, reserved_estimate: reservedEstimate, actual_deducted: 0n }] : [],
      releaseLeaseIds: leaseId ? [leaseId] : [],
    });
    if (probeLease) await runBestEffort(request.log, "release reselected probe", () =>
      deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt));
    state.triedResourceIds.add(candidate.resourceId);
    state.dispatchRecheckTarget = dispatchBlock.switchTargetResourceId;
    state.dispatchSatisfiedSwitch = { policyId: dispatchBlock.matchedPolicy!.id,
      policyVersion: dispatchBlock.matchedPolicy!.policyVersion, targetId: dispatchBlock.switchTargetResourceId };
    return { kind: "STOP", result: "CONTINUE" };
  }
  if (dispatchBlock) {
    const statusCode = dispatchBlock.finalAction === "REJECT" ? 403 : 429;
    await finalizeRejectedAttemptBeforeUpstream({ ledgerRepo: deps.ledgerRepo,
      requestId, enterpriseId: principal.enterpriseId, principalId: context.principalId,
      attemptId: attempt.id, attemptNo: state.attemptNo, resourceId: candidate.resourceId, resourceMode: candidate.mode,
      errorCode: "dispatch_changed_before_upstream",
      attemptResult: { http_status: statusCode, response_committed: false, finished_at: new Date(),
        error_classification: "DOWNSTREAM_AUTH_OR_QUOTA", error_code: "dispatch_changed_before_upstream", switch_reason: null },
      quotaSettlements: [...state.pendingQuotaSettlements,
        ...(grantId ? [{ grant_id: grantId, reserved_estimate: reservedEstimate, actual_deducted: 0n }] : [])],
      releaseLeaseIds: [...state.pendingLeaseIds, ...(leaseId ? [leaseId] : [])], overage: state.requestOverage,
    });
    if (probeLease) await runBestEffort(request.log, "release dispatch rejected probe", () =>
      deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt));
    reply.code(statusCode).header("x-request-id", traceId).send({ error: {
      message: "当前时段调度策略禁止此调用，请稍后重试", type: "rate_limit_error",
      code: "dispatch_changed_before_upstream", retryable: true, request_id: requestId,
    } });
    return { kind: "STOP", result: "RETURNED" };
  }
  return {
    kind: "READY",
    value: {
      candidate,
      probeLease,
      resourceConfig,
      invocationAuthorization,
      attempt,
      leaseId,
      grantId,
      reservedEstimate,
      reservedProjectedRemaining,
    },
  };
}

async function freezeRouteCandidates(
  context: PipelineContext,
  state: PipelineExecutionState,
): Promise<void> {
  for (const scored of state.lastScored) {
    if (state.triedResourceIds.has(scored.input.resourceId) && !scored.selected) continue;
    await context.deps.ledgerRepo.createRouteCandidate({
      ai_request_id: context.requestId,
      enterprise_id: context.principal.enterpriseId,
      provider_resource_id: scored.input.resourceId,
      upstream_model: scored.input.upstreamModel,
      priority: scored.input.priority,
      weight: scored.input.weight,
      selected: scored.selected,
      score_factors: {
        factors: scored.factors,
        policy_version: ROUTING_POLICY.version,
        affinity_resource_id: context.affinityResourceId,
      },
      total_score: scored.totalScore.toFixed(6),
      reason_code: scored.reasonCode,
    });
  }
}

async function reserveCodingPlanQuota(
  context: PipelineContext,
  state: PipelineExecutionState,
  probeLease: PreparedAttempt["probeLease"],
): Promise<QuotaReservationResult> {
  const { deps, principal, body } = context;
  const candidate = state.winner!.input;
  const leaseId = await acquireConcurrencyLeaseWithWait({
    quotaRepo: deps.quotaRepo,
    enterpriseId: principal.enterpriseId,
    providerResourceId: candidate.resourceId,
    aiRequestId: context.requestId,
    waitMs: context.capacityWaitMs,
    pollMs: context.capacityPollMs,
    cancelled: () => context.downstreamAbort.signal.aborted,
  });
  if (leaseId === null) {
    state.capacityWaitTimedOut = true;
    state.capacityRetryAfterMs = context.capacityPollMs;
    state.triedResourceIds.add(candidate.resourceId);
    if (probeLease) await deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt);
    return { kind: "STOP", result: "CONTINUE" };
  }
  const reserve = await deps.quotaRepo.reserveQuota({
    enterpriseId: principal.enterpriseId,
    principalId: context.principalId,
    provider: candidate.providerCode,
    modelAlias: body.model,
    estimatedCost: estimateRawTokens(context.effectiveBody),
  });
  if (reserve.decision !== QUOTA_DECISION.ALLOW && reserve.decision !== QUOTA_DECISION.ALLOW_OVERAGE) {
    if (reserve.decision === QUOTA_DECISION.REJECT_EXHAUSTED) {
      state.quotaExhaustedDuringDispatch = true;
      state.quotaExhaustedProviderCode = candidate.providerCode;
      state.quotaExhaustedResetAt = await latestProviderQuotaResetAt(
        deps.db, principal.enterpriseId, candidate.resourceId, new Date(context.requestStartedAt),
      );
    }
    await deps.quotaRepo.releaseLease(leaseId);
    if (probeLease) await deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt);
    state.triedResourceIds.add(candidate.resourceId);
    return {
      kind: "STOP",
      result: reserve.decision === QUOTA_DECISION.REJECT_EXHAUSTED ? "BREAK" : "CONTINUE",
    };
  }
  return {
    kind: "READY_QUOTA",
    leaseId,
    grantId: reserve.grantId,
    reservedEstimate: reserve.reservedEstimate,
    reservedProjectedRemaining: reserve.gate.projectedRemaining,
  };
}

async function releaseAttemptReservations(
  context: PipelineContext,
  resourceId: string,
  probeLease: PreparedAttempt["probeLease"],
  grantId: string | null,
  reservedEstimate: bigint,
  leaseId: string | null,
): Promise<void> {
  if (grantId) await context.deps.quotaRepo.releaseQuota(grantId, reservedEstimate);
  if (leaseId) await context.deps.quotaRepo.releaseLease(leaseId);
  if (probeLease) await context.deps.poolRepo.releaseHalfOpenProbe(resourceId, probeLease.acquiredAt);
}
