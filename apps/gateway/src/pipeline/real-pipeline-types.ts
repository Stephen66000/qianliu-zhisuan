import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Outcome, QuotaBlockErrorDetail } from "@qianliu/contracts";
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
  /** provider.adapter_type（Adapter 判定的唯一权威来源；缺省时回退 providerCode） */
  adapterType?: string;
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
  /** P2：capability_set.endpoints 模式专属地址，随 AdapterResource 进入端点策略。 */
  endpoints?: Partial<Record<"API" | "CODING_PLAN", string>>;
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
  /** Coding Plan 并发租约 TTL；生产 runtime 从总调用时限同源派生。 */
  concurrencyLeaseTtlMs?: number;
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
  /**
   * CPQW（F3）：原始有效授权集合存在启用未归档 CP 路由时为 true；
   * 初始候选、SWITCH、重选与 Attempt 前均排除 API（无隐式付费回退）。
   */
  planOnly: boolean;
  maxAttempts: number;
  capacityWaitMs: number;
  capacityPollMs: number;
  halfOpenProbeLeaseMs: number;
  concurrencyLeaseTtlMs: number;
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
  /** CPQW（F4）：Attempt 实际调用时的资源/凭证代次，供耗尽故障条件提交核验。 */
  resourceVersion: number | null;
  credentialVersion: number | null;
}

export type AttemptStepResult = "CONTINUE" | "BREAK" | "RETURNED";

export interface PipelineExecutionState {
  routeEligibleCandidates: RoutingCandidateInput[];
  triedResourceIds: Set<string>;
  lastScored: ScoredCandidate[];
  winner: ScoredCandidate | undefined;
  finalOutcome: Outcome | null;
  finalOutcomeProviderCode: string | null;
  /** CPQW：终态资源模式感知的错误分类（CP 窗口耗尽按 UPSTREAM_BILLING_BLOCKED）。 */
  finalOutcomeClassification: string | null;
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
  /** CPQW：true = 厂商窗口 block 门禁（UPSTREAM_BILLING_BLOCKED）；false = 主体额度（DOWNSTREAM_AUTH_OR_QUOTA）。 */
  quotaBlockAdmissionRejection: boolean;
  quotaExhaustedProviderCode: string | null;
  quotaExhaustedResetAt: string | null;
  /** CPQW：窗口额度耗尽呈现（首次失败/准入拒绝/重复请求共用，计划§2/§3）。 */
  quotaWindowPresentation: (QuotaBlockErrorDetail & {
    message: string;
    retryAfterSeconds: number | null;
    errorCode: "upstream_window_exhausted" | "upstream_quota_exhausted";
  }) | null;
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
    finalOutcomeClassification: null,
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
    quotaBlockAdmissionRejection: false,
    quotaExhaustedProviderCode: null,
    quotaExhaustedResetAt: null,
    quotaWindowPresentation: null,
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
