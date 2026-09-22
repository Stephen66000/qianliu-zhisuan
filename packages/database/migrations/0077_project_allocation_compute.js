import { sql } from "kysely";

/**
 * 迁移 0077 —— 项目归集计算层（v1.2 计划 §4/§6/§8，候选 C3 合同 10-WP01-contract.md §3）。
 *
 * run/line 只追加：SUCCEEDED/FAILED 后不可变（仅 is_current 可被新批次接管）；
 * 非成功状态禁止 is_current（CHECK）。企业边界全部复合 FK；目标列（零 UUID 哨兵）
 * 由触发器校验同企业 PROJECT 主体。共享组合唯一索引 IF NOT EXISTS 创建、down 保留。
 */
export async function up(db) {
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS operating_bill_version_enterprise_id_uq
    ON operating_bill_version(enterprise_id, id)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS provider_resource_enterprise_id_uq
    ON provider_resource(enterprise_id, id)`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS unified_model_enterprise_id_uq
    ON unified_model(enterprise_id, id)`.execute(db);

  // 1. 归集计算批次：同企业账期至多一个活动任务；当前结果至多一份且必须 SUCCEEDED。
  await sql`CREATE TABLE project_allocation_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL,
    period_month date NOT NULL,
    schema_version text NOT NULL,
    algorithm_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    generation bigint NOT NULL CHECK (generation >= 0),
    input_digest text,
    rule_input_digest text,
    membership_input_digest text,
    manual_attribution_input_digest text,
    source_fact_digest text,
    source_snapshot_as_of timestamptz,
    input_dirty_generation bigint,
    actor_type text NOT NULL CHECK (actor_type IN ('SYSTEM', 'ADMIN')),
    actor_admin_id uuid,
    attempt integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_expires_at timestamptz,
    last_error text,
    is_current boolean NOT NULL DEFAULT false,
    CHECK (NOT is_current OR status = 'SUCCEEDED'),
    source_line_count integer,
    employee_count integer,
    project_count integer,
    conservation jsonb,
    completeness jsonb,
    result_hash text,
    started_at timestamptz,
    finished_at timestamptz,
    duration_ms integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, actor_admin_id) REFERENCES admin_user (enterprise_id, id),
    UNIQUE (enterprise_id, id)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX project_allocation_run_active_uq
    ON project_allocation_run(enterprise_id, period_month) WHERE status IN ('QUEUED', 'RUNNING')`.execute(db);
  await sql`CREATE UNIQUE INDEX project_allocation_run_current_uq
    ON project_allocation_run(enterprise_id, period_month) WHERE is_current`.execute(db);
  await sql`CREATE UNIQUE INDEX project_allocation_run_published_idem_uq
    ON project_allocation_run(enterprise_id, period_month, input_digest, algorithm_version)
    WHERE status = 'SUCCEEDED' AND input_digest IS NOT NULL`.execute(db);
  await sql`CREATE INDEX project_allocation_run_history_idx
    ON project_allocation_run(enterprise_id, period_month, created_at DESC)`.execute(db);
  await sql`CREATE FUNCTION validate_project_allocation_run() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'allocation runs are append-only';
      END IF;
      IF TG_OP = 'UPDATE' THEN
        IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
          IF (to_jsonb(NEW) - 'is_current') IS DISTINCT FROM (to_jsonb(OLD) - 'is_current')
            OR NOT (OLD.is_current AND NOT NEW.is_current) THEN
            RAISE EXCEPTION 'published allocation runs are immutable (only is_current may be closed)';
          END IF;
        ELSE
          IF (to_jsonb(NEW) - 'status' - 'input_digest' - 'rule_input_digest' - 'membership_input_digest'
                - 'manual_attribution_input_digest' - 'source_fact_digest' - 'source_snapshot_as_of'
                - 'input_dirty_generation' - 'attempt' - 'lease_owner' - 'lease_expires_at' - 'last_error'
                - 'is_current' - 'source_line_count' - 'employee_count' - 'project_count' - 'conservation'
                - 'completeness' - 'result_hash' - 'started_at' - 'finished_at' - 'duration_ms' - 'updated_at')
              IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'input_digest' - 'rule_input_digest'
                - 'membership_input_digest' - 'manual_attribution_input_digest' - 'source_fact_digest'
                - 'source_snapshot_as_of' - 'input_dirty_generation' - 'attempt' - 'lease_owner'
                - 'lease_expires_at' - 'last_error' - 'is_current' - 'source_line_count' - 'employee_count'
                - 'project_count' - 'conservation' - 'completeness' - 'result_hash' - 'started_at'
                - 'finished_at' - 'duration_ms' - 'updated_at') THEN
            RAISE EXCEPTION 'allocation run identity is immutable';
          END IF;
          IF NOT (
            (OLD.status = 'QUEUED' AND NEW.status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'))
            OR (OLD.status = 'RUNNING' AND NEW.status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
          ) THEN
            RAISE EXCEPTION 'allocation run status must move forward';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_allocation_run_contract
    BEFORE UPDATE OR DELETE ON project_allocation_run
    FOR EACH ROW EXECUTE FUNCTION validate_project_allocation_run()`.execute(db);

  // 2. 源行归集结果：企业边界复合 FK；目标哨兵列由触发器校验同企业 PROJECT 主体。
  await sql`CREATE TABLE project_allocation_line (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL,
    enterprise_id uuid NOT NULL,
    ledger_line_id uuid NOT NULL,
    ai_request_id uuid NOT NULL,
    upstream_attempt_id uuid NOT NULL,
    provider_resource_id uuid,
    unified_model_id uuid,
    request_started_at timestamptz NOT NULL,
    accounted_at timestamptz NOT NULL,
    source_principal_id uuid NOT NULL,
    target_type text NOT NULL CHECK (target_type IN ('PROJECT', 'UNALLOCATED')),
    target_project_principal_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
    allocation_source text NOT NULL CHECK
      (allocation_source IN ('PROJECT_DIRECT', 'MANUAL_ASSIGNMENT', 'MEMBERSHIP_RULE', 'UNALLOCATED')),
    weight_bps integer,
    policy_id uuid,
    membership_id uuid,
    membership_revision_id uuid,
    segment_from timestamptz,
    segment_until timestamptz,
    unallocated_reason text CHECK (unallocated_reason IS NULL OR unallocated_reason IN (
      'HISTORICAL_UNKNOWN', 'NO_MEMBERSHIP', 'NO_EFFECTIVE_RULE', 'WEIGHT_REMAINDER', 'RULE_PENDING_REPAIR'
    )),
    source_input_tokens bigint NOT NULL,
    source_output_tokens bigint NOT NULL,
    source_cache_tokens bigint,
    source_reasoning_tokens bigint,
    share_input_tokens numeric(24, 4) NOT NULL,
    share_output_tokens numeric(24, 4) NOT NULL,
    share_cache_tokens numeric(24, 4),
    share_reasoning_tokens numeric(24, 4),
    source_api_cost numeric,
    share_api_cost numeric,
    api_cost_currency text,
    source_package_cost numeric,
    share_package_cost numeric,
    package_cost_currency varchar(3) NOT NULL DEFAULT 'CNY' CHECK (package_cost_currency = 'CNY'),
    usage_quality text NOT NULL,
    resource_mode text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, run_id) REFERENCES project_allocation_run (enterprise_id, id),
    FOREIGN KEY (enterprise_id, source_principal_id) REFERENCES principal (enterprise_id, id),
    FOREIGN KEY (enterprise_id, policy_id) REFERENCES employee_project_allocation_policy (enterprise_id, id),
    FOREIGN KEY (enterprise_id, membership_id) REFERENCES project_membership (enterprise_id, id),
    FOREIGN KEY (enterprise_id, membership_revision_id) REFERENCES project_membership_revision (enterprise_id, id),
    FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource (enterprise_id, id),
    FOREIGN KEY (enterprise_id, unified_model_id) REFERENCES unified_model (enterprise_id, id),
    UNIQUE (run_id, ledger_line_id, target_type, target_project_principal_id),
    CHECK ((target_type = 'UNALLOCATED') = (allocation_source = 'UNALLOCATED')),
    CHECK ((allocation_source = 'MEMBERSHIP_RULE') = (weight_bps IS NOT NULL)),
    CHECK ((target_type = 'PROJECT'
        AND target_project_principal_id <> '00000000-0000-0000-0000-000000000000'::uuid)
      OR (target_type = 'UNALLOCATED'
        AND target_project_principal_id = '00000000-0000-0000-0000-000000000000'::uuid))
  )`.execute(db);
  await sql`CREATE INDEX project_allocation_line_by_project_idx
    ON project_allocation_line(run_id, target_project_principal_id)`.execute(db);
  await sql`CREATE INDEX project_allocation_line_unallocated_idx
    ON project_allocation_line(run_id, target_type, unallocated_reason)`.execute(db);
  await sql`CREATE INDEX project_allocation_line_by_source_idx
    ON project_allocation_line(run_id, source_principal_id)`.execute(db);
  await sql`CREATE FUNCTION validate_project_allocation_line() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'allocation lines are immutable within their run';
      END IF;
      IF NEW.target_type = 'PROJECT' AND NOT EXISTS (
        SELECT 1 FROM principal p
        WHERE p.enterprise_id = NEW.enterprise_id AND p.id = NEW.target_project_principal_id
          AND p.type = 'PROJECT'
      ) THEN
        RAISE EXCEPTION 'allocation line target must be a PROJECT principal of the same enterprise';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_allocation_line_contract
    BEFORE INSERT OR UPDATE OR DELETE ON project_allocation_line
    FOR EACH ROW EXECUTE FUNCTION validate_project_allocation_line()`.execute(db);

  // 3. 启用登记、脏代次与按企业补偿扫描水位。
  await sql`CREATE TABLE project_allocation_period (
    enterprise_id uuid NOT NULL,
    period_month date NOT NULL,
    enabled_by uuid NOT NULL,
    enabled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (enterprise_id, period_month),
    FOREIGN KEY (enterprise_id, enabled_by) REFERENCES admin_user (enterprise_id, id)
  )`.execute(db);
  await sql`CREATE TABLE project_allocation_dirty (
    enterprise_id uuid NOT NULL,
    period_month date NOT NULL,
    generation bigint NOT NULL DEFAULT 0,
    dirty boolean NOT NULL DEFAULT false,
    last_marked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (enterprise_id, period_month)
  )`.execute(db);
  await sql`CREATE TABLE project_allocation_scan_watermark (
    enterprise_id uuid PRIMARY KEY,
    ledger_line_watermark timestamptz NOT NULL DEFAULT '1970-01-01',
    updated_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);

  // 4. 资源级套餐待分配成本（无源行可承接的月费余量，不伪造 Token）。
  await sql`CREATE TABLE project_allocation_resource_residual (
    run_id uuid NOT NULL,
    provider_resource_id uuid NOT NULL,
    enterprise_id uuid NOT NULL,
    amount numeric(24, 8) NOT NULL,
    currency varchar(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, provider_resource_id),
    FOREIGN KEY (enterprise_id, run_id) REFERENCES project_allocation_run (enterprise_id, id),
    FOREIGN KEY (enterprise_id, provider_resource_id) REFERENCES provider_resource (enterprise_id, id)
  )`.execute(db);
  await sql`CREATE FUNCTION validate_project_allocation_resource_residual() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'resource residual rows are immutable within their run';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER project_allocation_resource_residual_contract
    BEFORE INSERT OR UPDATE OR DELETE ON project_allocation_resource_residual
    FOR EACH ROW EXECUTE FUNCTION validate_project_allocation_resource_residual()`.execute(db);

  // 5. 账单冻结引用：只存不可变 run 引用与核对摘要；RESTRICT 保护被引用 run。
  await sql`CREATE TABLE operating_bill_project_allocation_ref (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL,
    bill_version_id uuid NOT NULL,
    run_id uuid NOT NULL,
    frozen jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (enterprise_id, bill_version_id) REFERENCES operating_bill_version (enterprise_id, id) ON DELETE CASCADE,
    FOREIGN KEY (enterprise_id, run_id) REFERENCES project_allocation_run (enterprise_id, id) ON DELETE RESTRICT,
    UNIQUE (bill_version_id)
  )`.execute(db);
  await sql`CREATE INDEX operating_bill_project_allocation_ref_run_idx
    ON operating_bill_project_allocation_ref(run_id)`.execute(db);
  await sql`CREATE FUNCTION validate_bill_allocation_ref() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'bill allocation references are immutable';
      END IF;
      RETURN NEW;
    END $fn$`.execute(db);
  await sql`CREATE TRIGGER operating_bill_project_allocation_ref_contract
    BEFORE INSERT OR UPDATE OR DELETE ON operating_bill_project_allocation_ref
    FOR EACH ROW EXECUTE FUNCTION validate_bill_allocation_ref()`.execute(db);
}

export async function down(db) {
  const guards = [
    "project_allocation_line",
    "project_allocation_resource_residual",
    "project_allocation_run",
  ];
  for (const table of guards) {
    const data = await sql.raw(`SELECT 1 FROM ${table} LIMIT 1`).execute(db);
    if (data.rows.length) throw new Error(`Cannot drop ${table} with data`);
  }
  await sql`DROP TRIGGER operating_bill_project_allocation_ref_contract ON operating_bill_project_allocation_ref`.execute(db);
  await sql`DROP FUNCTION validate_bill_allocation_ref`.execute(db);
  await sql`DROP TABLE operating_bill_project_allocation_ref`.execute(db);
  await sql`DROP TRIGGER project_allocation_resource_residual_contract ON project_allocation_resource_residual`.execute(db);
  await sql`DROP FUNCTION validate_project_allocation_resource_residual`.execute(db);
  await sql`DROP TABLE project_allocation_resource_residual`.execute(db);
  await sql`DROP TABLE project_allocation_scan_watermark`.execute(db);
  await sql`DROP TABLE project_allocation_dirty`.execute(db);
  await sql`DROP TABLE project_allocation_period`.execute(db);
  await sql`DROP TRIGGER project_allocation_line_contract ON project_allocation_line`.execute(db);
  await sql`DROP FUNCTION validate_project_allocation_line`.execute(db);
  await sql`DROP TABLE project_allocation_line`.execute(db);
  await sql`DROP TRIGGER project_allocation_run_contract ON project_allocation_run`.execute(db);
  await sql`DROP FUNCTION validate_project_allocation_run`.execute(db);
  await sql`DROP TABLE project_allocation_run`.execute(db);
  // 保守回退：operating_bill_version / provider_resource / unified_model 的
  // (enterprise_id, id) 组合唯一索引为共享基础设施，down 不删除。
}
