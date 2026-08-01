/**
 * POOL-012 —— 用量账本搜索、组合筛选与超额事实。
 *
 * 历史结算没有保存请求级超额判定，不能根据今天的 Grant/Counter 重算历史，
 * 因此新增 nullable overage：null 表示迁移前事实未知；新结算写入 true/false。
 * 其余索引覆盖企业内时间分页、常用维度和厂商资源过滤。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  // pg_trgm 是 PostgreSQL trusted extension；用于 request UUID 文本和主体名称的包含搜索。
  // down 不删除共享 extension，只回滚本迁移创建的对象。
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await db.schema
    .alterTable("ledger_transaction")
    .addColumn("overage", "boolean")
    .execute();

  await sql`
    CREATE INDEX ledger_transaction_enterprise_created_idx
        ON ledger_transaction (enterprise_id, created_at DESC, ai_request_id)
  `.execute(db);
  await sql`
    CREATE INDEX ai_request_enterprise_client_idx
        ON ai_request (enterprise_id, client_id)
  `.execute(db);
  await sql`
    CREATE INDEX ai_request_enterprise_model_idx
        ON ai_request (enterprise_id, unified_model)
  `.execute(db);
  await sql`
    CREATE INDEX ai_request_enterprise_status_started_idx
        ON ai_request (enterprise_id, status, started_at DESC)
  `.execute(db);
  await sql`
    CREATE INDEX ledger_line_enterprise_resource_request_idx
        ON ledger_line (enterprise_id, provider_resource_id, ai_request_id)
  `.execute(db);
  await sql`
    CREATE INDEX principal_enterprise_name_idx
        ON principal (enterprise_id, name)
  `.execute(db);
  await sql`
    CREATE INDEX principal_name_trgm_idx
        ON principal USING gin (name gin_trgm_ops)
  `.execute(db);
  await sql`
    CREATE INDEX ledger_transaction_request_text_trgm_idx
        ON ledger_transaction USING gin ((ai_request_id::text) gin_trgm_ops)
  `.execute(db);
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await sql`DROP INDEX IF EXISTS ledger_transaction_request_text_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS principal_name_trgm_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS principal_enterprise_name_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS ledger_line_enterprise_resource_request_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS ai_request_enterprise_status_started_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS ai_request_enterprise_model_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS ai_request_enterprise_client_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS ledger_transaction_enterprise_created_idx`.execute(db);
  await db.schema
    .alterTable("ledger_transaction")
    .dropColumn("overage")
    .execute();
}
