import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, listOfficialBalanceStates, migrateToLatest } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer("wp3_official_balance_states");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

const P2_MS = 1_800_000; // 30 分钟（合同冻结值）
const P3_MS = 30_000; // 30 秒

interface ResourceSeed {
  enterpriseId: string; adminId: string; resourceId: string;
}

async function seedResource(name: string, opts?: {
  providerCode?: string; mode?: "API" | "CODING_PLAN"; enterpriseId?: string; adminId?: string;
}): Promise<ResourceSeed> {
  const enterpriseId = opts?.enterpriseId ?? randomUUID();
  const adminId = opts?.adminId ?? randomUUID();
  const providerId = randomUUID(); const resourceId = randomUUID();
  if (!opts?.enterpriseId) {
    await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
    await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
      username: `${name}-admin`, password_hash: "not-used", status: "ACTIVE" }).execute();
  }
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: opts?.providerCode ?? "deepseek", name: `DeepSeek ${name}`,
    adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: `${name}-resource`, mode: opts?.mode ?? "API", credential_type: "API_KEY",
  }).execute();
  return { enterpriseId, adminId, resourceId };
}

async function insertSnapshot(seed: ResourceSeed, input: {
  version: number; collectedAt: Date; totalBalance: string | null; currency?: string;
  granted?: string | null; topped?: string | null; available?: boolean | null;
  source?: string; balanceSource?: string | null;
}): Promise<void> {
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
    version: input.version, source: input.source ?? "PROVIDER_SYNC",
    collected_at: input.collectedAt,
    currency: input.currency ?? "CNY",
    current_balance: input.totalBalance,
    granted_balance: input.granted ?? null,
    topped_up_balance: input.topped ?? null,
    provider_balance_available: input.available ?? null,
    balance_source: input.balanceSource ?? (input.source === "ADMIN" ? "ADMIN" : "PROVIDER_API"),
    usage_calculation: "MANUAL_SNAPSHOT",
  }).execute();
}

async function insertAttempt(seed: ResourceSeed, input: {
  startedAt: Date; balanceStatus: "SUCCESS" | "FAILED" | "NOT_SUPPORTED";
  errorCode?: string | null; failureReason?: string | null;
}): Promise<void> {
  await db.insertInto("provider_resource_operating_sync_attempt").values({
    enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
    sync_day: new Date("2026-08-18T00:00:00Z"),
    balance_status: input.balanceStatus, cost_status: "NOT_SUPPORTED",
    snapshot_id: null, provider_data_at: input.balanceStatus === "SUCCESS" ? input.startedAt : null,
    started_at: input.startedAt, completed_at: input.startedAt,
    next_sync_at: new Date(input.startedAt.getTime() + 900_000),
    error_code: input.errorCode ?? null, failure_reason: input.failureReason ?? null,
    adapter_version: "pool20-025-v1",
  }).execute();
}

const T0 = new Date("2026-08-18T01:00:00Z");
const read = (seed: ResourceSeed, now: Date, expireMs = P2_MS) =>
  listOfficialBalanceStates(db, seed.enterpriseId, { now, expireMs, cooldownMs: P3_MS })
    .then((rows) => rows.find((r) => r.provider_resource_id === seed.resourceId)!);

