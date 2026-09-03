export interface PurchaseFactRow {
  id: string; provider_resource_id: string; purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
  amount: string; currency: string; purchased_at: Date; service_period_start: string | null;
  service_period_end: string | null; source: string;
}

export interface ResourceConfirmationRow {
  provider_resource_id: string; status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
  fact_fingerprint: string; note: string | null; confirmed_at: Date;
  confirmed_by_name: string; version: number;
}

export interface LedgerSourceRow {
  id: string; billing_rule_id: string | null; rule_version: string | null;
  billing_rule_snapshot: Record<string, unknown> | null;
}

export interface UsageFactRow {
  principal_id: string; principal_name: string; principal_type: "EMPLOYEE" | "PROJECT";
  provider_resource_id: string; provider_name: string; resource_mode: "API" | "CODING_PLAN";
  input_tokens: string; output_tokens: string; cache_tokens: string; reasoning_tokens: string;
  deducted_quota: string; api_cost: string | null; active_days: string; request_count: string;
  ledger_line_count: string;
}

export interface SubjectStatsRow {
  principal_id: string; active_days: string; request_count: string;
}
