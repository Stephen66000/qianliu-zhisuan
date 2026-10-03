import { sql } from "kysely";

/**
 * Coding Plan 窗口额度阻断状态（计划§4，F1 最小 additive 迁移）。
 *
 * - provider_resource.quota_state_revision：额度状态单调代次；同一资源的每次有效
 *   额度写入（成功/故障/管理前提）递增，用作额度查询 token 的组成部分，
 *   防止旧查询结果覆盖新故障（F4）。
 * - provider_resource.quota_block_state：当前耗尽记录（白名单 schema v1，
 *   见 @qianliu/domain quota-block.ts）；NULL 表示无活跃记录。
 * - availability_event.quota_block_incident_id：把明确 CP 耗尽来源事件绑定到
 *   incident；带该标签的事件不受纯时钟恢复（recoverDueEvents）关闭。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`ALTER TABLE provider_resource ADD COLUMN quota_state_revision bigint NOT NULL DEFAULT 0`.execute(db);
  await sql`ALTER TABLE provider_resource ADD COLUMN quota_block_state jsonb NULL`.execute(db);
  await sql`ALTER TABLE availability_event ADD COLUMN quota_block_incident_id uuid NULL`.execute(db);
  await sql`CREATE INDEX availability_event_quota_incident_idx ON availability_event (provider_resource_id, quota_block_incident_id) WHERE quota_block_incident_id IS NOT NULL AND status = 'OPEN'`.execute(db);
}

/**
 * down 只允许在没有任何耗尽事实时执行（计划§10：down 不得删除已有耗尽事实）。
 */
/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const blocked = await sql`SELECT count(*)::int AS count FROM provider_resource WHERE quota_block_state IS NOT NULL`.execute(db);
  const bound = await sql`SELECT count(*)::int AS count FROM availability_event WHERE quota_block_incident_id IS NOT NULL`.execute(db);
  const hasFacts = (blocked.rows[0]?.count ?? 0) > 0 || (bound.rows[0]?.count ?? 0) > 0;
  if (hasFacts) {
    throw new Error("quota block facts exist; destructive down is not allowed (plan §10)");
  }
  await sql`DROP INDEX IF EXISTS availability_event_quota_incident_idx`.execute(db);
  await sql`ALTER TABLE availability_event DROP COLUMN IF EXISTS quota_block_incident_id`.execute(db);
  await sql`ALTER TABLE provider_resource DROP COLUMN IF EXISTS quota_block_state`.execute(db);
  await sql`ALTER TABLE provider_resource DROP COLUMN IF EXISTS quota_state_revision`.execute(db);
}
