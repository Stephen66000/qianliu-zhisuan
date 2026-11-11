import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
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

  // F1 返修（R2）负向回归 b-1：存量冒充行免疫——写旁路时代可能存在
  // source='PROVIDER_SYNC' 而 balance_source=NULL 的行；D2 双滤后该行不得成为
  // "官方余额"（按无快照处理，不显示 123）。
  it("F1 冒充行免疫：source=PROVIDER_SYNC 且 balance_source=NULL 的行不进入官方余额域", async () => {
    const seed = await seedResource("impersonated-row");
    // 直插冒充行（insertSnapshot 助手的 ?? 会把显式 null 归一成 PROVIDER_API，
    // 无法构造 balance_source=NULL 形态）：source='PROVIDER_SYNC' 而
    // balance_source=NULL、余额 123——写旁路时代的冒充行形态。
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      version: 1, source: "PROVIDER_SYNC", collected_at: T0,
      currency: "CNY", current_balance: "123", balance_source: null,
      usage_calculation: "MANUAL_SNAPSHOT",
    }).execute();
    const state = await read(seed, new Date(T0.getTime() + 60_000));
    expect(state).toMatchObject({ supported: true, status: "NEVER_SYNCED",
      total_balance: null, currency: null, composition: null, available: null,
      last_success_at: null });
    expect(state.total_balance).not.toBe("123.00000000");
    // 对照：同一来源补一条真实官方行（balance_source=PROVIDER_API）→ 照常进入官方域。
    await insertSnapshot(seed, { version: 2, collectedAt: new Date(T0.getTime() + 120_000),
      totalBalance: "77", source: "PROVIDER_SYNC", balanceSource: "PROVIDER_API" });
    const recovered = await read(seed, new Date(T0.getTime() + 180_000));
    expect(recovered).toMatchObject({ status: "OK", total_balance: "77.00000000" });
  });

  // F4 返修（R2）回归：租约过期收敛——过期的 RUNNING 刷新不再 SYNCING，回落
  // 快照/失败/NEVER_SYNCED 正常判定；未过期租约仍 SYNCING；过期后
  // next_refresh_at 输出 null（立即可刷）。
  it("F4 租约过期：expires_at 已过的 RUNNING 刷新收敛为非 SYNCING；未过期仍 SYNCING", async () => {
    const seed = await seedResource("lease-expiry");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "70", available: true });
    await insertAttempt(seed, { startedAt: T0, balanceStatus: "SUCCESS" });
    const now = new Date(T0.getTime() + 10_000);
    const leaseEnd = new Date(now.getTime() + 45_000);
    await db.insertInto("provider_resource_balance_refresh").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      actor_admin_id: seed.adminId, idempotency_key: randomUUID(), status: "RUNNING",
      started_at: now, finished_at: null, expires_at: leaseEnd, updated_at: now,
    }).execute();
    const syncing = await read(seed, now);
    expect(syncing).toMatchObject({ status: "SYNCING", total_balance: "70.00000000" });
    expect(syncing.next_refresh_at?.toISOString()).toBe(leaseEnd.toISOString());

    // 租约过期（时钟越过 expires_at）：不再 SYNCING，回落 OK（有成功快照）。
    const afterExpiry = new Date(leaseEnd.getTime() + 5_000);
    const converged = await read(seed, afterExpiry);
    expect(converged.status).not.toBe("SYNCING");
    expect(converged).toMatchObject({ status: "OK", total_balance: "70.00000000" });
    expect(converged.next_refresh_at).toBeNull(); // 过期租约不构成未来刷新时点

    // 无成功快照的资源：租约过期后回落 NEVER_SYNCED（而非永久 SYNCING）。
    const neverSeed = await seedResource("lease-expiry-never");
    const neverNow = new Date(T0.getTime() + 10_000);
    await db.insertInto("provider_resource_balance_refresh").values({
      enterprise_id: neverSeed.enterpriseId, provider_resource_id: neverSeed.resourceId,
      actor_admin_id: neverSeed.adminId, idempotency_key: randomUUID(), status: "RUNNING",
      started_at: neverNow, finished_at: null,
      expires_at: new Date(neverNow.getTime() + 45_000), updated_at: neverNow,
    }).execute();
    const neverDuring = await read(neverSeed, neverNow);
    expect(neverDuring.status).toBe("SYNCING");
    const neverAfter = await read(neverSeed, new Date(neverNow.getTime() + 50_000));
    expect(neverAfter.status).not.toBe("SYNCING");
    expect(neverAfter.status).toBe("NEVER_SYNCED");
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
  it("EG-02 定向补充：判定/活性边界与排序合同——租约恰等 now 不算 SYNCING、expired 恰等 P2 不算过期、CODING_PLAN 不支持、next_refresh_at 活性与恰等失效、输出按 resource_id 升序", async () => {
    // a) RUNNING 租约 expires_at 恰等 now（F4）：原实现 `expires_at > now` 才 SYNCING
    //    → 恰等不算在途 → 回落判定链（无快照 + attempt 非 FAILED → NEVER_SYNCED）。
    const a = await seedResource("eg02-lease-boundary");
    await insertAttempt(a, { startedAt: new Date(T0.getTime() - 120_000), balanceStatus: "SUCCESS" });
    await db.insertInto("provider_resource_balance_refresh").values({
      enterprise_id: a.enterpriseId, provider_resource_id: a.resourceId,
      actor_admin_id: a.adminId, idempotency_key: randomUUID(),
      status: "RUNNING", error_code: null,
      started_at: new Date(T0.getTime() - 60_000), expires_at: T0,
      updated_at: new Date(T0.getTime() - 60_000),
    }).execute();
    const stateA = await read(a, T0);
    expect(stateA.status).toBe("NEVER_SYNCED");

    // b) canonical deepseek 但 mode=CODING_PLAN → supported 恒 false → UNSUPPORTED。
    const b = await seedResource("eg02-plan", { mode: "CODING_PLAN" });
    const stateB = await read(b, T0);
    expect(stateB).toMatchObject({ supported: false, status: "UNSUPPORTED",
      total_balance: null, next_refresh_at: null });

    // c) expired 恰等 P2（collected_at == now - P2）：原实现 `差 > expireMs` 才过期。
    const c = await seedResource("eg02-expire-boundary");
    await insertSnapshot(c, { version: 1,
      collectedAt: new Date(T0.getTime() - P2_MS), totalBalance: "10", available: true });
    const stateC = await read(c, T0);
    expect(stateC).toMatchObject({ status: "OK", expired: false });

    // d) next_refresh_at 活性：attempt 10s 前 + P3=30s → 未来 20s → 非空（原实现
    //    refreshCandidates 非空时取 max；变异 false/恒 null 被杀）。
    const d = await seedResource("eg02-next-refresh-live");
    await insertAttempt(d, { startedAt: new Date(T0.getTime() - 10_000), balanceStatus: "FAILED" });
    const stateD = await read(d, T0);
    expect(stateD.status).toBe("FAILED");
    expect(stateD.next_refresh_at?.getTime()).toBe(T0.getTime() + 20_000);

    // e) next_refresh_at 恰等 now（attempt + P3 == now）：候选不大于 now → null（立即可刷）。
    const e = await seedResource("eg02-next-refresh-boundary");
    await insertAttempt(e, { startedAt: new Date(T0.getTime() - P3_MS), balanceStatus: "FAILED" });
    const stateE = await read(e, T0);
    expect(stateE.next_refresh_at).toBeNull();

    // f) 排序合同：同企业两资源按 provider_resource_id 升序输出（uuid 逆插入序）。
    const fEnt = randomUUID(); const fAdmin = randomUUID();
    const idSmall = "00000000-0000-4000-8000-000000000001";
    const idLarge = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insertInto("enterprise").values({ id: fEnt, name: "eg02-sort" }).execute();
    await db.insertInto("admin_user").values({ id: fAdmin, enterprise_id: fEnt,
      username: "eg02-sort-admin", password_hash: "not-used", status: "ACTIVE" }).execute();
    for (const [providerId, resourceId, code] of [
      [randomUUID(), idLarge, "deepseek"], [randomUUID(), idSmall, "kimi"],
    ] as const) {
      await db.insertInto("provider").values({ id: providerId, enterprise_id: fEnt,
        code, name: `${code} ${resourceId.slice(0, 6)}`,
        adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId, enterprise_id: fEnt, provider_id: providerId,
        name: `eg02-sort-${resourceId.slice(0, 6)}`, mode: "API",
        credential_type: "API_KEY" }).execute();
    }
    const statesF = await listOfficialBalanceStates(db, fEnt,
      { now: T0, expireMs: P2_MS, cooldownMs: P3_MS });
    expect(statesF.map((s) => s.provider_resource_id)).toEqual([idSmall, idLarge]);
  });

  // EG-02 收尾 T2（变异 id174 补测，official-balance-states.ts:174 双候选 reduce）：
  // 同一资源两条不同截止——冷却候选（attempt started_at+P3，候选数组第 0 位）晚于
  // 在途租约 expires_at（数组第 1 位＝后部），且两者都仍有效（> now）。合同：
  // next_refresh_at = max(冷却候选, 租约)＝较晚值。变异 id174 把比较改为恒 false
  // （reduce 恒取最后一项 b＝租约）→ 返回较早的租约值，被本用例较晚值断言杀死。
  it("EG-02 T2：冷却候选晚于在途租约（较早候选在后）→ next_refresh_at 取较晚且有效值", async () => {
    const seed = await seedResource("eg02-t2-max-candidate");
    await insertSnapshot(seed, { version: 1, collectedAt: T0, totalBalance: "60", available: true });
    const now = new Date(T0.getTime() + 10_000);
    // 冷却候选 = started_at + P3 = now + 25s（较晚，数组第 0 位）。
    await insertAttempt(seed, { startedAt: new Date(now.getTime() - 5_000), balanceStatus: "FAILED" });
    // 在途租约到期 = now + 10s（较早，数组第 1 位＝后部）。
    const leaseEnd = new Date(now.getTime() + 10_000);
    await db.insertInto("provider_resource_balance_refresh").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      actor_admin_id: seed.adminId, idempotency_key: randomUUID(), status: "RUNNING",
      started_at: now, finished_at: null, expires_at: leaseEnd, updated_at: now,
    }).execute();
    const state = await read(seed, now);
    expect(state.status).toBe("SYNCING"); // 未过期租约在途
    const laterCandidate = new Date(now.getTime() - 5_000 + P3_MS); // now+25s
    // 自证夹具方向：冷却候选更晚且两者均仍有效（> now）。
    expect(laterCandidate.getTime()).toBeGreaterThan(leaseEnd.getTime());
    expect(laterCandidate.getTime()).toBeGreaterThan(now.getTime());
    expect(leaseEnd.getTime()).toBeGreaterThan(now.getTime());
    // max 语义：取较晚的冷却候选，而非数组末位的较早租约（id174）。
    expect(state.next_refresh_at?.toISOString()).toBe(laterCandidate.toISOString());
  });

  // EG-02 收尾 T3（变异 id206/id207 补测，official-balance-states.ts:205 输出排序）：
  // 小表下规划器对 provider_resource 选 PK 全索引扫描（输出恒按 id 升序，等于排序
  // 后的期望序——id206/207 基线幸存的根因，两次实验证实）。本用例把同企业资源规模
  // 放大到 N=800，迫使规划器选择 seq scan（堆物理序＝插入序），从而让“输入到达
  // 顺序”完全受夹具控制：显式按 id 降序插入 → 无 ORDER BY 时函数收到的就是降序，
  // 断言输出按 id 升序。变异 id206（删 sort 调用）与 id207（比较器恒 undefined →
  // V8 稳定排序保持原序）都保留降序 → 被同一用例分别杀死。先用同形状裸查询自证
  // 到达顺序（前提不成立则如实失败，不把合同押在计划运气上）。
  it("EG-02 T3：输入显式降序插入 → 输出按 provider_resource_id 升序（同一用例双杀 id206/id207）", async () => {
    const ent = randomUUID(); const admin = randomUUID();
    await db.insertInto("enterprise").values({ id: ent, name: "eg02-t3-sort" }).execute();
    await db.insertInto("admin_user").values({ id: admin, enterprise_id: ent,
      username: "eg02-t3-admin", password_hash: "not-used", status: "ACTIVE" }).execute();
    const providerId = "70000000-0000-4000-8000-000000000007";
    await db.insertInto("provider").values({ id: providerId, enterprise_id: ent,
      code: "ds-t3", name: "eg02-t3-provider",
      adapter_type: "OPENAI_COMPATIBLE" }).execute();
    // N 行降序 id（0x320=800 递减到 1，12 位 hex 定长，数值降序＝字典序降序）。
    const N = 800;
    const idsDesc = Array.from({ length: N }, (_, i) => {
      const n = (N - i).toString(16).padStart(12, "0");
      return `aaaaaa00-0000-4000-8000-${n}`;
    });
    const values = idsDesc.map((id, i) => ({
      id, enterprise_id: ent, provider_id: providerId,
      name: `eg02-t3-resource-${i}`, mode: "API" as const, credential_type: "API_KEY" as const,
    }));
    for (let i = 0; i < values.length; i += 200) {
      await db.insertInto("provider_resource").values(values.slice(i, i + 200)).execute();
    }
    // 前提自证：与函数同形状（无 ORDER BY）的裸查询应返回插入序（降序）。
    // 本查询不在被变异文件内，变异运行不受其影响。
    const natural = await sql<{ id: string }>`
      SELECT pr.id FROM provider_resource pr
      JOIN provider p ON p.id = pr.provider_id
      WHERE pr.enterprise_id = ${ent}::uuid AND p.enterprise_id = ${ent}::uuid
    `.execute(db);
    expect(natural.rows.map((r) => r.id)).toEqual(idsDesc);
    const statesT3 = await listOfficialBalanceStates(db, ent,
      { now: T0, expireMs: P2_MS, cooldownMs: P3_MS });
    expect(statesT3.map((s) => s.provider_resource_id)).toEqual([...idsDesc].reverse());
    expect(statesT3).toHaveLength(N);
  });
});