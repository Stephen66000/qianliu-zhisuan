/**
 * POOL-014：Gateway 真实流式与 Kimi 稳定性诊断字段。
 *
 * 0029 已被资源额度自动计算迁移占用，0030 已被运行保障底座占用；
 * 本迁移固定使用 0031，保证统一候选中的迁移序号唯一。
 * - provider_resource 增加 RATE_LIMITED 运行态，与长期 UNAVAILABLE 分离；
 * - upstream_attempt 记录故障层，结合既有 first_byte_at/http_status/request_id 完成诊断；
 * - 不增加、不保存任何消息正文。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("upstream_attempt")
    .addColumn("failure_layer", "varchar(32)")
    .execute();

  await sql`ALTER TABLE provider_resource DROP CONSTRAINT IF EXISTS provider_resource_status_check`.execute(db);
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_status_check CHECK (status IN ('ACTIVE', 'DEGRADED', 'EXHAUSTED', 'EXPIRED', 'CREDENTIAL_INVALID', 'RATE_LIMITED', 'UNAVAILABLE'))`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`UPDATE provider_resource SET status = 'DEGRADED', cooldown_until = NULL, last_probe_at = NULL WHERE status = 'RATE_LIMITED'`.execute(db);
  await sql`ALTER TABLE provider_resource DROP CONSTRAINT IF EXISTS provider_resource_status_check`.execute(db);
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_status_check CHECK (status IN ('ACTIVE', 'DEGRADED', 'EXHAUSTED', 'EXPIRED', 'CREDENTIAL_INVALID', 'UNAVAILABLE'))`.execute(db);
  await db.schema
    .alterTable("upstream_attempt")
    .dropColumn("failure_layer")
    .execute();
}
