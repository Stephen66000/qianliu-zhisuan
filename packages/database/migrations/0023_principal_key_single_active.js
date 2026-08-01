/**
 * Principal Key 并发创建门禁：每个主体最多一把 ACTIVE Key。
 *
 * 向前迁移：
 * - 先修复历史异常重复数据：每个 (enterprise_id, principal_id) 只保留
 *   created_at/id 最新的一把 ACTIVE Key，其余标记 REVOKED；
 * - 再以 partial unique index 从数据库层消除 check-then-insert 竞态。
 *
 * 回滚：
 * - 仅移除唯一索引；已被迁移撤销的历史重复 Key 不自动恢复，避免扩大权限。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    WITH ranked_active_keys AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY enterprise_id, principal_id
               ORDER BY created_at DESC, id DESC
             ) AS active_rank
        FROM principal_key
       WHERE status = 'ACTIVE'
    )
    UPDATE principal_key AS key_to_revoke
       SET status = 'REVOKED',
           revoked_at = COALESCE(key_to_revoke.revoked_at, NOW())
      FROM ranked_active_keys
     WHERE key_to_revoke.id = ranked_active_keys.id
       AND ranked_active_keys.active_rank > 1
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX principal_key_one_active_per_principal_uq
        ON principal_key (enterprise_id, principal_id)
     WHERE status = 'ACTIVE'
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DROP INDEX IF EXISTS principal_key_one_active_per_principal_uq
  `.execute(db);
}
