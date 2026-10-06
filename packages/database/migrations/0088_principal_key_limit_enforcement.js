import { sql } from "kysely";

/**
 * 下游 Key 级限制执行（TRD §5.3 L220「Key 校验后继续执行模型、IP、有效期、额度和并发限制」）。
 *
 * - principal_key.used_tokens：Key 级 Token 计数器（bigint，与 quota_counter.used_value 同单位）。
 *   语义：Key 生命周期累计已消耗 Token 上限口径的已用值；quota_limit 为 NULL 表示不启用
 *   Key 级额度（跟随主体 Grant 与资源级限制）。计数器随请求结算校正，属可由
 *   ledger_line 重算的派生事实，但无自动重算任务，崩溃残留按偏大（保守）处理。
 * - ai_request 在途部分索引：Key 级并发限制按 principal_key_id 统计在途请求
 *   （status='IN_PROGRESS'，含 1 小时窗口防崩溃残留永久占位）。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`ALTER TABLE principal_key ADD COLUMN used_tokens bigint NOT NULL DEFAULT 0`.execute(db);
  await sql`CREATE INDEX ai_request_in_flight_by_key_idx ON ai_request (principal_key_id) WHERE status = 'IN_PROGRESS'`.execute(db);
}

/** down 只允许在没有 Key 级计数事实时执行（丢弃计数会使后续额度判断失真）。 */
/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const counted = await sql`SELECT count(*)::int AS count FROM principal_key WHERE used_tokens <> 0`.execute(db);
  if ((counted.rows[0]?.count ?? 0) > 0) {
    throw new Error("principal_key used_tokens facts exist; destructive down is not allowed");
  }
  await sql`DROP INDEX IF EXISTS ai_request_in_flight_by_key_idx`.execute(db);
  await sql`ALTER TABLE principal_key DROP COLUMN IF EXISTS used_tokens`.execute(db);
}
