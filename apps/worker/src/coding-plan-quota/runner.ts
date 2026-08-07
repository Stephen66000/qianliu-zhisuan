/**
 * POOL-032：厂商 Coding Plan 额度窗口定时同步 tick。
 *
 * 遍历所有 CODING_PLAN 资源（kimi/zhipu），解密凭证 → 调厂商额度接口 → 写窗口快照。
 * 不在员工请求热路径执行；失败保鲜（markStale），不影响 Gateway 与资源健康状态。
 */
import { type Kysely } from "kysely";
import {
  type Database,
  ProviderQuotaWindowRepository,
} from "@qianliu/database";
import {
  type ProviderCode,
  type ResourceMode,
  type EncryptedCredential,
  type QuotaFetch,
  decryptCredential,
  decodeKek,
  queryCodingPlanQuota,
  ProviderCodingPlanQuotaError,
  CODING_PLAN_QUOTA_ADAPTER_VERSION,
} from "@qianliu/provider-adapters";

export interface QuotaTickResult {
  resourcesScanned: number;
  windowsUpserted: number;
  failed: number;
}

interface CodingPlanResourceRow {
  enterprise_id: string;
  id: string;
  provider_code: string;
  credential_ciphertext: string | null;
}

function isProviderCode(code: string): code is ProviderCode {
  return code === "deepseek" || code === "kimi" || code === "zhipu";
}

/**
 * 执行一次额度窗口同步扫描。kekBase64 用于解密凭证；fetchImpl 可注入便于测试。
 * 厂商级开关：kimiEnabled/zhipuEnabled 为 false 时跳过对应厂商。
 */
export async function runCodingPlanQuotaTick(input: {
  db: Kysely<Database>;
  kekBase64: string;
  fetch?: QuotaFetch;
  kimiEnabled?: boolean;
  zhipuEnabled?: boolean;
  now?: Date;
}): Promise<QuotaTickResult> {
  const now = input.now ?? new Date();
  const kek = decodeKek(input.kekBase64);
  const repo = new ProviderQuotaWindowRepository(input.db);
  const kimiEnabled = input.kimiEnabled ?? process.env.KIMI_QUOTA_SYNC_ENABLED !== "false";
  const zhipuEnabled = input.zhipuEnabled ?? process.env.ZHIPU_QUOTA_SYNC_ENABLED !== "false";

  // 查所有 CODING_PLAN 且有凭证的 ACTIVE/DEGRADED 资源。
  const resources = await input.db.selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "provider_resource.enterprise_id as enterprise_id",
      "provider_resource.id as id",
      "provider.code as provider_code",
      "provider_resource.credential_ciphertext as credential_ciphertext",
    ])
    .where("provider_resource.mode", "=", "CODING_PLAN")
    .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED"])
    .where("provider.status", "=", "ACTIVE")
    .where("provider_resource.credential_ciphertext", "is not", null)
    .execute() as CodingPlanResourceRow[];

  let windowsUpserted = 0;
  let failed = 0;
  for (const resource of resources) {
    if (!isProviderCode(resource.provider_code)) continue;
    if (resource.provider_code === "kimi" && !kimiEnabled) continue;
    if (resource.provider_code === "zhipu" && !zhipuEnabled) continue;
    const mode = "CODING_PLAN" as ResourceMode;
    try {
      const credential = decryptCredential(
        JSON.parse(resource.credential_ciphertext!) as EncryptedCredential, kek,
      );
      const result = await queryCodingPlanQuota({
        providerCode: resource.provider_code, mode, credential, fetch: input.fetch, now,
      });
      for (const window of result.windows) {
        await repo.upsertCurrentWindow({
          enterprise_id: resource.enterprise_id,
          provider_resource_id: resource.id,
          window_type: window.windowType,
          limit_value: window.limit,
          used_value: window.used,
          remaining_value: window.remaining,
          unit: window.unit,
          ratio: window.ratio,
          reset_at: window.resetAt,
          provider_data_at: result.providerDataAt,
          source: "PROVIDER_SYNC",
          adapter_version: result.adapterVersion,
          sync_status: window.unsupported ? "UNSUPPORTED" : "SUCCESS",
          sync_error_code: null,
        }, now);
        windowsUpserted += 1;
      }
      console.error(JSON.stringify({
        event: "quota_sync_success", resource_id: resource.id,
        provider: resource.provider_code, windows: result.windows.length,
      }));
    } catch (cause) {
      const code = cause instanceof ProviderCodingPlanQuotaError ? cause.code : "UPSTREAM_UNAVAILABLE";
      // 失败保鲜：两个窗口类型都标记 stale/failed，不动已有数值。
      for (const windowType of ["FIVE_HOUR", "WEEKLY"] as const) {
        await repo.markStale(
          resource.enterprise_id, resource.id, windowType, "PROVIDER_SYNC",
          CODING_PLAN_QUOTA_ADAPTER_VERSION, code, now,
        );
      }
      failed += 1;
      console.error(JSON.stringify({
        event: "quota_sync_failed", resource_id: resource.id,
        provider: resource.provider_code, error_code: code,
      }));
    }
  }
  return { resourcesScanned: resources.length, windowsUpserted, failed };
}
