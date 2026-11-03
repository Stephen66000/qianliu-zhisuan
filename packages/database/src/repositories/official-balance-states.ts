/**
 * WP3 task 3.3 / C2 合同：官方余额状态读取（逐资源行，OAB-05 无任何合计）。
 *
 * 与既有读取的区别：快照侧显式筛 `source='PROVIDER_SYNC'`（官方来源）——
 * `listLatestOperatingSnapshots` 不筛 source（ADMIN 手工会混入），其语义与
 * dashboard 等旧消费方不动；本函数是官方余额域的独立读取入口。
 *
 * status 为主状态（判定序见 statusMatrix），叠加语义由 `expired` /
 * `last_attempt_failed` 布尔承载（OAB-04：失败与过期可同时表达）。
 */
import { sql, type Kysely } from "kysely";
import { canonicalProviderCode } from "@qianliu/provider-adapters";
import type { Database } from "../kysely.js";

export type OfficialBalanceStatus =
  | "UNSUPPORTED" | "NEVER_SYNCED" | "OK" | "FAILED" | "EXPIRED" | "SYNCING";

export interface OfficialBalanceState {
  provider_resource_id: string;
  supported: boolean;
  status: OfficialBalanceStatus;
  /** OAB-04 叠加：最新成功快照 collected_at 距 now 超过 P2（对所有非 UNSUPPORTED 态计算）。 */
  expired: boolean;
  /** OAB-04 叠加：最新 attempt（任意 outcome）的 balance_status 为 FAILED。 */
  last_attempt_failed: boolean;
  total_balance: string | null;
  currency: string | null;
  composition: { granted: string | null; topped: string | null } | null;
  available: boolean | null;
  /** 最新成功（PROVIDER_SYNC）快照的采集时间；无成功快照 → null。 */
  last_success_at: Date | null;
  last_attempt: {
    at: Date;
    outcome: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
    reason: string | null;
  } | null;
  /** max(最近 attempt started_at + P3, RUNNING 租约 expires_at)；已过期/无值 → null（立即可刷）。 */
  next_refresh_at: Date | null;
}

export interface OfficialBalanceStatesInput {
  now: Date;
  /** P2 过期阈值（毫秒，readProviderOperatingBalanceExpireMs）。 */
  expireMs: number;
  /** P3 刷新冷却（毫秒，readProviderOperatingBalanceRefreshCooldownMs）。 */
  cooldownMs: number;
}

interface LatestOfficialSnapshotRow {
  provider_resource_id: string;
  current_balance: string | null;
  currency: string | null;
  granted_balance: string | null;
  topped_up_balance: string | null;
  provider_balance_available: boolean | null;
  collected_at: Date;
}

interface LatestAttemptRow {
  provider_resource_id: string;
  balance_status: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
  started_at: Date;
  completed_at: Date;
  failure_reason: string | null;
}

/**
 * status 派生矩阵（判定序）：
 * | # | 条件                                          | status       |
 * |---|-----------------------------------------------|--------------|
 * | 1 | canonical provider ≠ deepseek 或 mode ≠ API    | UNSUPPORTED  |
 * | 2 | 存在 RUNNING refresh 行（0096）                | SYNCING      |
 * | 3 | 无成功快照 ∧ 最新 attempt balance_status=FAILED | FAILED（余额 null，不显 0） |
 * | 4 | 无成功快照（含从未同步或仅 NOT_SUPPORTED 痕迹） | NEVER_SYNCED |
 * | 5 | 有成功快照 ∧ 最新 attempt FAILED               | FAILED（expired 可叠加 true） |
 * | 6 | 有成功快照 ∧ 最新 attempt 非 FAILED ∧ 超 P2     | EXPIRED      |
 * | 7 | 其余                                           | OK           |
 */
