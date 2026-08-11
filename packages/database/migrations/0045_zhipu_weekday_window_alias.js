/**
 * POOL-046：修复智谱工作日下午停用策略与计费窗口。
 *
 * POOL-038 将统一模型 alias 从 qianliu-zhipu-glm-5-2 改为 ql-glm-5.2，
 * 但遗漏了 dispatch_policy，导致既有 REJECT 策略无法命中新 alias。
 * 同时，智谱 glm-5.2 的 14:00-18:00 三倍扣减窗口被配置为全周，
 * 实际业务规则仅适用于周一至周五。
 *
 * 本迁移只修正当前配置：
 * - dispatch_policy.match_unified_model 的旧 alias；
 * - 生产现存 zhipu-peak-v2/glm-5.2 与 zhipu-peak-v1/5.2 两条规则中，
 *   Asia/Shanghai、14:00-18:00、multiplier=3 的单窗镜像及
 *   time_windows 对应窗口的 days_of_week。
 *
 * ledger_line 及其 billing_rule_snapshot 是历史结算事实，禁止改写。
 * 迁移只把实际改动行写入专用回滚表，down 精确恢复这些行并删除回滚表，
 * 不反转迁移前已经使用新 alias 或工作日窗口的配置。
 */
import { sql } from "kysely";

const LEGACY_ALIAS = "qianliu-zhipu-glm-5-2";
const CURRENT_ALIAS = "ql-glm-5.2";
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const WEEKDAYS = [1, 2, 3, 4, 5];
const BACKUP_TABLE = "_migration_0045_pool046_backup";

/**
 * @param {import('kysely').Kysely} db
 * @param {number[]} fromDays
 * @param {number[]} toDays
 */
