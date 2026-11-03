/**
 * 0094：退役 API 资金 PENDING 调用准入种子（WP2 task 4.3 / AFR-02，前向迁移；不修改 0081 本体）。
 *
 * 依据：
 * - specs/api-funding-retirement/spec.md AFR-02（API 接入不再要求资金就绪）：其他准入
 *   条件满足时，没有 API 资金期初、激活状态或资金就绪标记的资源 MUST 进入调用候选；
 * - openspec change simplify-api-cost-and-official-balance WP2 plan.md §4.2/§4.3
 *   （总指挥决策 2/3）：删除种入触发器与函数；provider_resource_finance_state 表与
 *   全部存量行原样保留（D4 留档——不批量置 READY、不删行、不改任何数据）；
 *   准入侧的 PENDING 过滤在应用层（resource-pool-repository）同步解除。
 *
 * 本迁移只删除 0081 引入的种入触发器 `provider_resource_finance_state_seed_trigger`
 * 与函数 `provider_resource_finance_state_seed`（0081:185-205），使已激活企业新建的
 * API 资源不再被种入 PENDING 行；不触碰 provider_resource_finance_state 表结构、
 * 约束与任何存量行（留档审计证据），也不触碰 0083 期初校验触发器。
 *
 * down：逐字复制 0081:185-205 的函数与触发器定义恢复种入行为，供回退演练；
 * down 不删除、不改动任何 provider_resource_finance_state 行。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`DROP TRIGGER IF EXISTS provider_resource_finance_state_seed_trigger ON provider_resource`.execute(db);
  await sql`DROP FUNCTION IF EXISTS provider_resource_finance_state_seed()`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  // 0081:185-205 原文逐字复制（恢复种入触发器；不写任何数据行）。
  await sql`
    CREATE FUNCTION provider_resource_finance_state_seed() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE activated boolean;
    BEGIN
      IF NEW.mode <> 'API' THEN RETURN NEW; END IF;
      SELECT strict_writes_enabled INTO activated
        FROM provider_finance_runtime_state
       WHERE enterprise_id = NEW.enterprise_id;
      IF COALESCE(activated, false) THEN
        INSERT INTO provider_resource_finance_state
          (enterprise_id, provider_resource_id, state, required_currencies)
        VALUES (NEW.enterprise_id, NEW.id, 'PENDING', '[]'::jsonb)
        ON CONFLICT (provider_resource_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER provider_resource_finance_state_seed_trigger
      AFTER INSERT ON provider_resource
      FOR EACH ROW EXECUTE FUNCTION provider_resource_finance_state_seed()
  `.execute(db);
}
