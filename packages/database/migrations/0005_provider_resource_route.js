/**
 * 迁移 0005 —— Provider、Provider Resource、Unified Model、Model Route（W04）。
 *
 * 依据：TRD §5.4。
 * M1 落核心字段（凭证加密、状态、并发、路由优先级/权重）；
 * 运行期补充字段（健康分数、TTFT、错误率等 runtime snapshot）在后续工作包追加迁移。
 *
 * 凭证存储：credential_ciphertext（AES-256-GCM 密文）+ credential_fingerprint（指纹），
 * 明文绝不入库（TRD §5.4 L252）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // provider：厂商
  await db.schema
    .createTable("provider")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("code", "varchar(32)", (c) => c.notNull()) // deepseek | zhipu | kimi
    .addColumn("name", "varchar(128)", (c) => c.notNull())
    .addColumn("adapter_type", "varchar(32)", (c) => c.notNull())
    .addColumn("supported_protocols", "jsonb") // ['chat','messages']
    .addColumn("capability_set", "jsonb") // 能力声明
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("config_schema_version", "varchar(32)")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("provider_enterprise_code_idx")
    .ifNotExists()
    .on("provider")
    .columns(["enterprise_id", "code"])
    .unique()
    .execute();

  // provider_resource：厂商资源账号（凭证加密存储）
  await db.schema
    .createTable("provider_resource")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_id", "uuid", (c) => c.notNull().references("provider.id"))
    .addColumn("name", "varchar(255)", (c) => c.notNull())
    .addColumn("mode", "varchar(16)", (c) => c.notNull()) // API | CODING_PLAN
    .addColumn("credential_type", "varchar(32)", (c) => c.notNull()) // API_KEY | OAUTH | SUBSCRIPTION_SESSION
    // 凭证密文 + 指纹（明文绝不入库）
    .addColumn("credential_ciphertext", "text") // JSON: {ciphertext, nonce, tag}
    .addColumn("credential_fingerprint", "varchar(64)") // 展示用指纹
    .addColumn("credential_version", "integer")
    .addColumn("upstream_models", "jsonb") // 支持的上游模型
    .addColumn("concurrency_limit", "integer")
    .addColumn("status", "varchar(32)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("api_fallback_enabled", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_mode_check CHECK (mode IN ('API', 'CODING_PLAN'))`.execute(db);
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_credential_type_check CHECK (credential_type IN ('API_KEY', 'OAUTH', 'SUBSCRIPTION_SESSION'))`.execute(db);
  await sql`ALTER TABLE provider_resource ADD CONSTRAINT provider_resource_status_check CHECK (status IN ('ACTIVE', 'DEGRADED', 'EXHAUSTED', 'EXPIRED', 'CREDENTIAL_INVALID', 'UNAVAILABLE'))`.execute(db);

  // unified_model：统一模型别名（客户端看到的 qianliu-*）
  await db.schema
    .createTable("unified_model")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("alias", "varchar(64)", (c) => c.notNull()) // qianliu-deepseek 等
    .addColumn("display_name", "varchar(128)", (c) => c.notNull())
    .addColumn("required_capabilities", "jsonb")
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("unified_model_enterprise_alias_idx")
    .ifNotExists()
    .on("unified_model")
    .columns(["enterprise_id", "alias"])
    .unique()
    .execute();

  // model_route：路由候选（priority 数值越小优先级越高，仅同 priority 加权）
  await db.schema
    .createTable("model_route")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("unified_model_id", "uuid", (c) => c.notNull().references("unified_model.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("upstream_model", "varchar(128)", (c) => c.notNull())
    .addColumn("priority", "integer", (c) => c.notNull().defaultTo(100))
    .addColumn("weight", "integer", (c) => c.notNull().defaultTo(1))
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("fallback_policy", "varchar(32)")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  // 权重为正约束（TRD §5.4 L259）
  await sql`ALTER TABLE model_route ADD CONSTRAINT model_route_weight_check CHECK (weight > 0)`.execute(db);
  await db.schema
    .createIndex("model_route_model_idx")
    .ifNotExists()
    .on("model_route")
    .columns(["unified_model_id", "enabled"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("model_route").ifExists().execute();
  await db.schema.dropTable("unified_model").ifExists().execute();
  await db.schema.dropTable("provider_resource").ifExists().execute();
  await db.schema.dropTable("provider").ifExists().execute();
}
