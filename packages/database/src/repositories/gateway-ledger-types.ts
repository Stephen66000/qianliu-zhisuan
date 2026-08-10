import type { Selectable } from "kysely";
import type {
  AiRequestTable,
  LedgerLineTable,
  LedgerTransactionTable,
  RouteCandidateTable,
  UpstreamAttemptTable,
  UsageEventTable,
} from "../kysely.js";

export type AiRequest = Selectable<AiRequestTable>;
export type UpstreamAttempt = Selectable<UpstreamAttemptTable>;
export type UsageEvent = Selectable<UsageEventTable>;
export type LedgerLine = Selectable<LedgerLineTable>;
export type LedgerTransaction = Selectable<LedgerTransactionTable>;
export type RouteCandidate = Selectable<RouteCandidateTable>;

export interface CreateRequestInput {
  id: string;
  enterprise_id: string;
  principal_id: string;
  principal_key_id: string;
  idempotency_key?: string | null;
  client_request_id?: string | null;
  request_fingerprint?: string | null;
  protocol: string;
  unified_model: string;
  /** 调用方必须有意识地传稳定模型 ID；仅无法证明身份的历史/测试数据允许 null。 */
  unified_model_id: string | null;
  stream?: boolean;
  client_id?: string | null;
  agent_family?: string;
  agent_version?: string | null;
  agent_identity_source?: string;
  agent_identity_confidence?: string;
  client_identity_rule_version?: string;
}

export type ClaimRequestResult =
  | { kind: "CREATED"; request: AiRequest }
  | { kind: "REPLAY"; request: AiRequest }
  | { kind: "CONFLICT"; request: AiRequest };

export interface CreateAttemptInput {
  ai_request_id: string;
  enterprise_id: string;
  attempt_no: number;
  provider_resource_id: string;
  upstream_model: string;
}

export interface UsageInput {
  ai_request_id: string;
  enterprise_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_tokens: bigint;
  reasoning_tokens?: bigint;
  usage_quality: string;
  dedup_key: string;
  upstream_usage_id?: string | null;
}

export interface LedgerLineInput {
  ai_request_id: string;
  enterprise_id: string;
  usage_event_id: string;
  upstream_attempt_id: string;
  provider_resource_id: string;
  principal_id: string;
  resource_mode: string;
  raw_input_tokens: bigint;
  raw_output_tokens: bigint;
  raw_cache_tokens: bigint;
  raw_reasoning_tokens?: bigint;
  deducted_quota?: bigint | null;
  api_cost?: string | null;
  usage_quality: string;
  billing_rule_id?: string | null;
  rule_version?: string | null;
  multiplier?: string | null;
  billing_rule_snapshot?: Record<string, unknown> | null;
}

export interface CreateUsageLedgerLineInput {
  usage: UsageInput;
  ledger_line: Omit<LedgerLineInput, "usage_event_id">;
}

export interface UsageLedgerLineResult {
  usage: UsageEvent;
  line: LedgerLine;
  created: boolean;
}

/**
 * 非终态 Attempt 的事实与资源占用结算。
 *
 * 用于“已建 Attempt、但在访问上游前被最终栅栏拒绝后继续 failover”的场景：
 * usage/ledger、额度退回和并发租约释放必须同事务提交，同时 request 保持
 * IN_PROGRESS，供下一个 Attempt 继续执行。
 */
export interface PersistAttemptUsageAccountingInput extends CreateUsageLedgerLineInput {
  attempt_result: {
    http_status: number;
    response_committed: boolean;
    finished_at: Date;
    error_classification: string;
    error_code: string;
    switch_reason: string | null;
  };
  quota_settlements?: Array<{
    grant_id: string;
    reserved_estimate: bigint;
    actual_deducted: bigint;
  }>;
  release_lease_ids?: string[];
}

/** 上游访问前终态拒绝：Attempt、零账本事实与请求终态必须一次提交。 */
export interface FinalizeRejectedAttemptSettlementInput
  extends PersistAttemptUsageAccountingInput {
  error_classification: string;
  error_code: string;
  overage?: boolean;
}

export interface CreateLedgerTransactionInput {
  ai_request_id: string;
  enterprise_id: string;
  principal_id: string;
  total_input_tokens: bigint;
  total_output_tokens: bigint;
  total_cache_tokens: bigint;
  total_reasoning_tokens?: bigint;
  total_deducted_quota: bigint;
  total_api_cost: string;
  /** 请求结算时冻结的超额事实。 */
  overage?: boolean;
  usage_quality: string;
  attempt_count: number;
}

export interface FinalizeLedgerSettlementInput extends CreateLedgerTransactionInput {
  request_status: "SUCCEEDED" | "FAILED";
  error_classification?: string | null;
  error_code?: string | null;
  /** 与请求终态同事务提交，避免额度已预占但账本未终结。 */
  quota_settlements?: Array<{
    grant_id: string;
    reserved_estimate: bigint;
    actual_deducted: bigint;
  }>;
  /** 与请求终态同事务释放的并发租约。 */
  release_lease_ids?: string[];
}
