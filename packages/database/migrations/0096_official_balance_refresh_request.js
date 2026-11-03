/**
 * WP3 task 3.2 / OAB-03：官方余额手动刷新请求表（冷却/在途承载）。
 *
 * - 每次手动刷新一个请求行：begin 插入 RUNNING（provider_resource_id 上
 *   RUNNING 部分唯一索引保证单资源并发只有一个在途刷新，并发第二请求拿到
 *   IN_PROGRESS），执行完成后置 SUCCEEDED/FAILED 终态。
 * - 进程崩溃残留的 RUNNING 由下次 begin 按 expires_at 租约收敛为 FAILED
 *   （error_code=REFRESH_LEASE_EXPIRED）；租约 60s（官方查询超时 8s 的充足余量）。
 * - 冷却判定不在本表：按最近一次同步尝试（provider_resource_operating_sync_attempt，
 *   任意 outcome）started_at + P3 计算，attempt 表已有 latest_idx 支撑。
 * - 本表是瞬时协调状态而非证据：余额证据在快照/attempt 表（只追加、不可变）。
 *   down 直接 drop 表（可能丢弃仅存的在途标记，不影响任何余额事实）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("provider_resource_balance_refresh")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("actor_admin_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("idempotency_key", "uuid", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull())
    .addColumn("error_code", "varchar(80)")
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE provider_resource_balance_refresh
      ADD CONSTRAINT provider_resource_balance_refresh_status_check
        CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
  `.execute(db);
  await db.schema
    .createIndex("provider_resource_balance_refresh_idempotency_uq")
    .unique()
    .on("provider_resource_balance_refresh")
    .columns(["enterprise_id", "provider_resource_id", "idempotency_key"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX provider_resource_balance_refresh_running_uq
      ON provider_resource_balance_refresh (provider_resource_id)
      WHERE status = 'RUNNING'
  `.execute(db);
  await db.schema
    .createIndex("provider_resource_balance_refresh_latest_idx")
    .on("provider_resource_balance_refresh")
    .columns(["provider_resource_id", "started_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("provider_resource_balance_refresh").execute();
}
