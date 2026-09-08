import type {
  RequestShapeSummary,
  UpstreamErrorEvidence,
} from "@qianliu/contracts";

export interface GatewayRequestDetail {
  request: {
    id: string;
    principalId: string;
    protocol: string;
    unifiedModel: string;
    stream: boolean;
    status: string;
    clientId: string | null;
    startedAt: string;
    finishedAt: string | null;
    errorClassification: string | null;
    errorCode: string | null;
  };
  settlement: {
    totalInputTokens: string;
    totalOutputTokens: string;
    totalCacheTokens: string;
    totalReasoningTokens: string;
    totalDeductedQuota: string;
    totalApiCost: string;
    usageQuality: string;
    attemptCount: number;
    status: string;
  } | null;
}

export interface RouteCandidateItem {
  providerResourceId: string;
  upstreamModel: string;
  priority: number;
  weight: number;
  selected: boolean;
  scoreFactors: Record<string, unknown> | null;
  totalScore: string | null;
  reasonCode: string | null;
}

export interface AttemptMetering {
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  deductedQuota: string | null;
  apiCost: string | null;
  usageQuality: string;
  billingRuleId: string | null;
  ruleVersion: string | null;
  multiplier: string | null;
  billingRuleSnapshot: {
    ruleType?: string;
    ruleVersion?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    timezone?: string | null;
    daysOfWeek?: number[] | null;
    startTime?: string | null;
    endTime?: string | null;
    timeWindows?: Array<{
      timezone: string;
      daysOfWeek: number[] | null;
      startTime: string;
      endTime: string;
    }>;
    matchedWindow?: {
      timezone: string;
      daysOfWeek: number[] | null;
      startTime: string;
      endTime: string;
    } | null;
    cacheHitPrice?: string | null;
    cacheMissPrice?: string | null;
    outputPrice?: string | null;
    multiplier?: string | null;
    currency?: string;
    priority?: number;
  } | null;
}

export interface AttemptItem {
  attemptNo: number;
  providerResourceId: string;
  upstreamModel: string;
  startedAt: string;
  firstByteAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  errorClassification: string | null;
  errorCode: string | null;
  failureLayer: string | null;
  upstreamErrorEvidence: UpstreamErrorEvidence | null;
  requestShapeSummary: RequestShapeSummary | null;
  responseCommitted: boolean;
  switchReason: string | null;
  metering: AttemptMetering[];
}

export interface AttemptsResult {
  attempts: AttemptItem[];
  ledgerLines: Array<{
    attemptId: string;
    inputTokens: string;
    outputTokens: string;
    cacheTokens: string;
    reasoningTokens: string;
    deductedQuota: string | null;
    apiCost: string | null;
    usageQuality: string;
    billingRuleId: string | null;
    ruleVersion: string | null;
    multiplier: string | null;
    billingRuleSnapshot: AttemptMetering["billingRuleSnapshot"];
  }>;
}

export interface DispatchDecisionItem {
  dispatchInput: Record<string, unknown> | null;
  finalAction: string;
  reasonCode: string;
  reasonDetail: string | null;
  matchedPolicyId: string | null;
  matchedPolicyVersion: string | null;
  matchedPolicyAction: string | null;
  switchTargetResourceId: string | null;
  counterfactualCost: string | null;
  actualCost: string | null;
  dispatchSaving: string | null;
  savingCalculable: boolean;
  notCalculableReason: string | null;
}

export type AlertDomain =
  | "RESOURCE_UNAVAILABLE"
  | "USAGE_SPIKE"
  | "QUOTA_ANOMALY"
  | "CREDENTIAL_INVALID";

export interface AlertItem {
  id: string;
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string | null;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
  status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED" | "AUTO_RESOLVED";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  sourceClearedAt: string | null;
  resolvedBy: string | null;
}

export interface AlertsResult {
  alerts: AlertItem[];
  history?: AlertItem[];
}

export interface OperationLogItem {
  id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  change_summary: Record<string, unknown> | null;
  result: string;
  failure_reason: string | null;
  created_at: string;
}

export interface OperationLogsResult {
  logs: OperationLogItem[];
}

export type DeploymentStatus =
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "ROLLED_BACK";

export interface DeploymentLogItem {
  id: string;
  deployment_id: string;
  started_at: string;
  finished_at: string | null;
  status: DeploymentStatus;
  from_version: string | null;
  to_version: string | null;
  git_commit: string | null;
  artifact_sha256: string | null;
  migration_from: string | null;
  migration_to: string | null;
  release_id: string | null;
  actor: string;
  summary: string;
  pool_refs: string[];
  backup_ref: string | null;
  rollback_target: string | null;
  health_summary: Record<string, unknown> | null;
  smoke_summary: Record<string, unknown> | null;
  evidence_refs: string[];
  failure_classification: string | null;
}

export interface DeploymentLogEventItem {
  id: string;
  event_key: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  note: string | null;
  payload: Record<string, unknown> | null;
}

export interface DeploymentLogsResult {
  items: DeploymentLogItem[];
  total: number;
}

export interface DeploymentLogDetail {
  deployment: DeploymentLogItem;
  events: DeploymentLogEventItem[];
}