describe("listOfficialBalanceStates（C2 官方余额状态读取，task 3.3）", () => {
  it("AT-OAB-07：T0 成功 50 → 最新 attempt 失败保鲜旧值；时钟越过 P2 后 FAILED＋expired 叠加", async () => {
    const seed = await seedResource("fresh-stale");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "50",
      granted: "10", topped: "40", available: true });
    await insertAttempt(seed, { startedAt: T0, balanceStatus: "SUCCESS" });

    const fresh = await read(seed, new Date(T0.getTime() + 60_000));
    expect(fresh).toMatchObject({ supported: true, status: "OK", expired: false,
      last_attempt_failed: false, total_balance: "50.00000000", currency: "CNY",
      available: true });
    expect(fresh.composition).toEqual({ granted: "10.00000000", topped: "40.00000000" });
    expect(fresh.last_success_at?.toISOString()).toBe(T0.toISOString());
    expect(fresh.last_attempt).toMatchObject({ outcome: "SUCCESS" });
    expect(fresh.next_refresh_at).toBeNull(); // attempt+P3 已过 → 立即可刷

    // 最新 attempt 超时失败：旧值 50 保留、FAILED 表达、未过期。
    await insertAttempt(seed, { startedAt: new Date(T0.getTime() + 120_000),
      balanceStatus: "FAILED", errorCode: "TIMEOUT", failureReason: "厂商余额查询超时" });
    // 冷却窗口内读：next_refresh_at = 最新 attempt started_at + P3。
    const inCooldown = await read(seed, new Date(T0.getTime() + 125_000));
    expect(inCooldown).toMatchObject({ status: "FAILED", total_balance: "50.00000000",
      expired: false, last_attempt_failed: true });
    expect(inCooldown.last_success_at?.toISOString()).toBe(T0.toISOString());
    expect(inCooldown.last_attempt).toMatchObject({ outcome: "FAILED",
      reason: "厂商余额查询超时" });
    expect(inCooldown.next_refresh_at?.toISOString()).toBe(
      new Date(T0.getTime() + 120_000 + P3_MS).toISOString());
    // 冷却过后：立即可刷 → null。
    const afterFailure = await read(seed, new Date(T0.getTime() + 180_000));
    expect(afterFailure).toMatchObject({ status: "FAILED", total_balance: "50.00000000",
      expired: false, last_attempt_failed: true, next_refresh_at: null });

    // 时钟推进越过 P2（30 分钟）：FAILED 为主状态＋expired 叠加（OAB-04 同时表达）。
    const stale = await read(seed, new Date(T0.getTime() + P2_MS + 120_000));
    expect(stale).toMatchObject({ status: "FAILED", total_balance: "50.00000000",
      expired: true, last_attempt_failed: true });
    expect(stale.last_success_at?.toISOString()).toBe(T0.toISOString());
  });

  it("AT-OAB-08：从未成功＋401 attempt → FAILED 且余额 null 不显 0；仅 NOT_SUPPORTED 痕迹/从未同步 → NEVER_SYNCED", async () => {
    const failedSeed = await seedResource("first-fail");
    await insertAttempt(failedSeed, { startedAt: T0, balanceStatus: "FAILED",
      errorCode: "UNAUTHORIZED", failureReason: "厂商拒绝当前凭证" });
    const failed = await read(failedSeed, new Date(T0.getTime() + 60_000));
    expect(failed).toMatchObject({ supported: true, status: "FAILED", total_balance: null,
      currency: null, composition: null, available: null, last_success_at: null,
      expired: false, last_attempt_failed: true });
    expect(failed.last_attempt).toMatchObject({ outcome: "FAILED", reason: "厂商拒绝当前凭证" });

    const notSupportedAttemptSeed = await seedResource("cred-missing");
    await insertAttempt(notSupportedAttemptSeed, { startedAt: T0,
      balanceStatus: "NOT_SUPPORTED", errorCode: "CREDENTIAL_MISSING",
      failureReason: "资源没有可用凭证" });
    const notSupportedAttempt = await read(notSupportedAttemptSeed, new Date(T0.getTime() + 60_000));
    // 非失败痕迹不算失败：按本实现规则钉死为 NEVER_SYNCED（余额同样 null）。
    expect(notSupportedAttempt).toMatchObject({ status: "NEVER_SYNCED", total_balance: null,
      last_attempt_failed: false });
    expect(notSupportedAttempt.last_attempt).toMatchObject({ outcome: "NOT_SUPPORTED" });

    const neverSeed = await seedResource("never");
    const never = await read(neverSeed, T0);
    expect(never).toMatchObject({ status: "NEVER_SYNCED", total_balance: null,
      last_attempt: null, next_refresh_at: null });
  });

  it("AT-OAB-02：仅 ADMIN 手工快照 → 官方余额 null（暂无官方数据），手工金额不混入", async () => {
    const seed = await seedResource("manual-only");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "80",
      source: "ADMIN", balanceSource: "ADMIN" });
    const state = await read(seed, new Date(T0.getTime() + 60_000));
    expect(state).toMatchObject({ supported: true, status: "NEVER_SYNCED",
      total_balance: null, currency: null, composition: null, available: null,
      last_success_at: null });
    expect(state.total_balance).not.toBe("80.00000000");
  });

  it("不支持厂商：supported=false → UNSUPPORTED，全部余额字段 null（有 ADMIN 手工快照也不混入）", async () => {
    const zhipu = await seedResource("zhipu-res", { providerCode: "zhipu" });
    await insertSnapshot(zhipu, { version: 1, collectedAt: T0, totalBalance: "66",
      source: "ADMIN", balanceSource: "ADMIN" });
    await insertAttempt(zhipu, { startedAt: T0, balanceStatus: "SUCCESS" });
    const state = await read(zhipu, new Date(T0.getTime() + 60_000));
    expect(state).toMatchObject({ supported: false, status: "UNSUPPORTED", total_balance: null,
      currency: null, composition: null, available: null, last_success_at: null,
      last_attempt: null, next_refresh_at: null, expired: false, last_attempt_failed: false });
  });

  it("AT-OAB-09/10：同账户两资源各 100 → 两行独立展示，无任何合计字段", async () => {
    // 同一官方账户（同一 provider）下两个资源各查得 100。
    const resourceA = await seedResource("acct-dual-a");
    const providerId = (await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", resourceA.resourceId).executeTakeFirstOrThrow()).provider_id;
    const resourceBId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: resourceBId, enterprise_id: resourceA.enterpriseId, provider_id: providerId,
      name: "acct-dual-b", mode: "API", credential_type: "API_KEY",
    }).execute();
    const resourceB: ResourceSeed = {
      enterpriseId: resourceA.enterpriseId, adminId: resourceA.adminId, resourceId: resourceBId,
    };
    for (const seed of [resourceA, resourceB]) {
      await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "100",
        granted: "0", topped: "100", available: true });
      await insertAttempt(seed, { startedAt: T0, balanceStatus: "SUCCESS" });
    }
    const rows = await listOfficialBalanceStates(db, resourceA.enterpriseId,
      { now: new Date(T0.getTime() + 60_000), expireMs: P2_MS, cooldownMs: P3_MS });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.total_balance).toBe("100.00000000");
      expect(row.status).toBe("OK");
    }
    const rowKeys = Object.keys(rows[0]!);
    for (const key of rowKeys) {
      expect(key.toLowerCase()).not.toContain("total_account");
      expect(key.toLowerCase()).not.toContain("sum");
      expect(key.toLowerCase()).not.toContain("aggregate");
    }
  });

  it("RUNNING refresh 行 → SYNCING；next_refresh_at = max(attempt+P3, 租约到期)", async () => {
    const seed = await seedResource("syncing");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "70", available: true });
    await insertAttempt(seed, { startedAt: T0, balanceStatus: "SUCCESS" });
    const now = new Date(T0.getTime() + 10_000);
    const leaseEnd = new Date(now.getTime() + 45_000);
    await db.insertInto("provider_resource_balance_refresh").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      actor_admin_id: seed.adminId, idempotency_key: randomUUID(), status: "RUNNING",
      started_at: now, finished_at: null, expires_at: leaseEnd, updated_at: now,
    }).execute();
    const state = await read(seed, now);
    expect(state).toMatchObject({ status: "SYNCING", total_balance: "70.00000000" });
    // max(attempt+P3 = T0+30s, 租约 = now+45s) = 租约到期。
    expect(state.next_refresh_at?.toISOString()).toBe(leaseEnd.toISOString());
  });

  it("P2 可配置：同一数据在不同 expireMs 下 EXPIRED 判定不同", async () => {
    const seed = await seedResource("p2-config");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "40", available: true });
    await insertAttempt(seed, { startedAt: T0, balanceStatus: "SUCCESS" });
    const readAt = new Date(T0.getTime() + 20 * 60_000); // 20 分钟后
    const strict = await read(seed, readAt, 15 * 60_000);
    expect(strict.status).toBe("EXPIRED");
    expect(strict.expired).toBe(true);
    const lenient = await read(seed, readAt, 30 * 60_000);
    expect(lenient.status).toBe("OK");
    expect(lenient.expired).toBe(false);
  });
});
