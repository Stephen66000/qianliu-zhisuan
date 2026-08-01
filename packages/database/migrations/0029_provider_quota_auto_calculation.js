/**
 * 厂商套餐额度自动计算口径。
 *
 * 既有快照保持 MANUAL_SNAPSHOT，不回填、不重算；新管理员配置可切换为
 * SYSTEM_LEDGER，由当前周期内 ledger_line.deducted_quota 聚合已用额度，
 * 剩余额度与下一重置时间在读取时推导。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .addColumn("reset_anchor_at", "timestamptz")
    .addColumn("reset_timezone", "varchar(64)")
    .addColumn("usage_calculation", "varchar(32)", (c) =>
      c.notNull().defaultTo("MANUAL_SNAPSHOT"),
    )
    .execute();

  await sql`
    ALTER TABLE provider_resource_operating_snapshot
      ADD CONSTRAINT provider_resource_operating_snapshot_usage_calculation_check
        CHECK (usage_calculation IN ('MANUAL_SNAPSHOT', 'SYSTEM_LEDGER'))
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .dropConstraint("provider_resource_operating_snapshot_usage_calculation_check")
    .execute();
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .dropColumn("usage_calculation")
    .dropColumn("reset_timezone")
    .dropColumn("reset_anchor_at")
    .execute();
}
