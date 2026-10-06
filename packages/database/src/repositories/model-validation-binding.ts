import { capabilityChatConfigHash } from "@qianliu/provider-adapters";
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";

/**
 * F-099 补遗：模型验证与启用门禁共用的绑定快照。
 * credentialFingerprint = 资源当前凭证指纹（provider_resource.credential_fingerprint，
 * 不含明文密钥）；callerConfigHash = 影响实际调用的配置标识
 * （capabilityChatConfigHash：provider+mode+model+解析后端点，含 env 相关解析，
 * 解析失败时为 null——与验证记录的 null 按 IS NOT DISTINCT FROM 语义比对）。
 * 验证开始（beginModelValidation）与启用门禁（updateModelRoute）必须用同一实现，
 * 保证"配置变更前启动、变更后才完成的验证"不被当作当前配置的放行依据。
 */
export interface ModelValidationBinding {
  credentialFingerprint: string | null;
  callerConfigHash: string | null;
}

export async function readModelValidationBinding(
  db: Kysely<Database>,
  enterpriseId: string,
  resourceId: string,
  upstreamModel: string,
): Promise<ModelValidationBinding> {
  const row = await db
    .selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "provider_resource.credential_fingerprint",
      "provider_resource.mode",
      "provider.code",
      "provider.capability_set",
    ])
    .where("provider_resource.id", "=", resourceId)
    .where("provider_resource.enterprise_id", "=", enterpriseId)
    .executeTakeFirst();
  if (!row) return { credentialFingerprint: null, callerConfigHash: null };
  let callerConfigHash: string | null = null;
  try {
    callerConfigHash = capabilityChatConfigHash(row.code, row.mode, upstreamModel, row.capability_set);
  } catch {
    callerConfigHash = null;
  }
  return { credentialFingerprint: row.credential_fingerprint, callerConfigHash };
}
