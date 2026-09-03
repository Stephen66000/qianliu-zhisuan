export interface AccessConfigModel {
  unified_model_id: string;
  display_name: string;
  alias: string;
  provider_resource_id: string;
  resource_name: string;
  resource_mode: "API" | "CODING_PLAN";
  ready: boolean;
  unavailable_reasons: string[];
  enabled: boolean;
}

export interface AccessConfigPool {
  grant_id: string;
  quota_value: string;
  quota_used: string;
  allow_overage: boolean;
  valid_until: string | null;
  source: "MANAGED_SINGLE" | "MANAGED_BATCH" | "MANUAL_PENDING";
  over_limit: boolean;
}

export interface AccessConfigProvider {
  provider_code: string;
  provider_name: string;
  pool: AccessConfigPool | null;
  models: AccessConfigModel[];
}

export interface AccessConfiguration {
  principal: { id: string; name: string; status: string; department_label: string | null };
  key: {
    key_prefix: string;
    status: string;
    created_at: string;
    authorization_status: "PENDING" | "AUTHORIZED";
  } | null;
  providers: AccessConfigProvider[];
  summary: { total_quota: string; provider_count: number; model_count: number };
  manual_pending_takeover: string[];
  config_version: number;
}

export interface AccessConfigPoolInput {
  provider_code: string;
  quota_value: string;
  allow_overage: boolean;
  valid_until: string | null;
  enabled_model_ids: string[];
}

export interface AccessConfigPutBody {
  expected_version: number;
  idempotency_key: string;
  providers: AccessConfigPoolInput[];
}

export interface AccessConfigPutResult {
  config_version: number;
  changes: { pools_added: string[]; pools_updated: string[]; pools_closed: string[] };
  takeover: { cleared_manual: number };
  replayed?: boolean;
}