async function migrateZhipuWindowDays(db, fromDays, toDays) {
  const fromDaysJson = JSON.stringify(fromDays);
  const toDaysJson = JSON.stringify(toDays);

  await sql`
    UPDATE billing_rule AS br
       SET days_of_week = CASE
             WHEN br.timezone = 'Asia/Shanghai'
              AND br.days_of_week = ${fromDaysJson}::jsonb
              AND LEFT(br.start_time, 5) = '14:00'
              AND LEFT(br.end_time, 5) = '18:00'
             THEN ${toDaysJson}::jsonb
             ELSE br.days_of_week
           END,
           time_windows = CASE
             WHEN br.time_windows IS NULL THEN NULL
             ELSE (
               SELECT jsonb_agg(
                 CASE
                   WHEN item.value ->> 'timezone' = 'Asia/Shanghai'
                    AND item.value -> 'days_of_week' = ${fromDaysJson}::jsonb
                    AND LEFT(item.value ->> 'start_time', 5) = '14:00'
                    AND LEFT(item.value ->> 'end_time', 5) = '18:00'
                   THEN jsonb_set(
                     item.value,
                     '{days_of_week}',
                     ${toDaysJson}::jsonb,
                     false
                   )
                   ELSE item.value
                 END
                 ORDER BY item.ordinality
               )
                 FROM jsonb_array_elements(br.time_windows)
                      WITH ORDINALITY AS item(value, ordinality)
             )
           END,
           updated_at = NOW()
      FROM provider_resource AS pr
      JOIN provider AS p
        ON p.id = pr.provider_id
       AND p.enterprise_id = pr.enterprise_id
     WHERE br.provider_resource_id = pr.id
       AND br.enterprise_id = pr.enterprise_id
       AND p.code = 'zhipu'
       AND br.rule_type = 'TIME_WINDOW'
       AND br.enabled = TRUE
       AND (
         (br.rule_version = 'zhipu-peak-v2' AND br.upstream_model = 'glm-5.2')
         OR (br.rule_version = 'zhipu-peak-v1' AND br.upstream_model = '5.2')
       )
       AND br.multiplier = 3
       AND EXISTS (
         SELECT 1
           FROM _migration_0045_pool046_backup AS backup
          WHERE backup.row_type = 'billing_rule'
            AND backup.row_id = br.id
       )
       AND (
         (
           br.timezone = 'Asia/Shanghai'
           AND br.days_of_week = ${fromDaysJson}::jsonb
           AND LEFT(br.start_time, 5) = '14:00'
           AND LEFT(br.end_time, 5) = '18:00'
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(br.time_windows, '[]'::jsonb))
                  AS candidate(value)
            WHERE candidate.value ->> 'timezone' = 'Asia/Shanghai'
              AND candidate.value -> 'days_of_week' = ${fromDaysJson}::jsonb
              AND LEFT(candidate.value ->> 'start_time', 5) = '14:00'
              AND LEFT(candidate.value ->> 'end_time', 5) = '18:00'
         )
       )
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migration_0045_pool046_backup (
      row_type VARCHAR(32) NOT NULL,
      row_id UUID NOT NULL,
      original_alias VARCHAR(64),
      original_days_of_week JSONB,
      original_time_windows JSONB,
      original_updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (row_type, row_id)
    )
  `.execute(db);

  await sql`
    INSERT INTO _migration_0045_pool046_backup (
      row_type, row_id, original_alias, original_updated_at
    )
    SELECT 'dispatch_policy', dp.id, dp.match_unified_model, dp.updated_at
      FROM dispatch_policy AS dp
     WHERE dp.policy_version = 'v2'
       AND dp.status = 'PUBLISHED'
       AND dp.match_unified_model = ${LEGACY_ALIAS}
       AND dp.match_timezone = 'Asia/Shanghai'
       AND dp.match_days_of_week = ${JSON.stringify(WEEKDAYS)}::jsonb
       AND LEFT(dp.match_start_time, 5) = '14:00'
       AND LEFT(dp.match_end_time, 5) = '18:00'
       AND dp.action = 'REJECT'
       AND dp.priority = 10
    ON CONFLICT (row_type, row_id) DO NOTHING
  `.execute(db);

  await sql`
    INSERT INTO _migration_0045_pool046_backup (
      row_type, row_id, original_days_of_week, original_time_windows,
      original_updated_at
    )
    SELECT 'billing_rule', br.id, br.days_of_week, br.time_windows, br.updated_at
      FROM billing_rule AS br
      JOIN provider_resource AS pr
        ON pr.id = br.provider_resource_id
       AND pr.enterprise_id = br.enterprise_id
      JOIN provider AS p
        ON p.id = pr.provider_id
       AND p.enterprise_id = pr.enterprise_id
     WHERE p.code = 'zhipu'
       AND br.rule_type = 'TIME_WINDOW'
       AND br.enabled = TRUE
       AND (
         (br.rule_version = 'zhipu-peak-v2' AND br.upstream_model = 'glm-5.2')
         OR (br.rule_version = 'zhipu-peak-v1' AND br.upstream_model = '5.2')
       )
       AND br.multiplier = 3
       AND (
         (
           br.timezone = 'Asia/Shanghai'
           AND br.days_of_week = ${JSON.stringify(ALL_DAYS)}::jsonb
           AND LEFT(br.start_time, 5) = '14:00'
           AND LEFT(br.end_time, 5) = '18:00'
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(br.time_windows, '[]'::jsonb))
                  AS candidate(value)
            WHERE candidate.value ->> 'timezone' = 'Asia/Shanghai'
              AND candidate.value -> 'days_of_week' = ${JSON.stringify(ALL_DAYS)}::jsonb
              AND LEFT(candidate.value ->> 'start_time', 5) = '14:00'
              AND LEFT(candidate.value ->> 'end_time', 5) = '18:00'
         )
       )
    ON CONFLICT (row_type, row_id) DO NOTHING
  `.execute(db);

  await sql`
    UPDATE dispatch_policy AS dp
       SET match_unified_model = ${CURRENT_ALIAS},
           updated_at = NOW()
      FROM _migration_0045_pool046_backup AS backup
     WHERE backup.row_type = 'dispatch_policy'
       AND backup.row_id = dp.id
       AND dp.match_unified_model = ${LEGACY_ALIAS}
  `.execute(db);

  await migrateZhipuWindowDays(db, ALL_DAYS, WEEKDAYS);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const backupExists = await sql`
    SELECT to_regclass(${BACKUP_TABLE}) IS NOT NULL AS exists
  `.execute(db);
  if (!backupExists.rows[0]?.exists) return;

  await sql`
    UPDATE dispatch_policy AS dp
       SET match_unified_model = backup.original_alias,
           updated_at = backup.original_updated_at
      FROM _migration_0045_pool046_backup AS backup
     WHERE backup.row_type = 'dispatch_policy'
       AND backup.row_id = dp.id
       AND dp.match_unified_model = ${CURRENT_ALIAS}
  `.execute(db);

  await sql`
    UPDATE billing_rule AS br
       SET days_of_week = backup.original_days_of_week,
           time_windows = backup.original_time_windows,
           updated_at = backup.original_updated_at
      FROM _migration_0045_pool046_backup AS backup
     WHERE backup.row_type = 'billing_rule'
       AND backup.row_id = br.id
  `.execute(db);

  await sql`DROP TABLE IF EXISTS _migration_0045_pool046_backup`.execute(db);
}
