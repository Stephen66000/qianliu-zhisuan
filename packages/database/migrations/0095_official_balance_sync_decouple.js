/**
 * WP3 task 3.1 / OAB-03：官方余额同步解耦——放开同步尝试"每日一次"约束。
 *
 * - 0051 建立的 provider_resource_operating_sync_attempt_daily_uq 唯一索引
 *   （enterprise_id, provider_resource_id, sync_day）在旧"每日一次＋充值后补同步"
 *   门禁下保证同日单行；官方余额同步改为可配置周期（P1，默认 15 分钟）后，
 *   同日多次尝试需各留一行（attempt 只追加语义不变，0051 文件头）。
 * - 仅删除索引：表本体（0051）与既有行全部保留，不可变触发器（拒绝 UPDATE/DELETE）
 *   不受影响；0026 快照表无每日唯一约束，无需变更。
 * - down：重建同列唯一索引；若已存在同键多行（P1 周期门禁产物）则拒绝——
 *   此时唯一索引无法建立，提前给出明确错误，与 0051 down 的拒绝式守卫同风格。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.dropIndex("provider_resource_operating_sync_attempt_daily_uq").execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const duplicates = await sql`
    SELECT enterprise_id, provider_resource_id, sync_day
      FROM provider_resource_operating_sync_attempt
     GROUP BY enterprise_id, provider_resource_id, sync_day
    HAVING count(*) > 1
     LIMIT 1
  `.execute(db);
  if (duplicates.rows.length > 0) {
    throw new Error(
      "0095 down: provider_resource_operating_sync_attempt 已存在同日多行"
      + "（P1 周期门禁产物），重建 daily_uq 唯一索引会失败；回滚被拒绝",
    );
  }
  await db.schema
    .createIndex("provider_resource_operating_sync_attempt_daily_uq")
    .unique()
    .on("provider_resource_operating_sync_attempt")
    .columns(["enterprise_id", "provider_resource_id", "sync_day"])
    .execute();
}
