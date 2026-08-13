/**
 * W20-02/03：企业通讯录、组织关系与导入批次底座（MIG-A）。
 *
 * 兼容原则：
 * - 仅增加列、表、索引与约束，不删除 1.0 字段；
 * - Person 企业归属只由已绑定 Principal 或部署内唯一企业证明，歧义时阻断；
 * - principal.department_label 继续作为 1.0 当前部门兼容投影；
 * - 导入原文件不入库，Run/Item 只保存标准化字段、摘要和稳定 reason code。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // 企业设置：后续周期边界与金额展示复用；默认值保持 1.0 单企业部署兼容。
  await db.schema.alterTable("enterprise")
    .addColumn("timezone", "varchar(64)", (c) => c.notNull().defaultTo("Asia/Shanghai"))
    .addColumn("default_currency", "varchar(3)", (c) => c.notNull().defaultTo("CNY"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .execute();
  await sql`ALTER TABLE enterprise ADD CONSTRAINT enterprise_version_positive_check CHECK (version > 0)`.execute(db);
  await sql`ALTER TABLE enterprise ADD CONSTRAINT enterprise_currency_format_check CHECK (default_currency ~ '^[A-Z]{3}$')`.execute(db);

  // 为所有新增企业内复合外键提供稳定候选键。
  await db.schema.createIndex("principal_enterprise_id_id_uq")
    .unique().on("principal").columns(["enterprise_id", "id"]).execute();

  // Person 先 nullable、按可证明关系回填，再收紧为 NOT NULL；绝不按姓名猜测。
  await db.schema.alterTable("person")
    .addColumn("enterprise_id", "uuid")
    .addColumn("employee_number", "varchar(64)")
    .addColumn("email", "varchar(254)")
    .addColumn("mobile", "varchar(32)")
    .execute();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        WITH person_enterprises AS (
          SELECT person_id, enterprise_id FROM principal WHERE person_id IS NOT NULL
          UNION
          SELECT owner_person_id AS person_id, enterprise_id FROM principal WHERE owner_person_id IS NOT NULL
        )
        SELECT 1 FROM person_enterprises GROUP BY person_id HAVING count(DISTINCT enterprise_id) > 1
      ) THEN
        RAISE EXCEPTION '0046 blocked: one or more Person rows map to multiple enterprises';
      END IF;
      IF EXISTS (
        SELECT 1 FROM person p
        WHERE NOT EXISTS (
          SELECT 1 FROM principal pr
          WHERE pr.person_id = p.id OR pr.owner_person_id = p.id
        )
      ) AND (SELECT count(*) FROM enterprise) <> 1 THEN
        RAISE EXCEPTION '0046 blocked: unbound Person enterprise ownership is ambiguous';
      END IF;
    END $$
  `.execute(db);
  await sql`
    WITH person_enterprises AS (
      SELECT person_id, enterprise_id FROM principal WHERE person_id IS NOT NULL
      UNION
      SELECT owner_person_id AS person_id, enterprise_id FROM principal WHERE owner_person_id IS NOT NULL
    ), resolved AS (
      SELECT person_id, min(enterprise_id::text)::uuid AS enterprise_id
      FROM person_enterprises GROUP BY person_id
    )
    UPDATE person p SET enterprise_id = r.enterprise_id
    FROM resolved r WHERE p.id = r.person_id
  `.execute(db);
  await sql`
    UPDATE person SET enterprise_id = (SELECT id FROM enterprise LIMIT 1)
    WHERE enterprise_id IS NULL AND (SELECT count(*) FROM enterprise) = 1
  `.execute(db);
  await db.schema.alterTable("person")
    .alterColumn("enterprise_id", (c) => c.setNotNull())
    .execute();
  await db.schema.alterTable("person")
    .addForeignKeyConstraint("person_enterprise_fk", ["enterprise_id"], "enterprise", ["id"])
    .execute();
  await db.schema.createIndex("person_enterprise_id_id_uq")
    .unique().on("person").columns(["enterprise_id", "id"]).execute();
  await sql`
    CREATE UNIQUE INDEX principal_employee_person_uq
    ON principal (enterprise_id, person_id)
    WHERE type = 'EMPLOYEE' AND person_id IS NOT NULL
  `.execute(db);
  await db.schema.alterTable("principal")
    .addForeignKeyConstraint("principal_person_enterprise_fk", ["enterprise_id", "person_id"], "person", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("principal")
    .addForeignKeyConstraint("principal_owner_enterprise_fk", ["enterprise_id", "owner_person_id"], "person", ["enterprise_id", "id"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX person_employee_number_uq
    ON person (enterprise_id, lower(employee_number))
    WHERE employee_number IS NOT NULL
  `.execute(db);

  // 兼容 1.0 /people 写路径：仅在部署内恰好一个企业时允许省略 enterprise_id。
  await sql`
    CREATE FUNCTION qianliu_person_enterprise_default() RETURNS trigger AS $$
    DECLARE resolved uuid;
    BEGIN
      IF NEW.enterprise_id IS NULL THEN
        SELECT min(id::text)::uuid INTO resolved FROM enterprise
        HAVING count(*) = 1;
        IF resolved IS NULL THEN
          RAISE EXCEPTION 'person.enterprise_id is required when deployment has multiple enterprises';
        END IF;
        NEW.enterprise_id := resolved;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER person_enterprise_default_trigger
    BEFORE INSERT ON person FOR EACH ROW EXECUTE FUNCTION qianliu_person_enterprise_default()
  `.execute(db);

  await db.schema.createTable("directory_source")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("type", "varchar(16)", (c) => c.notNull())
    .addColumn("config_ciphertext", "text", (c) => c.notNull())
    .addColumn("config_fingerprint", "varchar(128)", (c) => c.notNull())
    .addColumn("config_key_version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("connector_version", "varchar(32)", (c) => c.notNull().defaultTo("v1"))
    .addColumn("cursor", "text")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("last_successful_sync_at", "timestamptz")
    .addColumn("last_error_code", "varchar(64)")
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("directory_source_enterprise_type_uq", ["enterprise_id", "type"])
    .execute();
  await sql`ALTER TABLE directory_source ADD CONSTRAINT directory_source_type_check CHECK (type IN ('WECOM','FEISHU'))`.execute(db);
  await sql`ALTER TABLE directory_source ADD CONSTRAINT directory_source_status_check CHECK (status IN ('ACTIVE','DISABLED'))`.execute(db);
  await sql`ALTER TABLE directory_source ADD CONSTRAINT directory_source_version_check CHECK (version > 0 AND config_key_version > 0)`.execute(db);
  await db.schema.createIndex("directory_source_enterprise_id_id_uq")
    .unique().on("directory_source").columns(["enterprise_id", "id"]).execute();

  await db.schema.createTable("organization_unit")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("parent_id", "uuid")
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("external_source_id", "uuid")
    .addColumn("external_unit_id", "varchar(255)")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("organization_unit_enterprise_id_id_uq")
    .unique().on("organization_unit").columns(["enterprise_id", "id"]).execute();
  await db.schema.alterTable("organization_unit")
    .addForeignKeyConstraint("organization_unit_parent_fk", ["enterprise_id", "parent_id"], "organization_unit", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("organization_unit")
    .addForeignKeyConstraint("organization_unit_source_fk", ["enterprise_id", "external_source_id"], "directory_source", ["enterprise_id", "id"])
    .execute();
  await sql`ALTER TABLE organization_unit ADD CONSTRAINT organization_unit_status_check CHECK (status IN ('ACTIVE','INACTIVE'))`.execute(db);
  await sql`ALTER TABLE organization_unit ADD CONSTRAINT organization_unit_version_positive_check CHECK (version > 0)`.execute(db);
  await sql`
    CREATE UNIQUE INDEX organization_unit_source_external_uq
    ON organization_unit (enterprise_id, external_source_id, external_unit_id)
    WHERE external_source_id IS NOT NULL AND external_unit_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX organization_unit_excel_path_uq
    ON organization_unit (enterprise_id, external_unit_id)
    WHERE external_source_id IS NULL AND external_unit_id IS NOT NULL
  `.execute(db);

  // 扩展既有外部身份；provider_user_id 继续承载外部成员 ID，避免破坏运行保障通知。
  await db.schema.alterTable("person_external_identity")
    .addColumn("enterprise_id", "uuid")
    .addColumn("directory_source_id", "uuid")
    .execute();
  await sql`
    UPDATE person_external_identity i SET enterprise_id = p.enterprise_id
    FROM person p WHERE p.id = i.person_id
  `.execute(db);
  await db.schema.alterTable("person_external_identity")
    .alterColumn("enterprise_id", (c) => c.setNotNull())
    .execute();
  await db.schema.alterTable("person_external_identity")
    .addForeignKeyConstraint("person_external_identity_enterprise_fk", ["enterprise_id"], "enterprise", ["id"])
    .execute();
  await db.schema.alterTable("person_external_identity")
    .addForeignKeyConstraint("person_external_identity_person_enterprise_fk", ["enterprise_id", "person_id"], "person", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("person_external_identity")
    .addForeignKeyConstraint("person_external_identity_source_fk", ["enterprise_id", "directory_source_id"], "directory_source", ["enterprise_id", "id"])
    .execute();
  await sql`ALTER TABLE person_external_identity DROP CONSTRAINT person_external_identity_provider_check`.execute(db);
  await sql`ALTER TABLE person_external_identity ADD CONSTRAINT person_external_identity_provider_check CHECK (provider IN ('WECOM','FEISHU'))`.execute(db);
  await sql`DROP INDEX person_external_identity_active_user_uq`.execute(db);
  await sql`
    CREATE UNIQUE INDEX person_external_identity_source_member_uq
    ON person_external_identity (enterprise_id, directory_source_id, provider_user_id)
    WHERE status = 'ACTIVE' AND directory_source_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX person_external_identity_legacy_member_uq
    ON person_external_identity (enterprise_id, provider, provider_user_id)
    WHERE status = 'ACTIVE' AND directory_source_id IS NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX person_external_identity_source_person_uq
    ON person_external_identity (enterprise_id, directory_source_id, person_id)
    WHERE status = 'ACTIVE' AND directory_source_id IS NOT NULL
  `.execute(db);
  // 兼容既有 setWecomIdentity：企业归属始终由 Person 推导并强校验。
  await sql`
    CREATE FUNCTION qianliu_identity_enterprise_guard() RETURNS trigger AS $$
    DECLARE resolved uuid;
    BEGIN
      SELECT enterprise_id INTO resolved FROM person WHERE id = NEW.person_id;
      IF resolved IS NULL THEN RAISE EXCEPTION 'person_external_identity references missing Person'; END IF;
      IF NEW.enterprise_id IS NOT NULL AND NEW.enterprise_id <> resolved THEN
        RAISE EXCEPTION 'person_external_identity enterprise mismatch';
      END IF;
      NEW.enterprise_id := resolved;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER person_external_identity_enterprise_trigger
    BEFORE INSERT OR UPDATE OF person_id, enterprise_id ON person_external_identity
    FOR EACH ROW EXECUTE FUNCTION qianliu_identity_enterprise_guard()
  `.execute(db);

  await db.schema.createTable("organization_membership")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("person_id", "uuid", (c) => c.notNull())
    .addColumn("organization_unit_id", "uuid", (c) => c.notNull())
    .addColumn("is_primary", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("valid_from", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("valid_until", "timestamptz")
    .addColumn("source", "varchar(16)", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.alterTable("organization_membership")
    .addForeignKeyConstraint("organization_membership_person_fk", ["enterprise_id", "person_id"], "person", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("organization_membership")
    .addForeignKeyConstraint("organization_membership_unit_fk", ["enterprise_id", "organization_unit_id"], "organization_unit", ["enterprise_id", "id"])
    .execute();
  await sql`ALTER TABLE organization_membership ADD CONSTRAINT organization_membership_source_check CHECK (source IN ('WECOM','FEISHU','EXCEL'))`.execute(db);
  await sql`ALTER TABLE organization_membership ADD CONSTRAINT organization_membership_period_check CHECK (valid_until IS NULL OR valid_until > valid_from)`.execute(db);
  await sql`ALTER TABLE organization_membership ADD CONSTRAINT organization_membership_version_positive_check CHECK (version > 0)`.execute(db);
  await sql`
    CREATE UNIQUE INDEX organization_membership_current_primary_uq
    ON organization_membership (enterprise_id, person_id)
    WHERE is_primary AND valid_until IS NULL
  `.execute(db);
  await db.schema.createIndex("organization_membership_unit_current_idx")
    .on("organization_membership").columns(["enterprise_id", "organization_unit_id", "valid_until"]).execute();

  await db.schema.createTable("directory_import_run")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("directory_source_id", "uuid")
    .addColumn("mode", "varchar(16)", (c) => c.notNull())
    .addColumn("job_type", "varchar(32)", (c) => c.notNull())
    .addColumn("template_version", "varchar(32)")
    .addColumn("connector_version", "varchar(32)")
    .addColumn("source_snapshot_id", "varchar(255)")
    .addColumn("content_sha256", "varchar(64)")
    .addColumn("request_hash", "varchar(64)", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("created_by_admin_user_id", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("QUEUED"))
    .addColumn("total_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("matched_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("updated_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("conflict_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("skipped_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("failed_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("failure_reason_code", "varchar(64)")
    .addColumn("source_data_at", "timestamptz")
    .addColumn("attempt", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "timestamptz")
    .addColumn("lease_until", "timestamptz")
    .addColumn("started_at", "timestamptz")
    .addColumn("completed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("directory_import_run_idempotency_uq", ["enterprise_id", "idempotency_key"])
    .execute();
  await db.schema.alterTable("directory_import_run")
    .addForeignKeyConstraint("directory_import_run_source_fk", ["enterprise_id", "directory_source_id"], "directory_source", ["enterprise_id", "id"])
    .execute();
  await db.schema.createIndex("directory_import_run_enterprise_id_id_uq")
    .unique().on("directory_import_run").columns(["enterprise_id", "id"]).execute();
  await sql`ALTER TABLE directory_import_run ADD CONSTRAINT directory_import_run_mode_check CHECK (mode IN ('SYNC','EXCEL'))`.execute(db);
  await sql`ALTER TABLE directory_import_run ADD CONSTRAINT directory_import_run_job_check CHECK (job_type IN ('DIRECTORY_SYNC','DIRECTORY_IMPORT_APPLY'))`.execute(db);
  await sql`ALTER TABLE directory_import_run ADD CONSTRAINT directory_import_run_status_check CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED'))`.execute(db);
  await sql`ALTER TABLE directory_import_run ADD CONSTRAINT directory_import_run_count_check CHECK (total_count >= 0 AND matched_count >= 0 AND created_count >= 0 AND updated_count >= 0 AND conflict_count >= 0 AND skipped_count >= 0 AND failed_count >= 0 AND attempt >= 0)`.execute(db);
  await sql`ALTER TABLE directory_import_run ADD CONSTRAINT directory_import_run_source_mode_check CHECK ((mode = 'SYNC' AND directory_source_id IS NOT NULL AND connector_version IS NOT NULL) OR (mode = 'EXCEL' AND directory_source_id IS NULL AND template_version IS NOT NULL AND content_sha256 IS NOT NULL))`.execute(db);
  await sql`
    CREATE INDEX directory_import_run_sync_snapshot_idx
    ON directory_import_run (enterprise_id, directory_source_id, source_snapshot_id, connector_version)
    WHERE mode = 'SYNC' AND source_snapshot_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX directory_import_run_excel_content_idx
    ON directory_import_run (enterprise_id, content_sha256, template_version)
    WHERE mode = 'EXCEL'
  `.execute(db);
  await db.schema.createIndex("directory_import_run_claim_idx")
    .on("directory_import_run").columns(["status", "next_attempt_at", "lease_until", "created_at"]).execute();

  await db.schema.createTable("directory_import_item")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("run_id", "uuid", (c) => c.notNull())
    .addColumn("row_number", "integer", (c) => c.notNull())
    .addColumn("external_member_id", "varchar(128)")
    .addColumn("employee_number", "varchar(64)")
    .addColumn("normalized_name", "varchar(128)")
    .addColumn("normalized_department_path", "varchar(512)")
    .addColumn("normalized_email", "varchar(254)")
    .addColumn("normalized_mobile", "varchar(32)")
    .addColumn("external_department_id", "varchar(255)")
    .addColumn("existing_principal_id", "uuid")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("STAGED"))
    .addColumn("reason_code", "varchar(64)")
    .addColumn("person_id", "uuid")
    .addColumn("principal_id", "uuid")
    .addColumn("organization_unit_id", "uuid")
    .addColumn("attempt", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("lease_until", "timestamptz")
    .addColumn("processed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("directory_import_item_run_row_uq", ["run_id", "row_number"])
    .execute();
  await db.schema.alterTable("directory_import_item")
    .addForeignKeyConstraint("directory_import_item_run_fk", ["enterprise_id", "run_id"], "directory_import_run", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("directory_import_item")
    .addForeignKeyConstraint("directory_import_item_existing_principal_fk", ["enterprise_id", "existing_principal_id"], "principal", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("directory_import_item")
    .addForeignKeyConstraint("directory_import_item_person_fk", ["enterprise_id", "person_id"], "person", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("directory_import_item")
    .addForeignKeyConstraint("directory_import_item_principal_fk", ["enterprise_id", "principal_id"], "principal", ["enterprise_id", "id"])
    .execute();
  await db.schema.alterTable("directory_import_item")
    .addForeignKeyConstraint("directory_import_item_unit_fk", ["enterprise_id", "organization_unit_id"], "organization_unit", ["enterprise_id", "id"])
    .execute();
  await sql`ALTER TABLE directory_import_item ADD CONSTRAINT directory_import_item_row_check CHECK (row_number > 0 AND attempt >= 0)`.execute(db);
  await sql`ALTER TABLE directory_import_item ADD CONSTRAINT directory_import_item_status_check CHECK (status IN ('STAGED','PROCESSING','MATCHED','CREATED','UPDATED','CONFLICT','SKIPPED','FAILED'))`.execute(db);
  await db.schema.createIndex("directory_import_item_claim_idx")
    .on("directory_import_item").columns(["run_id", "status", "lease_until", "row_number"]).execute();
  await db.schema.createIndex("directory_import_item_result_idx")
    .on("directory_import_item").columns(["enterprise_id", "principal_id", "status"]).execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 新业务写入后应关闭 Feature Flag 并前向修复；仅空底座允许破坏性 down。
  const written = await sql`
    SELECT
      (SELECT count(*) FROM directory_import_run) AS runs,
      (SELECT count(*) FROM organization_membership) AS memberships,
      (SELECT count(*) FROM organization_unit) AS units,
      (SELECT count(*) FROM directory_source) AS sources
  `.execute(db);
  const row = written.rows[0];
  if ([row.runs, row.memberships, row.units, row.sources].some((value) => Number(value) > 0)) {
    throw new Error("0046 rollback blocked: directory or organization data exists; disable feature and roll forward");
  }

  await db.schema.dropTable("directory_import_item").execute();
  await db.schema.dropTable("directory_import_run").execute();
  await db.schema.dropTable("organization_membership").execute();

  await sql`DROP TRIGGER person_external_identity_enterprise_trigger ON person_external_identity`.execute(db);
  await sql`DROP FUNCTION qianliu_identity_enterprise_guard()`.execute(db);
  await sql`DROP INDEX person_external_identity_source_person_uq`.execute(db);
  await sql`DROP INDEX person_external_identity_legacy_member_uq`.execute(db);
  await sql`DROP INDEX person_external_identity_source_member_uq`.execute(db);
  await sql`ALTER TABLE person_external_identity DROP CONSTRAINT person_external_identity_provider_check`.execute(db);
  await sql`ALTER TABLE person_external_identity ADD CONSTRAINT person_external_identity_provider_check CHECK (provider = 'WECOM')`.execute(db);
  await db.schema.alterTable("person_external_identity")
    .dropConstraint("person_external_identity_source_fk")
    .execute();
  await db.schema.alterTable("person_external_identity")
    .dropConstraint("person_external_identity_person_enterprise_fk")
    .execute();
  await db.schema.alterTable("person_external_identity")
    .dropConstraint("person_external_identity_enterprise_fk")
    .execute();
  await db.schema.alterTable("person_external_identity")
    .dropColumn("directory_source_id")
    .execute();
  await db.schema.alterTable("person_external_identity")
    .dropColumn("enterprise_id")
    .execute();
  await sql`CREATE UNIQUE INDEX person_external_identity_active_user_uq ON person_external_identity (provider, provider_user_id) WHERE status = 'ACTIVE'`.execute(db);

  await db.schema.dropTable("organization_unit").execute();
  await db.schema.dropTable("directory_source").execute();

  await sql`DROP TRIGGER person_enterprise_default_trigger ON person`.execute(db);
  await sql`DROP FUNCTION qianliu_person_enterprise_default()`.execute(db);
  await sql`DROP INDEX person_employee_number_uq`.execute(db);
  await db.schema.alterTable("principal")
    .dropConstraint("principal_owner_enterprise_fk")
    .execute();
  await db.schema.alterTable("principal")
    .dropConstraint("principal_person_enterprise_fk")
    .execute();
  await sql`DROP INDEX principal_employee_person_uq`.execute(db);
  await db.schema.dropIndex("person_enterprise_id_id_uq").execute();
  await db.schema.alterTable("person")
    .dropConstraint("person_enterprise_fk")
    .execute();
  await db.schema.alterTable("person")
    .dropColumn("mobile")
    .execute();
  await db.schema.alterTable("person").dropColumn("email").execute();
  await db.schema.alterTable("person").dropColumn("employee_number").execute();
  await db.schema.alterTable("person").dropColumn("enterprise_id").execute();
  await db.schema.dropIndex("principal_enterprise_id_id_uq").execute();

  await sql`ALTER TABLE enterprise DROP CONSTRAINT enterprise_currency_format_check`.execute(db);
  await sql`ALTER TABLE enterprise DROP CONSTRAINT enterprise_version_positive_check`.execute(db);
  await db.schema.alterTable("enterprise").dropColumn("version").execute();
  await db.schema.alterTable("enterprise").dropColumn("default_currency").execute();
  await db.schema.alterTable("enterprise").dropColumn("timezone").execute();
}
