/** POOL-029：员工模型授权规则、发布任务与手工授权基线。 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("principal_grant")
    .addColumn("authorization_rule_version_id", "uuid")
    .execute();

  await db.schema.createTable("employee_model_rule_version")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("rule_id", "uuid", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("status", "varchar(24)", (c) => c.notNull().defaultTo("DRAFT"))
    .addColumn("employee_scope", "varchar(16)", (c) => c.notNull())
    .addColumn("principal_ids", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("model_scope", "varchar(16)", (c) => c.notNull())
    .addColumn("model_targets", "jsonb", (c) => c.notNull().defaultTo("[]"))
    .addColumn("quota_value", "bigint", (c) => c.notNull())
    .addColumn("allow_overage", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("valid_from", "timestamptz", (c) => c.notNull())
    .addColumn("valid_until", "timestamptz")
    .addColumn("lock_version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("validation_snapshot", "jsonb")
    .addColumn("publish_idempotency_key", "varchar(128)")
    .addColumn("published_at", "timestamptz")
    .addColumn("disabled_at", "timestamptz")
    .addColumn("created_by_admin_user_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("employee_model_rule_version_unique", ["enterprise_id", "rule_id", "version"])
    .execute();
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_status_check CHECK (status IN ('DRAFT','VALIDATED','PUBLISHED','DISABLED'))`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_employee_scope_check CHECK (employee_scope IN ('SELECTED','ALL'))`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_model_scope_check CHECK (model_scope IN ('SELECTED','ALL'))`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_validity_check CHECK (valid_until IS NULL OR valid_until > valid_from)`.execute(db);
  await sql`ALTER TABLE employee_model_rule_version ADD CONSTRAINT employee_model_rule_quota_check CHECK (quota_value >= 0)`.execute(db);
  await sql`CREATE UNIQUE INDEX employee_model_rule_one_published_uq ON employee_model_rule_version (enterprise_id, rule_id) WHERE status = 'PUBLISHED'`.execute(db);
  await sql`CREATE UNIQUE INDEX employee_model_rule_publish_idempotency_uq ON employee_model_rule_version (enterprise_id, publish_idempotency_key) WHERE publish_idempotency_key IS NOT NULL`.execute(db);

  await db.schema.createTable("employee_model_rule_assignment")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("rule_version_id", "uuid", (c) => c.notNull().references("employee_model_rule_version.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.notNull().references("unified_model.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("grant_id", "uuid", (c) => c.notNull().references("principal_grant.id"))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("disabled_at", "timestamptz")
    .addUniqueConstraint("employee_model_rule_assignment_unique", [
      "rule_version_id", "principal_id", "unified_model_id", "provider_resource_id",
    ])
    .execute();
  await sql`ALTER TABLE employee_model_rule_assignment ADD CONSTRAINT employee_model_rule_assignment_status_check CHECK (status IN ('ACTIVE','DISABLED'))`.execute(db);
  await db.schema.createIndex("employee_model_rule_assignment_current_idx")
    .on("employee_model_rule_assignment")
    .columns(["enterprise_id", "principal_id", "status"])
    .execute();

  await db.schema.createTable("principal_model_manual_authorization")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.notNull().references("unified_model.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("principal_model_manual_authorization_pk", [
      "enterprise_id", "principal_id", "unified_model_id",
    ])
    .execute();
  // 上线前既有 Key 权限全部视为手工基线；新规则只能合并，不能静默撤销。
  await sql`
    INSERT INTO principal_model_manual_authorization (enterprise_id, principal_id, unified_model_id)
    SELECT DISTINCT pk.enterprise_id, pk.principal_id, um.id
    FROM principal_key pk
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(pk.allowed_model_ids, '[]'::jsonb)) AS model_ids(model_id)
    JOIN unified_model um ON um.id::text = model_id AND um.enterprise_id = pk.enterprise_id
    WHERE pk.status = 'ACTIVE'
    ON CONFLICT DO NOTHING
  `.execute(db);

  await db.schema.alterTable("principal_grant")
    .addForeignKeyConstraint(
      "principal_grant_authorization_rule_version_fk",
      ["authorization_rule_version_id"],
      "employee_model_rule_version",
      ["id"],
    )
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 已产生规则数据后禁止破坏性回滚：否则受管 Grant 会失去来源，审计链不可恢复。
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM employee_model_rule_version LIMIT 1) THEN
        RAISE EXCEPTION '0038 rollback blocked: employee model authorization data exists';
      END IF;
    END $$
  `.execute(db);
  await db.schema.alterTable("principal_grant")
    .dropConstraint("principal_grant_authorization_rule_version_fk")
    .execute();
  await db.schema.dropTable("principal_model_manual_authorization").ifExists().execute();
  await db.schema.dropTable("employee_model_rule_assignment").ifExists().execute();
  await db.schema.dropTable("employee_model_rule_version").ifExists().execute();
  await db.schema.alterTable("principal_grant")
    .dropColumn("authorization_rule_version_id")
    .execute();
}
