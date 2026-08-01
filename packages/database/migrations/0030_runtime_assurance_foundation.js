/**
 * RA-W01：运行保障数据底座。
 *
 * 决策：availability_rule（稳定身份）+ availability_rule_version（不可变发布版本）双表。
 * 当前试验版只有一个本地工作空间；本迁移不得新增 tenant_id / enterprise_id。
 * 本迁移只建立加法 Schema，不改写 provider_resource 六态，不接入 Gateway 热路径。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("person")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("department_label", "varchar(128)")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE person ADD CONSTRAINT person_status_check CHECK (status IN ('ACTIVE','DISABLED'))`.execute(db);
  await sql`ALTER TABLE person ADD CONSTRAINT person_version_positive_check CHECK (version > 0)`.execute(db);

  await db.schema
    .createTable("person_external_identity")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("person_id", "uuid", (c) => c.notNull().references("person.id"))
    .addColumn("provider", "varchar(16)", (c) => c.notNull())
    .addColumn("provider_user_id", "varchar(128)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("verified_at", "timestamptz")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE person_external_identity ADD CONSTRAINT person_external_identity_provider_check CHECK (provider = 'WECOM')`.execute(db);
  await sql`ALTER TABLE person_external_identity ADD CONSTRAINT person_external_identity_status_check CHECK (status IN ('ACTIVE','DISABLED'))`.execute(db);
  await sql`ALTER TABLE person_external_identity ADD CONSTRAINT person_external_identity_version_positive_check CHECK (version > 0)`.execute(db);
  await sql`CREATE UNIQUE INDEX person_external_identity_active_user_uq ON person_external_identity (provider, provider_user_id) WHERE status = 'ACTIVE'`.execute(db);
  await db.schema
    .createIndex("person_external_identity_person_idx")
    .on("person_external_identity")
    .columns(["person_id", "status"])
    .execute();

  // 先加 nullable 关系，避免 RA-W02 人员映射完成前破坏既有主体写路径。
  await db.schema
    .alterTable("principal")
    .addColumn("person_id", "uuid", (c) => c.references("person.id"))
    .addColumn("owner_person_id", "uuid", (c) => c.references("person.id"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .execute();
  await sql`ALTER TABLE principal ADD CONSTRAINT principal_version_positive_check CHECK (version > 0)`.execute(db);
  await db.schema.createIndex("principal_person_idx").on("principal").column("person_id").execute();
  await db.schema.createIndex("principal_owner_person_idx").on("principal").column("owner_person_id").execute();

  await db.schema
    .createTable("availability_rule")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("rule_type", "varchar(32)", (c) => c.notNull())
    .addColumn("description", "text")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE availability_rule ADD CONSTRAINT availability_rule_type_check CHECK (rule_type IN ('UPSTREAM_SIGNAL','SCHEDULE_BLOCK','OBSERVATION_ALERT'))`.execute(db);
  await sql`ALTER TABLE availability_rule ADD CONSTRAINT availability_rule_status_check CHECK (status IN ('ACTIVE','ARCHIVED'))`.execute(db);
  await sql`ALTER TABLE availability_rule ADD CONSTRAINT availability_rule_version_positive_check CHECK (version > 0)`.execute(db);

  await db.schema
    .createTable("availability_rule_version")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("availability_rule_id", "uuid", (c) => c.notNull().references("availability_rule.id"))
    .addColumn("rule_version", "integer", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("DRAFT"))
    .addColumn("provider_id", "uuid", (c) => c.references("provider.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.references("provider_resource.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.references("unified_model.id"))
    .addColumn("upstream_model", "varchar(128)")
    .addColumn("unified_signal", "varchar(64)")
    .addColumn("action", "varchar(16)", (c) => c.notNull())
    .addColumn("recovery_method", "varchar(32)")
    .addColumn("fallback_duration_seconds", "integer")
    .addColumn("schedule_timezone", "varchar(64)")
    .addColumn("schedule_days_of_week", "jsonb")
    .addColumn("schedule_start_time", "time")
    .addColumn("schedule_end_time", "time")
    .addColumn("priority", "integer", (c) => c.notNull().defaultTo(100))
    .addColumn("effective_from", "timestamptz")
    .addColumn("effective_to", "timestamptz")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("published_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("published_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_number_check CHECK (rule_version > 0)`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_status_check CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED','DISABLED'))`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_signal_check CHECK (unified_signal IS NULL OR unified_signal IN ('RATE_LIMIT_RETRY_AFTER','QUOTA_EXHAUSTED','PLAN_EXPIRED','MODEL_UNAUTHORIZED','UPSTREAM_MAINTENANCE','CONFIGURATION_ERROR','TECHNICAL_FAILURE'))`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_action_check CHECK (action IN ('WARN_ONLY','BLOCK'))`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_recovery_check CHECK (recovery_method IS NULL OR recovery_method IN ('RETRY_AFTER','UPSTREAM_RESET_TIME','FIXED_DURATION','SCHEDULE_END','MANUAL'))`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_block_recovery_check CHECK (action <> 'BLOCK' OR recovery_method IS NOT NULL)`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_fallback_duration_check CHECK (fallback_duration_seconds IS NULL OR fallback_duration_seconds > 0)`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_effective_range_check CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from)`.execute(db);
  await sql`ALTER TABLE availability_rule_version ADD CONSTRAINT availability_rule_version_lock_positive_check CHECK (version > 0)`.execute(db);
  await db.schema
    .createIndex("availability_rule_version_number_uq")
    .unique()
    .on("availability_rule_version")
    .columns(["availability_rule_id", "rule_version"])
    .execute();
  await db.schema
    .createIndex("availability_rule_version_event_ref_uq")
    .unique()
    .on("availability_rule_version")
    .columns(["id", "availability_rule_id", "rule_version"])
    .execute();
  await sql`CREATE UNIQUE INDEX availability_rule_version_one_draft_uq ON availability_rule_version (availability_rule_id) WHERE status = 'DRAFT'`.execute(db);
  await db.schema
    .createIndex("availability_rule_version_match_idx")
    .on("availability_rule_version")
    .columns(["status", "effective_from", "effective_to", "priority"])
    .execute();

  await db.schema
    .createTable("availability_event")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("event_number", "varchar(32)", (c) => c.notNull().unique())
    .addColumn("availability_rule_id", "uuid", (c) => c.notNull())
    .addColumn("rule_version_id", "uuid", (c) => c.notNull())
    .addColumn("rule_version", "integer", (c) => c.notNull())
    .addColumn("provider_id", "uuid", (c) => c.references("provider.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.references("provider_resource.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.references("unified_model.id"))
    .addColumn("upstream_model", "varchar(128)")
    .addColumn("unified_signal", "varchar(64)", (c) => c.notNull())
    .addColumn("upstream_code", "varchar(64)")
    .addColumn("sanitized_summary", "varchar(255)")
    .addColumn("availability_decision", "varchar(32)", (c) => c.notNull())
    .addColumn("trigger_ai_request_id", "uuid", (c) => c.references("ai_request.id"))
    .addColumn("trigger_principal_id", "uuid", (c) => c.references("principal.id"))
    .addColumn("recovery_method", "varchar(32)", (c) => c.notNull())
    .addColumn("dedup_key", "varchar(255)", (c) => c.notNull())
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("OPEN"))
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("recover_at", "timestamptz")
    .addColumn("recovered_at", "timestamptz")
    .addColumn("recovery_reason", "varchar(255)")
    .addColumn("affected_request_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("affected_person_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("notification_summary", "jsonb")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addForeignKeyConstraint(
      "availability_event_rule_version_fk",
      ["rule_version_id", "availability_rule_id", "rule_version"],
      "availability_rule_version",
      ["id", "availability_rule_id", "rule_version"],
    )
    .execute();
  await sql`ALTER TABLE availability_event ADD CONSTRAINT availability_event_signal_check CHECK (unified_signal IN ('RATE_LIMIT_RETRY_AFTER','QUOTA_EXHAUSTED','PLAN_EXPIRED','MODEL_UNAUTHORIZED','UPSTREAM_MAINTENANCE','CONFIGURATION_ERROR','TECHNICAL_FAILURE'))`.execute(db);
  await sql`ALTER TABLE availability_event ADD CONSTRAINT availability_event_decision_check CHECK (availability_decision IN ('BLOCKED_UPSTREAM','BLOCKED_SCHEDULE'))`.execute(db);
  await sql`ALTER TABLE availability_event ADD CONSTRAINT availability_event_recovery_check CHECK (recovery_method IN ('RETRY_AFTER','UPSTREAM_RESET_TIME','FIXED_DURATION','SCHEDULE_END','MANUAL'))`.execute(db);
  await sql`ALTER TABLE availability_event ADD CONSTRAINT availability_event_status_check CHECK (status IN ('OPEN','RECOVERED','MANUALLY_RECOVERED','CANCELLED'))`.execute(db);
  await sql`ALTER TABLE availability_event ADD CONSTRAINT availability_event_counts_nonnegative_check CHECK (affected_request_count >= 0 AND affected_person_count >= 0)`.execute(db);
  await sql`CREATE UNIQUE INDEX availability_event_open_dedup_uq ON availability_event (dedup_key) WHERE status = 'OPEN'`.execute(db);
  await db.schema
    .createIndex("availability_event_resource_status_idx")
    .on("availability_event")
    .columns(["provider_resource_id", "status", "recover_at"])
    .execute();

  await db.schema
    .alterTable("alert_event")
    .addColumn("availability_event_id", "uuid", (c) => c.references("availability_event.id"))
    .execute();
  await db.schema
    .createIndex("alert_event_availability_event_idx")
    .on("alert_event")
    .column("availability_event_id")
    .execute();

  await db.schema
    .createTable("notification_endpoint")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("provider", "varchar(32)", (c) => c.notNull())
    .addColumn("corp_id", "varchar(128)", (c) => c.notNull())
    .addColumn("agent_id", "varchar(64)", (c) => c.notNull())
    .addColumn("secret_ciphertext", "text", (c) => c.notNull())
    .addColumn("secret_fingerprint", "varchar(128)", (c) => c.notNull())
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("DISABLED"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE notification_endpoint ADD CONSTRAINT notification_endpoint_provider_check CHECK (provider = 'WECOM_APP')`.execute(db);
  await sql`ALTER TABLE notification_endpoint ADD CONSTRAINT notification_endpoint_status_check CHECK (status IN ('ACTIVE','DISABLED'))`.execute(db);
  await sql`ALTER TABLE notification_endpoint ADD CONSTRAINT notification_endpoint_version_positive_check CHECK (version > 0)`.execute(db);
  await sql`CREATE UNIQUE INDEX notification_endpoint_one_active_uq ON notification_endpoint (provider) WHERE status = 'ACTIVE'`.execute(db);

  await db.schema
    .createTable("notification_delivery")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("availability_event_id", "uuid", (c) => c.references("availability_event.id"))
    .addColumn("notification_endpoint_id", "uuid", (c) => c.notNull().references("notification_endpoint.id"))
    .addColumn("recipient_person_id", "uuid", (c) => c.notNull().references("person.id"))
    .addColumn("recipient_identity_id", "uuid", (c) => c.references("person_external_identity.id"))
    .addColumn("delivery_type", "varchar(16)", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(255)", (c) => c.notNull().unique())
    .addColumn("payload_version", "varchar(32)", (c) => c.notNull().defaultTo("v1"))
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "timestamptz")
    .addColumn("sent_at", "timestamptz")
    .addColumn("provider_message_id", "varchar(128)")
    .addColumn("provider_error_code", "varchar(64)")
    .addColumn("last_error_classification", "varchar(64)")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_type_check CHECK (delivery_type IN ('TRIGGER','RECOVERY','TEST'))`.execute(db);
  await sql`ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_event_required_check CHECK (delivery_type = 'TEST' OR availability_event_id IS NOT NULL)`.execute(db);
  await sql`ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_status_check CHECK (status IN ('PENDING','IN_PROGRESS','SENT','RETRYABLE_FAILED','PERMANENT_FAILED','SKIPPED'))`.execute(db);
  await sql`ALTER TABLE notification_delivery ADD CONSTRAINT notification_delivery_attempt_nonnegative_check CHECK (attempt_count >= 0)`.execute(db);
  await db.schema
    .createIndex("notification_delivery_claim_idx")
    .on("notification_delivery")
    .columns(["status", "next_attempt_at", "created_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("notification_delivery").ifExists().execute();
  await db.schema.dropTable("notification_endpoint").ifExists().execute();
  await db.schema.dropIndex("alert_event_availability_event_idx").ifExists().execute();
  await db.schema.alterTable("alert_event").dropColumn("availability_event_id").execute();
  await db.schema.dropTable("availability_event").ifExists().execute();
  await db.schema.dropTable("availability_rule_version").ifExists().execute();
  await db.schema.dropTable("availability_rule").ifExists().execute();
  await db.schema.dropIndex("principal_owner_person_idx").ifExists().execute();
  await db.schema.dropIndex("principal_person_idx").ifExists().execute();
  await db.schema
    .alterTable("principal")
    .dropConstraint("principal_version_positive_check")
    .execute();
  await db.schema
    .alterTable("principal")
    .dropColumn("version")
    .dropColumn("owner_person_id")
    .dropColumn("person_id")
    .execute();
  await db.schema.dropTable("person_external_identity").ifExists().execute();
  await db.schema.dropTable("person").ifExists().execute();
}
