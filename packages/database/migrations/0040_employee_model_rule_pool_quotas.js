/** POOL-035：批量模型授权规则额度厂商池化。
 *
 * 背景：POOL-033 已把单人接入配置收敛为"主体×厂商"池，每厂商独立额度
 * （PoolSpec）；批量规则发布时也按厂商分组建池，但建池时所有厂商共用
 * 版本级单一 quota_value，无法表达"DeepSeek 3 亿、Kimi 5000 万"。
 *
 * 变更：employee_model_rule_version 增加 pool_quotas jsonb 列，承载
 * [{ provider_code, quota_value, allow_overage, valid_until }]，与单人侧
 * PoolSpec 形态对齐。发布时每厂商池优先取 pool_quotas 里该厂商的值；
 * pool_quotas 为空（[]）或 NULL 的旧版本仍回退版本级 quota_value/allow_overage/
 * valid_until，存量已发布池 Grant 不动，不丢历史已用量与账本链。
 *
 * 不删除旧 quota_value/allow_overage/valid_until 列，保留兼容回退。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("employee_model_rule_version")
    .addColumn("pool_quotas", "jsonb", (col) => col.defaultTo(sql`'[]'::jsonb`))
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.alterTable("employee_model_rule_version")
    .dropColumn("pool_quotas")
    .execute();
}
