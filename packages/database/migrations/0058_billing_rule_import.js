/** 官网截图识别导入：只保留哈希与结构化证据，不保存图片正文。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("billing_rule_import")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("admin_user_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("model_route_id", "uuid", (c) => c.notNull().references("model_route.id"))
    .addColumn("image_sha256", "varchar(64)", (c) => c.notNull())
    .addColumn("image_mime", "varchar(32)", (c) => c.notNull())
    .addColumn("image_bytes", "integer", (c) => c.notNull())
    .addColumn("extractor_model", "varchar(128)", (c) => c.notNull())
    .addColumn("extractor_request_id", "varchar(128)")
    .addColumn("status", "varchar(24)", (c) => c.notNull().defaultTo("EXTRACTED"))
    .addColumn("source_evidence", "jsonb", (c) => c.notNull())
    .addColumn("candidate_rules", "jsonb", (c) => c.notNull())
    .addColumn("warnings", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("created_rule_ids", "jsonb")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("confirmed_at", "timestamptz")
    .execute();
  await sql`ALTER TABLE billing_rule_import ADD CONSTRAINT billing_rule_import_status_check CHECK (status IN ('EXTRACTED','CONFIRMED'))`.execute(db);
  await db.schema.createIndex("billing_rule_import_enterprise_created_idx")
    .on("billing_rule_import").columns(["enterprise_id", "created_at"]).execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("billing_rule_import_enterprise_created_idx").ifExists().execute();
  await db.schema.dropTable("billing_rule_import").ifExists().execute();
}
