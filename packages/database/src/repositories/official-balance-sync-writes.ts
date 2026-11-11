/**
 * WP3 task 3.2：官方余额同步的共享写入原语（单一事实来源）。
 *
 * worker 周期同步（provider-operating-sync runner）与 control-api 手动刷新
 * （official-balance-routes）共用同一组写入函数：
 * - 成功 = 追加一版 PROVIDER_SYNC 快照（费用维度沿用最新既有快照继承，不从余额
 *   倒推）+ 一行 SUCCESS attempt（cost 恒 NOT_SUPPORTED，DeepSeek 无公开费用接口）；
 * - 失败/不支持 = 只写一行 attempt（快照不动，上次成功值天然保留）。
 * 字段映射与 runner 历史行为逐字一致（WP3 S2 前的 runner 成功分支）。
 */
import type { Kysely } from "kysely";
import type { ProviderOperatingBalance } from "@qianliu/provider-adapters";
import type { Database } from "../kysely.js";
import { ProviderRepository } from "./provider-repository.js";

type LatestOperatingSnapshot =
  Awaited<ReturnType<ProviderRepository["listLatestOperatingSnapshots"]>>[number];

/** 费用维度沿用最新既有快照继承；无历史/无费用值时显式 NOT_SUPPORTED，不从余额倒推。 */
function inheritCostFacts(latest: LatestOperatingSnapshot | undefined): {
  rechargeAmount: string | null; cumulativeCost: string | null; currentPeriodCost: string | null;
  costPeriodStart: Date | null; costPeriodEnd: Date | null;
  costSource: "NOT_SUPPORTED" | "ADMIN" | "LOCAL_LEDGER" | "BILL_RECONCILIATION" | null;
} {
  return {
    rechargeAmount: latest?.recharge_amount ?? null,
    cumulativeCost: latest?.cumulative_cost ?? null,
    currentPeriodCost: latest?.current_period_cost ?? null,
    costPeriodStart: latest?.cost_period_start ?? null,
    costPeriodEnd: latest?.cost_period_end ?? null,
    costSource: latest?.cost_source
      ?? (latest?.current_period_cost === null || latest === undefined
        ? "NOT_SUPPORTED" : latest.source === "BILL_RECONCILIATION" ? "BILL_RECONCILIATION" : "ADMIN"),
  };
}

/** 与 runner 的 shanghaiSyncDay 同一口径（上海时区自然日，attempt.sync_day 分组键）。 */
export function officialBalanceSyncDay(now: Date): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

/** attempt 行公共身份（同步日/起止/下次允许同步时间/适配器版本）。 */
export interface OfficialBalanceAttemptIdentity {
  syncDay: Date; startedAt: Date; completedAt: Date; nextSyncAt: Date; adapterVersion: string;
}

interface OfficialBalanceAttemptValues extends OfficialBalanceAttemptIdentity {
  enterpriseId: string; resourceId: string;
  balanceStatus: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
  snapshotId: string | null; providerDataAt: Date | null;
  errorCode: string | null; failureReason: string | null;
}

async function insertOfficialBalanceAttempt(
  db: Kysely<Database>, v: OfficialBalanceAttemptValues,
): Promise<void> {
  // cost_status 恒 NOT_SUPPORTED：DeepSeek 没有公开费用/账单 API，本地账本费用
  // 在经营账单单独展示（与快照 cost_source 继承语义无关）。
  await db.insertInto("provider_resource_operating_sync_attempt").values({
    enterprise_id: v.enterpriseId,
    provider_resource_id: v.resourceId,
    sync_day: v.syncDay,
    balance_status: v.balanceStatus,
    cost_status: "NOT_SUPPORTED",
    snapshot_id: v.snapshotId,
    provider_data_at: v.providerDataAt,
    started_at: v.startedAt,
    completed_at: v.completedAt,
    next_sync_at: v.nextSyncAt,
    error_code: v.errorCode,
    failure_reason: v.failureReason,
    adapter_version: v.adapterVersion,
  }).execute();
}

/**
 * 官方余额同步成功：追加一版 PROVIDER_SYNC 快照 + 一行 SUCCESS attempt。
 * 返回快照 id（供 EXHAUSTED 恢复链消费）；resource 不存在时 append 返回 null，
 * attempt 照写（与 runner 历史行为一致）。
 */
export async function recordOfficialBalanceSyncSuccess(
  db: Kysely<Database>,
  input: OfficialBalanceAttemptIdentity & {
    enterpriseId: string; resourceId: string; balance: ProviderOperatingBalance;
  },
): Promise<{ snapshotId: string | null }> {
  const repo = new ProviderRepository(db);
  const latest = (await repo.listLatestOperatingSnapshots(input.enterpriseId))
    .find((row) => row.provider_resource_id === input.resourceId);
  const inherited = inheritCostFacts(latest);
  const snapshot = await repo.appendOperatingSnapshot(input.enterpriseId, input.resourceId, {
    source: "PROVIDER_SYNC",
    collected_at: input.completedAt,
    currency: input.balance.currency,
    recharge_amount: inherited.rechargeAmount,
    current_balance: input.balance.totalBalance,
    granted_balance: input.balance.grantedBalance,
    topped_up_balance: input.balance.toppedUpBalance,
    provider_balance_available: input.balance.available,
    balance_source: "PROVIDER_API",
    cumulative_cost: inherited.cumulativeCost,
    current_period_cost: inherited.currentPeriodCost,
    cost_period_start: inherited.costPeriodStart,
    cost_period_end: inherited.costPeriodEnd,
    cost_source: inherited.costSource,
    balance_updated_at: input.balance.providerDataAt,
  });
  const snapshotId = snapshot?.id ?? null;
  await insertOfficialBalanceAttempt(db, {
    enterpriseId: input.enterpriseId, resourceId: input.resourceId,
    syncDay: input.syncDay, startedAt: input.startedAt,
    completedAt: input.completedAt, nextSyncAt: input.nextSyncAt,
    adapterVersion: input.adapterVersion,
    balanceStatus: "SUCCESS",
    snapshotId,
    providerDataAt: input.balance.providerDataAt,
    errorCode: "PROVIDER_COST_API_NOT_SUPPORTED",
    failureReason: "余额同步成功；厂商未公开费用接口，API 实际费用取本地已结算账本",
  });
  return { snapshotId };
}

/** 官方余额同步失败/不支持：只留一行 attempt（快照/上次成功值不动）。 */
export async function recordOfficialBalanceSyncAttempt(
  db: Kysely<Database>,
  input: OfficialBalanceAttemptIdentity & {
    enterpriseId: string; resourceId: string;
    balanceStatus: "FAILED" | "NOT_SUPPORTED";
    errorCode: string | null; failureReason: string | null;
  },
): Promise<void> {
  await insertOfficialBalanceAttempt(db, {
    enterpriseId: input.enterpriseId, resourceId: input.resourceId,
    syncDay: input.syncDay, startedAt: input.startedAt,
    completedAt: input.completedAt, nextSyncAt: input.nextSyncAt,
    adapterVersion: input.adapterVersion,
    balanceStatus: input.balanceStatus,
    snapshotId: null,
    providerDataAt: null,
    errorCode: input.errorCode,
    failureReason: input.failureReason,
  });
}
