/** V1.4 审核加固：封死一次性历史例外，并保护资金辅助事实链。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_finance_runtime_state")
    .addColumn("enterprise_id", "uuid", (c) => c.primaryKey().references("enterprise.id"))
    .addColumn("strict_writes_enabled", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("activated_at", "timestamptz")
    .addColumn("activated_by_admin_user_id", "uuid")
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE provider_finance_runtime_state
      ADD CONSTRAINT provider_finance_runtime_state_admin_fk
        FOREIGN KEY (enterprise_id, activated_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_runtime_state_shape_check CHECK (
        (strict_writes_enabled=false AND activated_at IS NULL
          AND activated_by_admin_user_id IS NULL)
        OR (strict_writes_enabled=true AND activated_at IS NOT NULL
          AND activated_by_admin_user_id IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE FUNCTION provider_finance_protect_runtime_activation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.strict_writes_enabled THEN
        RAISE EXCEPTION 'provider finance strict write activation is irreversible';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_runtime_activation_immutable
      BEFORE UPDATE OR DELETE ON provider_finance_runtime_state
      FOR EACH ROW EXECUTE FUNCTION provider_finance_protect_runtime_activation();
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX provider_finance_legacy_resolution_account_uq
      ON provider_finance_legacy_cost_resolution
      (enterprise_id, provider_resource_id, account_currency);

    ALTER TABLE provider_finance_legacy_cost_resolution
      ADD CONSTRAINT provider_finance_legacy_resolution_fixed_cutoff_check CHECK (
        window_end_inclusive = '2026-09-03T06:56:18.540Z'::timestamptz
      ),
      ADD CONSTRAINT provider_finance_legacy_resolution_snapshot_fk
        FOREIGN KEY (provider_balance_snapshot_id)
        REFERENCES provider_resource_operating_snapshot (id)
        ON DELETE RESTRICT;

    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_actor_check CHECK (
        source = 'MIGRATION' OR created_by_admin_user_id IS NOT NULL
      );

    ALTER TABLE provider_subscription_period
      DROP CONSTRAINT provider_subscription_period_source_shape_check,
      ADD CONSTRAINT provider_subscription_period_source_shape_check CHECK (
        (source IN ('PURCHASE','RENEWAL') AND finance_event_id IS NOT NULL
          AND migration_source_record_id IS NULL)
        OR (source = 'MIGRATED_CARRYOVER' AND finance_event_id IS NULL
          AND (migration_source_record_id IS NOT NULL
            OR created_by_admin_user_id IS NOT NULL))
        OR (source = 'MIGRATED_PURCHASE' AND migration_source_record_id IS NOT NULL)
      );
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_legacy_cost_resolution() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resource_mode varchar(16);
    DECLARE provider_code varchar(64);
    DECLARE snapshot provider_resource_operating_snapshot%ROWTYPE;
    BEGIN
      SELECT resource.mode, provider.code INTO resource_mode, provider_code
        FROM provider_resource resource
        JOIN provider ON provider.enterprise_id=resource.enterprise_id
         AND provider.id=resource.provider_id
       WHERE resource.enterprise_id=NEW.enterprise_id AND resource.id=NEW.provider_resource_id;
      IF resource_mode <> 'API' OR lower(provider_code) <> 'deepseek' THEN
        RAISE EXCEPTION 'legacy API cost resolution requires a DeepSeek API resource';
      END IF;
      SELECT * INTO snapshot FROM provider_resource_operating_snapshot
       WHERE enterprise_id=NEW.enterprise_id
         AND provider_resource_id=NEW.provider_resource_id
         AND id=NEW.provider_balance_snapshot_id;
      IF snapshot.id IS NULL OR snapshot.source <> 'PROVIDER_SYNC'
         OR snapshot.balance_source <> 'PROVIDER_API'
         OR snapshot.currency <> NEW.account_currency
         OR snapshot.current_balance <> NEW.provider_confirmed_balance
         OR snapshot.collected_at <> NEW.window_end_inclusive THEN
        RAISE EXCEPTION 'legacy cost resolution requires an exact provider balance snapshot';
      END IF;
      IF TG_OP='UPDATE' AND OLD.status='RESOLVED' THEN
        RAISE EXCEPTION 'resolved legacy cost resolution is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE FUNCTION provider_finance_protect_resolution_snapshot() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM provider_finance_legacy_cost_resolution resolution
         WHERE resolution.provider_balance_snapshot_id=OLD.id
      ) THEN
        RAISE EXCEPTION 'provider balance snapshot is sealed by a legacy cost resolution';
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_resolution_snapshot_immutable
      BEFORE UPDATE OR DELETE ON provider_resource_operating_snapshot
      FOR EACH ROW EXECUTE FUNCTION provider_finance_protect_resolution_snapshot();

    CREATE TRIGGER provider_finance_idempotency_immutable
      BEFORE UPDATE OR DELETE ON provider_finance_idempotency
      FOR EACH ROW EXECUTE FUNCTION provider_finance_reject_event_mutation();
  `.execute(db);

  await sql`
    CREATE FUNCTION provider_finance_validate_period_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' THEN
        IF NEW.enterprise_id IS DISTINCT FROM OLD.enterprise_id
           OR NEW.provider_resource_id IS DISTINCT FROM OLD.provider_resource_id
           OR NEW.product_name IS DISTINCT FROM OLD.product_name
           OR NEW.period_start IS DISTINCT FROM OLD.period_start
           OR NEW.period_end_exclusive IS DISTINCT FROM OLD.period_end_exclusive
           OR NEW.source IS DISTINCT FROM OLD.source
           OR NEW.migration_source_record_id IS DISTINCT FROM OLD.migration_source_record_id
           OR NEW.created_by_admin_user_id IS DISTINCT FROM OLD.created_by_admin_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'subscription period identity is immutable';
        END IF;
        IF NEW.finance_event_id IS DISTINCT FROM OLD.finance_event_id
           AND NOT (OLD.source='MIGRATED_PURCHASE' AND OLD.finance_event_id IS NULL
             AND NEW.finance_event_id IS NOT NULL) THEN
          RAISE EXCEPTION 'subscription period finance binding is immutable';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_subscription_period_immutable_identity
      BEFORE UPDATE ON provider_subscription_period
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_period_mutation();

    CREATE FUNCTION provider_finance_validate_ledger_period_link() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE period provider_subscription_period%ROWTYPE;
    BEGIN
      IF NEW.resource_mode='API' AND NEW.subscription_period_id IS NOT NULL THEN
        RAISE EXCEPTION 'API ledger line cannot reference a subscription period';
      END IF;
      IF NEW.subscription_period_id IS NOT NULL THEN
        SELECT * INTO period FROM provider_subscription_period
         WHERE enterprise_id=NEW.enterprise_id
           AND provider_resource_id=NEW.provider_resource_id
           AND id=NEW.subscription_period_id;
        IF period.id IS NULL OR period.reversed_by_event_id IS NOT NULL
           OR NEW.settled_at IS NULL
           OR NEW.settled_at < period.period_start
           OR NEW.settled_at >= period.period_end_exclusive THEN
          RAISE EXCEPTION 'ledger line subscription period does not cover settlement time';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ledger_line_subscription_period_contract
      BEFORE INSERT OR UPDATE OF subscription_period_id, settled_at, provider_resource_id,
        enterprise_id, resource_mode ON ledger_line
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_ledger_period_link();

    CREATE FUNCTION provider_finance_validate_strict_ledger_fact() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE strict_enabled boolean;
    BEGIN
      SELECT strict_writes_enabled INTO strict_enabled
        FROM provider_finance_runtime_state WHERE enterprise_id=NEW.enterprise_id;
      IF COALESCE(strict_enabled, false) THEN
        IF NEW.settled_at IS NULL OR NEW.api_cost_status IS NULL THEN
          RAISE EXCEPTION 'active provider finance ledger requires settlement and cost status';
        END IF;
        IF NEW.resource_mode='API' AND NEW.subscription_period_id IS NOT NULL THEN
          RAISE EXCEPTION 'active API ledger line cannot reference a subscription period';
        END IF;
        IF NEW.resource_mode='CODING_PLAN'
           AND (NEW.api_cost_status<>'NOT_APPLICABLE' OR NEW.subscription_period_id IS NULL) THEN
          RAISE EXCEPTION 'active Coding Plan ledger line requires an attributed period';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ledger_line_provider_finance_strict_contract
      BEFORE INSERT OR UPDATE OF api_cost_status, subscription_period_id, settled_at,
        provider_resource_id, enterprise_id, resource_mode ON ledger_line
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_strict_ledger_fact();

    CREATE FUNCTION provider_finance_validate_case_terminal_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status IN ('REJECTED','RESOLVED') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'terminal reconciliation case is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_case_terminal_immutable
      BEFORE UPDATE ON provider_finance_reconciliation_case
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_case_terminal_mutation();

    CREATE TRIGGER provider_finance_case_no_delete
      BEFORE DELETE ON provider_finance_reconciliation_case
      FOR EACH ROW EXECUTE FUNCTION provider_finance_reject_event_mutation();

    CREATE FUNCTION provider_finance_validate_duplicate_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR OLD.status IN ('CONSUMED','EXPIRED') THEN
        RAISE EXCEPTION 'terminal duplicate candidate is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_duplicate_terminal_immutable
      BEFORE UPDATE OR DELETE ON provider_finance_duplicate_candidate
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_duplicate_mutation();
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_legacy_cost_resolution LIMIT 1)
         OR EXISTS (SELECT 1 FROM provider_finance_runtime_state
          WHERE strict_writes_enabled LIMIT 1) THEN
        RAISE EXCEPTION '0061 rollback blocked: sealed finance evidence or activation exists';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_runtime_activation_immutable ON provider_finance_runtime_state`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_protect_runtime_activation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_case_terminal_immutable ON provider_finance_reconciliation_case`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_case_terminal_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_case_no_delete ON provider_finance_reconciliation_case`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_duplicate_terminal_immutable ON provider_finance_duplicate_candidate`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_duplicate_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_line_subscription_period_contract ON ledger_line`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_ledger_period_link()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_line_provider_finance_strict_contract ON ledger_line`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_strict_ledger_fact()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_subscription_period_immutable_identity ON provider_subscription_period`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_period_mutation()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_idempotency_immutable ON provider_finance_idempotency`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_resolution_snapshot_immutable ON provider_resource_operating_snapshot`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_protect_resolution_snapshot()`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_legacy_cost_resolution() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resource_mode varchar(16);
    DECLARE snapshot provider_resource_operating_snapshot%ROWTYPE;
    BEGIN
      SELECT mode INTO resource_mode FROM provider_resource
       WHERE enterprise_id=NEW.enterprise_id AND id=NEW.provider_resource_id;
      IF resource_mode <> 'API' THEN
        RAISE EXCEPTION 'legacy API cost resolution requires API resource';
      END IF;
      SELECT * INTO snapshot FROM provider_resource_operating_snapshot
       WHERE enterprise_id=NEW.enterprise_id
         AND provider_resource_id=NEW.provider_resource_id
         AND id=NEW.provider_balance_snapshot_id;
      IF snapshot.id IS NULL OR snapshot.source <> 'PROVIDER_SYNC'
         OR snapshot.balance_source <> 'PROVIDER_API'
         OR snapshot.currency <> NEW.account_currency
         OR snapshot.current_balance <> NEW.provider_confirmed_balance
         OR snapshot.collected_at <> NEW.window_end_inclusive THEN
        RAISE EXCEPTION 'legacy cost resolution requires an exact provider balance snapshot';
      END IF;
      IF TG_OP='UPDATE' AND OLD.status='RESOLVED' THEN
        RAISE EXCEPTION 'resolved legacy cost resolution is immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `.execute(db);
  await db.schema.alterTable("provider_subscription_period")
    .dropConstraint("provider_subscription_period_source_shape_check").execute();
  await db.schema.alterTable("provider_subscription_period")
    .addCheckConstraint("provider_subscription_period_source_shape_check", sql`
      (source IN ('PURCHASE','RENEWAL') AND finance_event_id IS NOT NULL
        AND migration_source_record_id IS NULL)
      OR (source = 'MIGRATED_CARRYOVER' AND finance_event_id IS NULL)
      OR (source = 'MIGRATED_PURCHASE' AND migration_source_record_id IS NOT NULL)
    `).execute();
  await db.schema.alterTable("provider_finance_event")
    .dropConstraint("provider_finance_event_actor_check").execute();
  await db.schema.alterTable("provider_finance_legacy_cost_resolution")
    .dropConstraint("provider_finance_legacy_resolution_snapshot_fk").execute();
  await db.schema.alterTable("provider_finance_legacy_cost_resolution")
    .dropConstraint("provider_finance_legacy_resolution_fixed_cutoff_check").execute();
  await db.schema.dropIndex("provider_finance_legacy_resolution_account_uq").ifExists().execute();
  await db.schema.dropTable("provider_finance_runtime_state").ifExists().execute();
}
