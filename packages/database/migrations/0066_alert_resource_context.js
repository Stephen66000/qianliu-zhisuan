/**
 * 为已有请求级异常补齐厂商资源上下文，使历史异常可以按厂商查询。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    UPDATE alert_event AS alert
       SET resource_id = COALESCE(
         (
           SELECT decision.switch_target_resource_id
             FROM dispatch_decision AS decision
           WHERE decision.enterprise_id = alert.enterprise_id
              AND decision.ai_request_id = alert.ai_request_id
              AND alert.signal = 'dispatch_anomaly'
              AND decision.switch_target_resource_id IS NOT NULL
            ORDER BY decision.decided_at DESC
            LIMIT 1
         ),
         (
           SELECT attempt.provider_resource_id
             FROM upstream_attempt AS attempt
            WHERE attempt.enterprise_id = alert.enterprise_id
              AND attempt.ai_request_id = alert.ai_request_id
            ORDER BY attempt.attempt_no DESC
            LIMIT 1
         )
       )
     WHERE alert.resource_id IS NULL
       AND alert.ai_request_id IS NOT NULL
  `.execute(db);
}

/** @param {import('kysely').Kysely} _db */
export async function down(_db) {
  // 数据补全不回退；清空会重新制造已修复的历史筛选缺口。
}
