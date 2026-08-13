/**
 * W20-04：员工／项目周期用量可重建读模型基础。
 *
 * 本表不是结算事实；权威事实仍为 ai_request + ledger_transaction。按企业时区
 * 重算完整小时／日桶后 upsert，禁止以“旧值 + 增量”累计。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("usage_bucket_aggregate")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("bucket_granularity", "varchar(8)", (c) => c.notNull())
    .addColumn("bucket_start", "timestamptz", (c) => c.notNull())
    .addColumn("timezone", "varchar(64)", (c) => c.notNull())
    .addColumn("source_principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("project_principal_id", "uuid", (c) => c.references("principal.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.references("provider_resource.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.references("unified_model.id"))
    .addColumn("request_count", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("input_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("output_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("cache_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("reasoning_tokens", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("deducted_quota", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("api_cost", "numeric(30, 8)", (c) => c.notNull().defaultTo(0))
    .addColumn("fact_watermark", "timestamptz")
    .addColumn("max_fact_at", "timestamptz")
    .addColumn("dirty", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("generated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  // 独立 dirty 队列能表达“当前还没有聚合行的空桶”，也避免重建与
  // Settlement 并发时丢失后到的脏标记。队列不是业务事实，可随聚合一起重建。
  await db.schema
    .createTable("usage_aggregate_dirty_bucket")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("bucket_granularity", "varchar(8)", (c) => c.notNull())
    .addColumn("bucket_start", "timestamptz", (c) => c.notNull())
    .addColumn("timezone", "varchar(64)", (c) => c.notNull())
    .addColumn("marked_at", "timestamptz", (c) => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("usage_aggregate_dirty_bucket_pk", [
      "enterprise_id", "bucket_granularity", "bucket_start", "timezone",
    ])
    .execute();
  await sql`
    ALTER TABLE usage_aggregate_dirty_bucket
      ADD CONSTRAINT usage_aggregate_dirty_granularity_check
        CHECK (bucket_granularity IN ('HOUR', 'DAY'))
  `.execute(db);

  // 空桶也要保留“已完整重建”水位；否则读侧无法区分真实 0
  // 与尚未生成的缺桶，会把缺数据伪装成 0。
  await db.schema
    .createTable("usage_aggregate_bucket_state")
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("bucket_granularity", "varchar(8)", (c) => c.notNull())
    .addColumn("bucket_start", "timestamptz", (c) => c.notNull())
    .addColumn("timezone", "varchar(64)", (c) => c.notNull())
    .addColumn("fact_watermark", "timestamptz")
    .addColumn("max_fact_at", "timestamptz")
    .addColumn("generated_at", "timestamptz", (c) => c.notNull())
    .addPrimaryKeyConstraint("usage_aggregate_bucket_state_pk", [
      "enterprise_id", "bucket_granularity", "bucket_start", "timezone",
    ])
    .execute();
  await sql`
    ALTER TABLE usage_aggregate_bucket_state
      ADD CONSTRAINT usage_aggregate_state_granularity_check
        CHECK (bucket_granularity IN ('HOUR', 'DAY'))
  `.execute(db);

  // 0046 已为 principal 建立 (enterprise_id, id) 唯一键，复合外键固化租户边界。
  await db.schema.alterTable("usage_bucket_aggregate")
    .addForeignKeyConstraint(
      "usage_bucket_enterprise_source_principal_fk",
      ["enterprise_id", "source_principal_id"],
      "principal",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema.alterTable("usage_bucket_aggregate")
    .addForeignKeyConstraint(
      "usage_bucket_enterprise_project_principal_fk",
      ["enterprise_id", "project_principal_id"],
      "principal",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema.alterTable("usage_bucket_aggregate")
    .addForeignKeyConstraint(
      "usage_bucket_enterprise_resource_fk",
      ["enterprise_id", "provider_resource_id"],
      "provider_resource",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema.alterTable("usage_bucket_aggregate")
    .addForeignKeyConstraint(
      "usage_bucket_enterprise_model_fk",
      ["enterprise_id", "unified_model_id"],
      "unified_model",
      ["enterprise_id", "id"],
    )
    .execute();

  await sql`
    ALTER TABLE usage_bucket_aggregate
      ADD CONSTRAINT usage_bucket_granularity_check
        CHECK (bucket_granularity IN ('HOUR', 'DAY')),
      ADD CONSTRAINT usage_bucket_values_nonnegative_check
        CHECK (
          request_count >= 0 AND input_tokens >= 0 AND output_tokens >= 0 AND
          cache_tokens >= 0 AND reasoning_tokens >= 0 AND deducted_quota >= 0 AND
          api_cost >= 0
        )
  `.execute(db);

  // PostgreSQL 17：nullable 维度也参与唯一性，保证完整桶重算可稳定 upsert。
  await sql`
    CREATE UNIQUE INDEX usage_bucket_aggregate_dimensions_uq
      ON usage_bucket_aggregate (
        enterprise_id, bucket_granularity, bucket_start, timezone,
        source_principal_id, project_principal_id, provider_resource_id, unified_model_id
      ) NULLS NOT DISTINCT
  `.execute(db);
  await sql`
    CREATE INDEX usage_bucket_aggregate_range_idx
      ON usage_bucket_aggregate (enterprise_id, bucket_granularity, bucket_start)
  `.execute(db);
  await sql`
    CREATE INDEX usage_bucket_aggregate_dirty_idx
      ON usage_bucket_aggregate (enterprise_id, dirty, bucket_start)
      WHERE dirty = true
  `.execute(db);
  await sql`
    CREATE INDEX usage_aggregate_dirty_marked_idx
      ON usage_aggregate_dirty_bucket (bucket_granularity, marked_at, enterprise_id)
  `.execute(db);
  await sql`
    CREATE INDEX usage_aggregate_state_generated_idx
      ON usage_aggregate_bucket_state (enterprise_id, bucket_granularity, generated_at)
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("usage_aggregate_bucket_state").execute();
  await db.schema.dropTable("usage_aggregate_dirty_bucket").execute();
  await db.schema.dropTable("usage_bucket_aggregate").execute();
}
