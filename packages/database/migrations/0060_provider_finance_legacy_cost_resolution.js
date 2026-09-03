/** DeepSeek API 一次性历史费用封口；Coding Plan 固定月费不进入本迁移。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_finance_legacy_cost_resolution")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("account_currency", "varchar(3)", (c) => c.notNull())
    .addColumn("window_start", "timestamptz", (c) => c.notNull())
    .addColumn("window_end_inclusive", "timestamptz", (c) => c.notNull())
    .addColumn("provider_balance_snapshot_id", "uuid", (c) => c.notNull())
    .addColumn("provider_confirmed_balance", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("local_balance_before_adjustment", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("known_api_cost", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("missing_api_cost", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("unknown_line_count", "bigint", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("adjustment_event_id", "uuid")
    .addColumn("evidence_ref", "text", (c) => c.notNull())
    .addColumn("created_by_admin_user_id", "uuid", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("resolved_at", "timestamptz")
    .execute();
  await db.schema.createIndex("provider_finance_legacy_resolution_enterprise_id_uq")
    .unique().on("provider_finance_legacy_cost_resolution")
    .columns(["enterprise_id", "id"]).execute();
  await db.schema.createIndex("provider_finance_legacy_resolution_resource_id_uq")
    .unique().on("provider_finance_legacy_cost_resolution")
    .columns(["enterprise_id", "provider_resource_id", "id"]).execute();
  await db.schema.createIndex("provider_finance_legacy_resolution_window_uq")
    .unique().on("provider_finance_legacy_cost_resolution")
    .columns(["enterprise_id", "provider_resource_id", "account_currency",
      "window_start", "window_end_inclusive"]).execute();
  await sql`
    ALTER TABLE provider_finance_legacy_cost_resolution
      ADD CONSTRAINT provider_finance_legacy_resolution_resource_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_finance_legacy_resolution_admin_fk
        FOREIGN KEY (enterprise_id, created_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_legacy_resolution_currency_check
        CHECK (account_currency IN ('CNY','USD')),
      ADD CONSTRAINT provider_finance_legacy_resolution_amount_check CHECK (
        provider_confirmed_balance >= 0 AND known_api_cost >= 0 AND missing_api_cost > 0
        AND unknown_line_count > 0
        AND local_balance_before_adjustment - missing_api_cost = provider_confirmed_balance
      ),
      ADD CONSTRAINT provider_finance_legacy_resolution_window_check CHECK (
        window_start = '2026-08-31T16:00:00Z'::timestamptz
        AND window_end_inclusive >= window_start
      ),
      ADD CONSTRAINT provider_finance_legacy_resolution_state_check CHECK (
        (status='OPEN' AND adjustment_event_id IS NULL
          AND resolved_at IS NULL)
        OR (status='RESOLVED' AND adjustment_event_id IS NOT NULL
          AND resolved_at IS NOT NULL)
      )
  `.execute(db);

  await db.schema.alterTable("provider_finance_event")
    .addColumn("legacy_cost_resolution_id", "uuid").execute();
  await db.schema.alterTable("ledger_line")
    .addColumn("legacy_cost_resolution_id", "uuid").execute();
  await sql`
    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_legacy_resolution_fk
        FOREIGN KEY (enterprise_id, provider_resource_id, legacy_cost_resolution_id)
        REFERENCES provider_finance_legacy_cost_resolution
          (enterprise_id, provider_resource_id, id);
    ALTER TABLE provider_finance_legacy_cost_resolution
      ADD CONSTRAINT provider_finance_legacy_resolution_event_fk
        FOREIGN KEY (enterprise_id, adjustment_event_id)
        REFERENCES provider_finance_event (enterprise_id, id);
    ALTER TABLE ledger_line
      ADD CONSTRAINT ledger_line_legacy_resolution_fk
        FOREIGN KEY (enterprise_id, provider_resource_id, legacy_cost_resolution_id)
        REFERENCES provider_finance_legacy_cost_resolution
          (enterprise_id, provider_resource_id, id)
  `.execute(db);

  await sql`
    ALTER TABLE provider_finance_event
      DROP CONSTRAINT provider_finance_event_type_check,
      DROP CONSTRAINT provider_finance_event_shape_check;
    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_type_check CHECK (event_type IN (
        'API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE',
        'API_BALANCE_RECONCILIATION','API_LEGACY_COST_ADJUSTMENT',
        'CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL'
      )),
      ADD CONSTRAINT provider_finance_event_shape_check CHECK (
        (event_type = 'API_OPENING_BALANCE' AND account_amount >= 0
          AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
          AND correction_of_event_id IS NULL AND reconciliation_case_id IS NULL
          AND legacy_cost_resolution_id IS NULL)
        OR (event_type = 'API_OPENING_BALANCE_CORRECTION' AND account_amount <> 0
          AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
          AND correction_of_event_id IS NOT NULL AND reconciliation_case_id IS NULL
          AND legacy_cost_resolution_id IS NULL)
        OR (event_type = 'API_RECHARGE' AND account_amount > 0 AND cash_paid_cny > 0
          AND reversal_of_event_id IS NULL AND correction_of_event_id IS NULL
          AND reconciliation_case_id IS NULL AND legacy_cost_resolution_id IS NULL)
        OR (event_type = 'API_BALANCE_RECONCILIATION' AND account_amount <> 0
          AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
          AND correction_of_event_id IS NULL AND reconciliation_case_id IS NOT NULL
          AND legacy_cost_resolution_id IS NULL)
        OR (event_type = 'API_LEGACY_COST_ADJUSTMENT' AND account_amount < 0
          AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
          AND correction_of_event_id IS NULL AND reconciliation_case_id IS NULL
          AND legacy_cost_resolution_id IS NOT NULL)
        OR (event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
          AND account_amount > 0 AND cash_paid_cny > 0
          AND reversal_of_event_id IS NULL AND correction_of_event_id IS NULL
          AND reconciliation_case_id IS NULL AND legacy_cost_resolution_id IS NULL)
        OR (event_type = 'REVERSAL' AND account_amount <> 0
          AND reversal_of_event_id IS NOT NULL AND correction_of_event_id IS NULL
          AND reconciliation_case_id IS NULL AND legacy_cost_resolution_id IS NULL)
      )
  `.execute(db);

  await sql`
    CREATE FUNCTION provider_finance_validate_legacy_cost_resolution() RETURNS trigger
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
    $$;
    CREATE TRIGGER provider_finance_legacy_resolution_contract
      BEFORE INSERT OR UPDATE ON provider_finance_legacy_cost_resolution
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_legacy_cost_resolution();

    CREATE FUNCTION provider_finance_validate_legacy_cost_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resolution provider_finance_legacy_cost_resolution%ROWTYPE;
    BEGIN
      IF NEW.event_type='API_LEGACY_COST_ADJUSTMENT' THEN
        SELECT * INTO resolution FROM provider_finance_legacy_cost_resolution
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.legacy_cost_resolution_id;
        IF NEW.source <> 'MIGRATION' OR resolution.id IS NULL OR resolution.status <> 'OPEN'
           OR resolution.provider_resource_id <> NEW.provider_resource_id
           OR resolution.account_currency <> NEW.account_currency
           OR NEW.account_amount <> -resolution.missing_api_cost
           OR NEW.occurred_at <> resolution.window_end_inclusive THEN
          RAISE EXCEPTION 'legacy cost adjustment does not match its open resolution';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_legacy_cost_event_contract
      BEFORE INSERT ON provider_finance_event
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_legacy_cost_event();

    CREATE FUNCTION provider_finance_validate_legacy_line_link() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resolution provider_finance_legacy_cost_resolution%ROWTYPE;
    BEGIN
      IF NEW.legacy_cost_resolution_id IS NOT NULL THEN
        SELECT * INTO resolution FROM provider_finance_legacy_cost_resolution
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.legacy_cost_resolution_id;
        IF NEW.resource_mode <> 'API' OR NEW.api_cost_status <> 'UNKNOWN_COST'
           OR NEW.api_cost IS NOT NULL OR NEW.api_cost_currency IS NOT NULL
           OR resolution.id IS NULL OR resolution.provider_resource_id <> NEW.provider_resource_id
           OR NEW.settled_at < resolution.window_start
           OR NEW.settled_at > resolution.window_end_inclusive THEN
          RAISE EXCEPTION 'legacy cost resolution can only cover matching unknown API lines';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER ledger_line_legacy_resolution_contract
      BEFORE INSERT OR UPDATE OF legacy_cost_resolution_id ON ledger_line
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_legacy_line_link()
  `.execute(db);

  await sql`
    CREATE FUNCTION provider_finance_validate_legacy_resolution_closure() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE event provider_finance_event%ROWTYPE;
    DECLARE linked_count bigint;
    DECLARE remaining_count bigint;
    BEGIN
      IF NEW.status='RESOLVED' THEN
        SELECT * INTO event FROM provider_finance_event
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.adjustment_event_id;
        SELECT COUNT(*) INTO linked_count FROM ledger_line
         WHERE enterprise_id=NEW.enterprise_id
           AND legacy_cost_resolution_id=NEW.id;
        SELECT COUNT(*) INTO remaining_count FROM ledger_line
         WHERE enterprise_id=NEW.enterprise_id
           AND provider_resource_id=NEW.provider_resource_id
           AND resource_mode='API' AND api_cost_status='UNKNOWN_COST'
           AND legacy_cost_resolution_id IS NULL
           AND settled_at>=NEW.window_start AND settled_at<=NEW.window_end_inclusive;
        IF event.id IS NULL OR event.event_type <> 'API_LEGACY_COST_ADJUSTMENT'
           OR event.legacy_cost_resolution_id <> NEW.id
           OR event.account_amount <> -NEW.missing_api_cost
           OR linked_count <> NEW.unknown_line_count OR remaining_count <> 0 THEN
          RAISE EXCEPTION 'legacy cost resolution is not closed by exact event and lines';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER provider_finance_legacy_resolution_closure
      AFTER INSERT OR UPDATE ON provider_finance_legacy_cost_resolution
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_legacy_resolution_closure();

    CREATE FUNCTION provider_finance_validate_legacy_event_closure() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resolution provider_finance_legacy_cost_resolution%ROWTYPE;
    BEGIN
      IF NEW.event_type='API_LEGACY_COST_ADJUSTMENT' THEN
        SELECT * INTO resolution FROM provider_finance_legacy_cost_resolution
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.legacy_cost_resolution_id;
        IF resolution.status <> 'RESOLVED' OR resolution.adjustment_event_id <> NEW.id THEN
          RAISE EXCEPTION 'legacy cost adjustment is not closed by its resolution';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER provider_finance_legacy_event_closure
      AFTER INSERT ON provider_finance_event
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_legacy_event_closure()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_legacy_cost_resolution LIMIT 1) THEN
        RAISE EXCEPTION '0060 rollback blocked: legacy cost resolution facts exist';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_legacy_event_closure ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_legacy_event_closure()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_legacy_resolution_closure ON provider_finance_legacy_cost_resolution`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_legacy_resolution_closure()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS ledger_line_legacy_resolution_contract ON ledger_line`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_legacy_line_link()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_legacy_cost_event_contract ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_legacy_cost_event()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_legacy_resolution_contract ON provider_finance_legacy_cost_resolution`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_legacy_cost_resolution()`.execute(db);
  await db.schema.alterTable("ledger_line")
    .dropConstraint("ledger_line_legacy_resolution_fk").execute();
  await db.schema.alterTable("provider_finance_legacy_cost_resolution")
    .dropConstraint("provider_finance_legacy_resolution_event_fk").execute();
  await db.schema.alterTable("provider_finance_event")
    .dropConstraint("provider_finance_event_legacy_resolution_fk").execute();
  await db.schema.alterTable("provider_finance_event")
    .dropConstraint("provider_finance_event_shape_check").execute();
  await db.schema.alterTable("provider_finance_event")
    .dropConstraint("provider_finance_event_type_check").execute();
  await db.schema.alterTable("provider_finance_event")
    .addCheckConstraint("provider_finance_event_type_check", sql`event_type IN (
      'API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE',
      'API_BALANCE_RECONCILIATION','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL'
    )`).execute();
  await db.schema.alterTable("provider_finance_event")
    .addCheckConstraint("provider_finance_event_shape_check", sql`
      (event_type = 'API_OPENING_BALANCE' AND account_amount >= 0
        AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
        AND correction_of_event_id IS NULL AND reconciliation_case_id IS NULL)
      OR (event_type = 'API_OPENING_BALANCE_CORRECTION' AND account_amount <> 0
        AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
        AND correction_of_event_id IS NOT NULL AND reconciliation_case_id IS NULL)
      OR (event_type = 'API_RECHARGE' AND account_amount > 0 AND cash_paid_cny > 0
        AND reversal_of_event_id IS NULL AND correction_of_event_id IS NULL
        AND reconciliation_case_id IS NULL)
      OR (event_type = 'API_BALANCE_RECONCILIATION' AND account_amount <> 0
        AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
        AND correction_of_event_id IS NULL AND reconciliation_case_id IS NOT NULL)
      OR (event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
        AND account_amount > 0 AND cash_paid_cny > 0
        AND reversal_of_event_id IS NULL AND correction_of_event_id IS NULL
        AND reconciliation_case_id IS NULL)
      OR (event_type = 'REVERSAL' AND account_amount <> 0
        AND reversal_of_event_id IS NOT NULL AND correction_of_event_id IS NULL
        AND reconciliation_case_id IS NULL)
    `).execute();
  await db.schema.alterTable("ledger_line").dropColumn("legacy_cost_resolution_id").execute();
  await db.schema.alterTable("provider_finance_event")
    .dropColumn("legacy_cost_resolution_id").execute();
  await db.schema.dropTable("provider_finance_legacy_cost_resolution").execute();
}