export async function listOfficialBalanceStates(
  db: Kysely<Database>,
  enterpriseId: string,
  input: OfficialBalanceStatesInput,
): Promise<OfficialBalanceState[]> {
  const { now, expireMs, cooldownMs } = input;
  const [resources, snapshots, attempts, runningRefreshes] = await Promise.all([
    db.selectFrom("provider_resource")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select(["provider_resource.id", "provider_resource.mode", "provider.code as provider_code"])
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .execute(),
    // 最新官方来源快照：DISTINCT ON + collected_at/version 倒序（与恢复链证据查询同序）。
    sql<LatestOfficialSnapshotRow>`
      SELECT DISTINCT ON (provider_resource_id)
        provider_resource_id, current_balance, currency, granted_balance,
        topped_up_balance, provider_balance_available, collected_at
      FROM provider_resource_operating_snapshot
      WHERE enterprise_id = ${enterpriseId}::uuid AND source = 'PROVIDER_SYNC'
      ORDER BY provider_resource_id, collected_at DESC, version DESC
    `.execute(db),
    sql<LatestAttemptRow>`
      SELECT DISTINCT ON (provider_resource_id)
        provider_resource_id, balance_status, started_at, completed_at, failure_reason
      FROM provider_resource_operating_sync_attempt
      WHERE enterprise_id = ${enterpriseId}::uuid
      ORDER BY provider_resource_id, started_at DESC, created_at DESC
    `.execute(db),
    db.selectFrom("provider_resource_balance_refresh")
      .select(["provider_resource_id", "expires_at"])
      .where("enterprise_id", "=", enterpriseId)
      .where("status", "=", "RUNNING")
      .execute(),
  ]);

  const snapshotByResource = new Map(
    snapshots.rows.map((row) => [row.provider_resource_id, row]),
  );
  const attemptByResource = new Map(
    attempts.rows.map((row) => [row.provider_resource_id, row]),
  );
  const refreshExpiryByResource = new Map(
    runningRefreshes.map((row) => [row.provider_resource_id, row.expires_at]),
  );

  const states = resources.map((resource) => {
    const supported = canonicalProviderCode(resource.provider_code) === "deepseek"
      && resource.mode === "API";
    const snapshot = snapshotByResource.get(resource.id);
    const attempt = attemptByResource.get(resource.id);
    const refreshExpiresAt = refreshExpiryByResource.get(resource.id) ?? null;
    const lastAttemptFailed = attempt?.balance_status === "FAILED";
    const expired = supported && snapshot !== undefined
      && now.getTime() - snapshot.collected_at.getTime() > expireMs;

    let status: OfficialBalanceStatus;
    if (!supported) status = "UNSUPPORTED";
    else if (refreshExpiresAt !== null) status = "SYNCING";
    else if (!snapshot) status = lastAttemptFailed ? "FAILED" : "NEVER_SYNCED";
    else if (lastAttemptFailed) status = "FAILED";
    else if (expired) status = "EXPIRED";
    else status = "OK";

    // next_refresh_at：max(最近 attempt started_at + P3, RUNNING 租约 expires_at)；
    // 已过去的候选不输出（立即可刷 → null）。
    const refreshCandidates: Date[] = [];
    if (attempt) {
      refreshCandidates.push(new Date(attempt.started_at.getTime() + cooldownMs));
    }
    if (refreshExpiresAt) refreshCandidates.push(refreshExpiresAt);
    const nextRefreshAtRaw = refreshCandidates.length > 0
      ? refreshCandidates.reduce((a, b) => (a.getTime() > b.getTime() ? a : b))
      : null;
    const nextRefreshAt = nextRefreshAtRaw !== null && nextRefreshAtRaw.getTime() > now.getTime()
      ? nextRefreshAtRaw
      : null;

    return {
      provider_resource_id: resource.id,
      supported,
      status,
      expired,
      last_attempt_failed: lastAttemptFailed,
      // 官方余额只来自 PROVIDER_SYNC 快照；不支持/无成功快照一律 null，绝不零值冒充
      // （ADMIN 手工金额不混入，OAB-01/OAB-02）。
      total_balance: supported && snapshot ? snapshot.current_balance : null,
      currency: supported && snapshot ? snapshot.currency : null,
      composition: supported && snapshot
        ? { granted: snapshot.granted_balance, topped: snapshot.topped_up_balance }
        : null,
      available: supported && snapshot ? snapshot.provider_balance_available : null,
      last_success_at: supported && snapshot ? snapshot.collected_at : null,
      last_attempt: supported && attempt
        ? {
            at: attempt.completed_at,
            outcome: attempt.balance_status,
            reason: attempt.failure_reason,
          }
        : null,
      next_refresh_at: supported ? nextRefreshAt : null,
    };
  });
  states.sort((a, b) => a.provider_resource_id.localeCompare(b.provider_resource_id));
  return states;
}
