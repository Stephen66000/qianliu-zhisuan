/**
 * 迁移 0007 —— Gateway 请求意图与路由候选快照（W07）。
 *
 * 依据：TRD §5.7 行 336-338。
 * ai_request：稳定请求 ID（进入上游前创建，TRD §8.1 行 524）、下游幂等键、主体、Key、协议、模型、状态。
 * route_candidate：请求当时的候选资源快照、评分因子、总分、reason code（M2 简化，多因子 W12）。
 *
 * 安全：只存元数据，绝不存 messages/prompt/system 正文（content_retention_mode=METADATA_ONLY）。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .createTable("ai_request")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey()) // 稳定请求 ID（非自增，由 Gateway 分配）
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("principal_id", "uuid", (c) => c.notNull().references("principal.id"))
    .addColumn("principal_key_id", "uuid", (c) => c.notNull().references("principal_key.id"))
    .addColumn("idempotency_key", "varchar(128)") // 下游幂等键（客户端重试去重）
    .addColumn("protocol", "varchar(32)", (c) => c.notNull()) // chat | messages
    .addColumn("unified_model", "varchar(64)", (c) => c.notNull())
    .addColumn("stream", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("PENDING"))
    .addColumn("client_id", "varchar(64)") // 客户端识别（仟流 IDE / WorkBuddy 等）
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .addColumn("finished_at", "timestamptz")
    .addColumn("error_classification", "varchar(64)")
    .addColumn("error_code", "varchar(64)")
    .execute();
  await sql`ALTER TABLE ai_request ADD CONSTRAINT ai_request_status_check CHECK (status IN ('PENDING','IN_PROGRESS','SUCCEEDED','FAILED','CANCELLED'))`.execute(db);
  // 下游幂等键唯一（同企业内）
  await db.schema
    .createIndex("ai_request_idempotency_idx")
    .ifNotExists()
    .on("ai_request")
    .columns(["enterprise_id", "idempotency_key"])
    .unique()
    .execute();
  await db.schema
    .createIndex("ai_request_principal_idx")
    .ifNotExists()
    .on("ai_request")
    .columns(["principal_id", "started_at"])
    .execute();

  // route_candidate：候选资源快照（M2 简化：单候选；多因子评分在 W12）
  await db.schema
    .createTable("route_candidate")
    .ifNotExists()
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("ai_request_id", "uuid", (c) => c.notNull().references("ai_request.id"))
    .addColumn("enterprise_id", "uuid", (c) => c.notNull().references("enterprise.id"))
    .addColumn("provider_resource_id", "uuid", (c) => c.notNull().references("provider_resource.id"))
    .addColumn("upstream_model", "varchar(128)", (c) => c.notNull())
    .addColumn("priority", "integer", (c) => c.notNull())
    .addColumn("weight", "integer", (c) => c.notNull())
    .addColumn("selected", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("score_factors", "jsonb") // 评分因子快照（归一化值）
    .addColumn("total_score", "numeric")
    .addColumn("reason_code", "varchar(64)") // 选中/未选中原因
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo("now()"))
    .execute();
  await db.schema
    .createIndex("route_candidate_request_idx")
    .ifNotExists()
    .on("route_candidate")
    .column("ai_request_id")
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropTable("route_candidate").ifExists().execute();
  await db.schema.dropTable("ai_request").ifExists().execute();
}
