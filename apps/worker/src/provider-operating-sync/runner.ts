import { sql, type Kysely } from "kysely";
import {
  type Database,
  ProviderRepository,
  ResourcePoolRepository,
} from "@qianliu/database";
import {
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
}

function shanghaiSyncDay(now: Date): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

function isProviderCode(value: string): value is ProviderCode {
  return value === "deepseek" || value === "kimi" || value === "zhipu";
}

/** API 充值流水晚于最后一次厂商快照时，当天允许额外同步一次余额。 */
async function needsPostRechargeSync(
  db: Kysely<Database>, resource: SyncResource,
): Promise<boolean> {
  if (resource.mode !== "API") return false;
  const result = await sql<{
    purchase_created_at: Date | null; snapshot_collected_at: Date | null;
  }>`
    SELECT
      (SELECT max(p.created_at) FROM resource_purchase_record p
        WHERE p.enterprise_id = ${resource.enterprise_id}::uuid
          AND p.provider_resource_id = ${resource.id}::uuid
          AND p.purchase_type = 'API_RECHARGE') AS purchase_created_at,
      (SELECT max(s.collected_at) FROM provider_resource_operating_snapshot s
        WHERE s.enterprise_id = ${resource.enterprise_id}::uuid
          AND s.provider_resource_id = ${resource.id}::uuid
          AND s.source = 'PROVIDER_SYNC') AS snapshot_collected_at
  `.execute(db);
  const row = result.rows[0];
  return row?.purchase_created_at !== null && row?.purchase_created_at !== undefined
    && (row.snapshot_collected_at === null
      || row.snapshot_collected_at === undefined
      || row.purchase_created_at > row.snapshot_collected_at);
}

async function shouldSkipDailySync(
  db: Kysely<Database>, resource: SyncResource, syncDay: Date,
): Promise<boolean> {
  const attempted = await db.selectFrom("provider_resource_operating_sync_attempt")
    .select("id")
    .where("enterprise_id", "=", resource.enterprise_id)
    .where("provider_resource_id", "=", resource.id)
    .where("sync_day", "=", syncDay)
    .executeTakeFirst();
  return attempted !== undefined && !(await needsPostRechargeSync(db, resource));
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

export async function runProviderOperatingSyncTick(input: {
  db: Kysely<Database>; kekBase64: string; fetch?: ProviderOperatingFetch; now?: Date;
}): Promise<ProviderOperatingSyncResult> {
  const now = input.now ?? new Date();
  const syncDay = shanghaiSyncDay(now);
  const nextSyncAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const kek = decodeKek(input.kekBase64);
  const repo = new ProviderRepository(input.db);
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
    .execute() as SyncResource[];
  let snapshotsCreated = 0;
  let failed = 0;
  let notSupported = 0;
  for (const resource of resources) {
    await recoverFromFreshPositiveBalance(input.db, poolRepo, resource);
    if (await shouldSkipDailySync(input.db, resource, syncDay)) continue;
    const startedAt = new Date(now);
    let snapshotId: string | null = null;
    let providerDataAt: Date | null = null;
    let balanceStatus: "SUCCESS" | "FAILED" | "NOT_SUPPORTED" = "NOT_SUPPORTED";
    let costStatus: "SUCCESS" | "FAILED" | "NOT_SUPPORTED" = "NOT_SUPPORTED";
    let errorCode: string | null = null;
    let failureReason: string | null = null;
    try {
      if (!isProviderCode(resource.provider_code) || !resource.credential_ciphertext) {
        notSupported += 1;
        errorCode = resource.credential_ciphertext ? "PROVIDER_NOT_SUPPORTED" : "CREDENTIAL_MISSING";
        failureReason = resource.credential_ciphertext
          ? "厂商未提供可用的余额/费用同步接口"
          : "资源没有可用凭证";
      } else {
        const credential = decryptCredential(
          JSON.parse(resource.credential_ciphertext) as EncryptedCredential,
          kek,
        );
        const balance = await queryProviderOperatingBalance({
          providerCode: resource.provider_code,
          mode: resource.mode,
          credential,
          fetch: input.fetch,
          now,
        });
        if (balance === null) {
          notSupported += 1;
          errorCode = "PROVIDER_BALANCE_API_NOT_SUPPORTED";
          failureReason = "厂商未提供可用余额接口；费用接口同样未提供";
        } else {
          const latest = (await repo.listLatestOperatingSnapshots(resource.enterprise_id))
            .find((row) => row.provider_resource_id === resource.id);
          const snapshot = await repo.appendOperatingSnapshot(resource.enterprise_id, resource.id, {
            source: "PROVIDER_SYNC",
            collected_at: now,
            currency: balance.currency,
            recharge_amount: latest?.recharge_amount ?? null,
            current_balance: balance.totalBalance,
            granted_balance: balance.grantedBalance,
            topped_up_balance: balance.toppedUpBalance,
            provider_balance_available: balance.available,
            balance_source: "PROVIDER_API",
            cumulative_cost: latest?.cumulative_cost ?? null,
            current_period_cost: latest?.current_period_cost ?? null,
            cost_period_start: latest?.cost_period_start ?? null,
            cost_period_end: latest?.cost_period_end ?? null,
            cost_source: latest?.cost_source ?? (latest?.current_period_cost === null || latest === undefined
              ? "NOT_SUPPORTED" : latest.source === "BILL_RECONCILIATION" ? "BILL_RECONCILIATION" : "ADMIN"),
            balance_updated_at: balance.providerDataAt,
          });
          snapshotId = snapshot?.id ?? null;
          providerDataAt = balance.providerDataAt;
          balanceStatus = "SUCCESS";
          // DeepSeek 没有公开费用/账单 API；本地账本费用在经营账单单独展示。
          costStatus = "NOT_SUPPORTED";
          errorCode = "PROVIDER_COST_API_NOT_SUPPORTED";
          failureReason = "余额同步成功；厂商未公开费用接口，API 实际费用取本地已结算账本";
          snapshotsCreated += 1;
          await recoverFromFetchedBalance(poolRepo, resource, snapshotId);
        }
      }
    } catch (cause) {
      failed += 1;
      balanceStatus = "FAILED";
      costStatus = "NOT_SUPPORTED";
      errorCode = cause instanceof ProviderOperatingFactsError ? cause.code : "UPSTREAM_UNAVAILABLE";
      failureReason = cause instanceof Error ? cause.message.slice(0, 500) : "厂商经营数据同步失败";
    }
    await input.db.insertInto("provider_resource_operating_sync_attempt").values({
      enterprise_id: resource.enterprise_id,
      provider_resource_id: resource.id,
      sync_day: syncDay,
      balance_status: balanceStatus,
      cost_status: costStatus,
      snapshot_id: snapshotId,
      provider_data_at: providerDataAt,
      started_at: startedAt,
      completed_at: new Date(now),
      next_sync_at: nextSyncAt,
      error_code: errorCode,
      failure_reason: failureReason,
      adapter_version: PROVIDER_OPERATING_ADAPTER_VERSION,
    }).onConflict((oc) => oc.columns(["enterprise_id", "provider_resource_id", "sync_day"]).doNothing()).execute();
  }
  return { resourcesScanned: resources.length, snapshotsCreated, failed, notSupported };
}
