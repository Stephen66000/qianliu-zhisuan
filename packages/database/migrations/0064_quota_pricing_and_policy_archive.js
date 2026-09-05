import { sql } from "kysely";

export async function up(db) {
  await db.schema.alterTable("upstream_attempt").addColumn("dispatch_check", "jsonb").execute();
  await db.schema.alterTable("billing_rule")
    .addColumn("pricing_mode", "text", (col) => col.notNull().defaultTo("ABSOLUTE")).execute();
  await sql`ALTER TABLE billing_rule ADD CONSTRAINT billing_pricing_mode_check CHECK (
    pricing_mode = 'ABSOLUTE' OR (pricing_mode = 'MULTIPLIER' AND rule_type = 'API_PRICE'
    AND multiplier IS NOT NULL AND multiplier > 0
    AND cache_hit_price IS NOT NULL AND cache_miss_price IS NOT NULL AND output_price IS NOT NULL))`.execute(db);
  await db.schema.alterTable("dispatch_policy")
    .addColumn("archived_at", "timestamptz")
    .addColumn("archived_by_admin_id", "uuid")
    .addColumn("version", "integer", (col) => col.notNull().defaultTo(1)).execute();
  await sql`ALTER TABLE dispatch_policy ADD CONSTRAINT retired_policy_archive_check
    CHECK (archived_at IS NULL OR status = 'RETIRED')`.execute(db);
}

export async function down(db) {
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM billing_rule WHERE pricing_mode = 'MULTIPLIER')
      OR EXISTS (SELECT 1 FROM dispatch_policy WHERE archived_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM upstream_attempt WHERE dispatch_check IS NOT NULL) THEN
      RAISE EXCEPTION '0064 rollback blocked: pricing or archive facts exist';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE dispatch_policy DROP CONSTRAINT retired_policy_archive_check,
    DROP COLUMN archived_at, DROP COLUMN archived_by_admin_id, DROP COLUMN version`.execute(db);
  await sql`ALTER TABLE billing_rule DROP CONSTRAINT billing_pricing_mode_check, DROP COLUMN pricing_mode`.execute(db);
  await db.schema.alterTable("upstream_attempt").dropColumn("dispatch_check").execute();
}
