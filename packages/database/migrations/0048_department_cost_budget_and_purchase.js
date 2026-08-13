/**
 * 2.0 / W20-06~07：部门归属快照、月度预算与资源采购记录。
 *
 * 请求归属和采购记录不可覆盖；修正归属只能追加更高版本。
 * 部门预算仅是经营预警分母，不进入 Gateway 热路径。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // 新增表的所有业务外键都带 enterprise_id，防止合法 UUID 被跨租户组合。
  await db.schema.createIndex("ai_request_enterprise_id_id_uq")
    .unique().on("ai_request").columns(["enterprise_id", "id"]).execute();
  await db.schema
    .createTable("project_department_assignment")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("project_principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("organization_unit_id", "uuid", (c) => c.notNull().references("organization_unit.id"))
    .addColumn("valid_from", "timestamptz", (c) => c.notNull())
    .addColumn("valid_until", "timestamptz")
    .addColumn("source", "varchar(40)", (c) => c.notNull())
    .addColumn("owner_person_id_at_assignment", "uuid", (c) => c.references("person.id"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("created_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("reason", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE project_department_assignment
      ADD CONSTRAINT project_department_assignment_project_tenant_fk
        FOREIGN KEY (enterprise_id, project_principal_id)
        REFERENCES principal (enterprise_id, id),
      ADD CONSTRAINT project_department_assignment_unit_tenant_fk
        FOREIGN KEY (enterprise_id, organization_unit_id)
        REFERENCES organization_unit (enterprise_id, id),
      ADD CONSTRAINT project_department_assignment_owner_tenant_fk
        FOREIGN KEY (enterprise_id, owner_person_id_at_assignment)
        REFERENCES person (enterprise_id, id)
  `.execute(db);
  await sql`
    ALTER TABLE project_department_assignment
      ADD CONSTRAINT project_department_assignment_source_check
        CHECK (source IN ('EXPLICIT', 'OWNER_DEPARTMENT_DEFAULT')),
      ADD CONSTRAINT project_department_assignment_range_check
        CHECK (valid_until IS NULL OR valid_until > valid_from),
      ADD CONSTRAINT project_department_assignment_version_check CHECK (version > 0)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX project_department_assignment_current_uq
      ON project_department_assignment (enterprise_id, project_principal_id)
      WHERE valid_until IS NULL
  `.execute(db);
  await db.schema
    .createIndex("project_department_assignment_lookup_idx")
    .on("project_department_assignment")
    .columns(["enterprise_id", "project_principal_id", "valid_from", "valid_until"])
    .execute();
  await db.schema
    .createTable("request_attribution_snapshot")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("source_principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("employee_person_id", "uuid", (c) => c.references("person.id"))
    .addColumn("project_principal_id", "uuid", (c) => c.references("principal.id"))
    .addColumn("organization_unit_id", "uuid", (c) => c.references("organization_unit.id"))
    .addColumn("cost_category", "varchar(24)", (c) => c.notNull())
    .addColumn("attribution_source", "varchar(40)", (c) => c.notNull())
    .addColumn("request_occurred_at", "timestamptz", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("supersedes_id", "uuid", (c) => c.references("request_attribution_snapshot.id"))
    .addColumn("snapshot_origin", "varchar(32)", (c) => c.notNull().defaultTo("RUNTIME"))
    .addColumn("reason_code", "varchar(64)")
    .addColumn("created_by", "uuid", (c) => c.references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`
    ALTER TABLE request_attribution_snapshot
      ADD CONSTRAINT request_attribution_snapshot_request_tenant_fk
        FOREIGN KEY (enterprise_id, ai_request_id)
        REFERENCES ai_request (enterprise_id, id),
      ADD CONSTRAINT request_attribution_snapshot_source_tenant_fk
        FOREIGN KEY (enterprise_id, source_principal_id)
        REFERENCES principal (enterprise_id, id),
      ADD CONSTRAINT request_attribution_snapshot_employee_tenant_fk
        FOREIGN KEY (enterprise_id, employee_person_id)
        REFERENCES person (enterprise_id, id),
      ADD CONSTRAINT request_attribution_snapshot_project_tenant_fk
        FOREIGN KEY (enterprise_id, project_principal_id)
        REFERENCES principal (enterprise_id, id),
      ADD CONSTRAINT request_attribution_snapshot_unit_tenant_fk
        FOREIGN KEY (enterprise_id, organization_unit_id)
        REFERENCES organization_unit (enterprise_id, id)
  `.execute(db);
  await sql`
    ALTER TABLE request_attribution_snapshot
      ADD CONSTRAINT request_attribution_snapshot_category_check
        CHECK (cost_category IN ('EMPLOYEE_DIRECT', 'PROJECT', 'UNASSIGNED')),
      ADD CONSTRAINT request_attribution_snapshot_source_check
        CHECK (attribution_source IN (
          'PROJECT_DIRECT', 'EMPLOYEE_PROJECT', 'EMPLOYEE_MEMBERSHIP', 'UNASSIGNED'
        )),
      ADD CONSTRAINT request_attribution_snapshot_origin_check
        CHECK (snapshot_origin IN ('MIGRATION_BACKFILL', 'RUNTIME', 'CORRECTION')),
      ADD CONSTRAINT request_attribution_snapshot_version_check CHECK (version > 0),
      ADD CONSTRAINT request_attribution_snapshot_v1_chain_check
        CHECK ((version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL))
  `.execute(db);
  await db.schema
    .createIndex("request_attribution_snapshot_request_version_uq")
    .unique()
    .on("request_attribution_snapshot")
    .columns(["enterprise_id", "ai_request_id", "version"])
    .execute();
  await sql`
    CREATE UNIQUE INDEX request_attribution_snapshot_supersedes_uq
      ON request_attribution_snapshot (supersedes_id)
      WHERE supersedes_id IS NOT NULL
  `.execute(db);
  await db.schema
    .createIndex("request_attribution_snapshot_current_idx")
    .on("request_attribution_snapshot")
    .columns(["enterprise_id", "ai_request_id", "version"])
    .execute();
  await db.schema
    .createIndex("request_attribution_snapshot_department_month_idx")
    .on("request_attribution_snapshot")
    .columns(["enterprise_id", "organization_unit_id", "request_occurred_at"])
    .execute();

  await db.schema
    .createTable("department_budget")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("organization_unit_id", "uuid", (c) => c.notNull().references("organization_unit.id"))
    .addColumn("month", "date", (c) => c.notNull())
    .addColumn("currency", "varchar(8)", (c) => c.notNull())
    .addColumn("amount", "numeric(24, 8)", (c) => c.notNull())
    .addColumn("warning_threshold", "numeric(9, 8)", (c) => c.notNull().defaultTo("0.80000000"))
    .addColumn("version", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("updated_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.alterTable("department_budget")
    .addForeignKeyConstraint(
      "department_budget_unit_tenant_fk",
      ["enterprise_id", "organization_unit_id"], "organization_unit", ["enterprise_id", "id"],
    )
    .execute();
  await sql`
    ALTER TABLE department_budget
      ADD CONSTRAINT department_budget_month_check
        CHECK (month = date_trunc('month', month)::date),
      ADD CONSTRAINT department_budget_amount_check CHECK (amount >= 0),
      ADD CONSTRAINT department_budget_threshold_check
        CHECK (warning_threshold > 0 AND warning_threshold <= 1),
      ADD CONSTRAINT department_budget_version_check CHECK (version > 0)
  `.execute(db);
  await db.schema
    .createIndex("department_budget_enterprise_department_month_uq")
    .unique()
    .on("department_budget")
    .columns(["enterprise_id", "organization_unit_id", "month"])
    .execute();
  await db.schema
    .createIndex("department_budget_enterprise_month_idx")
    .on("department_budget")
    .columns(["enterprise_id", "month"])
    .execute();

  await db.schema
    .createTable("department_budget_idempotency")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("organization_unit_id", "uuid", (c) => c.notNull().references("organization_unit.id"))
    .addColumn("month", "date", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("department_budget_idempotency_pk", [
      "enterprise_id", "organization_unit_id", "month", "idempotency_key",
    ])
    .execute();
  await db.schema.alterTable("department_budget_idempotency")
    .addForeignKeyConstraint(
      "department_budget_idempotency_unit_tenant_fk",
      ["enterprise_id", "organization_unit_id"], "organization_unit", ["enterprise_id", "id"],
    )
    .execute();

  await db.schema
    .createTable("resource_purchase_record")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("purchase_type", "varchar(32)", (c) => c.notNull())
    .addColumn("description", "varchar(255)")
    .addColumn("amount", "numeric(24, 8)", (c) => c.notNull())
    .addColumn("currency", "varchar(8)", (c) => c.notNull())
    .addColumn("purchased_at", "timestamptz", (c) => c.notNull())
    .addColumn("service_period_start", "date")
    .addColumn("service_period_end", "date")
    .addColumn("source", "varchar(24)", (c) => c.notNull().defaultTo("ADMIN"))
    .addColumn("evidence_ref", "text")
    .addColumn("created_by", "uuid", (c) => c.notNull().references("admin_user.id"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint(
      "resource_purchase_record_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await sql`
    ALTER TABLE resource_purchase_record
      ADD CONSTRAINT resource_purchase_record_type_check
        CHECK (purchase_type IN ('API_RECHARGE', 'PACKAGE_PURCHASE')),
      ADD CONSTRAINT resource_purchase_record_amount_check CHECK (amount > 0),
      ADD CONSTRAINT resource_purchase_record_period_check CHECK (
        (service_period_start IS NULL AND service_period_end IS NULL)
        OR (service_period_start IS NOT NULL AND service_period_end IS NOT NULL
            AND service_period_end >= service_period_start)
      ),
      ADD CONSTRAINT resource_purchase_record_source_check
        CHECK (source IN ('ADMIN', 'IMPORT', 'PROVIDER_SYNC'))
  `.execute(db);
  await db.schema
    .createIndex("resource_purchase_record_enterprise_resource_time_idx")
    .on("resource_purchase_record")
    .columns(["enterprise_id", "provider_resource_id", "purchased_at"])
    .execute();
  await db.schema
    .createIndex("resource_purchase_record_enterprise_time_idx")
    .on("resource_purchase_record")
    .columns(["enterprise_id", "purchased_at"])
    .execute();

  await db.schema
    .createTable("resource_purchase_idempotency")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "char(64)", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("resource_purchase_idempotency_pk", [
      "enterprise_id", "provider_resource_id", "idempotency_key",
    ])
    .addForeignKeyConstraint(
      "resource_purchase_idempotency_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();

  await sql`
    CREATE FUNCTION w20_reject_immutable_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END;
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER request_attribution_snapshot_immutable
      BEFORE UPDATE OR DELETE ON request_attribution_snapshot
      FOR EACH ROW EXECUTE FUNCTION w20_reject_immutable_mutation()
  `.execute(db);
  await sql`
    CREATE TRIGGER resource_purchase_record_immutable
      BEFORE UPDATE OR DELETE ON resource_purchase_record
      FOR EACH ROW EXECUTE FUNCTION w20_reject_immutable_mutation()
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM project_department_assignment)
         OR EXISTS (SELECT 1 FROM request_attribution_snapshot)
         OR EXISTS (SELECT 1 FROM department_budget)
         OR EXISTS (SELECT 1 FROM resource_purchase_record) THEN
        RAISE EXCEPTION '0048 contains 2.0 attribution/budget/purchase writes; destructive down is disabled';
      END IF;
    END;
    $$
  `.execute(db);
  await db.schema.dropTable("resource_purchase_idempotency").ifExists().execute();
  await db.schema.dropTable("resource_purchase_record").ifExists().execute();
  await db.schema.dropTable("department_budget_idempotency").ifExists().execute();
  await db.schema.dropTable("department_budget").ifExists().execute();
  await db.schema.dropTable("request_attribution_snapshot").ifExists().execute();
  await db.schema.dropTable("project_department_assignment").ifExists().execute();
  await db.schema.dropIndex("ai_request_enterprise_id_id_uq").ifExists().execute();
  await sql`DROP FUNCTION IF EXISTS w20_reject_immutable_mutation()`.execute(db);
}
