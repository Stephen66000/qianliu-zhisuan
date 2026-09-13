import type { Generated } from "kysely";

/** RA-W01：自然人主数据；当前单工作空间，不新增 enterprise_id。 */
export interface PersonTable {
  id: Generated<string>;
  name: string;
  department_label: string | null;
  status: Generated<"ACTIVE" | "DISABLED">;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：人员外部身份；第一版 provider 仅 WECOM，保存内部成员 userid。 */
export interface PersonExternalIdentityTable {
  id: Generated<string>;
  person_id: string;
  provider: "WECOM";
  provider_user_id: string;
  status: Generated<"ACTIVE" | "DISABLED">;
  verified_at: Date | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：可用性规则稳定身份。 */
export interface AvailabilityRuleTable {
  id: Generated<string>;
  name: string;
  rule_type: "UPSTREAM_SIGNAL" | "SCHEDULE_BLOCK" | "OBSERVATION_ALERT";
  description: string | null;
  status: Generated<"ACTIVE" | "ARCHIVED">;
  version: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：规则不可变业务版本；version 是编辑并发锁，rule_version 是业务版本号。 */
export interface AvailabilityRuleVersionTable {
  id: Generated<string>;
  availability_rule_id: string;
  rule_version: number;
  status: Generated<"DRAFT" | "PUBLISHED" | "SUPERSEDED" | "DISABLED">;
  provider_id: string | null;
  provider_resource_id: string | null;
  unified_model_id: string | null;
  upstream_model: string | null;
  unified_signal: string | null;
  action: "WARN_ONLY" | "BLOCK";
  recovery_method: string | null;
  fallback_duration_seconds: number | null;
  schedule_timezone: string | null;
  schedule_days_of_week: number[] | null;
  schedule_start_time: string | null;
  schedule_end_time: string | null;
  priority: Generated<number>;
  effective_from: Date | null;
  effective_to: Date | null;
  version: Generated<number>;
  created_by: string | null;
  published_by: string | null;
  published_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：熔断触发、影响与恢复事实；事件冻结规则稳定 ID 和精确版本。 */
export interface AvailabilityEventTable {
  id: Generated<string>;
  event_number: string;
  availability_rule_id: string;
  rule_version_id: string;
  rule_version: number;
  provider_id: string | null;
  provider_resource_id: string | null;
  unified_model_id: string | null;
  upstream_model: string | null;
  unified_signal: string;
  upstream_code: string | null;
  sanitized_summary: string | null;
  availability_decision: "BLOCKED_UPSTREAM" | "BLOCKED_SCHEDULE";
  trigger_ai_request_id: string | null;
  trigger_principal_id: string | null;
  recovery_method: string;
  dedup_key: string;
  status: Generated<"OPEN" | "RECOVERED" | "MANUALLY_RECOVERED" | "CANCELLED">;
  started_at: Generated<Date>;
  recover_at: Date | null;
  recovered_at: Date | null;
  recovery_reason: string | null;
  affected_request_count: Generated<number>;
  affected_person_count: Generated<number>;
  notification_summary: Record<string, unknown> | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：唯一有效企业微信自建应用配置；Secret 只保存密文和指纹。 */
export interface NotificationEndpointTable {
  id: Generated<string>;
  provider: "WECOM_APP";
  corp_id: string;
  agent_id: string;
  secret_ciphertext: string;
  secret_fingerprint: string;
  status: Generated<"ACTIVE" | "DISABLED">;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/** RA-W01：成员应用消息 Outbox／送达事实，不保存自由消息正文。 */
export interface NotificationDeliveryTable {
  id: Generated<string>;
  availability_event_id: string | null;
  notification_endpoint_id: string;
  recipient_person_id: string;
  recipient_identity_id: string | null;
  delivery_type: "TRIGGER" | "RECOVERY" | "TEST";
  idempotency_key: string;
  payload_version: Generated<string>;
  status: Generated<
    | "PENDING"
    | "IN_PROGRESS"
    | "SENT"
    | "RETRYABLE_FAILED"
    | "PERMANENT_FAILED"
    | "SKIPPED"
  >;
  attempt_count: Generated<number>;
  next_attempt_at: Date | null;
  sent_at: Date | null;
  provider_message_id: string | null;
  provider_error_code: string | null;
  last_error_classification: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export type NotificationCategory =
  | "SYSTEM_FAILURE"
  | "UPSTREAM_RESOURCE"
  | "FINANCE_SECURITY"
  | "PERSONNEL_ACCOUNT";

export interface RuntimeNotificationRecipientTable {
  id: Generated<string>;
  category: NotificationCategory;
  person_id: string;
  created_at: Generated<Date>;
}
