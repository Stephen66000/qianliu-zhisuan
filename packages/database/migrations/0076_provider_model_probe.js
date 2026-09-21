/**
 * 0076：Kimi 权限探针运行/明细脱敏证据（WP04，加法迁移）。
 *
 * 背景：provider_model_discovery_item 只有 compatible/unavailable_reason/
 * last_validated_at，无法承载模型级探针诊断合同（HTTP 状态、统一错误码、
 * 可重试性）；且接入前尚不存在 provider_resource_id。
 *
 * 约束：不保存 Key、Authorization Header、Prompt 或原始错误正文；
 * 只保存 credential fingerprint、endpoint scope/host、状态、分类与哈希。
 * 旧发现快照继续可读（纯加法，无列删除/改写）。
 */
export async function up(db) {
  await db.schema
    .createTable("provider_model_probe_run")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (col) => col.notNull().references("enterprise.id"))
    .addColumn("provider_id", "uuid", (col) => col.references("provider.id"))
    .addColumn("provider_resource_id", "uuid", (col) => col.references("provider_resource.id"))
    .addColumn("provider_code", "text", (col) => col.notNull())
    .addColumn("resource_mode", "text", (col) => col.notNull())
    .addColumn("credential_fingerprint", "text", (col) => col.notNull())
    .addColumn("endpoint_scope", "text", (col) => col.notNull())
    .addColumn("endpoint_host", "text", (col) => col.notNull())
    .addColumn("discovery_source", "text")
    .addColumn("discovery_source_hash", "text")
    .addColumn("parser_version", "text")
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("idempotency_key", "text", (col) => col.notNull())
    .addColumn("request_hash", "text", (col) => col.notNull())
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(db.fn("now")))
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("provider_model_probe_run_resource_idx")
    .on("provider_model_probe_run")
    .columns(["enterprise_id", "provider_resource_id", "started_at"])
    .execute();
  await db.schema
    .createIndex("provider_model_probe_run_request_hash_idx")
    .on("provider_model_probe_run")
    .columns(["enterprise_id", "request_hash"])
    .execute();
  await db.schema
    .createTable("provider_model_probe_item")
    .addColumn("id", "uuid", (col) => col.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("probe_run_id", "uuid", (col) =>
      col.notNull().references("provider_model_probe_run.id").onDelete("cascade"))
    .addColumn("upstream_model", "text", (col) => col.notNull())
    .addColumn("validation_status", "text", (col) => col.notNull())
    .addColumn("http_status", "integer")
    .addColumn("error_code", "text")
    .addColumn("error_category", "text")
    .addColumn("retryable", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("diagnostic_hash", "text")
    .addColumn("checked_at", "timestamptz")
    .execute();
  await db.schema
    .createIndex("provider_model_probe_item_run_idx")
    .on("provider_model_probe_item")
    .columns(["probe_run_id", "upstream_model"])
    .unique()
    .execute();
}

export async function down(db) {
  const existing = await db.selectFrom("provider_model_probe_run").select("id").limit(1).execute();
  if (existing.length) throw new Error("0076 contains probe evidence; rollback refused");
  await db.schema.dropTable("provider_model_probe_item").execute();
  await db.schema.dropTable("provider_model_probe_run").execute();
}
