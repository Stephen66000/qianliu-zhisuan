/**
 * 迁移 0012 —— 资源并发租约（W14）。
 *
 * 依据：TRD §5.4 行 247/269（并发上限、当前并发、容量余量；热路径短期计数和租约）、
 *       §8 行 504（创建请求意图并预占额度／并发租约）。
 *
 * concurrency_lease：资源维度的并发占用记录。
 *   - 获取：检查当前活跃租约数 < provider_resource.concurrency_limit（行锁防穿透）；
 *   - 释放：Attempt 结束（成功/失败/取消）标记 released_at；
 *   - 恢复：expires_at 兜底（崩溃残留租约由恢复任务回收，W25 worker；W14 提供查询接口）。
 *
 * 并发不穿透的硬保证用 PostgreSQL 行锁（W14 离线可测）；
 * Redis 短期计数作为性能优化层在 W25 叠加（TRD 行 269：Redis 指标丢失不得伪造高可信）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("concurrency_lease")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("ai_request_id", "uuid", (c) => c.references("ai_request.id"))
    .addColumn("acquired_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull()) // 兜底回收
    .addColumn("released_at", "timestamptz") // null = 活跃
    .execute();

  // 活跃租约计数查询（released_at IS NULL）
  await db.schema
    .createIndex("concurrency_lease_active_idx")
    .ifNotExists()
    .on("concurrency_lease")
    .columns(["provider_resource_id", "released_at"])
    .execute();

  // 恢复任务：查过期未释放（expires_at < now 且 released_at IS NULL）
  await sql`CREATE INDEX concurrency_lease_expired_idx ON concurrency_lease (expires_at) WHERE released_at IS NULL`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("concurrency_lease").ifExists().execute();
}
