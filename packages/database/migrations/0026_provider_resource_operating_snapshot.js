/**
 * POOL-010：厂商资源经营数据快照。
 *
 * 经营数据与主体 Grant/Counter 完全独立。每次管理员录入、厂商同步或账单对账
 * 都追加一条不可变快照；历史账本与旧快照不回填、不重算。既有资源没有可靠
 * 厂商侧数据，因此不生成伪造的 0 快照，读取时按“未知”兼容。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("provider_resource_operating_snapshot")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) =>
      c.notNull().references("provider_resource.id"),
    )
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("source", "varchar(32)", (c) => c.notNull())
    .addColumn("collected_at", "timestamptz", (c) => c.notNull())
    .addColumn("currency", "varchar(8)")
    .addColumn("recharge_amount", "numeric(24, 8)")
    .addColumn("current_balance", "numeric(24, 8)")
    .addColumn("cumulative_cost", "numeric(24, 8)")
    .addColumn("current_period_cost", "numeric(24, 8)")
    .addColumn("cost_period_start", "timestamptz")
    .addColumn("cost_period_end", "timestamptz")
    .addColumn("balance_updated_at", "timestamptz")
    .addColumn("package_name", "varchar(255)")
    .addColumn("package_cost", "numeric(24, 8)")
    .addColumn("total_quota", "numeric(30, 8)")
    .addColumn("quota_unit", "varchar(32)")
    .addColumn("used_quota", "numeric(30, 8)")
    .addColumn("remaining_quota", "numeric(30, 8)")
    .addColumn("effective_from", "timestamptz")
    .addColumn("effective_until", "timestamptz")
    .addColumn("reset_cycle", "varchar(32)")
    .addColumn("next_reset_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`
    ALTER TABLE provider_resource_operating_snapshot
      ADD CONSTRAINT provider_resource_operating_snapshot_source_check
        CHECK (source IN ('ADMIN', 'PROVIDER_SYNC', 'BILL_RECONCILIATION')),
      ADD CONSTRAINT provider_resource_operating_snapshot_nonnegative_check
        CHECK (
          (recharge_amount IS NULL OR recharge_amount >= 0) AND
          (current_balance IS NULL OR current_balance >= 0) AND
          (cumulative_cost IS NULL OR cumulative_cost >= 0) AND
          (current_period_cost IS NULL OR current_period_cost >= 0) AND
          (package_cost IS NULL OR package_cost >= 0) AND
          (total_quota IS NULL OR total_quota >= 0) AND
          (used_quota IS NULL OR used_quota >= 0) AND
          (remaining_quota IS NULL OR remaining_quota >= 0)
        ),
      ADD CONSTRAINT provider_resource_operating_snapshot_quota_consistency_check
        CHECK (
          total_quota IS NULL OR used_quota IS NULL OR remaining_quota IS NULL OR
          total_quota = used_quota + remaining_quota
        ),
      ADD CONSTRAINT provider_resource_operating_snapshot_effective_range_check
        CHECK (
          effective_from IS NULL OR effective_until IS NULL OR
          effective_until > effective_from
        ),
      ADD CONSTRAINT provider_resource_operating_snapshot_cost_range_check
        CHECK (
          cost_period_start IS NULL OR cost_period_end IS NULL OR
          cost_period_end > cost_period_start
        )
  `.execute(db);

  await db.schema
    .createIndex("provider_resource_operating_snapshot_resource_version_uq")
    .unique()
    .on("provider_resource_operating_snapshot")
    .columns(["provider_resource_id", "version"])
    .execute();
  await db.schema
    .createIndex("provider_resource_operating_snapshot_latest_idx")
    .on("provider_resource_operating_snapshot")
    .columns(["enterprise_id", "provider_resource_id", "collected_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("provider_resource_operating_snapshot").ifExists().execute();
}
