/**
 * POOL-032：厂商 Coding Plan 额度窗口定时同步 tick。
 *
 * 只处理到期的 CODING_PLAN 资源（kimi/zhipu），解密凭证 → 调厂商额度接口 → 写窗口快照。
 * 健康资源按分钟节流；隔离资源按 cooldown_until 定点检查。厂商当次响应确认所有窗口
 * 有余量时只自动解除额度类隔离。CREDENTIAL_INVALID 保持隔离，因为额度接口成功
 * 不能证明 Chat 接口鉴权成功。
 */
import { type Kysely } from "kysely";
import {
  type Database,
  ProviderQuotaWindowRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import {
  type ProviderCode,
  type ResourceMode,
  type EncryptedCredential,
  type QuotaFetch,
  type QuotaWindow,
  decryptCredential,
  decodeKek,
  queryCodingPlanQuota,
  ProviderCodingPlanQuotaError,
  CODING_PLAN_QUOTA_ADAPTER_VERSION,
} from "@qianliu/provider-adapters";

export interface QuotaTickResult {
  resourcesScanned: number;
  windowsUpserted: number;
  resourcesRecovered: number;
  failed: number;
}

interface CodingPlanResourceRow {
  enterprise_id: string;
  id: string;
  provider_code: string;
  credential_ciphertext: string | null;
  status: string;
  cooldown_until: Date | null;
}

type QuotaProviderCode = Extract<ProviderCode, "kimi" | "zhipu">;

function supportsQuotaSync(code: string): code is QuotaProviderCode {
  return code === "kimi" || code === "zhipu";
}

function quotaWindowsConfirmRecovery(
  providerCode: QuotaProviderCode,
  windows: readonly QuotaWindow[],
): boolean {
  const knownWindows = windows.filter((window) =>
    !window.unsupported && window.remaining !== null
  );
  const knownWindowTypes = new Set(knownWindows.map((window) => window.windowType));
  // Kimi 同时提供 5 小时和周窗口，两者都是必需证据；
  // 智谱的周窗口可明确为 UNSUPPORTED，此时只要 5 小时窗口可知即可恢复。
  const requiredWindowTypes = providerCode === "kimi"
    ? ["FIVE_HOUR", "WEEKLY"] as const
    : ["FIVE_HOUR"] as const;
  return requiredWindowTypes.every((windowType) => knownWindowTypes.has(windowType))
    && knownWindows.every((window) => Number(window.remaining) > 0);
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
  healthySyncIntervalMs?: number;
  retryIntervalMs?: number;
}): Promise<QuotaTickResult> {
  const now = input.now ?? new Date();
  const kek = decodeKek(input.kekBase64);
  const repo = new ProviderQuotaWindowRepository(input.db);
  const poolRepo = new ResourcePoolRepository(input.db);
  const kimiEnabled = input.kimiEnabled ?? process.env.KIMI_QUOTA_SYNC_ENABLED !== "false";
  const zhipuEnabled = input.zhipuEnabled ?? process.env.ZHIPU_QUOTA_SYNC_ENABLED !== "false";

  const healthySyncIntervalMs = input.healthySyncIntervalMs ?? 5 * 60_000;
  const retryIntervalMs = input.retryIntervalMs ?? 5 * 60_000;
  const candidates = await input.db.selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "provider_resource.enterprise_id as enterprise_id",
      "provider_resource.id as id",
      "provider.code as provider_code",
      "provider_resource.credential_ciphertext as credential_ciphertext",
      "provider_resource.status as status",
      "provider_resource.cooldown_until as cooldown_until",
    ])
    .where("provider_resource.mode", "=", "CODING_PLAN")
    .where("provider_resource.status", "in", [
      "ACTIVE", "DEGRADED", "RATE_LIMITED", "EXHAUSTED", "CREDENTIAL_INVALID",
    ])
    .where("provider.status", "=", "ACTIVE")
    .where("provider_resource.credential_ciphertext", "is not", null)
    .execute() as CodingPlanResourceRow[];

  const lastSyncRows = await input.db.selectFrom("provider_quota_window")
    .select("provider_resource_id")
    .select((eb) => eb.fn.max("collected_at").as("last_collected_at"))
    .where("is_current", "=", true)
    .groupBy("provider_resource_id")
    .execute() as Array<{ provider_resource_id: string; last_collected_at: Date | null }>;
  const lastSyncAt = new Map(lastSyncRows.map((row) => [
    row.provider_resource_id, row.last_collected_at?.getTime() ?? null,
  ]));
  const resources = candidates.filter((resource): resource is CodingPlanResourceRow & {
    provider_code: QuotaProviderCode;
  } => {
    if (!supportsQuotaSync(resource.provider_code)) return false;
    if (resource.status === "ACTIVE" || resource.status === "DEGRADED") {
      const last = lastSyncAt.get(resource.id);
      return last === undefined || last === null || last <= now.getTime() - healthySyncIntervalMs;
    }
    return resource.cooldown_until === null || resource.cooldown_until <= now;
  });

  let windowsUpserted = 0;
  let resourcesRecovered = 0;
  let failed = 0;
  for (const resource of resources) {
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
      if (quotaWindowsConfirmRecovery(resource.provider_code, result.windows)) {
        const recovered = await poolRepo.recordQuotaSyncRecovery(resource.id);
        if (recovered) resourcesRecovered += 1;
        else if (resource.status === "CREDENTIAL_INVALID") {
          await poolRepo.scheduleQuotaSync(
            resource.id,
            new Date(now.getTime() + retryIntervalMs),
            now,
          );
        }
      } else if (!["ACTIVE", "DEGRADED"].includes(resource.status)) {
        const nextResetAt = result.windows
          .filter((window) => !window.unsupported
            && window.remaining !== null
            && Number(window.remaining) <= 0)
          .map((window) => window.resetAt)
          .filter((value): value is Date => value !== null && value > now)
          .sort((left, right) => left.getTime() - right.getTime())[0]
          ?? new Date(now.getTime() + retryIntervalMs);
        await poolRepo.scheduleQuotaSync(resource.id, nextResetAt, now);
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
      if (!["ACTIVE", "DEGRADED"].includes(resource.status)) {
        await poolRepo.scheduleQuotaSync(
          resource.id,
          new Date(now.getTime() + retryIntervalMs),
          now,
        );
      }
      console.error(JSON.stringify({
        event: "quota_sync_failed", resource_id: resource.id,
        provider: resource.provider_code, error_code: code,
      }));
    }
  }
  return { resourcesScanned: resources.length, windowsUpserted, resourcesRecovered, failed };
}
