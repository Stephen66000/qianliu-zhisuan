/**
 * 0078：资金账本初始化控制结构（WP01 / PFA-03、PFA-06、PFA-09、PFH-07）。
 *
 * 本迁移只新增“非资金事实”的控制与就绪结构，不写入任何资金事件、订阅周期或用量事实，
 * 也不改变既有资金读取路径：
 *
 * 1. provider_finance_activation_attempt —— 企业级候选与激活幂等。
 *    - 候选 TTL 固定 30 分钟：expires_at = created_at + interval '30 minutes'，禁止滑动续期。
 *    - status 仅 PREVIEWED | ACTIVATED | EXPIRED | REJECTED；**不持久化 ACTIVATING**。
 *    - 只能从 PREVIEWED 单向进入 ACTIVATED/EXPIRED/REJECTED；ACTIVATED 为不可修改终态。
 *    - 候选不属于资金事实，不得参与余额、成本或经营账单查询。
 * 2. provider_finance_activation_quiescence —— 企业级激活前静默租约（上限 60 分钟）。
 *    到期由服务端时间判定自动失效；开始/解除/到期恢复写 operation_log 非敏感审计。
 * 3. provider_resource_finance_state —— PFH-07 独立资源资金就绪状态（PENDING | READY）。
 *    新 API 资源在企业已激活严格写后默认 PENDING；Gateway 调度排除 PENDING；
 *    不存在记录表示未纳入门禁（激活前的历史资源由企业级候选覆盖）。
 *
 * 回滚：本迁移不承载资金事实，down 仅在存在 ACTIVATED 候选或 PENDING/READY 就绪事实时拒绝，
 * 避免抹掉可审计证据。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.createTable("provider_finance_activation_attempt")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("candidate_hash", "char(64)", (c) => c.notNull())
    .addColumn("fact_watermark_hash", "char(64)", (c) => c.notNull())
    .addColumn("decision", "varchar(16)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("PREVIEWED"))
    .addColumn("gap_summary", "jsonb", (c) => c.notNull())
    .addColumn("projection_summary", "jsonb", (c) => c.notNull())
    .addColumn("usage_repair_baseline", "jsonb", (c) => c.notNull())
    .addColumn("created_by_admin_user_id", "uuid", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("activation_idempotency_key", "varchar(128)")
    .addColumn("activation_result", "jsonb")
    .addColumn("activated_by_admin_user_id", "uuid")
    .addColumn("activated_at", "timestamptz")
    .execute();
  await db.schema.createIndex("provider_finance_activation_attempt_enterprise_id_id_uq")
    .unique().on("provider_finance_activation_attempt").columns(["enterprise_id", "id"]).execute();
  await db.schema.createIndex("provider_finance_activation_attempt_recent_idx")
    .on("provider_finance_activation_attempt").columns(["enterprise_id", "created_at"]).execute();
  await sql`
    ALTER TABLE provider_finance_activation_attempt
      ADD CONSTRAINT provider_finance_attempt_creator_admin_tenant_fk
        FOREIGN KEY (enterprise_id, created_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_attempt_activator_admin_tenant_fk
        FOREIGN KEY (enterprise_id, activated_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_attempt_hash_check CHECK (
        candidate_hash ~ '^[0-9a-f]{64}$' AND fact_watermark_hash ~ '^[0-9a-f]{64}$'
      ),
      ADD CONSTRAINT provider_finance_attempt_decision_check CHECK (
        decision IN ('GO_CANDIDATE','NO_GO')
      ),
      ADD CONSTRAINT provider_finance_attempt_status_check CHECK (
        status IN ('PREVIEWED','ACTIVATED','EXPIRED','REJECTED')
      ),
      ADD CONSTRAINT provider_finance_attempt_ttl_check CHECK (
        expires_at = created_at + interval '30 minutes'
      ),
      ADD CONSTRAINT provider_finance_attempt_state_shape_check CHECK (
        (status = 'PREVIEWED' AND activation_idempotency_key IS NULL
          AND activation_result IS NULL AND activated_by_admin_user_id IS NULL
          AND activated_at IS NULL)
        OR (status = 'ACTIVATED' AND activation_idempotency_key IS NOT NULL
          AND activation_result IS NOT NULL AND activated_by_admin_user_id IS NOT NULL
          AND activated_at IS NOT NULL)
        OR (status IN ('EXPIRED','REJECTED') AND activation_idempotency_key IS NULL
          AND activation_result IS NULL AND activated_by_admin_user_id IS NULL
          AND activated_at IS NULL)
      )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX provider_finance_attempt_activation_idempotency_uq
      ON provider_finance_activation_attempt (enterprise_id, activation_idempotency_key)
      WHERE activation_idempotency_key IS NOT NULL
  `.execute(db);
  await sql`
    CREATE FUNCTION provider_finance_protect_activation_attempt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status = 'ACTIVATED' THEN
          RAISE EXCEPTION 'activated provider finance candidate is immutable' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.status = 'ACTIVATED' THEN
        RAISE EXCEPTION 'activated provider finance candidate is immutable' USING ERRCODE = '55000';
      END IF;
      IF OLD.status <> 'PREVIEWED' THEN
        RAISE EXCEPTION 'provider finance candidate is already terminal' USING ERRCODE = '55000';
      END IF;
      IF NEW.status NOT IN ('ACTIVATED','EXPIRED','REJECTED') THEN
        RAISE EXCEPTION 'provider finance candidate must move PREVIEWED -> ACTIVATED|EXPIRED|REJECTED'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.enterprise_id <> OLD.enterprise_id
         OR NEW.candidate_hash <> OLD.candidate_hash
         OR NEW.fact_watermark_hash <> OLD.fact_watermark_hash
         OR NEW.decision <> OLD.decision
         OR NEW.gap_summary::text <> OLD.gap_summary::text
         OR NEW.projection_summary::text <> OLD.projection_summary::text
         OR NEW.usage_repair_baseline::text <> OLD.usage_repair_baseline::text
         OR NEW.created_by_admin_user_id <> OLD.created_by_admin_user_id
         OR NEW.created_at <> OLD.created_at
         OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'provider finance candidate preview facts are immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_finance_activation_attempt_guard
      BEFORE UPDATE OR DELETE ON provider_finance_activation_attempt
      FOR EACH ROW EXECUTE FUNCTION provider_finance_protect_activation_attempt()
  `.execute(db);

  await db.schema.createTable("provider_finance_activation_quiescence")
    .addColumn("enterprise_id", "uuid", (c) => c.primaryKey().references("enterprise.id"))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("started_by_admin_user_id", "uuid", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("released_at", "timestamptz")
    .addColumn("release_reason", "varchar(500)")
    .execute();
  await sql`
    ALTER TABLE provider_finance_activation_quiescence
      ADD CONSTRAINT provider_finance_quiescence_admin_tenant_fk
        FOREIGN KEY (enterprise_id, started_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_finance_quiescence_status_check CHECK (
        status IN ('ACTIVE','RELEASED','EXPIRED')
      ),
      ADD CONSTRAINT provider_finance_quiescence_window_check CHECK (
        expires_at > started_at AND expires_at <= started_at + interval '60 minutes'
      ),
      ADD CONSTRAINT provider_finance_quiescence_state_shape_check CHECK (
        (status = 'ACTIVE' AND released_at IS NULL AND release_reason IS NULL)
        OR (status = 'RELEASED' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
        OR (status = 'EXPIRED' AND released_at IS NULL AND release_reason IS NULL)
      )
  `.execute(db);

  await db.schema.createTable("provider_resource_finance_state")
    .addColumn("provider_resource_id", "uuid", (c) => c.primaryKey())
    .addColumn("enterprise_id", "uuid", (c) => c.notNull())
    .addColumn("state", "varchar(16)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("required_currencies", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("ready_at", "timestamptz")
    .addColumn("ready_by_admin_user_id", "uuid")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("provider_resource_finance_state_enterprise_idx")
    .on("provider_resource_finance_state").columns(["enterprise_id", "state"]).execute();
  await sql`
    ALTER TABLE provider_resource_finance_state
      ADD CONSTRAINT provider_resource_finance_state_resource_tenant_fk
        FOREIGN KEY (enterprise_id, provider_resource_id)
        REFERENCES provider_resource (enterprise_id, id),
      ADD CONSTRAINT provider_resource_finance_state_admin_tenant_fk
        FOREIGN KEY (enterprise_id, ready_by_admin_user_id)
        REFERENCES admin_user (enterprise_id, id),
      ADD CONSTRAINT provider_resource_finance_state_state_check CHECK (
        state IN ('PENDING','READY')
      ),
      ADD CONSTRAINT provider_resource_finance_state_shape_check CHECK (
        (state = 'PENDING' AND ready_at IS NULL AND ready_by_admin_user_id IS NULL)
        OR (state = 'READY' AND ready_at IS NOT NULL AND ready_by_admin_user_id IS NOT NULL)
      ),
      ADD CONSTRAINT provider_resource_finance_state_version_check CHECK (version > 0),
      ADD CONSTRAINT provider_resource_finance_state_currencies_check CHECK (
        jsonb_typeof(required_currencies) = 'array'
      )
  `.execute(db);
  await sql`
    CREATE FUNCTION provider_resource_finance_state_seed() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE activated boolean;
    BEGIN
      IF NEW.mode <> 'API' THEN RETURN NEW; END IF;
      SELECT strict_writes_enabled INTO activated
        FROM provider_finance_runtime_state
       WHERE enterprise_id = NEW.enterprise_id;
      IF COALESCE(activated, false) THEN
        INSERT INTO provider_resource_finance_state
          (enterprise_id, provider_resource_id, state, required_currencies)
        VALUES (NEW.enterprise_id, NEW.id, 'PENDING', '[]'::jsonb)
        ON CONFLICT (provider_resource_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_resource_finance_state_seed_trigger
      AFTER INSERT ON provider_resource
      FOR EACH ROW EXECUTE FUNCTION provider_resource_finance_state_seed()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_activation_attempt WHERE status = 'ACTIVATED') THEN
        RAISE EXCEPTION '0078 rollback blocked: activated provider finance candidates exist';
      END IF;
      IF EXISTS (SELECT 1 FROM provider_resource_finance_state LIMIT 1) THEN
        RAISE EXCEPTION '0078 rollback blocked: resource finance readiness facts exist';
      END IF;
    END $$
  `.execute(db);
  await sql`DROP TRIGGER IF EXISTS provider_resource_finance_state_seed_trigger ON provider_resource`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_resource_finance_state_seed()`.execute(db);
  await db.schema.dropTable("provider_resource_finance_state").ifExists().execute();
  await db.schema.dropTable("provider_finance_activation_quiescence").ifExists().execute();
  await sql`DROP TRIGGER IF EXISTS provider_finance_activation_attempt_guard ON provider_finance_activation_attempt`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_finance_protect_activation_attempt()`.execute(db);
  await db.schema.dropTable("provider_finance_activation_attempt").ifExists().execute();
}
