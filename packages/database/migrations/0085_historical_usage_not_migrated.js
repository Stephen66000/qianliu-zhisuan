/**
 * 0085：历史用量导入兼容 Schema（加法迁移）。
 *
 * 业务背景：Mac Mini 旧库 29,318 条请求需导入阿里云新库，但其 API 金额
 * 按 Owner 决策明确不迁移。需要显式状态 NOT_MIGRATED（"根据 Owner 决策该
 * 历史区间的金额明确不迁移"），统一覆盖 ledger_line、ledger_transaction、
 * 用量聚合与 API 读模型。
 *
 * 核心设计（严格遵守任务书与审计要求）：
 *  1. historical_import_run: 增加不可变导入运行表，记录 run_id、manifest_hash、
 *     source_package_hash、导入窗口、基线摘要、pre/post 快照与状态机保护触发器。
 *  2. historical_import_run_item: 增加实体导入归属表，精确记录每个导入实体 ID
 *     及其规范化摘要，附带 UNIQUE(entity_type, entity_id) 防止实体归属漂移。
 *  3. ai_request: 新增 import_source varchar(32) 与 import_run_id uuid，
 *     强制要求历史导入行必须挂接处于 RUNNING 状态的合法运行记录。
 *  4. ledger_line: 扩展 api_cost_status 支持 'NOT_MIGRATED'；shape 约束要求
 *     API 模式为 NOT_MIGRATED + NULL；Coding Plan 模式为 NOT_APPLICABLE + NULL。
 *  5. ledger_transaction: 新增显式 api_cost_status varchar(40) 列及 CHECK 约束；
 *     total_api_cost DROP NOT NULL，根据子行准确推导回填；兼容既有 Coding Plan 0 与新导入 NULL。
 *     绝不改写现有线上任何金额！
 *  6. usage_bucket_aggregate: 新增显式 api_cost_status varchar(40) 列及 CHECK 约束；
 *     api_cost DROP NOT NULL，Coding Plan 模式兼容既有 0 与新导入 NULL。绝不改写现有金额！
 *  7. provider_finance 严格触发器：保持完全启用。仅对挂接了有效 RUNNING import_run 的历史行
 *     开辟受约束免期初校验路径，一旦 run 达到终态 COMPLETED 则严格拒绝任何借旧 run 写入。
 *  8. down 过程严格 fail-closed：若存在任何导入数据、运行记录或 NOT_MIGRATED 行，必须拒绝回退。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // 1. 创建不可变 historical_import_run 表与状态机触发器
  await sql`
    CREATE TABLE historical_import_run (
      id uuid PRIMARY KEY,
      enterprise_id uuid NOT NULL REFERENCES enterprise(id),
      manifest_hash varchar(64) NOT NULL,
      source_package_hash varchar(64) NOT NULL,
      source_system varchar(32) NOT NULL DEFAULT 'LEGACY_MAC_MINI',
      window_start timestamptz NOT NULL,
      window_end timestamptz NOT NULL,
      total_requests integer NOT NULL,
      request_id_digest varchar(64) NOT NULL,
      input_tokens bigint NOT NULL,
      output_tokens bigint NOT NULL,
      cache_tokens bigint NOT NULL,
      reasoning_tokens bigint NOT NULL,
      status varchar(32) NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
      pre_cutover_snapshot jsonb,
      post_cutover_snapshot jsonb,
      pre_finance_snapshot jsonb,
      post_finance_snapshot jsonb,
      baseline_summary jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      rolled_back_at timestamptz,
      rollback_summary jsonb,
      CONSTRAINT uq_historical_import_run_identity UNIQUE (enterprise_id, manifest_hash, source_package_hash)
    );

    CREATE INDEX historical_import_run_ent_status_idx
      ON historical_import_run (enterprise_id, status);

    CREATE OR REPLACE FUNCTION historical_import_run_state_guard() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'historical_import_run records cannot be deleted';
      END IF;

      -- 基线、身份、快照、初始时间字段完全不可篡改
      IF OLD.id <> NEW.id OR OLD.enterprise_id <> NEW.enterprise_id
         OR OLD.manifest_hash <> NEW.manifest_hash
         OR OLD.source_package_hash <> NEW.source_package_hash
         OR OLD.source_system <> NEW.source_system
         OR OLD.window_start <> NEW.window_start
         OR OLD.window_end <> NEW.window_end
         OR OLD.total_requests <> NEW.total_requests
         OR OLD.request_id_digest <> NEW.request_id_digest
         OR OLD.input_tokens <> NEW.input_tokens
         OR OLD.output_tokens <> NEW.output_tokens
         OR OLD.cache_tokens <> NEW.cache_tokens
         OR OLD.reasoning_tokens <> NEW.reasoning_tokens
         OR OLD.baseline_summary::text <> NEW.baseline_summary::text
         OR OLD.pre_cutover_snapshot::text IS DISTINCT FROM NEW.pre_cutover_snapshot::text
         OR OLD.pre_finance_snapshot::text IS DISTINCT FROM NEW.pre_finance_snapshot::text
         OR OLD.started_at <> NEW.started_at
         OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'Baseline, identity, and pre-snapshots of historical_import_run cannot be modified';
      END IF;

      -- 状态机受控流转约束
      IF OLD.status = 'RUNNING' THEN
        IF NEW.status = 'COMPLETED' THEN
          IF NEW.completed_at IS NULL THEN
            RAISE EXCEPTION 'completed_at must be set when transitioning historical_import_run to COMPLETED';
          END IF;
          IF NEW.rolled_back_at IS NOT NULL OR NEW.rollback_summary IS NOT NULL THEN
            RAISE EXCEPTION 'rolled_back fields cannot be set when transitioning to COMPLETED';
          END IF;
        ELSIF NEW.status = 'FAILED' THEN
          -- 允许转入失败
        ELSIF NEW.status = 'RUNNING' THEN
          -- 允许保持运行
        ELSE
          RAISE EXCEPTION 'Invalid status transition from RUNNING to %', NEW.status;
        END IF;
      ELSIF OLD.status = 'COMPLETED' THEN
        IF NEW.status = 'ROLLED_BACK' THEN
          IF NEW.rolled_back_at IS NULL THEN
            RAISE EXCEPTION 'rolled_back_at must be set when transitioning historical_import_run to ROLLED_BACK';
          END IF;
          IF OLD.completed_at IS DISTINCT FROM NEW.completed_at THEN
            RAISE EXCEPTION 'completed_at cannot be altered when transitioning to ROLLED_BACK';
          END IF;
          IF OLD.post_cutover_snapshot::text IS DISTINCT FROM NEW.post_cutover_snapshot::text
             OR OLD.post_finance_snapshot::text IS DISTINCT FROM NEW.post_finance_snapshot::text THEN
            RAISE EXCEPTION 'post snapshots of historical_import_run cannot be altered when transitioning to ROLLED_BACK';
          END IF;
        ELSE
          RAISE EXCEPTION 'COMPLETED historical_import_run can only transition to ROLLED_BACK, not %', NEW.status;
        END IF;
      ELSIF OLD.status IN ('FAILED', 'ROLLED_BACK') THEN
        RAISE EXCEPTION 'Terminal state % of historical_import_run is strictly immutable', OLD.status;
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER historical_import_run_state_guard_trg
    BEFORE UPDATE OR DELETE ON historical_import_run
    FOR EACH ROW EXECUTE FUNCTION historical_import_run_state_guard();
  `.execute(db);

  // 2. 创建实体导入归属持久化表 historical_import_run_item（严格禁止 UPDATE 与 DELETE）
  await sql`
    CREATE TABLE historical_import_run_item (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES historical_import_run(id),
      enterprise_id uuid NOT NULL REFERENCES enterprise(id),
      entity_type varchar(64) NOT NULL,
      entity_id varchar(128) NOT NULL,
      canonical_digest varchar(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_run_item_entity UNIQUE (entity_type, entity_id)
    );

    CREATE INDEX historical_import_run_item_run_type_idx
      ON historical_import_run_item (run_id, entity_type);

    CREATE OR REPLACE FUNCTION historical_import_run_item_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'historical_import_run_item is append-only and strictly immutable: % is forbidden', TG_OP;
    END;
    $$;

    CREATE TRIGGER historical_import_run_item_immutable_trg
    BEFORE UPDATE OR DELETE ON historical_import_run_item
    FOR EACH ROW EXECUTE FUNCTION historical_import_run_item_immutable();
  `.execute(db);

  // 3. ai_request: 导入来源与导入运行 ID 绑定
  await sql`
    ALTER TABLE ai_request
      ADD COLUMN import_source varchar(32),
      ADD COLUMN import_run_id uuid REFERENCES historical_import_run(id);

    ALTER TABLE ai_request
      ADD CONSTRAINT ai_request_import_source_check CHECK (
        (import_source IS NULL AND import_run_id IS NULL)
        OR (import_source IN ('LEGACY_MAC_MINI') AND import_run_id IS NOT NULL)
      );

    CREATE INDEX ai_request_import_source_idx
      ON ai_request (import_source) WHERE import_source IS NOT NULL;
    CREATE INDEX ai_request_import_run_idx
      ON ai_request (import_run_id) WHERE import_run_id IS NOT NULL;
  `.execute(db);

  // 4. ledger_line: 扩展 api_cost_status CHECK 与 shape 约束
  await sql`
    ALTER TABLE ledger_line
      DROP CONSTRAINT IF EXISTS ledger_line_api_cost_status_check,
      DROP CONSTRAINT IF EXISTS ledger_line_api_cost_fact_shape_check;

    ALTER TABLE ledger_line
      ADD CONSTRAINT ledger_line_api_cost_status_check
        CHECK (api_cost_status IS NULL OR api_cost_status IN (
          'PRICED_USAGE','CONFIRMED_ZERO_NO_UPSTREAM','UNKNOWN_COST','NOT_APPLICABLE','NOT_MIGRATED'
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
        OR (api_cost_status='NOT_MIGRATED' AND resource_mode='API'
          AND api_cost IS NULL AND api_cost_currency IS NULL)
      );
  `.execute(db);

  // 5. ledger_transaction: total_api_cost 可空 + 显式 api_cost_status（绝不改写现有金额值）
  await sql`
    ALTER TABLE ledger_transaction ALTER COLUMN total_api_cost DROP NOT NULL;
    ALTER TABLE ledger_transaction ADD COLUMN api_cost_status varchar(40);
  `.execute(db);

  // 从子 ledger_line 逐行推导准确回填现有结算汇总，避免按 0 错误猜测；不修改已有 total_api_cost
  await sql`
    WITH line_summary AS (
      SELECT
        ai_request_id,
        bool_or(api_cost_status = 'NOT_MIGRATED') AS has_not_migrated,
        bool_or(api_cost_status = 'UNKNOWN_COST') AS has_unknown_cost,
        bool_or(api_cost_status = 'PRICED_USAGE') AS has_priced_usage,
        bool_or(api_cost_status = 'CONFIRMED_ZERO_NO_UPSTREAM') AS has_confirmed_zero,
        bool_and(resource_mode = 'CODING_PLAN' OR api_cost_status = 'NOT_APPLICABLE') AS all_plan_or_na
      FROM ledger_line
      GROUP BY ai_request_id
    )
    UPDATE ledger_transaction t
       SET api_cost_status = CASE
         WHEN s.has_not_migrated THEN 'NOT_MIGRATED'
         WHEN s.has_unknown_cost THEN 'UNKNOWN_COST'
         WHEN s.all_plan_or_na THEN 'NOT_APPLICABLE'
         WHEN s.has_priced_usage THEN 'PRICED_USAGE'
         WHEN s.has_confirmed_zero THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
         WHEN t.total_api_cost IS NULL THEN 'UNKNOWN_COST'
         WHEN t.total_api_cost::numeric = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
         ELSE 'PRICED_USAGE'
       END
      FROM line_summary s
     WHERE t.ai_request_id = s.ai_request_id
       AND t.api_cost_status IS NULL;

    UPDATE ledger_transaction
       SET api_cost_status = CASE
         WHEN total_api_cost IS NULL THEN 'UNKNOWN_COST'
         WHEN total_api_cost::numeric = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
         ELSE 'PRICED_USAGE'
       END
     WHERE api_cost_status IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT IF EXISTS ledger_transaction_api_cost_status_check,
      DROP CONSTRAINT IF EXISTS ledger_transaction_api_cost_shape_check;

    ALTER TABLE ledger_transaction
      ADD CONSTRAINT ledger_transaction_api_cost_status_check
        CHECK (api_cost_status IN (
          'PRICED_USAGE','CONFIRMED_ZERO_NO_UPSTREAM','UNKNOWN_COST','NOT_APPLICABLE','NOT_MIGRATED'
        )),
      ADD CONSTRAINT ledger_transaction_api_cost_shape_check CHECK (
        (api_cost_status = 'PRICED_USAGE' AND total_api_cost IS NOT NULL)
        OR (api_cost_status = 'CONFIRMED_ZERO_NO_UPSTREAM' AND total_api_cost::numeric = 0)
        -- UNKNOWN_COST 允许既有旧运行时的 0 占位（子行 line 级 UNKNOWN_COST 但旧结算写 0 的 4 条历史事实，
        -- 见 20260930 演练诊断 rehearsal/sql/diagnose_0085_violations.sql）；迁移绝不改写金额，新写入路径不会产生该组合。
        OR (api_cost_status = 'UNKNOWN_COST' AND (total_api_cost IS NULL OR total_api_cost::numeric = 0))
        OR (api_cost_status = 'NOT_APPLICABLE' AND (total_api_cost IS NULL OR total_api_cost::numeric = 0))
        OR (api_cost_status = 'NOT_MIGRATED' AND total_api_cost IS NULL)
      );

    ALTER TABLE ledger_transaction ALTER COLUMN api_cost_status SET NOT NULL;
  `.execute(db);

  // 6. usage_bucket_aggregate: api_cost 可空 + 显式 api_cost_status（绝不改写现有金额值）
  await sql`
    ALTER TABLE usage_bucket_aggregate ALTER COLUMN api_cost DROP NOT NULL;
    ALTER TABLE usage_bucket_aggregate ADD COLUMN api_cost_status varchar(40);
  `.execute(db);

  // 根据关联资源准确回填桶聚合状态；不修改已有 api_cost
  await sql`
    UPDATE usage_bucket_aggregate uba
       SET api_cost_status = CASE
         WHEN pr.mode = 'CODING_PLAN' THEN 'NOT_APPLICABLE'
         WHEN uba.api_cost IS NULL THEN 'UNKNOWN_COST'
         WHEN uba.api_cost = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
         ELSE 'PRICED_USAGE'
       END
      FROM provider_resource pr
     WHERE pr.id = uba.provider_resource_id
       AND uba.api_cost_status IS NULL;

    UPDATE usage_bucket_aggregate
       SET api_cost_status = CASE
         WHEN api_cost IS NULL THEN 'UNKNOWN_COST'
         WHEN api_cost = 0 THEN 'CONFIRMED_ZERO_NO_UPSTREAM'
         ELSE 'PRICED_USAGE'
       END
     WHERE api_cost_status IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE usage_bucket_aggregate
      DROP CONSTRAINT IF EXISTS usage_bucket_aggregate_api_cost_status_check,
      DROP CONSTRAINT IF EXISTS usage_bucket_aggregate_api_cost_shape_check;

    ALTER TABLE usage_bucket_aggregate
      ADD CONSTRAINT usage_bucket_aggregate_api_cost_status_check
        CHECK (api_cost_status IN (
          'PRICED_USAGE','CONFIRMED_ZERO_NO_UPSTREAM','UNKNOWN_COST','NOT_APPLICABLE','NOT_MIGRATED'
        )),
      ADD CONSTRAINT usage_bucket_aggregate_api_cost_shape_check CHECK (
        (api_cost_status = 'PRICED_USAGE' AND api_cost IS NOT NULL AND api_cost >= 0)
        OR (api_cost_status = 'CONFIRMED_ZERO_NO_UPSTREAM' AND api_cost = 0)
        OR (api_cost_status = 'UNKNOWN_COST' AND api_cost IS NULL)
        OR (api_cost_status = 'NOT_APPLICABLE' AND (api_cost IS NULL OR api_cost = 0))
        OR (api_cost_status = 'NOT_MIGRATED' AND api_cost IS NULL)
      );

    ALTER TABLE usage_bucket_aggregate ALTER COLUMN api_cost_status SET NOT NULL;
  `.execute(db);

  // 7. provider finance 严格触发器：保持完全启用，支持受约束的历史导入通路（写入仅接受 RUNNING 状态的 run）
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_strict_ledger_fact() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE strict_enabled boolean;
    DECLARE req_import_source varchar(32);
    DECLARE req_import_run_id uuid;
    DECLARE req_started_at timestamptz;
    DECLARE run_status varchar(32);
    BEGIN
      SELECT strict_writes_enabled INTO strict_enabled
        FROM provider_finance_runtime_state WHERE enterprise_id=NEW.enterprise_id;
      IF COALESCE(strict_enabled, false) THEN
        IF NEW.settled_at IS NULL OR NEW.api_cost_status IS NULL THEN
          RAISE EXCEPTION 'active provider finance ledger requires settlement and cost status';
        END IF;

        -- 检查请求是否带有导入来源
        SELECT import_source, import_run_id, started_at
          INTO req_import_source, req_import_run_id, req_started_at
          FROM ai_request WHERE id = NEW.ai_request_id AND enterprise_id = NEW.enterprise_id;

        IF req_import_source IS NOT NULL THEN
          -- 必须为 LEGACY_MAC_MINI 且挂接处于 RUNNING 状态的有效 import_run
          IF req_import_source <> 'LEGACY_MAC_MINI' THEN
            RAISE EXCEPTION 'Invalid import source % for historical ledger line', req_import_source;
          END IF;
          IF req_import_run_id IS NULL THEN
            RAISE EXCEPTION 'Historical imported ledger line requires an active import_run';
          END IF;
          SELECT status INTO run_status
            FROM historical_import_run
           WHERE id = req_import_run_id AND enterprise_id = NEW.enterprise_id;
          IF run_status IS NULL OR run_status <> 'RUNNING' THEN
            RAISE EXCEPTION 'Historical imported ledger line requires an active RUNNING import_run';
          END IF;
          IF req_started_at >= '2026-09-21T11:30:06.052+08:00'::timestamptz
             OR req_started_at < '2026-08-01T00:00:00+08:00'::timestamptz THEN
            RAISE EXCEPTION 'Historical imported request timestamp is outside the historical import window';
          END IF;
          IF NEW.legacy_cost_resolution_id IS NOT NULL THEN
            RAISE EXCEPTION 'Historical imported ledger line cannot reference legacy_cost_resolution';
          END IF;
          IF NEW.subscription_period_id IS NOT NULL THEN
            RAISE EXCEPTION 'Historical imported ledger line cannot reference a subscription period';
          END IF;

          -- 按资源模式分别强约束金额与状态
          IF NEW.resource_mode = 'API' THEN
            IF NEW.api_cost_status <> 'NOT_MIGRATED' THEN
              RAISE EXCEPTION 'Historical API ledger line must have NOT_MIGRATED api_cost_status';
            END IF;
            IF NEW.api_cost IS NOT NULL OR NEW.api_cost_currency IS NOT NULL THEN
              RAISE EXCEPTION 'NOT_MIGRATED ledger line must have NULL api_cost and api_cost_currency';
            END IF;
          ELSIF NEW.resource_mode = 'CODING_PLAN' THEN
            IF NEW.api_cost_status <> 'NOT_APPLICABLE' THEN
              RAISE EXCEPTION 'Historical Coding Plan ledger line must have NOT_APPLICABLE api_cost_status';
            END IF;
            IF NEW.api_cost IS NOT NULL OR NEW.api_cost_currency IS NOT NULL THEN
              RAISE EXCEPTION 'NOT_APPLICABLE ledger line must have NULL api_cost and api_cost_currency';
            END IF;
          ELSE
            RAISE EXCEPTION 'Unsupported resource_mode % for historical ledger line', NEW.resource_mode;
          END IF;

          -- 校验通过，直接返回，不施加运行时 period 强制约束
          RETURN NEW;
        END IF;

        -- 非导入行严禁使用 NOT_MIGRATED
        IF NEW.api_cost_status = 'NOT_MIGRATED' THEN
          RAISE EXCEPTION 'NOT_MIGRATED cost status is only valid for LEGACY_MAC_MINI imported requests';
        END IF;

        -- 运行时原有严格校验不变
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
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 严格 fail-closed：如果存在任何历史导入行、import_run 或 NOT_MIGRATED 行，必须拒绝回退！
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM ai_request WHERE import_source = 'LEGACY_MAC_MINI' OR import_run_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM historical_import_run)
         OR EXISTS (SELECT 1 FROM historical_import_run_item)
         OR EXISTS (SELECT 1 FROM ledger_line WHERE api_cost_status = 'NOT_MIGRATED')
         OR EXISTS (SELECT 1 FROM ledger_transaction WHERE api_cost_status = 'NOT_MIGRATED' OR total_api_cost IS NULL)
         OR EXISTS (SELECT 1 FROM usage_bucket_aggregate WHERE api_cost_status = 'NOT_MIGRATED' OR api_cost IS NULL) THEN
        RAISE EXCEPTION '0085 rollback blocked: historical imported rows or NOT_MIGRATED rows exist. Roll back imported rows by exact IDs first.'
          USING ERRCODE = '55000';
      END IF;
    END $$;
  `.execute(db);

  // 恢复 0061 原严格触发器函数
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_strict_ledger_fact() RETURNS trigger
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
  `.execute(db);

  // usage_bucket_aggregate: 移除约束与列，恢复 NOT NULL
  await sql`
    ALTER TABLE usage_bucket_aggregate
      DROP CONSTRAINT IF EXISTS usage_bucket_aggregate_api_cost_shape_check,
      DROP CONSTRAINT IF EXISTS usage_bucket_aggregate_api_cost_status_check;
    ALTER TABLE usage_bucket_aggregate DROP COLUMN IF EXISTS api_cost_status;
    ALTER TABLE usage_bucket_aggregate ALTER COLUMN api_cost SET NOT NULL;
  `.execute(db);

  // ledger_transaction: 移除约束与列，恢复 NOT NULL
  await sql`
    ALTER TABLE ledger_transaction
      DROP CONSTRAINT IF EXISTS ledger_transaction_api_cost_shape_check,
      DROP CONSTRAINT IF EXISTS ledger_transaction_api_cost_status_check;
    ALTER TABLE ledger_transaction DROP COLUMN IF EXISTS api_cost_status;
    ALTER TABLE ledger_transaction ALTER COLUMN total_api_cost SET NOT NULL;
  `.execute(db);

  // ledger_line: 恢复 0059 CHECK
  await sql`
    ALTER TABLE ledger_line
      DROP CONSTRAINT IF EXISTS ledger_line_api_cost_status_check,
      DROP CONSTRAINT IF EXISTS ledger_line_api_cost_fact_shape_check;
    ALTER TABLE ledger_line
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
      );
  `.execute(db);

  // ai_request: 移除 import_run_id 与 import_source
  await sql`
    DROP INDEX IF EXISTS ai_request_import_run_idx;
    DROP INDEX IF EXISTS ai_request_import_source_idx;
    ALTER TABLE ai_request DROP CONSTRAINT IF EXISTS ai_request_import_source_check;
    ALTER TABLE ai_request DROP COLUMN IF EXISTS import_run_id;
    ALTER TABLE ai_request DROP COLUMN IF EXISTS import_source;
  `.execute(db);

  // 删除持久归属表与运行表
  await sql`
    DROP TRIGGER IF EXISTS historical_import_run_item_immutable_trg ON historical_import_run_item;
    DROP FUNCTION IF EXISTS historical_import_run_item_immutable;
    DROP TABLE IF EXISTS historical_import_run_item;
    DROP TRIGGER IF EXISTS historical_import_run_state_guard_trg ON historical_import_run;
    DROP FUNCTION IF EXISTS historical_import_run_state_guard;
    DROP TABLE IF EXISTS historical_import_run;
  `.execute(db);
}
