import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { AlertDomain, AlertEvent, DerivedAlert } from "./alert-event-types.js";

export async function deriveRoutingAlerts(db: Kysely<Database>, enterpriseId: string): Promise<DerivedAlert[]> {
  const rows = await db.selectFrom("ai_request")
    .select(["id", "principal_id", "error_classification", "error_code"])
    .where("enterprise_id", "=", enterpriseId).where("status", "=", "FAILED")
    .where("error_classification", "in", ["NO_AVAILABLE_RESOURCE", "ROUTING_FAILED", "CIRCUIT_OPEN"])
    .execute();
  return rows.map((row) => ({
    alertKey: `RESOURCE_UNAVAILABLE:routing:${row.id}`,
    domain: "RESOURCE_UNAVAILABLE",
    signal: "routing_anomaly",
    severity: "HIGH",
    title: "路由无可用候选",
    detail: `${row.error_classification ?? "ROUTING_FAILED"}${row.error_code ? `（${row.error_code}）` : ""}`,
    resourceId: null,
    principalId: row.principal_id,
    aiRequestId: row.id,
  }));
}

export async function deriveStreamingAlerts(db: Kysely<Database>, enterpriseId: string): Promise<DerivedAlert[]> {
  const rows = await db.selectFrom("ai_request")
    .select(["id", "principal_id", "error_classification", "error_code"])
    .where("enterprise_id", "=", enterpriseId).where("stream", "=", true)
    .where("status", "=", "FAILED")
    .where("error_classification", "in", [
      "STREAM_INTERRUPTED", "STREAM_END_MISSING", "CLIENT_CANCEL_NOT_PROPAGATED",
    ]).execute();
  return rows.map((row) => ({
    alertKey: `RESOURCE_UNAVAILABLE:streaming:${row.id}`,
    domain: "RESOURCE_UNAVAILABLE",
    signal: "streaming_anomaly",
    severity: "HIGH",
    title: "流式响应异常",
    detail: `${row.error_classification ?? "STREAM_INTERRUPTED"}${row.error_code ? `（${row.error_code}）` : ""}`,
    resourceId: null,
    principalId: row.principal_id,
    aiRequestId: row.id,
  }));
}

export async function deriveDispatchAlerts(db: Kysely<Database>, enterpriseId: string): Promise<DerivedAlert[]> {
  const rows = await db.selectFrom("dispatch_decision")
    .select(["id", "ai_request_id", "matched_policy_action", "final_action", "saving_calculable", "not_calculable_reason"])
    .where("enterprise_id", "=", enterpriseId).where("matched_policy_id", "is not", null).execute();
  return rows.filter((row) =>
    (row.matched_policy_action !== null && row.matched_policy_action !== row.final_action)
      || (!row.saving_calculable && row.not_calculable_reason === "unexplained_baseline"))
    .map((row) => ({
      alertKey: `RESOURCE_UNAVAILABLE:dispatch:${row.id}`,
      domain: "RESOURCE_UNAVAILABLE" as const,
      signal: "dispatch_anomaly",
      severity: "MEDIUM" as const,
      title: "调度执行异常",
      detail: row.matched_policy_action !== row.final_action
        ? `策略动作 ${row.matched_policy_action ?? "未知"}，实际动作 ${row.final_action}`
        : `节省基线不可解释：${row.not_calculable_reason ?? "未知"}`,
      resourceId: null,
      principalId: null,
      aiRequestId: row.ai_request_id,
    }));
}

export function toAlertEvent(row: {
  id: string; alert_key: string; domain: string; signal: string; severity: string;
  title: string; detail: string | null; resource_id: string | null; principal_id: string | null;
  ai_request_id: string | null; status: string; first_seen_at: Date; last_seen_at: Date;
  resolved_at: Date | null; resolution_note: string | null;
}): AlertEvent {
  return {
    id: row.id, alertKey: row.alert_key, domain: row.domain as AlertDomain,
    signal: row.signal, severity: row.severity as AlertEvent["severity"], title: row.title,
    detail: row.detail, resourceId: row.resource_id, principalId: row.principal_id,
    aiRequestId: row.ai_request_id, status: row.status as AlertEvent["status"],
    firstSeenAt: row.first_seen_at.toISOString(), lastSeenAt: row.last_seen_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    resolutionNote: row.resolution_note,
  };
}
