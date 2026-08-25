/** W-MD-01～05：官方来源 Evidence、模型事实与持久化验证互斥。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("provider_model_discovery")
    .addColumn("parser_version", "varchar(64)")
    .addColumn("source_url", "text")
    .addColumn("source_etag", "varchar(255)")
    .addColumn("source_last_modified", "varchar(255)")
    .addColumn("source_content_hash", "varchar(80)")
    .addColumn("source_checked_at", "timestamptz")
    .addColumn("stale", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();

  await db.schema.alterTable("provider_model_discovery_item")
    .addColumn("facts", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();

  await db.schema.createTable("provider_model_validation")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.notNull().references("unified_model.id"))
    .addColumn("upstream_model", "varchar(128)", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_fingerprint", "varchar(64)", (c) => c.notNull())
    .addColumn("status", "varchar(24)", (c) => c.notNull())
    .addColumn("result", "jsonb", (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("provider_model_validation_idempotent", ["enterprise_id", "idempotency_key"])
    .execute();
  await sql`ALTER TABLE provider_model_validation ADD CONSTRAINT provider_model_validation_status_check CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED'))`.execute(db);
  await db.schema.createIndex("provider_model_validation_in_progress_unique")
    .unique()
    .on("provider_model_validation")
    .columns(["enterprise_id", "provider_resource_id", "upstream_model"])
    .where(sql`status = 'IN_PROGRESS'`)
    .execute();
  await db.schema.createIndex("provider_model_validation_latest_idx")
    .on("provider_model_validation")
    .columns(["enterprise_id", "provider_resource_id", "upstream_model", "created_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("provider_model_validation_latest_idx").ifExists().execute();
  await db.schema.dropIndex("provider_model_validation_in_progress_unique").ifExists().execute();
  await db.schema.dropTable("provider_model_validation").ifExists().execute();
  await db.schema.alterTable("provider_model_discovery_item").dropColumn("facts").execute();
  await db.schema.alterTable("provider_model_discovery")
    .dropColumn("stale")
    .dropColumn("source_checked_at")
    .dropColumn("source_content_hash")
    .dropColumn("source_last_modified")
    .dropColumn("source_etag")
    .dropColumn("source_url")
    .dropColumn("parser_version")
    .execute();
}
