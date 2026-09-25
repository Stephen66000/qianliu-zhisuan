/**
 * 0079：候选草稿载荷持久化（WP04 / PFA-02、PFA-03、PFA-04）。
 *
 * 背景（WP01 数据合同缺口）：0078 建立的 `provider_finance_activation_attempt` 只保存
 * 候选哈希、事实水位哈希、缺口摘要、投影摘要与固定修复基准，**没有保存草稿本身**。
 * 而 `POST /provider-finance/activate` 的合同（design §3.3、计划 v1.2 §6.1）只接受
 * `candidate_id / candidate_hash / idempotency_key / confirm_enterprise_id`——不接受草稿：
 *
 * - 权威企业与管理员的唯一来源是认证会话（PFA-07），请求体不得携带业务载荷；
 * - 激活需要在锁内重算候选哈希与完整投影，并在同一事务内写入期初、充值、购买、
 *   跨切换周期与旧记录关闭决定；没有草稿这三件事都无法进行。
 *
 * 因此草稿必须随候选一起落库。计划 §7 明确允许"新增或扩展非资金事实控制结构，
 * 以保存企业级候选与激活幂等"；本迁移只做这一件事，不写入任何资金事实。
 *
 * 语义：
 * - `candidate_draft` 是**业务草稿载荷**，不具备财务权威性，不参与余额、成本或经营账单
 *   查询，也不进入任何资金读取路径；
 * - 它与 `candidate_hash` 互为校验：激活时协调器用存档草稿重算候选哈希，
 *   不一致一律 `CANDIDATE_STALE` 失败关闭；
 * - 与既有候选字段一样不可篡改（触发器一并覆盖本列），且 `ACTIVATED` 终态仍不可修改；
 * - 本迁移之前创建的候选没有草稿载荷，写入一个结构合法但**必然无法通过哈希复算**的
 *   空草稿哨兵：这些候选不能再被激活（必须重新预检），绝不猜测或继承旧草稿。
 *
 * 回滚：仅删除本迁移新增的列与触发器定义；不触碰任何资金事实。
 */
import { sql } from "kysely";

/**
 * 历史候选的失败关闭哨兵：结构合法（可被领域规范化读取），但不可能与任何真实
 * 候选哈希匹配，因此这类候选在激活时必然以 `CANDIDATE_STALE` 被拒绝。
 * @type {string}
 */
const LEGACY_SENTINEL_DRAFT = JSON.stringify({
  schema_version: "1",
  api_opening_balances: [],
  historical_api_recharges: [],
  coding_plan_purchases: [],
  coding_plan_carryovers: [],
  legacy_purchase_resolutions: [],
});

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`
    ALTER TABLE provider_finance_activation_attempt
      ADD COLUMN candidate_draft jsonb
  `.execute(db);

  await sql`
    UPDATE provider_finance_activation_attempt
       SET candidate_draft = ${LEGACY_SENTINEL_DRAFT}::jsonb
     WHERE candidate_draft IS NULL
  `.execute(db);

  await sql`
    ALTER TABLE provider_finance_activation_attempt
      ALTER COLUMN candidate_draft SET NOT NULL,
      ADD CONSTRAINT provider_finance_attempt_draft_shape_check CHECK (
        jsonb_typeof(candidate_draft) = 'object'
        AND candidate_draft ? 'schema_version'
      )
  `.execute(db);

  // 候选草稿与候选哈希同属不可篡改的预检事实：把本列并入既有守卫触发器。
  // 触发器函数为替换语义（CREATE OR REPLACE），绑定关系保持不变。
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_protect_activation_attempt() RETURNS trigger
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
         OR NEW.candidate_draft::text <> OLD.candidate_draft::text
         OR NEW.created_by_admin_user_id <> OLD.created_by_admin_user_id
         OR NEW.created_at <> OLD.created_at
         OR NEW.expires_at <> OLD.expires_at THEN
        RAISE EXCEPTION 'provider finance candidate preview facts are immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$;
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 与 0078 的回滚守卫同语义：已激活（ACTIVATED）候选是终态财务事实的锚点，
  // 其候选草稿列是候选哈希复算的输入之一，回滚删除该列等于篡改已激活候选，
  // 因此存在 ACTIVATED 候选时必须拒绝回滚（失败关闭），而不是静默删除数据。
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM provider_finance_activation_attempt WHERE status = 'ACTIVATED') THEN
        RAISE EXCEPTION '0079 rollback blocked: activated provider finance candidates exist';
      END IF;
    END $$
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION provider_finance_protect_activation_attempt() RETURNS trigger
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
  `.execute(db);
  await sql`
    ALTER TABLE provider_finance_activation_attempt
      DROP CONSTRAINT IF EXISTS provider_finance_attempt_draft_shape_check,
      DROP COLUMN IF EXISTS candidate_draft
  `.execute(db);
}
