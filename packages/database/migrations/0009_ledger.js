/**
 * 迁移 0009 —— 账本明细与幂等结算汇总（W07）。
 *
 * 依据：TRD §5.7 行 340-348、§10（计价与结算）。
 * ledger_line：每真实消耗 Attempt 的不可覆盖明细；引用 usage_event、资源、扣减、费用。
 * ledger_transaction：每 ai_request 唯一幂等结算汇总（UNIQUE 约束保证一个请求一个结算）。
 *
 * 重复结算为 0 的机制（M2 DoD）：
 *   - ledger_transaction UNIQUE(ai_request_id) —— 一个请求只能有一个结算
 *   - ledger_line 引用 usage_event（usage_event 已有 dedup_key 唯一）
 *
 * 计价简化（M2）：固定价格（API 模式按 token 数 × 单价；套餐模式 PACKAGE_INCLUDED）。
 * 完整计价规则版本（billing_rule_version）在 W13。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // ledger_line：不可覆盖明细
  await db.schema
    .createTable("ledger_line")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("usage_event_id", "uuid", (c) => c.notNull().references("usage_event.id"))
    .addColumn("upstream_attempt_id", "uuid", (c) => c.notNull().references("upstream_attempt.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("resource_mode", "varchar(16)", (c) => c.notNull()) // API | CODING_PLAN
    .addColumn("raw_input_tokens", "bigint", (c) => c.notNull())
    .addColumn("raw_output_tokens", "bigint", (c) => c.notNull())
    .addColumn("raw_cache_tokens", "bigint", (c) => c.notNull())
    .addColumn("deducted_quota", "bigint") // 套餐扣减（PLAN 模式）；API 模式为 null
    .addColumn("api_cost", "numeric") // API 费用（decimal）；套餐模式为 null
    .addColumn("usage_quality", "varchar(32)", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("ledger_line_request_idx")
    .ifNotExists()
    .on("ledger_line")
    .column("ai_request_id")
    .execute();
  await db.schema
    .createIndex("ledger_line_principal_idx")
    .ifNotExists()
    .on("ledger_line")
    .columns(["principal_id", "created_at"])
    .execute();

  // ledger_transaction：每 ai_request 唯一幂等结算汇总
  await db.schema
    .createTable("ledger_transaction")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("total_input_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("total_output_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("total_cache_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("total_deducted_quota", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("total_api_cost", "numeric", (c) => c.notNull().defaultTo(sql`0`))
    .addColumn("usage_quality", "varchar(64)", (c) => c.notNull()) // 可能是 MIXED:A+B
    .addColumn("attempt_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("SETTLED"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  // 关键：一个 ai_request 只能有一个 ledger_transaction（重复结算为 0 的硬保证）
  await sql`ALTER TABLE ledger_transaction ADD CONSTRAINT ledger_transaction_unique_request UNIQUE (ai_request_id)`.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("ledger_transaction").ifExists().execute();
  await db.schema.dropTable("ledger_line").ifExists().execute();
}
