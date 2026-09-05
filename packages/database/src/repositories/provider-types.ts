import type { EncryptedCredential, DiscoveredProviderModel, ModelDiscoveryResult } from "@qianliu/provider-adapters";

export interface ProviderModelOnboardingResult {
  resourceId: string;
  discoveryId: string;
  models: Array<{
    upstreamModel: string;
    unifiedModelId: string;
    alias: string;
    routeId: string;
    reused: boolean;
    status: "PENDING_CONFIG" | "ACTIVE";
  }>;
}

export class EnterpriseReferenceError extends Error {
  constructor(message: string = "referenced object does not belong to enterprise") {
    super(message);
    this.name = "EnterpriseReferenceError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(message: string = "idempotency key was already used for another request") {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

export class ModelValidationInProgressError extends Error {
  constructor(message: string = "model validation is already in progress") {
    super(message);
    this.name = "ModelValidationInProgressError";
  }
}

export class ModelRouteNotReadyError extends Error {
  constructor(message: string = "model route requires a successful validation before enabling") {
    super(message);
    this.name = "ModelRouteNotReadyError";
  }
}

export interface ModelValidationResult {
  validationId: string;
  status: "SUCCEEDED" | "FAILED";
  requestId: string;
  upstreamModel: string;
  checks: Array<{
    kind: "NON_STREAM" | "STREAM" | "TOOL";
    status: number;
    ok: boolean;
    durationMs: number;
    firstByteMs: number | null;
    usage: { input: number; output: number; cache: number; reasoning: number };
    errorCode: string | null;
  }>;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface CreateProviderInput {
  enterprise_id: string;
  code: string;
  name: string;
  adapter_type: string;
  supported_protocols?: string[] | null;
  capability_set?: Record<string, unknown> | null;
}

export interface CreateProviderResourceInput {
  enterprise_id: string;
  provider_id: string;
  name: string;
  mode: "API" | "CODING_PLAN";
  credential_type: "API_KEY" | "OAUTH" | "SUBSCRIPTION_SESSION";
  credential_encrypted?: EncryptedCredential | null;
  credential_fingerprint?: string | null;
  upstream_models?: string[] | null;
  concurrency_limit?: number | null;
  operating_snapshot?: OperatingSnapshotInput;
}

/** 所有金额/额度均为十进制文本，避免 JS number 精度损失。 */
export interface OperatingSnapshotInput {
  source: "ADMIN" | "PROVIDER_SYNC" | "BILL_RECONCILIATION";
  collected_at: Date;
  currency?: string | null;
  recharge_amount?: string | null;
  current_balance?: string | null;
  granted_balance?: string | null;
  topped_up_balance?: string | null;
  provider_balance_available?: boolean | null;
  balance_source?: "ADMIN" | "PROVIDER_API" | "BILL_RECONCILIATION" | null;
  cost_source?: "ADMIN" | "LOCAL_LEDGER" | "BILL_RECONCILIATION" | "NOT_SUPPORTED" | null;
  cumulative_cost?: string | null;
  current_period_cost?: string | null;
  cost_period_start?: Date | null;
  cost_period_end?: Date | null;
  balance_updated_at?: Date | null;
  package_name?: string | null;
  package_cost?: string | null;
  total_quota?: string | null;
  quota_unit?: string | null;
  used_quota?: string | null;
  remaining_quota?: string | null;
  effective_from?: Date | null;
  effective_until?: Date | null;
  reset_cycle?: string | null;
  reset_anchor_at?: Date | null;
  reset_timezone?: string | null;
  usage_calculation?: "MANUAL_SNAPSHOT" | "SYSTEM_LEDGER";
  next_reset_at?: Date | null;
  subscription_period_id?: string | null;
}

export interface OnboardResourceModelsInput {
  enterpriseId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  providerCode: string;
  resource: CreateProviderResourceInput;
  discovery: ModelDiscoveryResult;
  selectedModels: DiscoveredProviderModel[];
}
