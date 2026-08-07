/**
 * POOL-032：厂商 Coding Plan 额度窗口快照。
 *
 * 记录 Kimi/智谱 Coding Plan 厂商返回的实时窗口额度（5 小时/周），与
 * operating_snapshot 的 token 口径独立——本表承载厂商百分比/额度点（100 制），
 * 不混 token。每资源每窗口类型至多一条「当前」快照（is_current=true），
 * 同步成功时旧当前行归档（is_current=false）并插入新行，历史可追溯；
 * 同步失败不动当前行，只更新 sync_status 保鲜。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("provider_quota_window")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) =>
      c.notNull().references("provider_resource.id"),
    )
    .addColumn("window_type", "varchar(16)", (c) => c.notNull())
    .addColumn("is_current", "boolean", (c) => c.notNull().defaultTo(true))
    // 数值用 numeric 字符串承载（TS 侧 string），兼容百分比小数与额度点。
    .addColumn("limit_value", "numeric(30, 8)")
    .addColumn("used_value", "numeric(30, 8)")
    .addColumn("remaining_value", "numeric(30, 8)")
    .addColumn("unit", "varchar(16)")
    .addColumn("ratio", "numeric(8, 6)")
    .addColumn("reset_at", "timestamptz")
    .addColumn("provider_data_at", "timestamptz")
    .addColumn("collected_at", "timestamptz", (c) => c.notNull())
    .addColumn("source", "varchar(16)", (c) => c.notNull())
    .addColumn("adapter_version", "varchar(32)", (c) => c.notNull())
    .addColumn("sync_status", "varchar(16)", (c) => c.notNull())
    .addColumn("sync_error_code", "varchar(64)")
    .addColumn("last_success_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    ALTER TABLE provider_quota_window
      ADD CONSTRAINT provider_quota_window_window_type_check
        CHECK (window_type IN ('FIVE_HOUR', 'WEEKLY')),
      ADD CONSTRAINT provider_quota_window_unit_check
        CHECK (unit IS NULL OR unit IN ('PERCENT', 'POINT')),
      ADD CONSTRAINT provider_quota_window_source_check
        CHECK (source IN ('PROVIDER_SYNC', 'MANUAL_SYNC')),
      ADD CONSTRAINT provider_quota_window_sync_status_check
        CHECK (sync_status IN ('SUCCESS', 'STALE', 'FAILED', 'UNSUPPORTED')),
      ADD CONSTRAINT provider_quota_window_nonnegative_check
        CHECK (
          (limit_value IS NULL OR limit_value >= 0) AND
          (used_value IS NULL OR used_value >= 0) AND
          (remaining_value IS NULL OR remaining_value >= 0) AND
          (ratio IS NULL OR (ratio >= 0 AND ratio <= 1))
        )
  `.execute(db);

  // 每资源每窗口类型至多一条当前快照；并发同步靠此约束 + 事务归档保证幂等。
  await sql`
    CREATE UNIQUE INDEX provider_quota_window_current_uq
    ON provider_quota_window (provider_resource_id, window_type)
    WHERE is_current = true
  `.execute(db);

  await sql`
    CREATE INDEX provider_quota_window_enterprise_history_idx
    ON provider_quota_window (enterprise_id, created_at)
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("provider_quota_window").execute();
}
