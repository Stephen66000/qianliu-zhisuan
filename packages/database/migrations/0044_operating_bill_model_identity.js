/**
 * POOL-043：为请求冻结统一模型稳定 ID。
 *
 * ai_request.unified_model 继续保存请求发生时的 alias；新列只负责把历史事实稳定
 * 归到 unified_model。历史数据只按可证明的当前 alias 或 POOL-038 显式改名表回填，
 * 无法判定的记录保留 NULL，禁止按当前路由猜测。
 */
import { sql } from "kysely";

const ALIAS_MAP = [
  ["qianliu-deepseek-deepseek-v4-flash", "ql-deepseek-v4-flash"],
  ["qianliu-deepseek-deepseek-v4-pro", "ql-deepseek-v4-pro"],
  ["qianliu-kimi-k3", "ql-k3"],
  ["qianliu-kimi-k3-256k", "ql-k3-256k"],
  ["qianliu-zhipu-glm-4-6", "ql-glm-4.6"],
  ["qianliu-zhipu-glm-4-7", "ql-glm-4.7"],
  ["qianliu-zhipu-glm-5-2", "ql-glm-5.2"],
];

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema.alterTable("ai_request")
    .addColumn("unified_model_id", "uuid")
    .execute();

  await sql`
    UPDATE ai_request ar
       SET unified_model_id = um.id
      FROM unified_model um
     WHERE ar.enterprise_id = um.enterprise_id
       AND ar.unified_model = um.alias
       AND ar.unified_model_id IS NULL
  `.execute(db);

  for (const [historicalAlias, currentAlias] of ALIAS_MAP) {
    await sql`
      UPDATE ai_request ar
         SET unified_model_id = um.id
        FROM unified_model um
       WHERE ar.enterprise_id = um.enterprise_id
         AND ar.unified_model = ${historicalAlias}
         AND um.alias = ${currentAlias}
         AND ar.unified_model_id IS NULL
    `.execute(db);
  }

  await db.schema.alterTable("ai_request")
    .addForeignKeyConstraint(
      "ai_request_enterprise_model_fk",
      ["enterprise_id", "unified_model_id"],
      "unified_model",
      ["enterprise_id", "id"],
    )
    .execute();
  await db.schema.createIndex("ai_request_enterprise_principal_model_started_idx")
    .on("ai_request")
    .columns(["enterprise_id", "principal_id", "unified_model_id", "started_at"])
    .execute();
  await db.schema.createIndex("ledger_line_enterprise_created_request_idx")
    .on("ledger_line")
    .columns(["enterprise_id", "created_at", "ai_request_id"])
    .execute();
  // completion barrier 的数据库硬约束：一次请求的 attempt 序号与一次 usage 的
  // ledger_line 都只能出现一次。若历史存在重复，迁移应 fail-closed 并先对账修复。
  await db.schema.createIndex("upstream_attempt_unique_request_no_idx")
    .on("upstream_attempt")
    .columns(["ai_request_id", "attempt_no"])
    .unique()
    .execute();
  await db.schema.createIndex("ledger_line_unique_usage_event_idx")
    .on("ledger_line")
    .column("usage_event_id")
    .unique()
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("ledger_line_unique_usage_event_idx").ifExists().execute();
  await db.schema.dropIndex("upstream_attempt_unique_request_no_idx").ifExists().execute();
  await db.schema.dropIndex("ledger_line_enterprise_created_request_idx").ifExists().execute();
  await db.schema.dropIndex("ai_request_enterprise_principal_model_started_idx").ifExists().execute();
  await db.schema.alterTable("ai_request")
    .dropConstraint("ai_request_enterprise_model_fk")
    .execute();
  await db.schema.alterTable("ai_request")
    .dropColumn("unified_model_id")
    .execute();
}
