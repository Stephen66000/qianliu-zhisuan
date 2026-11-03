import { type Kysely } from "kysely";
import { readProviderOperatingSyncIntervalMs } from "@qianliu/config";
import {
  type Database,
  listQuiescentEnterpriseIds,
  officialBalanceSyncDay,
  recordOfficialBalanceSyncAttempt,
  recordOfficialBalanceSyncSuccess,
  ResourcePoolRepository,
} from "@qianliu/database";
import {
  canonicalProviderCode,
  decodeKek,
  decryptCredential,
  PROVIDER_OPERATING_ADAPTER_VERSION,
  ProviderOperatingFactsError,
  queryProviderOperatingBalance,
  type EncryptedCredential,
  type ProviderCode,
  type ProviderOperatingFetch,
} from "@qianliu/provider-adapters";

interface SyncResource {
  id: string; enterprise_id: string; mode: "API" | "CODING_PLAN";
  provider_code: string; credential_ciphertext: string | null;
  status: string; updated_at: Date;
}

export interface ProviderOperatingSyncResult {
  resourcesScanned: number; snapshotsCreated: number; failed: number; notSupported: number;
  /** PFA-09：因目标企业处于有效静默租约内而整企业跳过的资源数。 */
  skippedQuiescentResources: number;
}

/**
 * F-P2-7：canonical code 判定（与额度同步 runner 同一修复）——生产历史
 * code（"DeepSeek"/"Zhipu"/"Kimi"）不再被严格比较静默跳过；命中时返回
 * 规范化 code，下游一律消费 canonical 值。
 */
function operatingProviderCode(value: string): ProviderCode | null {
  const code = canonicalProviderCode(value);
  return code === "deepseek" || code === "kimi" || code === "zhipu" ? code : null;
}

/**
 * WP3/OAB-03：P1 周期门禁——最近一次同步尝试（任意 outcome）的 next_sync_at
 * 未到则跳过本资源。替代 0051 时代"每日一次＋充值后补同步"门禁：充值写入口
 * 已随 WP2 API 资金退役（410），充值补同步依赖（resource_purchase_record 查询）
 * 一并移除；0095 放开 attempt 表 daily_uq 后同日多次尝试各留一行。
 */
async function shouldSkipUntilNextSync(
  db: Kysely<Database>, resource: SyncResource, now: Date,
): Promise<boolean> {
  const latest = await db.selectFrom("provider_resource_operating_sync_attempt")
    .select("next_sync_at")
    .where("enterprise_id", "=", resource.enterprise_id)
    .where("provider_resource_id", "=", resource.id)
    .orderBy("started_at", "desc").orderBy("created_at", "desc")
    .executeTakeFirst();
  return latest !== undefined && latest.next_sync_at.getTime() > now.getTime();
}

async function recoverFromFreshPositiveBalance(
  db: Kysely<Database>, poolRepo: ResourcePoolRepository, resource: SyncResource,
): Promise<void> {
  if (resource.mode !== "API" || resource.status !== "EXHAUSTED") return;
  const snapshot = await db.selectFrom("provider_resource_operating_snapshot")
    .select("id")
    .where("enterprise_id", "=", resource.enterprise_id)
    .where("provider_resource_id", "=", resource.id)
    .where("source", "=", "PROVIDER_SYNC")
    .orderBy("collected_at", "desc").orderBy("version", "desc")
    .executeTakeFirst();
  if (snapshot) await poolRepo.recordBalanceSyncRecovery(resource.id, snapshot.id);
}

async function recoverFromFetchedBalance(
  poolRepo: ResourcePoolRepository, resource: SyncResource, snapshotId: string | null,
): Promise<void> {
  if (resource.mode === "API" && resource.status === "EXHAUSTED" && snapshotId) {
    await poolRepo.recordBalanceSyncRecovery(resource.id, snapshotId);
  }
}

