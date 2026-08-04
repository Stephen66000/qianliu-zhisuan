/**
 * POOL-025 —— 企业 AI 算力月度经营账单。
 *
 * 草稿按账本与厂商经营快照实时重建；结账生成不可覆盖的 JSON 快照版本。
 * 价值事项与账期事件独立留痕，重开只改变账期状态，不覆盖旧版本。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("operating_bill_period")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_month", "date", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("DRAFT"))
    .addColumn("current_version", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE operating_bill_period
      ADD CONSTRAINT operating_bill_period_status_check
        CHECK (status IN ('DRAFT', 'CLOSED')),
      ADD CONSTRAINT operating_bill_period_version_check
        CHECK (current_version >= 0)
  `.execute(db);
  await db.schema
    .createIndex("operating_bill_period_enterprise_month_uq")
    .unique()
    .on("operating_bill_period")
    .columns(["enterprise_id", "period_month"])
    .execute();

  await db.schema
    .createTable("operating_bill_value_item")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_id", "uuid", (c) =>
      c.notNull().references("operating_bill_period.id").onDelete("cascade"),
    )
    .addColumn("title", "varchar(255)", (c) => c.notNull())
    .addColumn("value_type", "varchar(24)", (c) => c.notNull())
    .addColumn("amount", "numeric(24, 8)")
    .addColumn("metric_value", "varchar(255)")
    .addColumn("metric_unit", "varchar(64)")
    .addColumn("description", "text")
    .addColumn("evidence_ref", "text")
    .addColumn("related_principal_id", "uuid", (c) => c.references("principal.id"))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("submitted_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("confirmed_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("confirmed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE operating_bill_value_item
      ADD CONSTRAINT operating_bill_value_type_check
        CHECK (value_type IN ('MONETARY', 'NON_MONETARY')),
      ADD CONSTRAINT operating_bill_value_status_check
        CHECK (status IN ('PENDING', 'CONFIRMED')),
      ADD CONSTRAINT operating_bill_value_payload_check
        CHECK (
          (value_type = 'MONETARY' AND amount IS NOT NULL AND amount >= 0) OR
          (value_type = 'NON_MONETARY' AND metric_value IS NOT NULL AND length(trim(metric_value)) > 0)
        )
  `.execute(db);
  await db.schema
    .createIndex("operating_bill_value_period_idx")
    .on("operating_bill_value_item")
    .columns(["enterprise_id", "period_id", "created_at"])
    .execute();

  await db.schema
    .createTable("operating_bill_request_project_assignment")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id").onDelete("cascade"))
    .addColumn("project_principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("assigned_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("operating_bill_request_project_assignment_uq")
    .unique()
    .on("operating_bill_request_project_assignment")
    .columns(["enterprise_id", "ai_request_id"])
    .execute();
  await db.schema
    .createIndex("operating_bill_request_project_idx")
    .on("operating_bill_request_project_assignment")
    .columns(["enterprise_id", "project_principal_id"])
    .execute();

  await db.schema
    .createTable("operating_bill_version")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_id", "uuid", (c) =>
      c.notNull().references("operating_bill_period.id").onDelete("cascade"),
    )
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("snapshot", "jsonb", (c) => c.notNull())
    .addColumn("close_note", "text")
    .addColumn("exceptions", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("closed_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("closed_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema
    .createIndex("operating_bill_version_period_version_uq")
    .unique()
    .on("operating_bill_version")
    .columns(["period_id", "version"])
    .execute();

  await db.schema
    .createTable("operating_bill_event")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("period_id", "uuid", (c) =>
      c.notNull().references("operating_bill_period.id").onDelete("cascade"),
    )
    .addColumn("action", "varchar(32)", (c) => c.notNull())
    .addColumn("version", "integer")
    .addColumn("reason", "text")
    .addColumn("actor_admin_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("metadata", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE operating_bill_event
      ADD CONSTRAINT operating_bill_event_action_check
        CHECK (action IN ('CREATED', 'VALUE_CREATED', 'VALUE_CONFIRMED', 'CLOSED', 'REOPENED'))
  `.execute(db);
  await db.schema
    .createIndex("operating_bill_event_period_idx")
    .on("operating_bill_event")
    .columns(["enterprise_id", "period_id", "created_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("operating_bill_event").ifExists().execute();
  await db.schema.dropTable("operating_bill_version").ifExists().execute();
  await db.schema.dropTable("operating_bill_request_project_assignment").ifExists().execute();
  await db.schema.dropTable("operating_bill_value_item").ifExists().execute();
  await db.schema.dropTable("operating_bill_period").ifExists().execute();
}
