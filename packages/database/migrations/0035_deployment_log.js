/** POOL-026：生产升级主记录与只追加事件。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("deployment_log")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("deployment_id", "varchar(128)", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("finished_at", "timestamptz")
    .addColumn("status", "varchar(24)", (c) => c.notNull())
    .addColumn("from_version", "varchar(128)")
    .addColumn("to_version", "varchar(128)")
    .addColumn("git_commit", "varchar(64)")
    .addColumn("artifact_sha256", "varchar(64)")
    .addColumn("migration_from", "varchar(128)")
    .addColumn("migration_to", "varchar(128)")
    .addColumn("release_id", "varchar(128)")
    .addColumn("actor", "varchar(128)", (c) => c.notNull())
    .addColumn("summary", "text", (c) => c.notNull())
    .addColumn("pool_refs", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("backup_ref", "varchar(256)")
    .addColumn("rollback_target", "varchar(128)")
    .addColumn("health_summary", "jsonb")
    .addColumn("smoke_summary", "jsonb")
    .addColumn("evidence_refs", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("failure_classification", "varchar(64)")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("deployment_log_enterprise_deployment_unique", ["enterprise_id", "deployment_id"])
    .execute();
  await sql`ALTER TABLE deployment_log ADD CONSTRAINT deployment_log_status_check CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED','ROLLED_BACK'))`.execute(db);
  await db.schema.createTable("deployment_log_event")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("deployment_log_id", "uuid", (c) => c.notNull().references("deployment_log.id"))
    .addColumn("event_key", "varchar(128)", (c) => c.notNull())
    .addColumn("event_type", "varchar(32)", (c) => c.notNull())
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull())
    .addColumn("actor", "varchar(128)", (c) => c.notNull())
    .addColumn("note", "text")
    .addColumn("payload", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("deployment_log_event_key_unique", ["deployment_log_id", "event_key"])
    .execute();
  await db.schema.createIndex("deployment_log_query_idx").on("deployment_log")
    .columns(["enterprise_id", "started_at", "status"]).execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("deployment_log_event").ifExists().execute();
  await db.schema.dropTable("deployment_log").ifExists().execute();
}
