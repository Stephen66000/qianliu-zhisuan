/**
 * 迁移 0008 —— 上游 Attempt 与计量事件（W07）。
 *
 * 依据：TRD §5.7 行 338-339、§8.1（计量原则）。
 * upstream_attempt：每次真实上游尝试；含 response_committed 状态（TRD §8.3）。
 * usage_event：每 Attempt 的输入/输出/缓存 Token 事实 + 计量质量 + 去重键（唯一约束防重复记账）。
 *
 * 安全：绝不存 messages/prompt/chunk 正文。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("upstream_attempt")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("attempt_no", "integer", (c) => c.notNull()) // 1-based 序号
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("upstream_model", "varchar(128)", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("first_byte_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addColumn("http_status", "integer")
    .addColumn("error_classification", "varchar(64)")
    .addColumn("error_code", "varchar(64)")
    .addColumn("response_committed", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("switch_reason", "varchar(64)") // 切换原因（failover 时）
    .execute();
  await db.schema
    .createIndex("upstream_attempt_request_idx")
    .ifNotExists()
    .on("upstream_attempt")
    .columns(["ai_request_id", "attempt_no"])
    .execute();

  // usage_event：每 Attempt 的 Token 事实 + 计量质量 + 去重键
  await db.schema
    .createTable("usage_event")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("upstream_attempt_id", "uuid", (c) => c.notNull().references("upstream_attempt.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("input_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("usage_quality", "varchar(32)", (c) => c.notNull())
    .addColumn("upstream_usage_id", "varchar(128)") // 上游计量标识
    .addColumn("dedup_key", "varchar(128)", (c) => c.notNull()) // 去重键：同一计量事实不重复
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await sql`ALTER TABLE usage_event ADD CONSTRAINT usage_event_quality_check CHECK (usage_quality IN ('PROVIDER_REPORTED','ESTIMATED','ACCOUNT_AGGREGATED','UNKNOWN'))`.execute(db);
  // 去重键唯一（同一计量事实重复到达只更新状态，不新增）
  await db.schema
    .createIndex("usage_event_dedup_idx")
    .ifNotExists()
    .on("usage_event")
    .column("dedup_key")
    .unique()
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("usage_event").ifExists().execute();
  await db.schema.dropTable("upstream_attempt").ifExists().execute();
}
