/**
 * 迁移 0003 —— 下游 Principal Key（W03）。
 *
 * 依据：TRD §5.3。
 * 每个主体默认只有一把有效主 Key（L214）；DB 只存 Pepper HMAC 摘要不存明文（L215）。
 * 字段：key_prefix（展示用）、key_digest（HMAC 摘要）、限制字段、状态、吊销时间。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("principal_key")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("key_prefix", "varchar(32)", (c) => c.notNull()) // 展示用前缀（sk-qianliu-xxxx）
    .addColumn("key_digest", "text", (c) => c.notNull().unique()) // HMAC-SHA256(pepper, key).hex()
    .addColumn("allowed_model_ids", "jsonb") // 允许的 unified_model id 数组；null=全部
    .addColumn("ip_allowlist", "jsonb") // CIDR 数组；null=不限
    .addColumn("expires_at", "timestamptz")
    .addColumn("quota_limit", "bigint") // Token 上限；null=跟随主体 grant
    .addColumn("concurrency_limit", "integer")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE")) // ACTIVE | REVOKED
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("last_used_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .execute();
  // 按 digest 唯一查找（Gateway 校验热路径）
  await db.schema
    .createIndex("principal_key_digest_idx")
    .ifNotExists()
    .on("principal_key")
    .column("key_digest")
    .unique()
    .execute();
  // 按主体查有效 Key
  await db.schema
    .createIndex("principal_key_principal_status_idx")
    .ifNotExists()
    .on("principal_key")
    .columns(["principal_id", "status"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("principal_key").ifExists().execute();
}
