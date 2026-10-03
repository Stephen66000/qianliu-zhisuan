/**
 * POOL-032 / CPQW：厂商 Coding Plan 额度窗口定时同步 tick。
 *
 * 只处理到期的 CODING_PLAN 资源（kimi/zhipu）。健康资源按分钟节流；隔离资源按
 * cooldown_until 定点检查。每次 GET 走统一条件提交入口（计划§7）：
 * GET 前捕获 queryToken，网络在事务外，提交在同一资源优先事务内完成窗口写入、
 * block 合并/解除、状态迁移、关联额度事件关闭与 revision 递增；token 失配只标
 * SUPERSEDED，不写当前事实。CREDENTIAL_INVALID 保持隔离，因为额度接口成功不能
 * 证明 Chat 接口鉴权成功。
 */
import { type Kysely } from "kysely";
import {
  type Database,
  QuotaBlockRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import {
  type ProviderCode,
  type ResourceMode,
  type EncryptedCredential,
  type QuotaFetch,
  canonicalProviderCode,
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
  /** CPQW：token 失配被拒绝的提交数（旧结果覆盖新故障的防线）。 */
  superseded: number;
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

// 审核修复（P1）：生产历史 code 可能为 "Kimi"/"Zhipu"（大写），严格比较会
// 把整条资源跳过（WP02 额度同步覆盖的残余漏洞）。与 Adapter/探针同口径：
// 先经 canonicalProviderCode 规范化，再匹配额度同步支持的厂商。
function quotaProviderCode(rawCode: string): QuotaProviderCode | null {
  const code = canonicalProviderCode(rawCode);
  if (code === "kimi") return "kimi";
  if (code === "zhipu") return "zhipu";
  return null;
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
  const poolRepo = new ResourcePoolRepository(input.db);
  const quotaBlockRepo = new QuotaBlockRepository(input.db);
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
    .where("provider.archived_at", "is", null)
    .where("provider_resource.archived_at", "is", null)
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
  // 审核修复（P1）：规范化后的厂商 code 回写进资源行，下游
  // queryCodingPlanQuota / 恢复判定 / 日志全部使用 canonical code。
  const resources = candidates.flatMap((raw): Array<CodingPlanResourceRow & {
    provider_code: QuotaProviderCode;
  }> => {
    const code = quotaProviderCode(raw.provider_code);
    if (code === null) return [];
    const resource: CodingPlanResourceRow & { provider_code: QuotaProviderCode } = { ...raw, provider_code: code };
    if (resource.status === "ACTIVE" || resource.status === "DEGRADED") {
      const last = lastSyncAt.get(resource.id);
      const due = last === undefined || last === null || last <= now.getTime() - healthySyncIntervalMs;
      return due ? [resource] : [];
    }
    const cooled = resource.cooldown_until === null || resource.cooldown_until <= now;
    return cooled ? [resource] : [];
  });

  let windowsUpserted = 0;
  let resourcesRecovered = 0;
  let failed = 0;
  let superseded = 0;
  for (const resource of resources) {
    if (resource.provider_code === "kimi" && !kimiEnabled) continue;
    if (resource.provider_code === "zhipu" && !zhipuEnabled) continue;
    const mode = "CODING_PLAN" as ResourceMode;
    // GET 前捕获 queryToken（计划§7）；网络在事务外。
    const capture = await quotaBlockRepo.captureQuotaQueryToken(resource.id, now);
    if (capture === null || capture.credentialCiphertext === null) continue;
    try {
      const credential = decryptCredential(
        JSON.parse(capture.credentialCiphertext) as EncryptedCredential, kek,
      );
      const result = await queryCodingPlanQuota({
        providerCode: resource.provider_code, mode, credential, fetch: input.fetch, now,
      });
      windowsUpserted += result.windows.length;
      const commit = await quotaBlockRepo.commitQuotaQueryResult({
        token: capture.token,
        source: "PROVIDER_SYNC",
        adapterVersion: result.adapterVersion,
        providerDataAt: result.providerDataAt,
        windows: result.windows.map((window) => ({
          windowType: window.windowType,
          limit: window.limit,
          used: window.used,
          remaining: window.remaining,
          unit: window.unit,
          ratio: window.ratio,
          resetAt: window.resetAt,
          unsupported: Boolean(window.unsupported),
        })),
        now,
        retryIntervalMs,
      });
      if (commit.status === "SUPERSEDED") {
        superseded += 1;
        console.error(JSON.stringify({
          event: "quota_sync_superseded", resource_id: resource.id,
          provider: resource.provider_code, reason: commit.reason,
        }));
        continue;
      }
      if (commit.recovered) resourcesRecovered += 1;
      // CREDENTIAL_INVALID 的额度事实即使清空也保持隔离，按间隔继续检查。
      if (resource.status === "CREDENTIAL_INVALID" && !commit.blockActive) {
        await poolRepo.scheduleQuotaSync(resource.id, new Date(now.getTime() + retryIntervalMs), now);
      }
      console.error(JSON.stringify({
        event: "quota_sync_success", resource_id: resource.id,
        provider: resource.provider_code, windows: result.windows.length,
        recovered: commit.recovered,
      }));
    } catch (cause) {
      const code = cause instanceof ProviderCodingPlanQuotaError ? cause.code : "UPSTREAM_UNAVAILABLE";
      failed += 1;
      // 失败也走条件提交：仅保鲜观察与 nextCheck，保留 block 与未来 reset（计划§7）。
      const commit = await quotaBlockRepo.commitQuotaQueryFailure({
        token: capture.token,
        source: "PROVIDER_SYNC",
        adapterVersion: CODING_PLAN_QUOTA_ADAPTER_VERSION,
        errorCode: code,
        now,
        retryIntervalMs,
      });
      if (commit.status === "SUPERSEDED") {
        superseded += 1;
        continue;
      }
      // 无 block 的 CREDENTIAL_INVALID 失败路径沿用间隔调度。
      if (resource.status === "CREDENTIAL_INVALID" && !commit.blockActive) {
        await poolRepo.scheduleQuotaSync(resource.id, new Date(now.getTime() + retryIntervalMs), now);
      }
      console.error(JSON.stringify({
        event: "quota_sync_failed", resource_id: resource.id,
        provider: resource.provider_code, error_code: code,
      }));
    }
  }
  return { resourcesScanned: resources.length, windowsUpserted, resourcesRecovered, failed, superseded };
}
