import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Outcome } from "@qianliu/contracts";
import type {
  Database,
  DispatchPolicyRepository,
  GatewayLedgerRepository,
  HalfOpenProbeLease,
  QuotaGateRepository,
  ResourcePoolRepository,
  RuntimeAssuranceRepository,
  SignalResult,
} from "@qianliu/database";
import type { SecretValue, UpstreamCaller } from "@qianliu/provider-adapters";
import type {
  BillingRule,
  DispatchInput,
  DispatchPolicy,
  RoutingCandidateInput,
  ScoredCandidate,
} from "@qianliu/domain";
import type { PrincipalAuthResult } from "../auth/principal-auth.js";
import type {
  GatewayPipelineBody,
  NorthboundCapability,
} from "../routes/chat.js";
import type { GatewayStreamWriter } from "../routes/chat-protocol.js";
import type { TruncationConfig } from "./history-truncation.js";

/** 路由候选（listCandidates 返回；硬过滤 + model_route 配置）。 */
export interface RouteCandidateRow {
  routeId?: string;
  resourceId: string;
  providerCode: string;
  upstreamModel: string;
  priority: number;
  weight: number;
  mode: "API" | "CODING_PLAN";
  status: string;
  probe: boolean;
  principalId: string;
  providerId?: string;
  unifiedModelId?: string;
  secret?: SecretValue;
  concurrencyLimit?: number;
  baseUrl?: string;
}

export interface RealPipelineDeps {
  db: Kysely<Database>;
  ledgerRepo: GatewayLedgerRepository;
  caller: UpstreamCaller;
  poolRepo: ResourcePoolRepository;
  runtimeAssuranceRepo?: RuntimeAssuranceRepository;
  runtimeAssuranceMode?: "OFF" | "OBSERVE" | "ENFORCE";
  runtimeAssuranceWecomNotify?: boolean;
  dispatchRepo?: DispatchPolicyRepository;
  quotaRepo: QuotaGateRepository;
  listCandidates: (enterpriseId: string, unifiedModel: string) => Promise<RouteCandidateRow[]>;
  resolveAffinity?: (principalId: string, unifiedModel: string) => Promise<string | null>;
  resolveDispatchInput?: (
    enterpriseId: string,
    principalId: string,
    unifiedModel: string,
    winnerResourceId: string,
    winnerMode: "API" | "CODING_PLAN",
    now: number,
    upstreamModel?: string,
  ) => Promise<{
    priceMultiplier: string | null;
    remainingQuotaRatio: number | null;
    forecastExhaustRisk: boolean;
  }>;
  now?: () => number;
  maxAttempts?: number;
  capacityWaitMs?: number;
  capacityPollMs?: number;
  halfOpenProbeLeaseMs?: number;
  truncationConfig?: TruncationConfig | null;
}

export interface PipelineContext {
  deps: RealPipelineDeps;
  request: FastifyRequest;
  reply: FastifyReply;
  body: GatewayPipelineBody;
  capability: NorthboundCapability;
  requestId: string;
  traceId: string;
  principal: PrincipalAuthResult;
  principalId: string;
  requestStartedAt: number;
  created: number;
  streamWriter: GatewayStreamWriter | null;
  downstreamAbort: AbortController;
  effectiveBody: GatewayPipelineBody;
  eligible: RoutingCandidateInput[];
  candidateByInvocationKey: Map<string, RouteCandidateRow>;
  affinityResourceId: string | null;
  maxAttempts: number;
  capacityWaitMs: number;
  capacityPollMs: number;
  halfOpenProbeLeaseMs: number;
}

export interface QuotaSettlement {
  grant_id: string;
  reserved_estimate: bigint;
  actual_deducted: bigint;
}

export interface DeferredResourceEffect {
  outcome: Outcome;
  classification: string | null;
  resource: RouteCandidateRow;
  probeLease: HalfOpenProbeLease | null;
}

export type AttemptStepResult = "CONTINUE" | "BREAK" | "RETURNED";

export interface PipelineExecutionState {
  routeEligibleCandidates: RoutingCandidateInput[];
  triedResourceIds: Set<string>;
  lastScored: ScoredCandidate[];
  winner: ScoredCandidate | undefined;
  finalOutcome: Outcome | null;
  finalOutcomeProviderCode: string | null;
  finalSignalResult: SignalResult | null;
  attemptNo: number;
  dispatchFinalAction: "ALLOW" | "SWITCH" | "RATE_LIMIT" | "REJECT" | "ALLOW_OVERAGE" | null;
  dispatchReasonCode: string;
  dispatchMatchedPolicy: DispatchPolicy | null;
  dispatchSwitchTargetId: string | null;
  dispatchRecheckTarget?: string;
  dispatchSatisfiedSwitch?: { policyId: string; policyVersion: string; targetId: string };
  dispatchBaselineRule?: BillingRule | null;
  dispatchDispatchInput: DispatchInput | null;
  dispatchBaselineCandidate: RoutingCandidateInput | null;
  invokedResourceIds: Set<string>;
  dispatchTerminated: boolean;
  grantRevokedDuringDispatch: boolean;
  capacityWaitTimedOut: boolean;
  capacityRetryAfterMs: number;
  halfOpenProbeBusy: boolean;
  quotaExhaustedDuringDispatch: boolean;
  quotaExhaustedProviderCode: string | null;
  quotaExhaustedResetAt: string | null;
  requestOverage: boolean;
  pendingQuotaSettlements: QuotaSettlement[];
  pendingLeaseIds: string[];
  deferredResourceEffects: DeferredResourceEffect[];
}

export function createExecutionState(context: PipelineContext): PipelineExecutionState {
  return {
    routeEligibleCandidates: context.eligible,
    triedResourceIds: new Set(),
    lastScored: [],
    winner: undefined,
    finalOutcome: null,
    finalOutcomeProviderCode: null,
    finalSignalResult: null,
    attemptNo: 0,
    dispatchFinalAction: null,
    dispatchReasonCode: "",
    dispatchMatchedPolicy: null,
    dispatchSwitchTargetId: null,
    dispatchDispatchInput: null,
    dispatchBaselineCandidate: null,
    invokedResourceIds: new Set(),
    dispatchTerminated: false,
    grantRevokedDuringDispatch: false,
    capacityWaitTimedOut: false,
    capacityRetryAfterMs: context.capacityPollMs,
    halfOpenProbeBusy: false,
    quotaExhaustedDuringDispatch: false,
    quotaExhaustedProviderCode: null,
    quotaExhaustedResetAt: null,
    requestOverage: false,
    pendingQuotaSettlements: [],
    pendingLeaseIds: [],
    deferredResourceEffects: [],
  };
}

export function invocationCandidateKey(
  candidate: Pick<RouteCandidateRow, "resourceId" | "providerCode" | "upstreamModel">,
): string {
  return `${candidate.resourceId}\u0000${candidate.providerCode}\u0000${candidate.upstreamModel}`;
}
