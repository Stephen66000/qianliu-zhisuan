import { sql } from "kysely";

/**
 * 迁移 0079 —— 项目归集管理层（UAT 已执行 Kimi 0076–0078 后顺延；v1.2 计划 §3/§6）。
 *
 * 管理归集层新表：不修改 principal/ledger/usage/operating_bill 既有列，不回写原始事实。
 * 历史不可变约束沿用 0065 触发器范式：版本行禁 DELETE；UPDATE 仅允许指针列单向关闭。
 * 跨表引用一律复合 (enterprise_id, id) 外键；共享基础设施以 IF NOT EXISTS 创建、down 保守保留。
 */
export async function up(db) {
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS principal_enterprise_id_uq ON principal(enterprise_id, id)`.execute(db);

  // 1. 项目核算生命周期版本：核算起止与调用 status 分离，结束归集不撤 Key。
  await sql`CREATE TABLE project_accounting_profile_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL,
    project_principal_id uuid NOT NULL,
    accounting_started_at timestamptz NOT NULL,
    accounting_ended_at timestamptz,
    version integer NOT NULL CHECK (version > 0),
    is_current boolean NOT NULL DEFAULT true,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, project_principal_id) REFERENCES principal (enterprise_id, id),
    FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user (enterprise_id, id),
    UNIQUE (enterprise_id, project_principal_id, version),
    CHECK (accounting_ended_at IS NULL OR accounting_ended_at > accounting_started_at)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX project_accounting_profile_current_uq
    ON project_accounting_profile_version(enterprise_id, project_principal_id) WHERE is_current`.execute(db);
  await sql`CREATE INDEX project_accounting_profile_history_idx
    ON project_accounting_profile_version(enterprise_id, project_principal_id, version DESC)`.execute(db);
  await sql`CREATE FUNCTION validate_project_accounting_profile() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'project accounting history is immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current')
          OR NOT (OLD.is_current AND NOT NEW.is_current) THEN
          RAISE EXCEPTION 'project accounting history is immutable';
        END IF;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM principal
        WHERE enterprise_id = NEW.enterprise_id AND id = NEW.project_principal_id AND type = 'PROJECT'
      ) THEN
        RAISE EXCEPTION 'accounting profile requires a PROJECT principal';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_accounting_profile_contract
    BEFORE INSERT OR UPDATE OR DELETE ON project_accounting_profile_version
    FOR EACH ROW EXECUTE FUNCTION validate_project_accounting_profile()`.execute(db);

  // 2. 成员参与身份（稳定 stint）与不可变修订。
  // 修订行冗余 employee/project 主体列：供区间排他与索引使用。
  await sql`CREATE TABLE project_membership (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL,
    project_principal_id uuid NOT NULL,
    employee_principal_id uuid NOT NULL,
    stint_index integer NOT NULL CHECK (stint_index > 0),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, project_principal_id) REFERENCES principal (enterprise_id, id),
    FOREIGN KEY (enterprise_id, employee_principal_id) REFERENCES principal (enterprise_id, id),
    FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user (enterprise_id, id),
    UNIQUE (enterprise_id, id),
    UNIQUE (enterprise_id, project_principal_id, employee_principal_id, stint_index)
  )`.execute(db);
  await sql`CREATE INDEX project_membership_by_employee_idx
    ON project_membership(enterprise_id, employee_principal_id)`.execute(db);
  await sql`CREATE FUNCTION validate_project_membership() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'membership identities are immutable';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM principal
        WHERE enterprise_id = NEW.enterprise_id AND id = NEW.project_principal_id AND type = 'PROJECT'
      ) OR NOT EXISTS (
        SELECT 1 FROM principal
        WHERE enterprise_id = NEW.enterprise_id AND id = NEW.employee_principal_id AND type = 'EMPLOYEE'
      ) THEN
        RAISE EXCEPTION 'membership requires a PROJECT project principal and an EMPLOYEE employee principal';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_membership_contract
    BEFORE INSERT OR UPDATE OR DELETE ON project_membership
    FOR EACH ROW EXECUTE FUNCTION validate_project_membership()`.execute(db);

  await sql`CREATE TABLE project_membership_revision (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id uuid NOT NULL,
    enterprise_id uuid NOT NULL,
    project_principal_id uuid NOT NULL,
    employee_principal_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'VOID')),
    joined_at timestamptz NOT NULL,
    left_at timestamptz,
    idempotency_key text,
    reason text NOT NULL,
    supersedes_id uuid,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, membership_id) REFERENCES project_membership (enterprise_id, id),
    FOREIGN KEY (enterprise_id, supersedes_id) REFERENCES project_membership_revision (enterprise_id, id),
    FOREIGN KEY (enterprise_id, created_by) REFERENCES admin_user (enterprise_id, id),
    UNIQUE (enterprise_id, id),
    UNIQUE (membership_id, revision),
    CHECK (left_at IS NULL OR left_at > joined_at),
    CHECK ((revision = 1 AND supersedes_id IS NULL) OR (revision > 1 AND supersedes_id IS NOT NULL))
  )`.execute(db);
  // 同项目+员工的有效区间不重叠；仅约束 ACTIVE 行，历史修订允许时间覆盖。
  await sql`ALTER TABLE project_membership_revision ADD CONSTRAINT project_membership_revision_active_interval_excl
    EXCLUDE USING gist (
      project_principal_id WITH =,
      employee_principal_id WITH =,
      tstzrange(joined_at, COALESCE(left_at, 'infinity'::timestamptz)) WITH &&
    ) WHERE (status = 'ACTIVE')`.execute(db);
  await sql`CREATE UNIQUE INDEX project_membership_revision_idem_uq
    ON project_membership_revision(enterprise_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.execute(db);
  await sql`CREATE INDEX project_membership_revision_interval_idx
    ON project_membership_revision(enterprise_id, employee_principal_id, joined_at, left_at)`.execute(db);
  await sql`CREATE INDEX project_membership_revision_project_interval_idx
    ON project_membership_revision(enterprise_id, project_principal_id, joined_at, left_at)`.execute(db);
  await sql`CREATE FUNCTION validate_project_membership_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'membership history is immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status')
          OR NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('SUPERSEDED', 'VOID')) THEN
          RAISE EXCEPTION 'membership history is immutable';
        END IF;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM project_membership m
        JOIN principal emp ON emp.enterprise_id = m.enterprise_id AND emp.id = m.employee_principal_id
        WHERE m.id = NEW.membership_id AND m.enterprise_id = NEW.enterprise_id
          AND m.project_principal_id = NEW.project_principal_id
          AND m.employee_principal_id = NEW.employee_principal_id
          AND emp.type = 'EMPLOYEE'
      ) THEN
        RAISE EXCEPTION 'membership revision must match an EMPLOYEE membership of the same enterprise';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_membership_revision_contract
    BEFORE INSERT OR UPDATE OR DELETE ON project_membership_revision
    FOR EACH ROW EXECUTE FUNCTION validate_project_membership_revision()`.execute(db);

  // 3. 员工级归集规则集合（整组原子发布）与集合内权重段。
  await sql`CREATE TABLE employee_project_allocation_policy (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL,
    employee_principal_id uuid NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    is_current boolean NOT NULL DEFAULT true,
    input_hash text NOT NULL,
    idempotency_key text,
    reason text NOT NULL,
    published_by uuid NOT NULL,
    published_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, employee_principal_id) REFERENCES principal (enterprise_id, id),
    FOREIGN KEY (enterprise_id, published_by) REFERENCES admin_user (enterprise_id, id),
    UNIQUE (enterprise_id, id),
    UNIQUE (enterprise_id, employee_principal_id, version)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX employee_project_allocation_policy_current_uq
    ON employee_project_allocation_policy(enterprise_id, employee_principal_id) WHERE is_current`.execute(db);
  await sql`CREATE UNIQUE INDEX employee_project_allocation_policy_idem_uq
    ON employee_project_allocation_policy(enterprise_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.execute(db);
  await sql`CREATE FUNCTION validate_employee_allocation_policy() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'allocation policy versions are immutable';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current')
          OR NOT (OLD.is_current AND NOT NEW.is_current) THEN
          RAISE EXCEPTION 'allocation policy versions are immutable';
        END IF;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM principal
        WHERE enterprise_id = NEW.enterprise_id AND id = NEW.employee_principal_id AND type = 'EMPLOYEE'
      ) THEN
        RAISE EXCEPTION 'allocation policy requires an EMPLOYEE principal';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER employee_project_allocation_policy_contract
    BEFORE INSERT OR UPDATE OR DELETE ON employee_project_allocation_policy
    FOR EACH ROW EXECUTE FUNCTION validate_employee_allocation_policy()`.execute(db);

  // 权重段不可变；复合 FK 锁 policy/membership/revision 同企业；触发器校验归属与区间包含。
  await sql`CREATE TABLE employee_project_allocation_rule (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id uuid NOT NULL,
    enterprise_id uuid NOT NULL,
    employee_principal_id uuid NOT NULL,
    project_principal_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    membership_revision_id uuid NOT NULL,
    weight_bps integer NOT NULL CHECK (weight_bps >= 0 AND weight_bps <= 10000),
    valid_from timestamptz NOT NULL,
    valid_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, policy_id) REFERENCES employee_project_allocation_policy (enterprise_id, id),
    FOREIGN KEY (enterprise_id, membership_id) REFERENCES project_membership (enterprise_id, id),
    FOREIGN KEY (enterprise_id, membership_revision_id) REFERENCES project_membership_revision (enterprise_id, id),
    FOREIGN KEY (enterprise_id, project_principal_id) REFERENCES principal (enterprise_id, id),
    CHECK (valid_until IS NULL OR valid_until > valid_from)
  )`.execute(db);
  await sql`CREATE INDEX employee_project_allocation_rule_by_policy_idx
    ON employee_project_allocation_rule(policy_id)`.execute(db);
  await sql`CREATE INDEX employee_project_allocation_rule_by_employee_idx
    ON employee_project_allocation_rule(enterprise_id, employee_principal_id, valid_from)`.execute(db);
  await sql`CREATE INDEX employee_project_allocation_rule_by_project_idx
    ON employee_project_allocation_rule(enterprise_id, project_principal_id, valid_from)`.execute(db);
  await sql`CREATE FUNCTION validate_employee_allocation_rule() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE
      revision_row project_membership_revision%ROWTYPE;
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'published allocation rules are immutable';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM project_membership m
        WHERE m.id = NEW.membership_id AND m.enterprise_id = NEW.enterprise_id
          AND m.employee_principal_id = NEW.employee_principal_id
          AND m.project_principal_id = NEW.project_principal_id
      ) THEN
        RAISE EXCEPTION 'allocation rule must reference its own membership';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM employee_project_allocation_policy p
        WHERE p.id = NEW.policy_id AND p.enterprise_id = NEW.enterprise_id
          AND p.employee_principal_id = NEW.employee_principal_id
      ) THEN
        RAISE EXCEPTION 'allocation rule policy must belong to the same employee';
      END IF;
      SELECT * INTO revision_row FROM project_membership_revision
        WHERE id = NEW.membership_revision_id;
      IF revision_row.membership_id IS DISTINCT FROM NEW.membership_id
        OR revision_row.enterprise_id IS DISTINCT FROM NEW.enterprise_id
        OR revision_row.employee_principal_id IS DISTINCT FROM NEW.employee_principal_id
        OR revision_row.project_principal_id IS DISTINCT FROM NEW.project_principal_id
        OR revision_row.status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'allocation rule must reference the ACTIVE revision of its membership';
      END IF;
      IF revision_row.joined_at > NEW.valid_from
        OR (NEW.valid_until IS NULL AND revision_row.left_at IS NOT NULL)
        OR (NEW.valid_until IS NOT NULL AND revision_row.left_at IS NOT NULL
          AND NEW.valid_until > revision_row.left_at) THEN
        RAISE EXCEPTION 'allocation rule interval must be covered by its membership revision interval';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER employee_project_allocation_rule_contract
    BEFORE INSERT OR UPDATE OR DELETE ON employee_project_allocation_rule
    FOR EACH ROW EXECUTE FUNCTION validate_employee_allocation_rule()`.execute(db);
}

export async function down(db) {
  const guards = [
    "employee_project_allocation_rule",
    "employee_project_allocation_policy",
    "project_membership_revision",
    "project_membership",
    "project_accounting_profile_version",
  ];
  for (const table of guards) {
    const data = await sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(db);
    if (data.rows.length) throw new Error(`Cannot drop ${table} with data`);
  }
  await sql`DROP TRIGGER employee_project_allocation_rule_contract ON employee_project_allocation_rule`.execute(db);
  await sql`DROP FUNCTION validate_employee_allocation_rule`.execute(db);
  await sql`DROP TABLE employee_project_allocation_rule`.execute(db);
  await sql`DROP TRIGGER employee_project_allocation_policy_contract ON employee_project_allocation_policy`.execute(db);
  await sql`DROP FUNCTION validate_employee_allocation_policy`.execute(db);
  await sql`DROP TABLE employee_project_allocation_policy`.execute(db);
  await sql`DROP TRIGGER project_membership_revision_contract ON project_membership_revision`.execute(db);
  await sql`DROP FUNCTION validate_project_membership_revision`.execute(db);
  await sql`DROP TABLE project_membership_revision`.execute(db);
  await sql`DROP TRIGGER project_membership_contract ON project_membership`.execute(db);
  await sql`DROP FUNCTION validate_project_membership`.execute(db);
  await sql`DROP TABLE project_membership`.execute(db);
  await sql`DROP TRIGGER project_accounting_profile_contract ON project_accounting_profile_version`.execute(db);
  await sql`DROP FUNCTION validate_project_accounting_profile`.execute(db);
  await sql`DROP TABLE project_accounting_profile_version`.execute(db);
  // 保守回退：principal_enterprise_id_uq 与 btree_gist 为共享基础设施，down 不删除。
}
