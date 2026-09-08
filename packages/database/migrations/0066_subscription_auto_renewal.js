import { sql } from "kysely";

/** Existing registered subscriptions continue by default until explicitly cancelled. */
export async function up(db) {
  await db.schema.alterTable("provider_resource")
    .addColumn("subscription_auto_renew_enabled", "boolean", c => c.notNull().defaultTo(true)).execute();
  await sql`ALTER TABLE provider_finance_event
    DROP CONSTRAINT provider_finance_event_source_check,
    DROP CONSTRAINT provider_finance_event_actor_check,
    ADD CONSTRAINT provider_finance_event_source_check CHECK (source IN (
      'ADMIN','MIGRATION','RECONCILIATION','SYSTEM_REVERSAL','SYSTEM_RENEWAL')),
    ADD CONSTRAINT provider_finance_event_actor_check CHECK (
      source='MIGRATION' OR (source='SYSTEM_RENEWAL' AND event_type='CODING_PLAN_RENEWAL' AND created_by_admin_user_id IS NULL)
      OR (source<>'SYSTEM_RENEWAL' AND created_by_admin_user_id IS NOT NULL))`.execute(db);
}

export async function down(db) {
  await sql`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM provider_finance_event WHERE source='SYSTEM_RENEWAL')
      OR EXISTS(SELECT 1 FROM provider_resource WHERE NOT subscription_auto_renew_enabled) THEN
      RAISE EXCEPTION '0066 rollback blocked: automatic renewal facts or cancellations exist';
    END IF;
  END $$`.execute(db);
  await sql`ALTER TABLE provider_finance_event
    DROP CONSTRAINT provider_finance_event_source_check,
    DROP CONSTRAINT provider_finance_event_actor_check,
    ADD CONSTRAINT provider_finance_event_source_check CHECK (source IN ('ADMIN','MIGRATION','RECONCILIATION','SYSTEM_REVERSAL')),
    ADD CONSTRAINT provider_finance_event_actor_check CHECK (source='MIGRATION' OR created_by_admin_user_id IS NOT NULL)`.execute(db);
  await db.schema.alterTable("provider_resource").dropColumn("subscription_auto_renew_enabled").execute();
}
