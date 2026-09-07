import type { Generated } from "kysely";

export type ProviderFinanceEventType =
  | "API_OPENING_BALANCE"
  | "API_OPENING_BALANCE_CORRECTION"
  | "API_RECHARGE"
  | "API_BALANCE_RECONCILIATION"
  | "API_LEGACY_COST_ADJUSTMENT"
  | "CODING_PLAN_PURCHASE"
  | "CODING_PLAN_RENEWAL"
  | "REVERSAL";

export interface ProviderFinanceEventTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  event_type: ProviderFinanceEventType;
  account_amount: string;
  account_currency: "CNY" | "USD";
  cash_paid_cny: string | null;
  occurred_at: Date;
  external_reference: string | null;
  reversal_of_event_id: string | null;
  correction_of_event_id: string | null;
  reconciliation_case_id: string | null;
  legacy_cost_resolution_id: Generated<string | null>;
  description: string | null;
  evidence_ref: string | null;
  source: "ADMIN" | "MIGRATION" | "RECONCILIATION" | "SYSTEM_REVERSAL" | "SYSTEM_RENEWAL";
  idempotency_key: string;
  created_by_admin_user_id: string | null;
  created_at: Generated<Date>;
}

export interface ProviderFinanceLegacyCostResolutionTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  account_currency: "CNY" | "USD";
  window_start: Date;
  window_end_inclusive: Date;
  provider_balance_snapshot_id: string;
  provider_confirmed_balance: string;
  local_balance_before_adjustment: string;
  known_api_cost: string;
  missing_api_cost: string;
  unknown_line_count: bigint;
  status: Generated<"OPEN" | "RESOLVED">;
  adjustment_event_id: string | null;
  evidence_ref: string;
  created_by_admin_user_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  resolved_at: Date | null;
}

export interface ProviderSubscriptionPeriodTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  finance_event_id: string | null;
  product_name: string;
  period_start: Date;
  period_end_exclusive: Date;
  source: "PURCHASE" | "RENEWAL" | "MIGRATED_CARRYOVER" | "MIGRATED_PURCHASE";
  migration_source_record_id: string | null;
  reversed_by_event_id: string | null;
  created_by_admin_user_id: string | null;
  created_at: Generated<Date>;
}

export interface ProviderFinanceReconciliationCaseTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  account_currency: "CNY" | "USD";
  local_balance: string;
  provider_confirmed_balance: string;
  difference_amount: string;
  balance_as_of: Date;
  fact_watermark: Record<string, unknown>;
  status: Generated<"OPEN" | "REJECTED" | "RESOLVED">;
  decision: "CONFIRMED" | "REJECTED" | null;
  evidence_ref: string;
  opened_by_admin_user_id: string | null;
  decided_by_admin_user_id: string | null;
  adjustment_event_id: string | null;
  decision_note: string | null;
  decision_idempotency_key: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  decided_at: Date | null;
  resolved_at: Date | null;
}

export interface ProviderFinanceIdempotencyTable {
  enterprise_id: string;
  provider_resource_id: string;
  idempotency_key: string;
  request_hash: string;
  response_snapshot: Record<string, unknown>;
  created_at: Generated<Date>;
}

export interface ProviderFinanceDuplicateCandidateTable {
  id: Generated<string>;
  enterprise_id: string;
  provider_resource_id: string;
  event_type: ProviderFinanceEventType;
  request_hash: string;
  request_payload: Record<string, unknown>;
  confirmation_token_hash: string;
  status: Generated<"PENDING" | "CONSUMED" | "EXPIRED">;
  expires_at: Date;
  created_by_admin_user_id: string;
  consumed_event_id: string | null;
  created_at: Generated<Date>;
  consumed_at: Date | null;
}
