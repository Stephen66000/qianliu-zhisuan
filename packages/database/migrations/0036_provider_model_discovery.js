/** POOL-027：资源级厂商模型发现快照与幂等接入。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_model_discovery")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("source", "varchar(32)", (c) => c.notNull())
    .addColumn("source_version", "varchar(128)", (c) => c.notNull())
    .addColumn("status", "varchar(24)", (c) => c.notNull())
    .addColumn("discovered_at", "timestamptz", (c) => c.notNull())
    .addColumn("failure_code", "varchar(64)")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`ALTER TABLE provider_model_discovery ADD CONSTRAINT provider_model_discovery_status_check CHECK (status IN ('SUCCEEDED','FAILED'))`.execute(db);

  await db.schema.createTable("provider_model_discovery_item")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("discovery_id", "uuid", (c) => c.notNull().references("provider_model_discovery.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("upstream_model", "varchar(128)", (c) => c.notNull())
    .addColumn("display_name", "varchar(128)", (c) => c.notNull())
    .addColumn("model_type", "varchar(32)", (c) => c.notNull())
    .addColumn("capabilities", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("source", "varchar(32)", (c) => c.notNull())
    .addColumn("compatible", "boolean", (c) => c.notNull())
    .addColumn("unavailable_reason", "varchar(255)")
    .addColumn("availability_status", "varchar(24)", (c) => c.notNull().defaultTo("AVAILABLE"))
    .addColumn("first_discovered_at", "timestamptz", (c) => c.notNull())
    .addColumn("last_discovered_at", "timestamptz", (c) => c.notNull())
    .addColumn("last_validated_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("provider_model_discovery_item_unique", ["discovery_id", "upstream_model"])
    .execute();

  await db.schema.createTable("provider_model_onboarding")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_fingerprint", "varchar(64)", (c) => c.notNull())
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("result", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("provider_model_onboarding_idempotent", ["enterprise_id", "idempotency_key"])
    .execute();

  await db.schema.createIndex("provider_model_discovery_latest_idx")
    .on("provider_model_discovery").columns(["enterprise_id", "provider_resource_id", "discovered_at"])
    .execute();
  await db.schema.createIndex("model_route_resource_upstream_unique")
    .unique().on("model_route")
    .columns(["enterprise_id", "unified_model_id", "provider_resource_id", "upstream_model"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("model_route_resource_upstream_unique").ifExists().execute();
  await db.schema.dropTable("provider_model_onboarding").ifExists().execute();
  await db.schema.dropTable("provider_model_discovery_item").ifExists().execute();
  await db.schema.dropTable("provider_model_discovery").ifExists().execute();
}
