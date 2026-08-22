/**
 * POOL20-047：API 资源月预算版本化事实。
 *
 * 旧 provider_resource.monthly_budget_* 没有适用月份，不能安全回填。
 * 新表按资源＋自然月追加版本；清除也追加 CLEARED 版本，
 * 不删除历史预算。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_resource_monthly_budget")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("month", "date", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull())
    .addColumn("amount", "numeric(24, 8)")
    .addColumn("currency", "varchar(8)")
    .addColumn("is_current", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("created_by", "uuid", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .execute();
  await sql`
    ALTER TABLE provider_resource_monthly_budget
      ADD CONSTRAINT provider_resource_monthly_budget_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_resource_monthly_budget_actor_tenant_fk
        FOREIGN KEY (enterprise_id, created_by)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_resource_monthly_budget_month_check
        CHECK (month = date_trunc('month', month)::date),
      ADD CONSTRAINT provider_resource_monthly_budget_version_check CHECK (version > 0),
      ADD CONSTRAINT provider_resource_monthly_budget_status_check
        CHECK (status IN ('ACTIVE', 'CLEARED')),
      ADD CONSTRAINT provider_resource_monthly_budget_value_check CHECK (
        (status = 'ACTIVE' AND amount > 0 AND currency IS NOT NULL)
        OR (status = 'CLEARED' AND amount IS NULL AND currency IS NULL)
      )
  `.execute(db);
  await db.schema.createIndex("provider_resource_monthly_budget_version_uq")
    .unique().on("provider_resource_monthly_budget")
    .columns(["enterprise_id", "provider_resource_id", "month", "version"])
    .execute();
  await db.schema.createIndex("provider_resource_monthly_budget_idempotency_uq")
    .unique().on("provider_resource_monthly_budget")
    .columns(["enterprise_id", "provider_resource_id", "month", "idempotency_key"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX provider_resource_monthly_budget_current_uq
      ON provider_resource_monthly_budget (enterprise_id, provider_resource_id, month)
      WHERE is_current
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provider_resource_monthly_budget) THEN
        RAISE EXCEPTION '0056 contains resource monthly budget facts; destructive down is disabled';
      END IF;
    END;
    $$
  `.execute(db);
  await db.schema.dropTable("provider_resource_monthly_budget").execute();
}
