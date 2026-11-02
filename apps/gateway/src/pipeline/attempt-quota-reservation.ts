import { EmployeeQuotaRepository, type HalfOpenProbeLease } from "@qianliu/database";
import { QUOTA_DECISION, type BillingRule } from "@qianliu/domain";
import {
  getCurrentInvocationAuthorization,
  type CurrentInvocationAuthorization,
} from "../auth/current-model-authorization.js";
import { computeBillingFromRule } from "./billing.js";
import {
  acquireConcurrencyLeaseWithWait,
  estimateRawTokens,
  latestProviderQuotaResetAt,
} from "./runtime-controls.js";
import type {
  AttemptStepResult,
  PipelineContext,
  PipelineExecutionState,
} from "./real-pipeline-types.js";

export interface MonthlyAttemptQuota {
  periodId: string;
  usageId: string;
  billingRule?: BillingRule;
  pricingAt?: number;
}

type QuotaReservationResult =
  | { kind: "STOP"; result: AttemptStepResult }
  | {
      kind: "READY_QUOTA";
      leaseId: string | null;
      monthlyQuota?: MonthlyAttemptQuota;
      grantId: string | null;
      reservedEstimate: bigint;
      reservedProjectedRemaining: bigint;
    };

export async function reserveAttemptQuota(
  context: PipelineContext,
  state: PipelineExecutionState,
  probeLease: HalfOpenProbeLease | null,
): Promise<QuotaReservationResult> {
  const { deps, principal, body } = context;
  const candidate = state.winner!.input;
  const leaseId = candidate.mode === "CODING_PLAN" ? await acquireConcurrencyLeaseWithWait({
    quotaRepo: deps.quotaRepo,
    enterpriseId: principal.enterpriseId,
    providerResourceId: candidate.resourceId,
    aiRequestId: context.requestId,
    waitMs: context.capacityWaitMs,
    pollMs: context.capacityPollMs,
    leaseTtlMs: context.concurrencyLeaseTtlMs,
    cancelled: () => context.downstreamAbort.signal.aborted,
  }) : null;
  if (candidate.mode === "CODING_PLAN" && leaseId === null) {
    state.capacityWaitTimedOut = true;
    state.capacityRetryAfterMs = context.capacityPollMs;
    state.triedResourceIds.add(candidate.resourceId);
    if (probeLease) await deps.poolRepo.releaseHalfOpenProbe(candidate.resourceId, probeLease.acquiredAt);
    return { kind: "STOP", result: "CONTINUE" };
  }
  const now = new Date(deps.now?.() ?? Date.now());
  const auth = await getCurrentInvocationAuthorization(deps.db, {
    enterpriseId: principal.enterpriseId, principalId: context.principalId, keyId: principal.keyId,
    modelAlias: body.model, routeId: candidate.routeId,
    providerCode: candidate.providerCode, resourceId: candidate.resourceId,
    upstreamModel: candidate.upstreamModel, allowHalfOpenProbe: probeLease !== null, now,
  });
  const rawEstimate = estimateRawTokens(context.effectiveBody);
  const estimatedCost = candidate.mode === "API" ? rawEstimate : BigInt(computeBillingFromRule(
    auth?.billingRule ?? null, candidate.mode, now.getTime(),
    { input: Number(rawEstimate), output: 0, cache: 0 },
  ).deductedQuota ?? rawEstimate);
  const monthly = await new EmployeeQuotaRepository(deps.db).reserveEmployeeQuota({
    enterpriseId: principal.enterpriseId, principalId: context.principalId,
    provider: candidate.providerCode, modelAlias: body.model, requestId: context.requestId,
    attemptNo: state.attemptNo, basis: candidate.mode === "API" ? "RAW_TOKEN" : "PLAN_QUOTA",
    estimatedCost, now,
  });
  if (monthly.mode === "LEGACY" && candidate.mode === "API") {
    return { kind: "READY_QUOTA", leaseId: null, grantId: null,
      reservedEstimate: 0n, reservedProjectedRemaining: 0n };
  }
  const reserve = monthly.mode === "MONTHLY" ? monthly : await deps.quotaRepo.reserveQuota({
    enterpriseId: principal.enterpriseId, principalId: context.principalId,
    provider: candidate.providerCode, modelAlias: body.model, estimatedCost: rawEstimate,
  });
  if (reserve.decision !== QUOTA_DECISION.ALLOW && reserve.decision !== QUOTA_DECISION.ALLOW_OVERAGE) {
    if (reserve.decision === QUOTA_DECISION.REJECT_EXHAUSTED) {
      state.quotaExhaustedDuringDispatch = true;
      state.quotaExhaustedProviderCode = candidate.providerCode;
      state.quotaExhaustedResetAt = monthly.periodEnd?.toISOString() ?? await latestProviderQuotaResetAt(
        deps.db, principal.enterpriseId, candidate.resourceId, new Date(context.requestStartedAt),
      );
    }
    if (leaseId) await deps.quotaRepo.releaseLease(leaseId);
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
    ...(monthly.mode === "MONTHLY" && monthly.periodId && monthly.usageId
      ? { monthlyQuota: { periodId: monthly.periodId, usageId: monthly.usageId, ...(auth && candidate.mode === "CODING_PLAN" ? { billingRule: auth.billingRule, pricingAt: auth.pricingAt } : {}) } } : {}),
    grantId: reserve.grantId,
    reservedEstimate: reserve.reservedEstimate,
    reservedProjectedRemaining: reserve.gate.projectedRemaining,
  };
}

export async function releaseAttemptReservations(
  context: PipelineContext,
  resourceId: string,
  probeLease: HalfOpenProbeLease | null,
  grantId: string | null,
  reservedEstimate: bigint,
  leaseId: string | null,
  monthlyQuota?: MonthlyAttemptQuota | undefined,
): Promise<void> {
  if (monthlyQuota) await new EmployeeQuotaRepository(context.deps.db).settleEmployeeQuota({
    enterpriseId: context.principal.enterpriseId, usageId: monthlyQuota.usageId,
    periodId: monthlyQuota.periodId, actual: 0n, release: true,
  });
  else if (grantId) await context.deps.quotaRepo.releaseQuota(grantId, reservedEstimate);
  if (leaseId) await context.deps.quotaRepo.releaseLease(leaseId);
  if (probeLease) await context.deps.poolRepo.releaseHalfOpenProbe(resourceId, probeLease.acquiredAt);
}

export function frozenMonthlyAuthorization(
  authorization: CurrentInvocationAuthorization, monthlyQuota: MonthlyAttemptQuota | undefined,
): CurrentInvocationAuthorization {
  return monthlyQuota?.billingRule ? { ...authorization, billingRule: monthlyQuota.billingRule, pricingAt: monthlyQuota.pricingAt ?? authorization.pricingAt } : authorization;
}
