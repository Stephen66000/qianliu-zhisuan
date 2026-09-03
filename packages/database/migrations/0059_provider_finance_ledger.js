/** 充值与订阅唯一资金账本：加法迁移，不切换现有读取或写入口。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_finance_event")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("event_type", "varchar(48)", (c) => c.notNull())
    .addColumn("account_amount", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("account_currency", "varchar(3)", (c) => c.notNull())
    .addColumn("cash_paid_cny", sql`numeric(24,8)`)
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull())
    .addColumn("external_reference", "varchar(255)")
    .addColumn("reversal_of_event_id", "uuid")
    .addColumn("correction_of_event_id", "uuid")
    .addColumn("reconciliation_case_id", "uuid")
    .addColumn("description", "varchar(1000)")
    .addColumn("evidence_ref", "text")
    .addColumn("source", "varchar(32)", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("created_by_admin_user_id", "uuid")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("provider_finance_event_enterprise_id_id_uq")
    .unique().on("provider_finance_event").columns(["enterprise_id", "id"]).execute();
  await sql`
    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_finance_event_admin_tenant_fk
        FOREIGN KEY (enterprise_id, created_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_event_reversal_tenant_fk
        FOREIGN KEY (enterprise_id, reversal_of_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_finance_event_correction_tenant_fk
        FOREIGN KEY (enterprise_id, correction_of_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_finance_event_type_check CHECK (event_type IN (
        'API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE',
        'API_BALANCE_RECONCILIATION','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL','REVERSAL'
      )),
      ADD CONSTRAINT provider_finance_event_currency_check CHECK (account_currency IN ('CNY','USD')),
      ADD CONSTRAINT provider_finance_event_source_check CHECK (source IN (
        'ADMIN','MIGRATION','RECONCILIATION','SYSTEM_REVERSAL'
      )),
      ADD CONSTRAINT provider_finance_event_cash_precision_check CHECK (
        cash_paid_cny IS NULL OR cash_paid_cny = trunc(cash_paid_cny, 2)
      ),
      ADD CONSTRAINT provider_finance_event_shape_check CHECK (
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
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX provider_finance_opening_balance_uq
      ON provider_finance_event (enterprise_id, provider_resource_id, account_currency)
      WHERE event_type = 'API_OPENING_BALANCE';
    CREATE UNIQUE INDEX provider_finance_external_reference_uq
      ON provider_finance_event (enterprise_id, provider_resource_id, external_reference)
      WHERE external_reference IS NOT NULL
        AND event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL');
    CREATE UNIQUE INDEX provider_finance_reversal_uq
      ON provider_finance_event (reversal_of_event_id)
      WHERE reversal_of_event_id IS NOT NULL;
    CREATE UNIQUE INDEX provider_finance_idempotency_key_uq
      ON provider_finance_event (enterprise_id, provider_resource_id, idempotency_key)
  `.execute(db);

  await db.schema.createTable("provider_subscription_period")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("finance_event_id", "uuid")
    .addColumn("product_name", "varchar(255)", (c) => c.notNull())
    .addColumn("period_start", "timestamptz", (c) => c.notNull())
    .addColumn("period_end_exclusive", "timestamptz", (c) => c.notNull())
    .addColumn("source", "varchar(32)", (c) => c.notNull())
    .addColumn("migration_source_record_id", "uuid")
    .addColumn("reversed_by_event_id", "uuid")
    .addColumn("created_by_admin_user_id", "uuid")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("provider_subscription_period_enterprise_id_id_uq")
    .unique().on("provider_subscription_period").columns(["enterprise_id", "id"]).execute();
  await db.schema.createIndex("provider_subscription_period_resource_id_uq")
    .unique().on("provider_subscription_period")
    .columns(["enterprise_id", "provider_resource_id", "id"]).execute();
  await sql`
    ALTER TABLE provider_subscription_period
      ADD CONSTRAINT provider_subscription_period_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_subscription_period_event_tenant_fk
        FOREIGN KEY (enterprise_id, finance_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_subscription_period_reversal_tenant_fk
        FOREIGN KEY (enterprise_id, reversed_by_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_subscription_period_admin_tenant_fk
        FOREIGN KEY (enterprise_id, created_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_subscription_period_range_check
        CHECK (period_end_exclusive > period_start
          AND (period_start AT TIME ZONE 'Asia/Shanghai')::time = time '00:00:00'
          AND (period_end_exclusive AT TIME ZONE 'Asia/Shanghai')::time = time '00:00:00'),
      ADD CONSTRAINT provider_subscription_period_source_check CHECK (source IN (
        'PURCHASE','RENEWAL','MIGRATED_CARRYOVER','MIGRATED_PURCHASE'
      )),
      ADD CONSTRAINT provider_subscription_period_source_shape_check CHECK (
        (source IN ('PURCHASE','RENEWAL') AND finance_event_id IS NOT NULL
          AND migration_source_record_id IS NULL)
        OR (source = 'MIGRATED_CARRYOVER' AND finance_event_id IS NULL)
        OR (source = 'MIGRATED_PURCHASE' AND migration_source_record_id IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX provider_subscription_period_event_uq
      ON provider_subscription_period (finance_event_id) WHERE finance_event_id IS NOT NULL;
    CREATE UNIQUE INDEX provider_subscription_period_reversal_uq
      ON provider_subscription_period (reversed_by_event_id) WHERE reversed_by_event_id IS NOT NULL;
    CREATE UNIQUE INDEX provider_subscription_period_migration_source_uq
      ON provider_subscription_period (enterprise_id, migration_source_record_id)
      WHERE migration_source_record_id IS NOT NULL;
    CREATE INDEX provider_subscription_period_lookup_idx
      ON provider_subscription_period
      (enterprise_id, provider_resource_id, period_start DESC, period_end_exclusive)
  `.execute(db);

  await db.schema.createTable("provider_finance_reconciliation_case")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("account_currency", "varchar(3)", (c) => c.notNull())
    .addColumn("local_balance", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("provider_confirmed_balance", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("difference_amount", sql`numeric(24,8)`, (c) => c.notNull())
    .addColumn("balance_as_of", "timestamptz", (c) => c.notNull())
    .addColumn("fact_watermark", "jsonb", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("decision", "varchar(16)")
    .addColumn("evidence_ref", "text", (c) => c.notNull())
    .addColumn("opened_by_admin_user_id", "uuid")
    .addColumn("decided_by_admin_user_id", "uuid")
    .addColumn("adjustment_event_id", "uuid")
    .addColumn("decision_note", "varchar(2000)")
    .addColumn("decision_idempotency_key", "varchar(128)")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("decided_at", "timestamptz")
    .addColumn("resolved_at", "timestamptz")
    .execute();
  await db.schema.createIndex("provider_finance_reconciliation_case_enterprise_id_id_uq")
    .unique().on("provider_finance_reconciliation_case").columns(["enterprise_id", "id"]).execute();
  await sql`
    ALTER TABLE provider_finance_reconciliation_case
      ADD CONSTRAINT provider_finance_case_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_finance_case_opened_admin_tenant_fk
        FOREIGN KEY (enterprise_id, opened_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_case_decided_admin_tenant_fk
        FOREIGN KEY (enterprise_id, decided_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_case_adjustment_tenant_fk
        FOREIGN KEY (enterprise_id, adjustment_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_finance_case_currency_check CHECK (account_currency IN ('CNY','USD')),
      ADD CONSTRAINT provider_finance_case_difference_check CHECK (
        provider_confirmed_balance >= 0
        AND difference_amount <> 0
        AND difference_amount = provider_confirmed_balance - local_balance
      ),
      ADD CONSTRAINT provider_finance_case_version_check CHECK (version > 0),
      ADD CONSTRAINT provider_finance_case_state_check CHECK (
        (status = 'OPEN' AND decision IS NULL AND adjustment_event_id IS NULL
          AND decided_at IS NULL AND resolved_at IS NULL)
        OR (status = 'REJECTED' AND decision = 'REJECTED' AND adjustment_event_id IS NULL
          AND decided_by_admin_user_id IS NOT NULL AND decided_at IS NOT NULL
          AND resolved_at IS NULL)
        OR (status = 'RESOLVED' AND decision = 'CONFIRMED' AND adjustment_event_id IS NOT NULL
          AND decided_by_admin_user_id IS NOT NULL AND decided_at IS NOT NULL
          AND resolved_at IS NOT NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX provider_finance_case_decision_idempotency_uq
      ON provider_finance_reconciliation_case (enterprise_id, decision_idempotency_key)
      WHERE decision_idempotency_key IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX provider_finance_case_open_uq
      ON provider_finance_reconciliation_case
      (enterprise_id, provider_resource_id, account_currency)
      WHERE status = 'OPEN'
  `.execute(db);
  await sql`
    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_case_tenant_fk
        FOREIGN KEY (enterprise_id, reconciliation_case_id)
        REFERENCES provider_finance_reconciliation_case (enterprise_id, id)
  `.execute(db);

  await db.schema.createTable("provider_finance_idempotency")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("provider_finance_idempotency_pk", [
      "enterprise_id", "provider_resource_id", "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "provider_finance_idempotency_resource_tenant_fk",
      ["enterprise_id", "provider_resource_id"], "provider_resource", ["enterprise_id", "id"],
    )
    .execute();

  await db.schema.createTable("provider_finance_duplicate_candidate")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("event_type", "varchar(48)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("request_payload", "jsonb", (c) => c.notNull())
    .addColumn("confirmation_token_hash", "char(64)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_by_admin_user_id", "uuid", (c) => c.notNull())
    .addColumn("consumed_event_id", "uuid")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("consumed_at", "timestamptz")
    .execute();
  await sql`
    ALTER TABLE provider_finance_duplicate_candidate
      ADD CONSTRAINT provider_finance_duplicate_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_finance_duplicate_admin_tenant_fk
        FOREIGN KEY (enterprise_id, created_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_duplicate_event_tenant_fk
        FOREIGN KEY (enterprise_id, consumed_event_id)
        REFERENCES provider_finance_event (enterprise_id, id),
      ADD CONSTRAINT provider_finance_duplicate_status_check CHECK (status IN ('PENDING','CONSUMED','EXPIRED')),
      ADD CONSTRAINT provider_finance_duplicate_state_check CHECK (
        (status = 'PENDING' AND consumed_event_id IS NULL AND consumed_at IS NULL)
        OR (status = 'CONSUMED' AND consumed_event_id IS NOT NULL AND consumed_at IS NOT NULL)
        OR (status = 'EXPIRED' AND consumed_event_id IS NULL AND consumed_at IS NULL)
      )
  `.execute(db);
  await db.schema.createIndex("provider_finance_duplicate_pending_idx")
    .on("provider_finance_duplicate_candidate")
    .columns(["enterprise_id", "provider_resource_id", "status", "expires_at"])
    .execute();

  await db.schema.alterTable("ledger_line")
    .addColumn("api_cost_currency", "varchar(3)")
    .addColumn("api_cost_status", "varchar(40)")
    .addColumn("subscription_period_id", "uuid")
    .addColumn("settled_at", "timestamptz")
    .execute();
  await sql`
    ALTER TABLE ledger_line
      ADD CONSTRAINT ledger_line_api_cost_currency_check
        CHECK (api_cost_currency IS NULL OR api_cost_currency IN ('CNY','USD')),
      ADD CONSTRAINT ledger_line_api_cost_status_check
        CHECK (api_cost_status IS NULL OR api_cost_status IN (
          'PRICED_USAGE','CONFIRMED_ZERO_NO_UPSTREAM','UNKNOWN_COST','NOT_APPLICABLE'
        )),
      ADD CONSTRAINT ledger_line_api_cost_fact_shape_check CHECK (
        api_cost_status IS NULL
        OR (api_cost_status='PRICED_USAGE' AND resource_mode='API'
          AND api_cost IS NOT NULL AND api_cost_currency IS NOT NULL)
        OR (api_cost_status='CONFIRMED_ZERO_NO_UPSTREAM' AND resource_mode='API'
          AND api_cost=0 AND api_cost_currency IS NULL)
        OR (api_cost_status='UNKNOWN_COST' AND resource_mode='API'
          AND api_cost IS NULL AND api_cost_currency IS NULL)
        OR (api_cost_status='NOT_APPLICABLE' AND resource_mode='CODING_PLAN'
          AND api_cost IS NULL AND api_cost_currency IS NULL)
      ),
      ADD CONSTRAINT ledger_line_subscription_period_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id, subscription_period_id)
        REFERENCES provider_subscription_period (enterprise_id, provider_resource_id, id)
  `.execute(db);

  await sql`
    CREATE FUNCTION provider_finance_validate_event_contract() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE resource_mode varchar(16);
    DECLARE original provider_finance_event%ROWTYPE;
    DECLARE finance_case provider_finance_reconciliation_case%ROWTYPE;
    BEGIN
      SELECT mode INTO resource_mode FROM provider_resource
       WHERE enterprise_id = NEW.enterprise_id AND id = NEW.provider_resource_id;
      IF resource_mode IS NULL THEN
        RAISE EXCEPTION 'provider finance resource is missing';
      END IF;
      IF NEW.event_type LIKE 'API_%' AND resource_mode <> 'API' THEN
        RAISE EXCEPTION 'API finance event requires API resource';
      END IF;
      IF NEW.event_type LIKE 'CODING_PLAN_%' AND resource_mode <> 'CODING_PLAN' THEN
        RAISE EXCEPTION 'Coding Plan finance event requires Coding Plan resource';
      END IF;
      IF NEW.source <> 'MIGRATION' AND NEW.occurred_at > now() THEN
        RAISE EXCEPTION 'future provider finance event is not allowed';
      END IF;
      IF NEW.source <> 'MIGRATION'
         AND NEW.event_type IN ('API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
         AND NEW.occurred_at < '2026-08-31T16:00:00Z'::timestamptz THEN
        RAISE EXCEPTION 'provider finance event predates the cutover instant';
      END IF;
      IF NEW.event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION')
         AND NEW.occurred_at <> '2026-08-31T16:00:00Z'::timestamptz THEN
        RAISE EXCEPTION 'opening balance facts must use the cutover instant';
      END IF;
      IF NEW.event_type = 'API_RECHARGE' AND NOT EXISTS (
        SELECT 1 FROM provider_finance_event opening
         WHERE opening.enterprise_id = NEW.enterprise_id
           AND opening.provider_resource_id = NEW.provider_resource_id
           AND opening.account_currency = NEW.account_currency
           AND opening.event_type = 'API_OPENING_BALANCE'
      ) THEN
        RAISE EXCEPTION 'API recharge requires an opening balance in the same currency';
      END IF;
      IF NEW.event_type = 'API_OPENING_BALANCE_CORRECTION' THEN
        SELECT * INTO original FROM provider_finance_event
         WHERE enterprise_id = NEW.enterprise_id AND id = NEW.correction_of_event_id;
        IF original.id IS NULL OR original.event_type <> 'API_OPENING_BALANCE'
           OR original.provider_resource_id <> NEW.provider_resource_id
           OR original.account_currency <> NEW.account_currency THEN
          RAISE EXCEPTION 'opening correction must reference the matching opening event';
        END IF;
      END IF;
      IF NEW.event_type = 'REVERSAL' THEN
        SELECT * INTO original FROM provider_finance_event
         WHERE enterprise_id = NEW.enterprise_id AND id = NEW.reversal_of_event_id;
        IF original.id IS NULL OR original.event_type NOT IN (
          'API_RECHARGE','CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL'
        ) OR original.provider_resource_id <> NEW.provider_resource_id
          OR original.account_currency <> NEW.account_currency
          OR NEW.account_amount <> -original.account_amount
          OR NEW.cash_paid_cny IS DISTINCT FROM -original.cash_paid_cny
          OR NEW.occurred_at <> original.occurred_at THEN
          RAISE EXCEPTION 'reversal must exactly negate an eligible original event';
        END IF;
      END IF;
      IF NEW.event_type = 'API_BALANCE_RECONCILIATION' THEN
        SELECT * INTO finance_case FROM provider_finance_reconciliation_case
         WHERE enterprise_id = NEW.enterprise_id AND id = NEW.reconciliation_case_id;
        IF finance_case.id IS NULL OR finance_case.status <> 'OPEN'
           OR finance_case.provider_resource_id <> NEW.provider_resource_id
           OR finance_case.account_currency <> NEW.account_currency
           OR finance_case.difference_amount <> NEW.account_amount
           OR finance_case.balance_as_of <> NEW.occurred_at THEN
          RAISE EXCEPTION 'balance reconciliation must match its open case';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_event_contract
      BEFORE INSERT ON provider_finance_event
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_event_contract();

    CREATE FUNCTION provider_finance_reject_event_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'provider_finance_event is append-only' USING ERRCODE = '55000';
    END;
    $$;
    CREATE TRIGGER provider_finance_event_immutable
      BEFORE UPDATE OR DELETE ON provider_finance_event
      FOR EACH ROW EXECUTE FUNCTION provider_finance_reject_event_mutation()
  `.execute(db);

  await sql`
    CREATE FUNCTION provider_finance_validate_case_closure() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE linked provider_finance_event%ROWTYPE;
    BEGIN
      IF NEW.status = 'RESOLVED' THEN
        SELECT * INTO linked FROM provider_finance_event
         WHERE id = NEW.adjustment_event_id AND enterprise_id = NEW.enterprise_id;
        IF linked.id IS NULL
           OR linked.event_type <> 'API_BALANCE_RECONCILIATION'
           OR linked.reconciliation_case_id <> NEW.id
           OR linked.provider_resource_id <> NEW.provider_resource_id
           OR linked.account_currency <> NEW.account_currency
           OR linked.account_amount <> NEW.difference_amount
           OR linked.occurred_at <> NEW.balance_as_of THEN
          RAISE EXCEPTION 'resolved reconciliation case is not closed by its exact adjustment event';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER provider_finance_case_closure
      AFTER INSERT OR UPDATE ON provider_finance_reconciliation_case
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_case_closure()
  `.execute(db);
  await sql`
    CREATE FUNCTION provider_finance_validate_adjustment_closure() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE finance_case provider_finance_reconciliation_case%ROWTYPE;
    BEGIN
      IF NEW.event_type = 'API_BALANCE_RECONCILIATION' THEN
        SELECT * INTO finance_case FROM provider_finance_reconciliation_case
         WHERE id=NEW.reconciliation_case_id AND enterprise_id=NEW.enterprise_id;
        IF finance_case.id IS NULL OR finance_case.status <> 'RESOLVED'
           OR finance_case.decision <> 'CONFIRMED'
           OR finance_case.adjustment_event_id <> NEW.id THEN
          RAISE EXCEPTION 'reconciliation adjustment is not closed by its resolved case';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER provider_finance_adjustment_closure
      AFTER INSERT ON provider_finance_event
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_adjustment_closure()
  `.execute(db);
  await sql`
    CREATE FUNCTION provider_finance_validate_period_contract() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE finance_event provider_finance_event%ROWTYPE;
    DECLARE reversal_event provider_finance_event%ROWTYPE;
    DECLARE resource_mode varchar(16);
    BEGIN
      SELECT mode INTO resource_mode FROM provider_resource
       WHERE enterprise_id=NEW.enterprise_id AND id=NEW.provider_resource_id;
      IF resource_mode <> 'CODING_PLAN' THEN
        RAISE EXCEPTION 'subscription period requires Coding Plan resource';
      END IF;
      IF NEW.finance_event_id IS NOT NULL THEN
        SELECT * INTO finance_event FROM provider_finance_event
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.finance_event_id;
        IF finance_event.id IS NULL
           OR finance_event.provider_resource_id <> NEW.provider_resource_id
           OR finance_event.event_type NOT IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL')
           OR (finance_event.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
              <> (NEW.period_start AT TIME ZONE 'Asia/Shanghai')::date THEN
          RAISE EXCEPTION 'subscription period does not match its finance event';
        END IF;
      END IF;
      IF NEW.reversed_by_event_id IS NOT NULL THEN
        SELECT * INTO reversal_event FROM provider_finance_event
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.reversed_by_event_id;
        IF reversal_event.id IS NULL OR reversal_event.event_type <> 'REVERSAL'
           OR NEW.finance_event_id IS NULL
           OR reversal_event.reversal_of_event_id <> NEW.finance_event_id
           OR reversal_event.provider_resource_id <> NEW.provider_resource_id THEN
          RAISE EXCEPTION 'subscription period reversal does not match its finance event';
        END IF;
      END IF;
      IF TG_OP='UPDATE' AND OLD.reversed_by_event_id IS NOT NULL
         AND NEW.reversed_by_event_id IS DISTINCT FROM OLD.reversed_by_event_id THEN
        RAISE EXCEPTION 'subscription period reversal is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_subscription_period_contract
      BEFORE INSERT OR UPDATE ON provider_subscription_period
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_period_contract();

    CREATE TRIGGER provider_subscription_period_no_delete
      BEFORE DELETE ON provider_subscription_period
      FOR EACH ROW EXECUTE FUNCTION provider_finance_reject_event_mutation();

    CREATE FUNCTION provider_finance_validate_period_closure() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE original provider_finance_event%ROWTYPE;
    DECLARE period provider_subscription_period%ROWTYPE;
    BEGIN
      IF NEW.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL') THEN
        SELECT * INTO period FROM provider_subscription_period
         WHERE enterprise_id=NEW.enterprise_id AND finance_event_id=NEW.id;
        IF period.id IS NULL OR period.provider_resource_id <> NEW.provider_resource_id THEN
          RAISE EXCEPTION 'Coding Plan finance event is missing its period';
        END IF;
      ELSIF NEW.event_type='REVERSAL' THEN
        SELECT * INTO original FROM provider_finance_event
         WHERE enterprise_id=NEW.enterprise_id AND id=NEW.reversal_of_event_id;
        IF original.event_type IN ('CODING_PLAN_PURCHASE','CODING_PLAN_RENEWAL') THEN
          SELECT * INTO period FROM provider_subscription_period
           WHERE enterprise_id=NEW.enterprise_id AND finance_event_id=original.id;
          IF period.id IS NULL OR period.reversed_by_event_id <> NEW.id THEN
            RAISE EXCEPTION 'Coding Plan reversal did not reverse its period';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER provider_subscription_period_closure
      AFTER INSERT ON provider_finance_event
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION provider_finance_validate_period_closure()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_event LIMIT 1)
         OR EXISTS (SELECT 1 FROM provider_subscription_period LIMIT 1)
         OR EXISTS (SELECT 1 FROM provider_finance_reconciliation_case LIMIT 1) THEN
        RAISE EXCEPTION '0059 rollback blocked: provider finance facts exist';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_case_closure ON provider_finance_reconciliation_case`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_case_closure()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_adjustment_closure ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_adjustment_closure()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_subscription_period_closure ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_period_closure()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_subscription_period_contract ON provider_subscription_period`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_subscription_period_no_delete ON provider_subscription_period`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_period_contract()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_event_contract ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_validate_event_contract()`.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_finance_event_immutable ON provider_finance_event`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_reject_event_mutation()`.execute(db);
  await db.schema.alterTable("ledger_line")
    .dropConstraint("ledger_line_subscription_period_tenant_fk").execute();
  await db.schema.alterTable("ledger_line")
    .dropConstraint("ledger_line_api_cost_fact_shape_check").execute();
  await db.schema.alterTable("ledger_line")
    .dropConstraint("ledger_line_api_cost_status_check").execute();
  await db.schema.alterTable("ledger_line")
    .dropConstraint("ledger_line_api_cost_currency_check").execute();
  await db.schema.alterTable("ledger_line").dropColumn("settled_at").execute();
  await db.schema.alterTable("ledger_line").dropColumn("subscription_period_id").execute();
  await db.schema.alterTable("ledger_line").dropColumn("api_cost_status").execute();
  await db.schema.alterTable("ledger_line").dropColumn("api_cost_currency").execute();
  await db.schema.dropTable("provider_finance_duplicate_candidate").ifExists().execute();
  await db.schema.dropTable("provider_finance_idempotency").ifExists().execute();
  await db.schema.alterTable("provider_finance_event")
    .dropConstraint("provider_finance_event_case_tenant_fk").execute();
  await db.schema.dropTable("provider_finance_reconciliation_case").ifExists().execute();
  await db.schema.dropTable("provider_subscription_period").ifExists().execute();
  await db.schema.dropTable("provider_finance_event").ifExists().execute();
}
