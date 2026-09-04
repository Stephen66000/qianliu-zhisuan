/**
 * 0904 资源事实收口：修复状态事件时间默认值。
 *
 * 0010 把 "now()" 作为字符串默认值，PostgreSQL 在建表时将它折叠为
 * 固定时刻，导致后续状态事件全部显示为 2026-07-29。新默认值必须
 * 是 SQL 函数。历史时间无法可靠反推，不伪造回填。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely<any>} db */
export async function up(db) {
  await sql`ALTER TABLE resource_status_event
    ADD COLUMN time_reliable boolean NOT NULL DEFAULT true`.execute(db);
  // 0062 之前的默认值已在建表时被折叠，历史时间不可证。
  await sql`UPDATE resource_status_event SET time_reliable=false`.execute(db);
  await sql`ALTER TABLE resource_status_event
    ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`.execute(db);
  await sql`CREATE INDEX ledger_line_resource_settled_idx ON ledger_line (
    enterprise_id, provider_resource_id,
    (COALESCE(settled_at,created_at)) DESC, created_at DESC, id DESC
  )`.execute(db);
}

/** @param {import('kysely').Kysely<any>} db */
export async function down(db) {
  await sql`DROP INDEX ledger_line_resource_settled_idx`.execute(db);
  await sql`ALTER TABLE resource_status_event DROP COLUMN time_reliable`.execute(db);
  // 回滚应用版本时仍须保证旧代码的默认写入可用；不恢复已证实错误的固定时刻。
  await sql`ALTER TABLE resource_status_event
    ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP`.execute(db);
}
