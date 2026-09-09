import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { DerivedAlert } from "./alert-event-types.js";

const CREDENTIAL_INVALID_STATES = new Set(["CREDENTIAL_INVALID", "EXPIRED"]);

/** 信号 3：调用/扣减异常，以未闭合对账差异为事实源。 */
export async function deriveCallDeductionAlerts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DerivedAlert[]> {
  const rows = await db
    .selectFrom("reconciliation_discrepancy")
    .select([
      "id",
      "discrepancy_type",
      "severity",
      "ai_request_id",
      "created_at",
      sql<string | null>`(
        SELECT attempt.provider_resource_id
          FROM upstream_attempt AS attempt
         WHERE attempt.enterprise_id = reconciliation_discrepancy.enterprise_id
           AND attempt.ai_request_id = reconciliation_discrepancy.ai_request_id
         ORDER BY attempt.attempt_no DESC
         LIMIT 1
      )`.as("provider_resource_id"),
    ])
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "in", ["OPEN", "INVESTIGATING"])
    .execute();
  return rows.map((row) => ({
    alertKey: `QUOTA_ANOMALY:reconciliation:${row.id}`,
    domain: "QUOTA_ANOMALY",
    signal: "call_deduction_anomaly",
    severity: row.severity as DerivedAlert["severity"],
    title: "调用或额度扣减异常",
    detail: `对账差异类型 ${row.discrepancy_type}`,
    resourceId: row.provider_resource_id,
    principalId: null,
    aiRequestId: row.ai_request_id,
    occurredAt: row.created_at,
    observedAt: row.created_at,
  }));
}

/** 信号 4：凭证/安全异常。 */
export async function deriveCredentialAlerts(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DerivedAlert[]> {
  const resources = await db
    .selectFrom("provider_resource")
    .select([
      "id",
      "name",
      "status",
      "credential_refresh_status",
      "refresh_error_classification",
    ])
    .where("enterprise_id", "=", enterpriseId)
    .where("status", "not in", ["DELETED", "DISABLED"])
    .execute();
  const out: DerivedAlert[] = [];
  for (const resource of resources) {
    if (
      CREDENTIAL_INVALID_STATES.has(resource.status) ||
      resource.credential_refresh_status === "FAILED"
    ) {
      out.push({
        alertKey: `CREDENTIAL_INVALID:${resource.status}:${resource.id}`,
        domain: "CREDENTIAL_INVALID",
        signal: "credential_security_anomaly",
        severity: "HIGH",
        title: `凭证失效：${resource.name}`,
        detail: `资源状态 ${resource.status}${resource.refresh_error_classification ? `（${resource.refresh_error_classification}）` : ""}，需重新授权后受控恢复（WT-19）`,
        resourceId: resource.id,
        principalId: null,
        aiRequestId: null,
      });
    }
  }
  return out;
}
