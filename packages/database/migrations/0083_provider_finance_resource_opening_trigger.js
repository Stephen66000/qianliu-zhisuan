/**
 * 0083：资源级期初时点触发器修订（F-P2-6，前向迁移；不修改 0059 历史文件）。
 *
 * Owner 裁决（2026-09-25）：
 * - 历史 MIGRATION 期初仍固定为资金切换时点（PFH-01 口径不变）；
 * - ADMIN 资源级期初：仅企业已激活（provider_finance_runtime_state.strict_writes_enabled）
 *   且资源处于 PENDING（provider_resource_finance_state.state）时，允许
 *   created_at <= occurred_at <= now()；同资源多币种期初必须同点；
 * - 期初更正必须追随其原始期初事件的 occurred_at（初始化口径自动追随切换时点）；
 * - down 遇到任何非切换时点的期初/期初更正事实时必须拒绝回退（失败关闭）。
 *
 * 本迁移只 CREATE OR REPLACE 触发器函数 provider_finance_validate_event_contract，
 * 其余子句逐项承袭 0059 原函数体（逐字复制），不触碰触发器绑定与任何数据行。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_event_contract() RETURNS trigger
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
      -- F-P2-6（0083）：期初时点合同——
      --   MIGRATION 源（历史初始化）：仍固定为切换时点（PFH-01 口径不变）；
      --   ADMIN 源（激活后资源级）：仅企业已激活且资源处于 PENDING 时，
      --     允许 created_at <= occurred_at <= now()，且同资源多币种期初同点；
      --   期初更正：必须追随其原始期初事件的 occurred_at（两种口径一致追随）。
      IF NEW.event_type = 'API_OPENING_BALANCE' THEN
        IF NEW.source = 'MIGRATION' THEN
          IF NEW.occurred_at <> '2026-08-31T16:00:00Z'::timestamptz THEN
            RAISE EXCEPTION 'migration opening balance facts must use the cutover instant';
          END IF;
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM provider_finance_runtime_state runtime
             WHERE runtime.enterprise_id = NEW.enterprise_id
               AND runtime.strict_writes_enabled
          ) THEN
            RAISE EXCEPTION 'resource-level opening balance requires an activated enterprise';
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM provider_resource_finance_state fin_state
             WHERE fin_state.provider_resource_id = NEW.provider_resource_id
               AND fin_state.state = 'PENDING'
          ) THEN
            RAISE EXCEPTION 'resource-level opening balance requires a PENDING resource finance state';
          END IF;
          IF NEW.occurred_at < (SELECT resource.created_at FROM provider_resource resource
             WHERE resource.enterprise_id = NEW.enterprise_id
               AND resource.id = NEW.provider_resource_id) THEN
            RAISE EXCEPTION 'resource-level opening balance must not predate the resource creation';
          END IF;
          IF EXISTS (
            SELECT 1 FROM provider_finance_event other_opening
             WHERE other_opening.enterprise_id = NEW.enterprise_id
               AND other_opening.provider_resource_id = NEW.provider_resource_id
               AND other_opening.event_type = 'API_OPENING_BALANCE'
               AND other_opening.occurred_at <> NEW.occurred_at
          ) THEN
            RAISE EXCEPTION 'multi-currency opening balances must share one resource effective instant';
          END IF;
        END IF;
      END IF;
      IF NEW.event_type = 'API_OPENING_BALANCE_CORRECTION' THEN
        IF NOT EXISTS (
          SELECT 1 FROM provider_finance_event original_opening
           WHERE original_opening.enterprise_id = NEW.enterprise_id
             AND original_opening.id = NEW.correction_of_event_id
             AND original_opening.occurred_at = NEW.occurred_at
        ) THEN
          RAISE EXCEPTION 'opening correction must reuse the original opening instant';
        END IF;
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
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 回滚守卫：任何非切换时点的期初/期初更正事实（即 0083 引入的资源级口径产物）
  // 都会在回退到 0059 触发器后立即违约。失败关闭：拒绝回滚而不是静默篡改事实。
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM provider_finance_event
         WHERE event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION')
           AND occurred_at <> '2026-08-31T16:00:00Z'::timestamptz
      ) THEN
        RAISE EXCEPTION '0083 rollback blocked: resource-level opening facts exist';
      END IF;
    END
    $$;
  `.execute(db);
  // 恢复 0059 原函数体（逐字复制，仅函数语句本身；触发器绑定从未被本迁移改动）。
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_validate_event_contract() RETURNS trigger
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
  `.execute(db);
}
