import { sql } from "kysely";

/**
 * 模型验证记录绑定当前凭证与调用配置（F-099 补遗）。
 *
 * - provider_model_validation.credential_fingerprint：验证开始时资源凭证的指纹快照
 *   （来自 provider_resource.credential_fingerprint，不存明文密钥）；NULL=资源无凭证指纹。
 * - provider_model_validation.caller_config_hash：验证开始时影响实际调用的配置标识
 *   （capabilityChatConfigHash：provider+mode+model+解析后端点地址，含 env 相关解析）。
 * 启用路由门禁要求 SUCCEEDED 记录的两组快照与当前资源一致（IS NOT DISTINCT FROM），
 * 换凭证或调用配置变更前启动、变更后才完成的验证不作为放行依据。
 * 历史行（NULL）不匹配已配置资源，仅影响下一次启用动作；不批量停用已启用路由。
 */
/** @param {import('kysely').Kysely} db */
export async function up(db) {
  await sql`ALTER TABLE provider_model_validation ADD COLUMN credential_fingerprint varchar(128) NULL`.execute(db);
  await sql`ALTER TABLE provider_model_validation ADD COLUMN caller_config_hash varchar(64) NULL`.execute(db);
}

/** down 只允许在没有绑定快照事实时执行（丢弃快照会使后续启用门禁失去比对依据）。 */
/** @param {import('kysely').Kysely} db */
export async function down(db) {
  const bound = await sql`SELECT count(*)::int AS count FROM provider_model_validation WHERE credential_fingerprint IS NOT NULL OR caller_config_hash IS NOT NULL`.execute(db);
  if ((bound.rows[0]?.count ?? 0) > 0) {
    throw new Error("validation binding facts exist; destructive down is not allowed");
  }
  await sql`ALTER TABLE provider_model_validation DROP COLUMN IF EXISTS caller_config_hash`.execute(db);
  await sql`ALTER TABLE provider_model_validation DROP COLUMN IF EXISTS credential_fingerprint`.execute(db);
}
