import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";

export const EXCLUDED_ALERT_SIGNALS = [
  "principal_usage_anomaly",
  "supply_anomaly",
  "department_budget_warning",
];

/** Absence from a derivation is never proof. Requests are immutable historical failures. */
export async function verifyAlertRecoveries(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<void> {
  await verifyBackgroundRecoveries(db, enterpriseId);
  await verifyRequestRecoveries(db, enterpriseId);
  await sql`
    UPDATE alert_event alert SET
      recovery_evidence=jsonb_build_object('kind','RECONCILIATION_RESOLVED','summary','对应账本差异已完成处理','verifiedAt',discrepancy.resolved_at,'referenceId',discrepancy.id),
      source_cleared_at=discrepancy.resolved_at,
      status=CASE WHEN alert.status IN ('OPEN','INVESTIGATING') THEN 'AUTO_RESOLVED' ELSE alert.status END,
      resolved_at=CASE WHEN alert.status IN ('OPEN','INVESTIGATING','AUTO_RESOLVED') THEN discrepancy.resolved_at ELSE alert.resolved_at END
    FROM reconciliation_discrepancy discrepancy
    WHERE alert.enterprise_id=${enterpriseId}::uuid AND discrepancy.enterprise_id=alert.enterprise_id
      AND alert.alert_key='QUOTA_ANOMALY:reconciliation:' || discrepancy.id::text
      AND discrepancy.status='RESOLVED' AND discrepancy.resolved_at IS NOT NULL
      AND alert.recovery_evidence IS NULL
  `.execute(db);
}

/** Before merging a new failure, preserve an intervening success even if nobody opened the page.
 * The current resource may already be unhealthy again; the bounded historical proof does not
 * claim it is healthy now. Normal page evaluation retains all current-health checks.
 */
export async function verifyRequestRecoveries(
  db: Kysely<Database>,
  enterpriseId: string,
  nextFailure?: { alertKey: string; observedAt: Date },
): Promise<void> {
  await sql`
    WITH evidence AS (
      SELECT alert.id, alert.last_seen_at AS observed_at, success.id AS success_id, success.finished_at AS verified_at
      FROM alert_event alert
      JOIN provider_resource resource ON resource.id=alert.resource_id AND resource.enterprise_id=alert.enterprise_id
      LEFT JOIN ai_request trigger_request ON trigger_request.id=alert.ai_request_id AND trigger_request.enterprise_id=alert.enterprise_id
      JOIN LATERAL (
        SELECT attempt.id, attempt.finished_at FROM upstream_attempt attempt
        JOIN ai_request request ON request.id=attempt.ai_request_id AND request.enterprise_id=attempt.enterprise_id
        WHERE attempt.enterprise_id=alert.enterprise_id AND attempt.provider_resource_id=alert.resource_id
          AND request.status='SUCCEEDED' AND request.error_code IS NULL AND attempt.http_status BETWEEN 200 AND 299
          AND attempt.error_code IS NULL AND attempt.finished_at > alert.last_seen_at
          AND attempt.finished_at > COALESCE(trigger_request.finished_at,alert.last_seen_at)
          AND attempt.finished_at <= CURRENT_TIMESTAMP
          AND (${nextFailure?.observedAt ?? null}::timestamptz IS NULL OR attempt.finished_at < ${nextFailure?.observedAt ?? null}::timestamptz)
          AND (alert.signal IN ('resource_unavailable','credential_security_anomaly')
            OR (trigger_request.unified_model_id IS NOT NULL AND request.unified_model_id=trigger_request.unified_model_id)
            OR (trigger_request.id IS NOT NULL AND trigger_request.unified_model_id IS NULL AND attempt.upstream_model=(
              SELECT failed.upstream_model FROM upstream_attempt failed
              WHERE failed.enterprise_id=alert.enterprise_id AND failed.ai_request_id=trigger_request.id AND failed.provider_resource_id=alert.resource_id
              ORDER BY failed.attempt_no DESC LIMIT 1)))
        ORDER BY attempt.finished_at ${nextFailure ? sql`ASC` : sql`DESC`}, attempt.id DESC LIMIT 1
      ) success ON true
      WHERE alert.enterprise_id=${enterpriseId}::uuid AND alert.recovery_evidence IS NULL
        AND (${nextFailure?.alertKey ?? null}::text IS NULL OR alert.alert_key=${nextFailure?.alertKey ?? null}::text)
        AND (alert.signal IN ('resource_unavailable','credential_security_anomaly') OR alert.alert_key LIKE 'RUNTIME_ASSURANCE:%:%:%'
          OR alert.alert_key LIKE 'AVAILABILITY:%')
        AND (${nextFailure !== undefined} OR (resource.status='ACTIVE' AND resource.consecutive_failures=0 AND resource.credential_refresh_status<>'FAILED'
        AND NOT EXISTS(SELECT 1 FROM availability_event block WHERE block.provider_resource_id=resource.id AND block.status='OPEN')))
    ) UPDATE alert_event alert SET
      recovery_evidence=jsonb_build_object('kind','SUCCESSFUL_REQUEST','summary',${nextFailure ? "同一资源同一模型在再次故障前调用成功" : "同一资源后续调用成功，资源状态正常"}::text,'verifiedAt',evidence.verified_at,'referenceId',evidence.success_id),
      source_cleared_at=evidence.verified_at,
      status=CASE WHEN alert.status IN ('OPEN','INVESTIGATING') THEN 'AUTO_RESOLVED' ELSE alert.status END,
      resolved_at=CASE WHEN alert.status IN ('OPEN','INVESTIGATING','AUTO_RESOLVED') THEN evidence.verified_at ELSE alert.resolved_at END
    FROM evidence WHERE alert.id=evidence.id AND alert.last_seen_at=evidence.observed_at AND alert.recovery_evidence IS NULL
  `.execute(db);
}

async function verifyBackgroundRecoveries(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<void> {
  await sql`
    WITH successes AS (
      SELECT 'TASK:quota_sync:' || provider_resource_id::text AS key, MIN(collected_at) AS at
      FROM provider_quota_window WHERE enterprise_id=${enterpriseId}::uuid AND is_current
      GROUP BY provider_resource_id HAVING bool_and(sync_status IN ('SUCCESS','UNSUPPORTED')) AND bool_or(sync_status='SUCCESS')
    ) UPDATE alert_event alert SET
      recovery_evidence=jsonb_build_object('kind','TASK_SUCCEEDED','summary','对应资源后续同步已成功','verifiedAt',successes.at,'referenceId',successes.key),
      source_cleared_at=successes.at,
      status=CASE WHEN alert.status IN ('OPEN','INVESTIGATING') THEN 'AUTO_RESOLVED' ELSE alert.status END,
      resolved_at=CASE WHEN alert.status IN ('OPEN','INVESTIGATING','AUTO_RESOLVED') THEN successes.at ELSE alert.resolved_at END
    FROM successes WHERE alert.enterprise_id=${enterpriseId}::uuid AND alert.alert_key=successes.key
      AND successes.at> alert.last_seen_at AND alert.recovery_evidence IS NULL
  `.execute(db);
  // Each persisted failed attempt remains a historical occurrence, even when a later
  // success and another failure both happened before the first page visit.
  await sql`
    WITH evidence AS (
      SELECT alert.id, success.id AS reference_id, success.completed_at AS at
      FROM alert_event alert
      LEFT JOIN provider_resource_operating_sync_attempt failed
        ON alert.alert_key='TASK:operating_sync:' || failed.provider_resource_id::text || ':' || failed.id::text
        AND failed.enterprise_id=alert.enterprise_id AND failed.provider_resource_id=alert.resource_id
      JOIN LATERAL (
        SELECT attempt.id, attempt.completed_at FROM provider_resource_operating_sync_attempt attempt
        WHERE attempt.enterprise_id=alert.enterprise_id AND attempt.provider_resource_id=alert.resource_id
          AND attempt.balance_status='SUCCESS' AND attempt.cost_status<>'FAILED'
          AND attempt.started_at > alert.last_seen_at AND attempt.completed_at > alert.last_seen_at
          AND (failed.id IS NULL OR (failed.completed_at IS NOT NULL AND attempt.started_at > failed.completed_at))
          AND attempt.completed_at <= CURRENT_TIMESTAMP
        ORDER BY attempt.completed_at, attempt.id LIMIT 1
      ) success ON true
      WHERE alert.enterprise_id=${enterpriseId}::uuid AND alert.signal='operating_sync_failure' AND alert.recovery_evidence IS NULL
    ) UPDATE alert_event alert SET
      recovery_evidence=jsonb_build_object('kind','TASK_SUCCEEDED','summary','对应资源后续同步已成功','verifiedAt',evidence.at,'referenceId',evidence.reference_id),
      source_cleared_at=evidence.at,
      status=CASE WHEN alert.status IN ('OPEN','INVESTIGATING') THEN 'AUTO_RESOLVED' ELSE alert.status END,
      resolved_at=CASE WHEN alert.status IN ('OPEN','INVESTIGATING','AUTO_RESOLVED') THEN evidence.at ELSE alert.resolved_at END
    FROM evidence WHERE alert.id=evidence.id AND alert.recovery_evidence IS NULL
  `.execute(db);
}
