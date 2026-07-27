/**
 * 迁移 0004 —— 主体授权与额度计数（W03）。
 *
 * 依据：TRD §5.5。
 * principal_grant：主体在某 provider/model 上的额度授权。
 * quota_counter：当前周期已用值（W14 热路径消费；M1 先建表）。
 * 一期 quota_unit 固定 TOKEN（TRD §5.5 L286）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("principal_grant")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("provider", "varchar(32)", (c) => c.notNull()) // deepseek | zhipu | kimi
    .addColumn("model_alias", "varchar(64)", (c) => c.notNull()) // unified_model alias
    .addColumn("quota_unit", "varchar(16)", (c) => c.notNull().defaultTo("TOKEN"))
    .addColumn("quota_value", "bigint", (c) => c.notNull()) // 额度数值
    .addColumn("allow_overage", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("valid_from", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("valid_until", "timestamptz")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await sql`ALTER TABLE principal_grant ADD CONSTRAINT principal_grant_quota_unit_check CHECK (quota_unit IN ('TOKEN'))`.execute(db);
  await sql`ALTER TABLE principal_grant ADD CONSTRAINT principal_grant_status_check CHECK (status IN ('ACTIVE', 'EXPIRED', 'DISABLED'))`.execute(db);
  await db.schema
    .createIndex("principal_grant_principal_idx")
    .ifNotExists()
    .on("principal_grant")
    .columns(["principal_id", "provider", "model_alias"])
    .execute();

  // quota_counter：当前周期已用值（W14 热路径；M1 仅建表）
  await db.schema
    .createTable("quota_counter")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("grant_id", "uuid", (c) => c.notNull().references("principal_grant.id"))
    .addColumn("used_value", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("overage_value", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("period_anchor", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("next_reset_at", "timestamptz")
    .addColumn("reset_marker", "varchar(64)") // 周期标识，幂等重置用
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("quota_counter_grant_idx")
    .ifNotExists()
    .on("quota_counter")
    .column("grant_id")
    .unique()
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("quota_counter").ifExists().execute();
  await db.schema.dropTable("principal_grant").ifExists().execute();
}
