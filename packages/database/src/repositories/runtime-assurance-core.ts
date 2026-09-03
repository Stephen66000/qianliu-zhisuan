import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import type {
  AvailabilityRuleSnapshot,
  AvailabilityRuleType,
  UnifiedAvailabilitySignal,
} from "@qianliu/domain";
import type {
  AvailabilityEventTable,
  AvailabilityRuleTable,
  AvailabilityRuleVersionTable,
  Database,
  NotificationDeliveryTable,
  NotificationEndpointTable,
  DirectoryPersonExternalIdentityTable,
  DirectoryPersonTable,
} from "../kysely.js";

export type Person = Selectable<DirectoryPersonTable>;
export type PersonExternalIdentity = Selectable<DirectoryPersonExternalIdentityTable> & { provider: "WECOM" };
export type AvailabilityRule = Selectable<AvailabilityRuleTable>;
export type AvailabilityRuleVersion = Selectable<AvailabilityRuleVersionTable>;
export type AvailabilityEvent = Selectable<AvailabilityEventTable>;
export type NotificationEndpoint = Selectable<NotificationEndpointTable>;
export type NotificationDelivery = Selectable<NotificationDeliveryTable>;

export class RuntimeAssuranceConflictError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "RuntimeAssuranceConflictError";
  }
}

export interface PersonView extends Person {
  wecom_identity: PersonExternalIdentity | null;
  active_project_count: number;
}

export interface RuleVersionInput {
  provider_id?: string | null;
  provider_resource_id?: string | null;
  unified_model_id?: string | null;
  upstream_model?: string | null;
  unified_signal?: UnifiedAvailabilitySignal | null;
  action: "WARN_ONLY" | "BLOCK";
  recovery_method?: string | null;
  fallback_duration_seconds?: number | null;
  schedule_timezone?: string | null;
  schedule_days_of_week?: number[] | null;
  schedule_start_time?: string | null;
  schedule_end_time?: string | null;
  priority?: number;
  effective_from?: Date | null;
  effective_to?: Date | null;
}

export interface RuleView {
  rule: AvailabilityRule;
  current_version: AvailabilityRuleVersion;
  versions?: AvailabilityRuleVersion[];
}

export interface SignalInput {
  enterpriseId: string;
  providerId: string;
  providerResourceId: string;
  unifiedModelId: string | null;
  upstreamModel: string;
  signal: UnifiedAvailabilitySignal;
  upstreamCode?: string | null;
  sanitizedSummary?: string | null;
  upstreamRecoverAt?: Date | null;
  aiRequestId: string;
  principalId: string;
  now?: Date;
  mode: "OFF" | "OBSERVE" | "ENFORCE";
  wecomNotify: boolean;
}

export interface SignalResult {
  decision: "ALLOW" | "WARN_ONLY" | "BLOCKED_UPSTREAM";
  event: AvailabilityEvent | null;
  matchedRule: AvailabilityRuleSnapshot | null;
  recoverAt: Date | null;
}

export interface DeliveryContext {
  delivery: NotificationDelivery;
  endpoint: NotificationEndpoint;
  identity: PersonExternalIdentity | null;
  person: Person;
  principal: Selectable<Database["principal"]> | null;
  event: AvailabilityEvent | null;
}

export interface LegacyUnavailableAssessment {
  resource_id: string;
  resource_name: string;
  latest_reason: string | null;
  latest_error_classification: string | null;
  disposition: "SAFE_DOWNGRADE" | "MANUAL_REVIEW";
}

export function versionSnapshot(
  row: AvailabilityRuleVersion & { rule_type: AvailabilityRuleType },
): AvailabilityRuleSnapshot {
  return {
    id: row.id, ruleId: row.availability_rule_id, ruleVersion: row.rule_version,
    ruleType: row.rule_type, providerId: row.provider_id,
    providerResourceId: row.provider_resource_id, unifiedModelId: row.unified_model_id,
    upstreamModel: row.upstream_model,
    unifiedSignal: row.unified_signal as UnifiedAvailabilitySignal | null,
    action: row.action, recoveryMethod: row.recovery_method as AvailabilityRuleSnapshot["recoveryMethod"],
    fallbackDurationSeconds: row.fallback_duration_seconds, scheduleTimezone: row.schedule_timezone,
    scheduleDaysOfWeek: row.schedule_days_of_week, scheduleStartTime: row.schedule_start_time,
    scheduleEndTime: row.schedule_end_time, priority: row.priority,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to,
  };
}

export function eventNumber(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `BRK-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
