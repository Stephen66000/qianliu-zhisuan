/**
 * POOL20-025/026：资源经营同步尝试历史与结账事实确认。
 *
 * - 同步尝试只追加，失败不会覆盖最后一次成功经营快照；
 * - 结账确认独立于原始账本/经营快照，按账期和资源留痕；
 * - 全部变化为加性 Schema，旧应用可忽略新表继续读取 0049 合同。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("provider_resource_operating_snapshot")
    .addColumn("granted_balance", "numeric(24, 8)")
    .addColumn("topped_up_balance", "numeric(24, 8)")
    .addColumn("provider_balance_available", "boolean")
    .addColumn("balance_source", "varchar(24)")
    .addColumn("cost_source", "varchar(24)")
    .execute();
  await sql`
    ALTER TABLE provider_resource_operating_snapshot
      ADD CONSTRAINT provider_resource_operating_snapshot_balance_parts_check CHECK (
        (granted_balance IS NULL OR granted_balance >= 0) AND
        (topped_up_balance IS NULL OR topped_up_balance >= 0)
      ),
      ADD CONSTRAINT provider_resource_operating_snapshot_fact_source_check CHECK (
        (balance_source IS NULL OR balance_source IN ('ADMIN', 'PROVIDER_API', 'BILL_RECONCILIATION')) AND
        (cost_source IS NULL OR cost_source IN ('ADMIN', 'LOCAL_LEDGER', 'BILL_RECONCILIATION', 'NOT_SUPPORTED'))
      )
  `.execute(db);

  await db.schema
    .createTable("provider_resource_operating_sync_attempt")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("sync_day", "date", (c) => c.notNull())
    .addColumn("balance_status", "varchar(24)", (c) => c.notNull())
    .addColumn("cost_status", "varchar(24)", (c) => c.notNull())
    .addColumn("snapshot_id", "uuid", (c) => c.references("provider_resource_operating_snapshot.id"))
    .addColumn("provider_data_at", "timestamptz")
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("completed_at", "timestamptz", (c) => c.notNull())
    .addColumn("next_sync_at", "timestamptz", (c) => c.notNull())
    .addColumn("error_code", "varchar(80)")
    .addColumn("failure_reason", "varchar(500)")
    .addColumn("adapter_version", "varchar(64)", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "provider_resource_operating_sync_attempt_resource_tenant_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await sql`
    ALTER TABLE provider_resource_operating_sync_attempt
      ADD CONSTRAINT provider_resource_operating_sync_attempt_balance_status_check
        CHECK (balance_status IN ('SUCCESS', 'FAILED', 'NOT_SUPPORTED')),
      ADD CONSTRAINT provider_resource_operating_sync_attempt_cost_status_check
        CHECK (cost_status IN ('SUCCESS', 'FAILED', 'NOT_SUPPORTED')),
      ADD CONSTRAINT provider_resource_operating_sync_attempt_time_check
        CHECK (completed_at >= started_at AND next_sync_at > started_at)
  `.execute(db);
  await db.schema
    .createIndex("provider_resource_operating_sync_attempt_daily_uq")
    .unique()
    .on("provider_resource_operating_sync_attempt")
    .columns(["enterprise_id", "provider_resource_id", "sync_day"])
    .execute();
  await db.schema
    .createIndex("provider_resource_operating_sync_attempt_latest_idx")
    .on("provider_resource_operating_sync_attempt")
    .columns(["enterprise_id", "provider_resource_id", "completed_at"])
    .execute();

  await db.schema
    .createTable("operating_bill_resource_confirmation")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_id", "uuid", (c) => c.notNull().references("operating_bill_period.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("status", "varchar(24)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("fact_fingerprint", "char(64)", (c) => c.notNull())
    .addColumn("operating_snapshot_id", "uuid", (c) => c.references("provider_resource_operating_snapshot.id"))
    .addColumn("request_range_from", "timestamptz")
    .addColumn("request_range_to", "timestamptz")
    .addColumn("request_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("note", "varchar(1000)")
    .addColumn("confirmed_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("confirmed_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "operating_bill_resource_confirmation_resource_tenant_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await sql`
    ALTER TABLE operating_bill_resource_confirmation
      ADD CONSTRAINT operating_bill_resource_confirmation_status_check
        CHECK (status IN ('CONFIRMED', 'PENDING', 'NOT_APPLICABLE', 'ANOMALY')),
      ADD CONSTRAINT operating_bill_resource_confirmation_version_check CHECK (version > 0),
      ADD CONSTRAINT operating_bill_resource_confirmation_note_check CHECK (
        status NOT IN ('ANOMALY', 'NOT_APPLICABLE') OR length(trim(note)) > 0
      )
  `.execute(db);
  await db.schema
    .createIndex("operating_bill_resource_confirmation_current_uq")
    .unique()
    .on("operating_bill_resource_confirmation")
    .columns(["enterprise_id", "period_id", "provider_resource_id"])
    .execute();

  await sql`
    CREATE TRIGGER provider_resource_operating_sync_attempt_immutable
      BEFORE UPDATE OR DELETE ON provider_resource_operating_sync_attempt
      FOR EACH ROW EXECUTE FUNCTION w20_reject_immutable_mutation()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provider_resource_operating_sync_attempt)
         OR EXISTS (SELECT 1 FROM operating_bill_resource_confirmation) THEN
        RAISE EXCEPTION '0050 contains operating sync/closing confirmation writes; destructive down is disabled';
      END IF;
    END;
    $$
  `.execute(db);
  await db.schema.dropTable("operating_bill_resource_confirmation").ifExists().execute();
  await db.schema.dropTable("provider_resource_operating_sync_attempt").ifExists().execute();
  await sql`
    ALTER TABLE provider_resource_operating_snapshot
      DROP CONSTRAINT provider_resource_operating_snapshot_fact_source_check,
      DROP CONSTRAINT provider_resource_operating_snapshot_balance_parts_check,
      DROP COLUMN cost_source,
      DROP COLUMN balance_source,
      DROP COLUMN provider_balance_available,
      DROP COLUMN topped_up_balance,
      DROP COLUMN granted_balance
  `.execute(db);
}
