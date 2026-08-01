/**
 * POOL-001/002：
 * - ledger_line 冻结实际命中的计价/倍率规则快照，避免规则后续编辑影响历史解释；
 * - usage/ledger 单独保留 reasoning token，Responses Usage 映射不丢维度。
 *
 * 兼容性：新增列均可空或带 0 默认值，既有行无需回填重算。
 */

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("usage_event")
    .addColumn("reasoning_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .alterTable("ledger_line")
    .addColumn("raw_reasoning_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("billing_rule_snapshot", "jsonb")
    .execute();
  await db.schema
    .alterTable("ledger_transaction")
    .addColumn("total_reasoning_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.alterTable("ledger_transaction").dropColumn("total_reasoning_tokens").execute();
  await db.schema
    .alterTable("ledger_line")
    .dropColumn("billing_rule_snapshot")
    .dropColumn("raw_reasoning_tokens")
    .execute();
  await db.schema.alterTable("usage_event").dropColumn("reasoning_tokens").execute();
}
