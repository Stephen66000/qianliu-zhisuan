/**
 * 2.0 / W20-08~09：API 月预算分母与采购复盘人工备注。
 *
 * 资源月预算只参与经营利用率展示，不进入 Gateway 热路径；复盘备注保留
 * 单调版本并用独立回执表保证幂等重放。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    CREATE INDEX ledger_line_enterprise_resource_created_idx
      ON ledger_line (enterprise_id, provider_resource_id, created_at DESC)
  `.execute(db);

  await db.schema
    .alterTable("provider_resource")
    .addColumn("monthly_budget_amount", "numeric(24, 8)")
    .addColumn("monthly_budget_currency", "varchar(8)")
    .execute();
  await sql`
    ALTER TABLE provider_resource
      ADD CONSTRAINT provider_resource_monthly_budget_check CHECK (
        (monthly_budget_amount IS NULL AND monthly_budget_currency IS NULL)
        OR (monthly_budget_amount > 0 AND monthly_budget_currency IS NOT NULL)
      )
  `.execute(db);

  await db.schema
    .createTable("procurement_review_note")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("month", "date", (c) => c.notNull())
    .addColumn("note", "text", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("updated_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE procurement_review_note
      ADD CONSTRAINT procurement_review_note_month_check
        CHECK (month = date_trunc('month', month)::date),
      ADD CONSTRAINT procurement_review_note_version_check CHECK (version > 0),
      ADD CONSTRAINT procurement_review_note_length_check CHECK (char_length(note) <= 4000)
  `.execute(db);
  await db.schema
    .createIndex("procurement_review_note_enterprise_month_uq")
    .unique()
    .on("procurement_review_note")
    .columns(["enterprise_id", "month"])
    .execute();

  await db.schema
    .createTable("procurement_review_note_idempotency")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("month", "date", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("procurement_review_note_idempotency_pk", [
      "enterprise_id",
      "month",
      "idempotency_key",
    ])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("procurement_review_note_idempotency").ifExists().execute();
  await db.schema.dropTable("procurement_review_note").ifExists().execute();
  await sql`
    ALTER TABLE provider_resource
      DROP CONSTRAINT IF EXISTS provider_resource_monthly_budget_check,
      DROP COLUMN IF EXISTS monthly_budget_currency,
      DROP COLUMN IF EXISTS monthly_budget_amount
  `.execute(db);
  await sql`DROP INDEX IF EXISTS ledger_line_enterprise_resource_created_idx`.execute(db);
}
