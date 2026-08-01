/**
 * POOL-001：一条计价规则支持多个时间窗口。
 *
 * 兼容策略：
 * - 新增 nullable JSONB，不改变旧列和旧查询；
 * - 把既有完整单窗口自动回填为单元素数组；
 * - 应用写入新数组时继续把第一窗镜像到旧列，便于旧版本应用读取与数据库回滚。
 * - down 只删除新列；额外窗口会丢失，但镜像的第一窗仍留在旧列，可降级运行。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("billing_rule")
    .addColumn("time_windows", "jsonb")
    .execute();

  await sql`
    UPDATE billing_rule
       SET time_windows = jsonb_build_array(
         jsonb_build_object(
           'timezone', timezone,
           'days_of_week', days_of_week,
           'start_time', start_time,
           'end_time', end_time
         )
       )
     WHERE timezone IS NOT NULL
       AND start_time IS NOT NULL
       AND end_time IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE billing_rule
    ADD CONSTRAINT billing_rule_time_windows_array_check
    CHECK (
      time_windows IS NULL
      OR (
        jsonb_typeof(time_windows) = 'array'
        AND jsonb_array_length(time_windows) > 0
      )
    )
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    ALTER TABLE billing_rule
    DROP CONSTRAINT IF EXISTS billing_rule_time_windows_array_check
  `.execute(db);
  await db.schema
    .alterTable("billing_rule")
    .dropColumn("time_windows")
    .execute();
}
