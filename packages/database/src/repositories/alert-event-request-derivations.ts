import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import { isPlannedRequestBlock } from "./alert-event-exclusions.js";
import type {
  AlertDomain,
  AlertEvent,
  DerivedAlert,
} from "./alert-event-types.js";

function latestAttemptResource(
  requestIdColumn: string,
  enterpriseIdColumn: string,
) {
  return sql<string | null>`(
    SELECT attempt.provider_resource_id
      FROM upstream_attempt AS attempt
     WHERE attempt.enterprise_id = ${sql.ref(enterpriseIdColumn)}
       AND attempt.ai_request_id = ${sql.ref(requestIdColumn)}
     ORDER BY attempt.attempt_no DESC
     LIMIT 1
  )`;
}

export async function deriveDispatchAlerts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DerivedAlert[]> {
  const rows = await db
    .selectFrom("dispatch_decision")
    .select([
      "id",
      "ai_request_id",
      "matched_policy_action",
      "final_action",
      "saving_calculable",
      "not_calculable_reason",
      "switch_target_resource_id",
      "decided_at",
      latestAttemptResource(
        "dispatch_decision.ai_request_id",
        "dispatch_decision.enterprise_id",
      ).as("latest_resource_id"),
    ])
    .where("enterprise_id", "=", enterpriseId)
    .where("matched_policy_id", "is not", null)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("matched_policy_action", "is not", null),
          eb("matched_policy_action", "!=", eb.ref("final_action")),
        ]),
        eb.and([
          eb("saving_calculable", "=", false),
          eb("not_calculable_reason", "=", "unexplained_baseline"),
        ]),
      ]),
    )
    .execute();
  return rows.map((row) => ({
    alertKey: `RESOURCE_UNAVAILABLE:dispatch:${row.id}`,
    domain: "RESOURCE_UNAVAILABLE" as const,
    signal: "dispatch_anomaly",
    severity: "MEDIUM" as const,
    title: "调度执行异常",
    detail:
      row.matched_policy_action !== row.final_action
        ? `策略动作 ${row.matched_policy_action ?? "未知"}，实际动作 ${row.final_action}`
        : `节省基线不可解释：${row.not_calculable_reason ?? "未知"}`,
    resourceId: row.switch_target_resource_id ?? row.latest_resource_id,
    principalId: null,
    aiRequestId: row.ai_request_id,
    occurredAt: row.decided_at,
    observedAt: row.decided_at,
  }));
}

/** Every recorded final failure, except intentional cancellation and ordinary quota/policy limits. */
export async function deriveFailedRequestAlerts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DerivedAlert[]> {
  const rows = await db
    .selectFrom("ai_request")
    .select([
      "id",
      "principal_id",
      "error_classification",
      "error_code",
      "stream",
      "unified_model",
      "started_at",
      "finished_at",
      latestAttemptResource("ai_request.id", "ai_request.enterprise_id").as(
        "provider_resource_id",
      ),
    ])
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "=", "FAILED")
    .where(
      sql<boolean>`NOT ${isPlannedRequestBlock("ai_request.id", "ai_request.enterprise_id")}`,
    )
    .execute();
  const excluded = new Set([
    "client_cancelled",
    "request_cancelled",
    "dispatch_rejected",
    "dispatch_rate_limited",
    "quota_exceeded",
    "quota_limit_exceeded",
    "principal_quota_exceeded",
    "quota_insufficient",
    "provider_quota_exhausted",
  ]);
  const routing = new Set([
    "NO_AVAILABLE_RESOURCE",
    "NO_HEALTHY_CANDIDATE",
    "ROUTING_FAILED",
    "CIRCUIT_OPEN",
  ]);
  return rows
    .filter((row) => !excluded.has(row.error_code ?? ""))
    .map((row) => {
      const isRouting = routing.has(row.error_classification ?? "");
      const isStreaming =
        row.stream &&
        (row.error_classification?.includes("STREAM") ||
          row.error_classification === "CLIENT_CANCEL_NOT_PROPAGATED");
      const kind = isRouting
        ? "routing"
        : isStreaming
          ? "streaming"
          : "request";
      return {
        alertKey: `RESOURCE_UNAVAILABLE:${kind}:${row.id}`,
        domain: "RESOURCE_UNAVAILABLE",
        signal: isRouting
          ? "routing_anomaly"
          : isStreaming
            ? "streaming_anomaly"
            : "request_failure",
        severity: "HIGH",
        title: isRouting
          ? "路由无可用候选"
          : isStreaming
            ? "流式响应异常"
            : "模型调用失败",
        detail: `模型 ${row.unified_model}；分类 ${row.error_classification ?? "未分类"}；错误码 ${row.error_code ?? "未记录"}`,
        resourceId: row.provider_resource_id,
        principalId: row.principal_id,
        aiRequestId: row.id,
        occurredAt: row.started_at,
        observedAt: row.finished_at ?? row.started_at,
      };
    });
}

export function toAlertEvent(row: {
  recovery_evidence?: Record<string, unknown> | null;
  id: string;
  alert_key: string;
  domain: string;
  signal: string;
  severity: string;
  title: string;
  detail: string | null;
  resource_id: string | null;
  principal_id: string | null;
  ai_request_id: string | null;
  status: string;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
  source_cleared_at: Date | null;
  resolution_note: string | null;
  resolved_by: string | null;
}): AlertEvent {
  return {
    recoveryEvidence: row.recovery_evidence ?? null,
    id: row.id,
    alertKey: row.alert_key,
    domain: row.domain as AlertDomain,
    signal: row.signal,
    severity: row.severity as AlertEvent["severity"],
    title: row.title,
    detail: row.detail,
    resourceId: row.resource_id,
    principalId: row.principal_id,
    aiRequestId: row.ai_request_id,
    status: row.status as AlertEvent["status"],
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    resolutionNote: row.resolution_note,
    sourceClearedAt: row.source_cleared_at
      ? row.source_cleared_at.toISOString()
      : null,
    resolvedBy: row.resolved_by,
  };
}
