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