export interface ProviderOperatingSyncInput {
  db: Kysely<Database>; kekBase64: string; fetch?: ProviderOperatingFetch; now?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * 官方余额同步 tick（WP3/OAB-03：独立于内部资金账本运行）——不再读取
 * PROVIDER_FINANCE_MODE（旧 FINANCE_MODE_INACTIVE fail-closed 门禁随资金停写
 * 门禁退役移除；订阅续订 runner 的同款门禁独立存在，不受影响）。
 * 快照/attempt 写入走 @qianliu/database 共享原语（WP3 task 3.2，与手动刷新
 * 单一事实来源）：纯查询+留痕，零资金事实写入（provider_finance_* / 充值流水）。
 */
export async function runProviderOperatingSyncTick(
  input: ProviderOperatingSyncInput,
): Promise<ProviderOperatingSyncResult> {
  const now = input.now ?? new Date();
  const syncDay = officialBalanceSyncDay(now);
  const intervalMs = readProviderOperatingSyncIntervalMs(input.env ?? process.env);
  const nextSyncAt = new Date(now.getTime() + intervalMs);
  const kek = decodeKek(input.kekBase64);
  const poolRepo = new ResourcePoolRepository(input.db);
  const resources = await input.db.selectFrom("provider_resource")
    .innerJoin("provider", "provider.id", "provider_resource.provider_id")
    .select([
      "provider_resource.id", "provider_resource.enterprise_id", "provider_resource.mode",
      "provider_resource.credential_ciphertext", "provider.code as provider_code",
      "provider_resource.status", "provider_resource.updated_at",
    ])
    .where("provider_resource.status", "in", ["ACTIVE", "DEGRADED", "EXHAUSTED"])
    .where("provider.status", "=", "ACTIVE")
    .where("provider.archived_at", "is", null)
    .where("provider_resource.archived_at", "is", null)
    .execute() as SyncResource[];
  let snapshotsCreated = 0;
  let failed = 0;
  let notSupported = 0;
  // PFA-09：厂商经营快照属于完整事实水位的一部分（provider_resource_operating_snapshot）。
  // 目标企业处于有效静默租约内时整企业跳过，否则已冻结的候选会被同步写入立刻打漂。
  const quiescent = new Set(await listQuiescentEnterpriseIds(input.db, now));
  const scoped = resources.filter((resource) => !quiescent.has(resource.enterprise_id));
  const skippedQuiescentResources = resources.length - scoped.length;
  for (const resource of scoped) {
    // 恢复尝试先于周期门禁：即使本资源本轮被跳过，隔离后取得的新官方证据
    // （既有快照）仍可按既有流程解除耗尽隔离（OAB-06，行为不变）。
    await recoverFromFreshPositiveBalance(input.db, poolRepo, resource);
    if (await shouldSkipUntilNextSync(input.db, resource, now)) continue;
    const startedAt = new Date(now);
    const completedAt = new Date(now);
    const identity = {
      syncDay, startedAt, completedAt, nextSyncAt,
      adapterVersion: PROVIDER_OPERATING_ADAPTER_VERSION,
    };
    // 失败 attempt 保持"插入发生在 try/catch 之后"的历史语义。
    let failure: { errorCode: string; failureReason: string } | null = null;
    try {
      const operatingCode = operatingProviderCode(resource.provider_code);
      if (!operatingCode || !resource.credential_ciphertext) {
        notSupported += 1;
        await recordOfficialBalanceSyncAttempt(input.db, {
          ...identity, enterpriseId: resource.enterprise_id, resourceId: resource.id,
          balanceStatus: "NOT_SUPPORTED",
          errorCode: resource.credential_ciphertext ? "PROVIDER_NOT_SUPPORTED" : "CREDENTIAL_MISSING",
          failureReason: resource.credential_ciphertext
            ? "厂商未提供可用的余额/费用同步接口"
            : "资源没有可用凭证",
        });
      } else {
        const credential = decryptCredential(
          JSON.parse(resource.credential_ciphertext) as EncryptedCredential,
          kek,
        );
        const balance = await queryProviderOperatingBalance({
          providerCode: operatingCode,
          mode: resource.mode,
          credential,
          fetch: input.fetch,
          now,
        });
        if (balance === null) {
          notSupported += 1;
          await recordOfficialBalanceSyncAttempt(input.db, {
            ...identity, enterpriseId: resource.enterprise_id, resourceId: resource.id,
            balanceStatus: "NOT_SUPPORTED",
            errorCode: "PROVIDER_BALANCE_API_NOT_SUPPORTED",
            failureReason: "厂商未提供可用余额接口；费用接口同样未提供",
          });
        } else {
          const { snapshotId } = await recordOfficialBalanceSyncSuccess(input.db, {
            ...identity, enterpriseId: resource.enterprise_id, resourceId: resource.id,
            balance,
          });
          snapshotsCreated += 1;
          await recoverFromFetchedBalance(poolRepo, resource, snapshotId);
        }
      }
    } catch (cause) {
      failed += 1;
      failure = {
        errorCode: cause instanceof ProviderOperatingFactsError ? cause.code : "UPSTREAM_UNAVAILABLE",
        failureReason: cause instanceof Error ? cause.message.slice(0, 500) : "厂商经营数据同步失败",
      };
    }
    if (failure) {
      await recordOfficialBalanceSyncAttempt(input.db, {
        ...identity, enterpriseId: resource.enterprise_id, resourceId: resource.id,
        balanceStatus: "FAILED",
        errorCode: failure.errorCode,
        failureReason: failure.failureReason,
      });
    }
  }
  return { resourcesScanned: scoped.length, snapshotsCreated, failed, notSupported,
    skippedQuiescentResources };
}
