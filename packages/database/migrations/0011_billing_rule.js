/**
 * 迁移 0011 —— 计价规则版本（W13）。
 *
 * 依据：TRD §10（额度和费用计算）、§5.5 行 289 起、调研文档「厂商额度扣减规则」。
 * billing_rule：可版本化的价格／倍率规则（时间段分时、模型档位、缓存状态），
 * 管理员按厂商当期公开规则/合同录入（调研文档「以具体资源上已生效的规则版本为准」）。
 *
 * 关键设计：
 *   - 规则带 rule_version + effective_from/to，历史 Attempt 冻结命中版本，配置变化不重算历史；
 *   - 时段规则带 timezone + days_of_week + start/end_time（智谱 14:00–18:00 UTC+8 高峰）；
 *   - 档位规则按 upstream_model 匹配（Kimi kimi-for-coding-highspeed 3 倍档）；
 *   - ledger_line 增加 rule_version_id + multiplier（每 Attempt 冻结命中规则，WT-05 可解释）。
 *
 * 金额：PostgreSQL numeric；应用层 decimal.js（工程规则 §2 行 36）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("billing_rule")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    // 适用范围：资源（可空=企业级默认）+ 上游模型（可空=全部模型）
    .addColumn("provider_resource_id", "uuid", (c) => c.references("provider_resource.id"))
    .addColumn("upstream_model", "varchar(128)")
    // 规则类型：TIME_WINDOW（分时倍率）| MODEL_TIER（模型档位倍率）| CACHE_STATE（缓存状态价格）| API_PRICE（Token 单价）
    .addColumn("rule_type", "varchar(32)", (c) => c.notNull())
    // 版本与生效区间（历史不重算的事实底座）
    .addColumn("rule_version", "varchar(32)", (c) => c.notNull())
    .addColumn("effective_from", "timestamptz", (c) => c.notNull())
    .addColumn("effective_to", "timestamptz")
    // 时段规则字段（TIME_WINDOW）
    .addColumn("timezone", "varchar(64)") // 如 Asia/Shanghai
    .addColumn("days_of_week", "jsonb") // [1,2,3,4,5] 周一..周日（ISO 1-7）；null=每天
    .addColumn("start_time", "varchar(8)") // "14:00"
    .addColumn("end_time", "varchar(8)") // "18:00"
    // 倍率与价格
    .addColumn("multiplier", "numeric") // 套餐扣减倍率（raw × multiplier）
    .addColumn("cache_hit_price", "numeric") // API：cache 命中 input 单价（每 token）
    .addColumn("cache_miss_price", "numeric") // API：cache 未命中 input 单价
    .addColumn("output_price", "numeric") // API：output 单价
    .addColumn("currency", "varchar(8)", (c) => c.notNull().defaultTo("CNY"))
    // 匹配优先级（数值小优先）与启用
    .addColumn("priority", "integer", (c) => c.notNull().defaultTo(100))
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("source", "varchar(255)") // 规则来源（官方定价页/合同，调研文档要求保存来源）
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();

  await sql`ALTER TABLE billing_rule ADD CONSTRAINT billing_rule_type_check CHECK (rule_type IN ('TIME_WINDOW','MODEL_TIER','CACHE_STATE','API_PRICE'))`.execute(db);
  await db.schema
    .createIndex("billing_rule_match_idx")
    .ifNotExists()
    .on("billing_rule")
    .columns(["enterprise_id", "provider_resource_id", "upstream_model", "enabled", "priority"])
    .execute();

  // ledger_line：冻结每 Attempt 命中的规则版本与倍率（历史不重算 + WT-05 可解释）
  await db.schema
    .alterTable("ledger_line")
    .addColumn("billing_rule_id", "uuid", (c) => c.references("billing_rule.id"))
    .addColumn("rule_version", "varchar(32)")
    .addColumn("multiplier", "numeric")
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema
    .alterTable("ledger_line")
    .dropColumn("billing_rule_id")
    .dropColumn("rule_version")
    .dropColumn("multiplier")
    .execute();
  await db.schema.dropTable("billing_rule").ifExists().execute();
}
