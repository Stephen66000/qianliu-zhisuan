/**
 * 0084：历史 API 消耗事件类型（前向迁移；不修改 0059/0060/0083 已部署迁移）。
 *
 * 业务背景（2026-09-27 最小增量）：旧 MacMini 数据库与阿里云新数据库相互独立。
 * 管理员从旧库核实了一段「切换时点后、上新服务器前」的 API 实际计价汇总；
 * 该成本不是新库 ledger_line，不能伪装成负期初余额，也不能改充值金额凑数。
 *
 * 本迁移做两件事：
 *  1. 扩展 `provider_finance_event` 的类型与形状 CHECK 约束，新增独立事件类型
 *    `API_HISTORICAL_USAGE_COST`：
 *    - 金额必须小于 0（落账即负向资金事实；管理员输入的正数由服务端规范化取负）；
 *    - `cash_paid_cny` 必须为空（历史消耗没有人民币实付语义）；
 *    - 不得绑定 reversal / correction / reconciliation / legacy_cost_resolution；
 *    - 企业、资源、管理员、证据与幂等审计字段全部保留（复用既有列）。
 *  2. 建 partial unique index（复核修复 R2）：历史消耗的期间开始固定为切换时点，
 *    同一（企业、资源、币种）第二条必然与前一条区间重叠并重复扣减——数据库层
 *    直接拒绝；不同截止时间或金额也不放行。其余事件类型的多行语义不受影响。
 *
 * 既有 `API_LEGACY_COST_ADJUSTMENT`（与 UNKNOWN_COST ledger_line、
 * provider_finance_legacy_cost_resolution 一一绑定）的约束子句逐字承袭，语义不变；
 * 0059/0083 触发器函数 `provider_finance_validate_event_contract` 对新类型无需分支
 * （`LIKE 'API_%'` 已强制 API 资源；source='MIGRATION' 写入不受未来时间限制）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    ALTER TABLE provider_finance_event
      DROP CONSTRAINT provider_finance_event_type_check,
      DROP CONSTRAINT provider_finance_event_shape_check;
    ALTER TABLE provider_finance_event
      ADD CONSTRAINT provider_finance_event_type_check CHECK (event_type IN (
        'API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE',
        'API_BALANCE_RECONCILIATION','API_LEGACY_COST_ADJUSTMENT',
        'API_HISTORICAL_USAGE_COST',
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
        OR (event_type = 'API_HISTORICAL_USAGE_COST' AND account_amount < 0
          AND cash_paid_cny IS NULL AND reversal_of_event_id IS NULL
          AND correction_of_event_id IS NULL AND reconciliation_case_id IS NULL
          AND legacy_cost_resolution_id IS NULL)
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
    CREATE UNIQUE INDEX provider_finance_event_historical_usage_cost_uq
      ON provider_finance_event (enterprise_id, provider_resource_id, account_currency)
      WHERE event_type = 'API_HISTORICAL_USAGE_COST'
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 精确删除本迁移创建的 partial unique index。
  await sql`
    DROP INDEX IF EXISTS provider_finance_event_historical_usage_cost_uq
  `.execute(db);
  // 精确恢复 0060 up 之后的约束（八种类型），不触碰任何数据行。
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
}
