/**
 * POOL-007：分离 Gateway 内部请求主键、客户端追踪 ID 与业务幂等键。
 *
 * - ai_request.id：Gateway 生成的内部 UUID；
 * - client_request_id：可复用的客户端 x-request-id，仅用于追踪；
 * - idempotency_key + request_fingerprint：同一认证 Key 范围内的业务去重。
 */
import { sql } from "kysely";

/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await db.schema
    .alterTable("ai_request")
    .addColumn("client_request_id", "varchar(128)")
    .addColumn("request_fingerprint", "char(64)")
    .execute();

  await db.schema.dropIndex("ai_request_idempotency_idx").ifExists().execute();
  await sql`
    CREATE UNIQUE INDEX ai_request_principal_key_idempotency_uq
        ON ai_request (principal_key_id, idempotency_key)
     WHERE idempotency_key IS NOT NULL
  `.execute(db);
  await db.schema
    .createIndex("ai_request_client_request_idx")
    .on("ai_request")
    .columns(["enterprise_id", "client_request_id", "started_at"])
    .execute();
}

/** @param {import('kysely').Kysely} db */
export async function down(db) {
  await db.schema.dropIndex("ai_request_client_request_idx").ifExists().execute();
  await db.schema.dropIndex("ai_request_principal_key_idempotency_uq").ifExists().execute();
  await db.schema
    .createIndex("ai_request_idempotency_idx")
    .on("ai_request")
    .columns(["enterprise_id", "idempotency_key"])
    .unique()
    .execute();
  await db.schema
    .alterTable("ai_request")
    .dropColumn("request_fingerprint")
    .dropColumn("client_request_id")
    .execute();
}
