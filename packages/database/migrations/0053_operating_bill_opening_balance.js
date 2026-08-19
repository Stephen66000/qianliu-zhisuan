/**
 * POOL20-046：经营账单期初余额追加事实。
 *
 * 历史期初余额不能写入 provider_resource_operating_snapshot：该表按递增版本投影
 * 当前经营事实，历史补录会把旧余额误当成当前余额。本表仅承载账期级期初事实，
 * 只追加、不可更新或删除，不改变资源当前快照指针。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createIndex("operating_bill_period_enterprise_id_uq")
    .unique()
    .on("operating_bill_period")
    .columns(["enterprise_id", "id"])
    .execute();
  await db.schema
    .createIndex("admin_user_enterprise_id_uq")
    .unique()
    .on("admin_user")
    .columns(["enterprise_id", "id"])
    .execute();
  await db.schema
    .createTable("operating_bill_opening_balance")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_id", "uuid", (c) => c.notNull())
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("amount", "numeric(24, 8)", (c) => c.notNull())
    .addColumn("currency", "varchar(8)", (c) => c.notNull())
    .addColumn("source", "varchar(24)", (c) => c.notNull().defaultTo("MANUAL"))
    .addColumn("reason", "varchar(1000)")
    .addColumn("created_by", "uuid", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "operating_bill_opening_balance_period_tenant_fk",
      ["enterprise_id", "period_id"],
      "operating_bill_period",
      ["enterprise_id", "id"],
    )
    .addForeignKeyConstraint(
      "operating_bill_opening_balance_resource_tenant_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .addForeignKeyConstraint(
      "operating_bill_opening_balance_actor_tenant_fk",
      ["enterprise_id", "created_by"],
      "admin_user",
      ["enterprise_id", "id"],
    )
    .execute();
  await sql`
    ALTER TABLE operating_bill_opening_balance
      ADD CONSTRAINT operating_bill_opening_balance_amount_check CHECK (amount >= 0),
      ADD CONSTRAINT operating_bill_opening_balance_version_check CHECK (version > 0),
      ADD CONSTRAINT operating_bill_opening_balance_source_check CHECK (source = 'MANUAL')
  `.execute(db);
  await db.schema
    .createIndex("operating_bill_opening_balance_version_uq")
    .unique()
    .on("operating_bill_opening_balance")
    .columns(["enterprise_id", "period_id", "provider_resource_id", "version"])
    .execute();
  await sql`
    CREATE TRIGGER operating_bill_opening_balance_immutable
      BEFORE UPDATE OR DELETE ON operating_bill_opening_balance
      FOR EACH ROW EXECUTE FUNCTION w20_reject_immutable_mutation()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM operating_bill_opening_balance) THEN
        RAISE EXCEPTION '0053 contains opening balance facts; destructive down is disabled';
      END IF;
    END;
    $$
  `.execute(db);
  await db.schema.dropTable("operating_bill_opening_balance").ifExists().execute();
  await db.schema.dropIndex("operating_bill_period_enterprise_id_uq").ifExists().execute();
  await db.schema.dropIndex("admin_user_enterprise_id_uq").ifExists().execute();
}
