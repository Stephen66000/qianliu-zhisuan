import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { DerivedAlert } from "./alert-event-types.js";

/** Persisted failures only; operating attempts retain their own identity after a later success.
 * Quota windows remain current-state signals; old windows must not become new active faults.
 */
export async function deriveBackgroundFaults(
  db: Kysely<Database>,
  enterpriseId: string,
): Promise<DerivedAlert[]> {
  const rows = await sql<{
    id: string;
    resource_id: string | null;
    principal_id: string | null;
    request_id: string | null;
    signal: string;
    title: string;
    detail: string;
    at: Date;
    occurred_at: Date;
  }>`
    SELECT background.*, COALESCE(request.started_at, background.at) AS occurred_at FROM (
    SELECT 'TASK:quota_sync:' || provider_resource_id::text AS id, provider_resource_id AS resource_id,
      NULL::uuid AS principal_id, NULL::uuid AS request_id, 'quota_sync_failure' AS signal,
      '厂商额度同步失败' AS title, '后台同步未成功；请核对厂商连接和凭证' AS detail, MAX(collected_at) AS at
    FROM provider_quota_window WHERE enterprise_id=${enterpriseId}::uuid AND is_current
      AND (sync_status='FAILED' OR (sync_status='STALE' AND sync_error_code IS NOT NULL))
    GROUP BY provider_resource_id
    UNION ALL
    SELECT 'TASK:operating_sync:' || provider_resource_id::text || ':' || id::text, provider_resource_id, NULL::uuid, NULL::uuid,
      'operating_sync_failure','厂商经营数据同步失败','请检查厂商同步连接和凭证',started_at
    FROM provider_resource_operating_sync_attempt
    WHERE enterprise_id=${enterpriseId}::uuid AND (balance_status='FAILED' OR cost_status='FAILED')
    UNION ALL
    SELECT 'TASK:directory:' || id::text,NULL::uuid,NULL::uuid,NULL::uuid,'directory_task_failure',
      '通讯录后台任务失败','任务处理失败；请查看导入或同步记录',COALESCE(started_at,created_at)
    FROM directory_import_run WHERE enterprise_id=${enterpriseId}::uuid AND (status='FAILED' OR (status='PARTIAL' AND failed_count>0))
    UNION ALL
    SELECT 'AVAILABILITY:' || id::text, provider_resource_id, trigger_principal_id, trigger_ai_request_id,
      'availability_fault','上游服务阻断',COALESCE(sanitized_summary,'上游明确返回不可用'),started_at
    FROM availability_event WHERE availability_decision='BLOCKED_UPSTREAM' AND status='OPEN'
      AND provider_resource_id IN (SELECT id FROM provider_resource WHERE enterprise_id=${enterpriseId}::uuid)
    ) background LEFT JOIN ai_request request ON request.id=background.request_id AND request.enterprise_id=${enterpriseId}::uuid
  `.execute(db);
  return rows.rows.map((row) => ({
    alertKey: row.id,
    domain: "RESOURCE_UNAVAILABLE",
    signal: row.signal,
    severity: "HIGH",
    title: row.title,
    detail: row.detail,
    resourceId: row.resource_id,
    principalId: row.principal_id,
    aiRequestId: row.request_id,
    occurredAt: row.occurred_at,
    observedAt: row.at,
  }));
}
