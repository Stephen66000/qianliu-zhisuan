import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  migrateDown,
  migrateToLatest,
  OfficialBalanceRefreshConflict,
  OfficialBalanceRefreshRepository,
  recordOfficialBalanceSyncSuccess,
} from "../index.js";
import { createMigrator } from "../migrator.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer();
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Seed {
  enterpriseId: string; adminId: string; resourceId: string;
  refreshRepo: OfficialBalanceRefreshRepository;
}

async function seedEnterprise(name: string): Promise<Seed> {
  const enterpriseId = randomUUID(); const adminId = randomUUID();
  const providerId = randomUUID(); const resourceId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: `${name}-admin`, password_hash: "not-used", status: "ACTIVE" }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "deepseek", name: `DeepSeek ${name}`, adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
    name: `${name}-API`, mode: "API", credential_type: "API_KEY",
    credential_ciphertext: JSON.stringify({ c: "fixture" }),
  }).execute();
  return { enterpriseId, adminId, resourceId,
    refreshRepo: new OfficialBalanceRefreshRepository(db) };
}

const beginInput = (seed: Seed, overrides?: Partial<{
  cooldownMs: number; now: Date; idempotencyKey: string;
}>) => ({
  enterpriseId: seed.enterpriseId,
  resourceId: seed.resourceId,
  actorAdminId: seed.adminId,
  idempotencyKey: overrides?.idempotencyKey ?? randomUUID(),
  cooldownMs: overrides?.cooldownMs ?? 30_000,
  leaseMs: 60_000,
  now: overrides?.now ?? new Date(),
});

describe.sequential("0096 官方余额手动刷新请求表（task 3.2）", () => {
  it("迁移水位含 0096：表与 RUNNING 部分唯一索引存在", async () => {
    const table = await sql<{ reg: string | null }>`
      SELECT to_regclass('provider_resource_balance_refresh')::text AS reg
    `.execute(db);
    expect(table.rows[0]!.reg).toBe("provider_resource_balance_refresh");
    const index = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'provider_resource_balance_refresh_running_uq'
    `.execute(db);
    expect(index.rows[0]!.indexdef).toContain("CREATE UNIQUE INDEX");
    expect(index.rows[0]!.indexdef).toContain("RUNNING");
  });

  it("begin/finish：RUNNING 行创建；并发第二请求 IN_PROGRESS；终态后可再次发起", async () => {
    const seed = await seedEnterprise("begin-finish");
    const first = await seed.refreshRepo.begin(beginInput(seed));
    expect(first.replay).toBe(false);
    expect(first.row.status).toBe("RUNNING");
    expect(first.row.expires_at.getTime() - first.row.started_at.getTime()).toBe(60_000);

    // 在途：并发第二请求（不同幂等键）→ in_progress。
    try {
      await seed.refreshRepo.begin(beginInput(seed));
      throw new Error("expected conflict");
    } catch (cause) {
      expect(cause).toBeInstanceOf(OfficialBalanceRefreshConflict);
      expect((cause as OfficialBalanceRefreshConflict).code).toBe("in_progress");
      expect((cause as OfficialBalanceRefreshConflict).retryAfterSeconds).toBeGreaterThan(0);
    }

    await seed.refreshRepo.finish({ requestId: first.row.id, outcome: "SUCCEEDED",
      errorCode: null, now: new Date() });
    const rows = await db.selectFrom("provider_resource_balance_refresh").selectAll()
      .where("provider_resource_id", "=", seed.resourceId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SUCCEEDED");
    expect(rows[0]!.finished_at).not.toBeNull();

    // 终态后无在途、无 attempt → 冷却外（attempt 表空）可再次发起。
    const second = await seed.refreshRepo.begin(beginInput(seed));
    expect(second.replay).toBe(false);
    expect(second.row.status).toBe("RUNNING");
  });

  it("幂等重放：同键请求复用既有终态（SUCCEEDED），不产生新行", async () => {
    const seed = await seedEnterprise("replay");
    const key = randomUUID();
    const first = await seed.refreshRepo.begin(beginInput(seed, { idempotencyKey: key }));
    await seed.refreshRepo.finish({ requestId: first.row.id, outcome: "SUCCEEDED",
      errorCode: null, now: new Date() });
    const replay = await seed.refreshRepo.begin(beginInput(seed, { idempotencyKey: key }));
    expect(replay.replay).toBe(true);
    expect(replay.row.id).toBe(first.row.id);
    expect(replay.row.status).toBe("SUCCEEDED");
    expect(await db.selectFrom("provider_resource_balance_refresh").selectAll()
      .where("provider_resource_id", "=", seed.resourceId).execute()).toHaveLength(1);
  });

  it("冷却：最近 attempt started_at + P3 内拒绝并给出 retry_after；窗口外放行", async () => {
    const seed = await seedEnterprise("cooldown");
    const now = new Date("2026-08-18T01:00:00Z");
    await db.insertInto("provider_resource_operating_sync_attempt").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      sync_day: new Date("2026-08-18T00:00:00Z"),
      balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      snapshot_id: null, provider_data_at: now, started_at: now, completed_at: now,
      next_sync_at: new Date(now.getTime() + 900_000),
      error_code: null, failure_reason: null, adapter_version: "pool20-025-v1",
    }).execute();
    // now = started+10s：冷却 30s 内 → 拒绝，retry_after ≈ 20s。
    try {
      await seed.refreshRepo.begin(beginInput(seed, { now: new Date(now.getTime() + 10_000) }));
      throw new Error("expected conflict");
    } catch (cause) {
      expect(cause).toBeInstanceOf(OfficialBalanceRefreshConflict);
      const conflict = cause as OfficialBalanceRefreshConflict;
      expect(conflict.code).toBe("cooldown");
      expect(conflict.retryAfterSeconds).toBeGreaterThanOrEqual(19);
      expect(conflict.retryAfterSeconds).toBeLessThanOrEqual(21);
    }
    // 周期产生的 FAILED attempt 同样计入冷却（任意 outcome）。
    await db.insertInto("provider_resource_operating_sync_attempt").values({
      enterprise_id: seed.enterpriseId, provider_resource_id: seed.resourceId,
      sync_day: new Date("2026-08-18T00:00:00Z"),
      balance_status: "FAILED", cost_status: "NOT_SUPPORTED",
      snapshot_id: null, provider_data_at: null,
      started_at: new Date(now.getTime() + 60_000),
      completed_at: new Date(now.getTime() + 60_000),
      next_sync_at: new Date(now.getTime() + 960_000),
      error_code: "UPSTREAM_UNAVAILABLE", failure_reason: "offline",
      adapter_version: "pool20-025-v1",
    }).execute();
    try {
      await seed.refreshRepo.begin(beginInput(seed, { now: new Date(now.getTime() + 65_000) }));
      throw new Error("expected conflict");
    } catch (cause) {
      expect((cause as OfficialBalanceRefreshConflict).code).toBe("cooldown");
    }
    // 冷却窗外（P3=30s，最近 attempt 已 40s 前）→ 放行。
    const ok = await seed.refreshRepo.begin(beginInput(seed, {
      now: new Date(now.getTime() + 100_000),
    }));
    expect(ok.row.status).toBe("RUNNING");
  });

  it("租约收敛：过期 RUNNING 在下次 begin 时置 FAILED/REFRESH_LEASE_EXPIRED，并放行新请求", async () => {
    const seed = await seedEnterprise("lease");
    const staleNow = new Date("2026-08-18T01:00:00Z");
    const stale = await seed.refreshRepo.begin(beginInput(seed, { now: staleNow }));
    // 手动把租约改到过去（模拟进程崩溃后时间流逝）。
    await db.updateTable("provider_resource_balance_refresh")
      .set({ expires_at: new Date(staleNow.getTime() - 1_000) })
      .where("id", "=", stale.row.id).execute();
    const next = await seed.refreshRepo.begin(beginInput(seed, {
      now: new Date(staleNow.getTime() + 120_000),
    }));
    expect(next.replay).toBe(false);
    expect(next.row.status).toBe("RUNNING");
    const staleRow = await db.selectFrom("provider_resource_balance_refresh").selectAll()
      .where("id", "=", stale.row.id).executeTakeFirstOrThrow();
    expect(staleRow.status).toBe("FAILED");
    expect(staleRow.error_code).toBe("REFRESH_LEASE_EXPIRED");
    expect(staleRow.finished_at).not.toBeNull();
  });

  it("共享写入原语：成功写 PROVIDER_SYNC 快照＋SUCCESS attempt（cost NOT_SUPPORTED）；同日多次各留一行", async () => {
    const seed = await seedEnterprise("writes");
    const balance = {
      currency: "CNY", totalBalance: "110", grantedBalance: "10",
      toppedUpBalance: "100", available: true, providerDataAt: new Date("2026-08-18T02:00:00Z"),
    };
    const identity = {
      syncDay: new Date("2026-08-18T00:00:00Z"),
      startedAt: new Date("2026-08-18T02:00:00Z"),
      completedAt: new Date("2026-08-18T02:00:00Z"),
      nextSyncAt: new Date("2026-08-18T02:15:00Z"),
      adapterVersion: "pool20-025-v1",
    };
    const first = await recordOfficialBalanceSyncSuccess(db, {
      ...identity, enterpriseId: seed.enterpriseId, resourceId: seed.resourceId, balance,
    });
    expect(first.snapshotId).not.toBeNull();
    const second = await recordOfficialBalanceSyncSuccess(db, {
      ...identity, startedAt: new Date("2026-08-18T02:20:00Z"),
      completedAt: new Date("2026-08-18T02:20:00Z"),
      nextSyncAt: new Date("2026-08-18T02:35:00Z"),
      enterpriseId: seed.enterpriseId, resourceId: seed.resourceId,
      balance: { ...balance, totalBalance: "95" },
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    const snapshots = await db.selectFrom("provider_resource_operating_snapshot").selectAll()
      .where("provider_resource_id", "=", seed.resourceId)
      .orderBy("version", "asc").execute();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      currency: "CNY", provider_balance_available: true });
    expect(snapshots[1]!.current_balance).toBe("95.00000000");
    expect(snapshots[1]!.version).toBe(2);
    // 继承语义：无历史 ADMIN 费用 → cost_source NOT_SUPPORTED、费用列 null。
    expect(snapshots[0]!.cost_source).toBe("NOT_SUPPORTED");
    expect(snapshots[0]!.current_period_cost).toBeNull();
    const attempts = await db.selectFrom("provider_resource_operating_sync_attempt").selectAll()
      .where("provider_resource_id", "=", seed.resourceId)
      .orderBy("started_at", "asc").execute();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      error_code: "PROVIDER_COST_API_NOT_SUPPORTED", adapter_version: "pool20-025-v1" });
    expect(attempts[0]!.sync_day.toISOString()).toBe(attempts[1]!.sync_day.toISOString());
  });

  it("EG-02 定向补充：listLatest 返回该资源最近一行刷新请求（按 started_at 倒序）", async () => {
    const seed = await seedEnterprise("eg02-listlatest");
    const t0 = new Date("2026-08-18T03:00:00Z");
    const begun = await seed.refreshRepo.begin(beginInput(seed, { now: t0 }));
    // listLatest：按 started_at 倒序取该资源最近一行刷新请求。
    const latest = await seed.refreshRepo.listLatest(seed.resourceId);
    expect(latest).toBeDefined();
    expect(latest!.id).toBe(begun.row.id);
    expect(latest!.status).toBe("RUNNING");

    // 注：共享写入原语合同中「resource 不存在 → snapshotId null、attempt 照写」的
    // 分支在本 schema 下不可达——attempt 表对 provider_resource 有租户外键
    // （resource_tenant_fk），resource 真不存在时 attempt 照写会 FK 失败；
    // snapshotId ?? null 仅作防御保留（EG-02 报告已记录该合同/外键不一致观察）。
    expect((await seed.refreshRepo.listLatest(seed.resourceId))!.id).toBe(begun.row.id);
  });

  it("down：drop 表（纯协调状态，无数据守卫）；重新 up 恢复", async () => {
    const rollbackPg = await startPostgresContainer("wp3_0096_rollback");
    const rollbackDb = createKysely(rollbackPg.connectionString);
    try {
      expect((await createMigrator(rollbackDb).migrateToLatest()).error).toBeUndefined();
      const rolledBack = await migrateDown(rollbackDb);
      expect(rolledBack).toBe("0096_official_balance_refresh_request");
      const afterDown = await sql<{ reg: string | null }>`
        SELECT to_regclass('provider_resource_balance_refresh')::text AS reg
      `.execute(rollbackDb);
      expect(afterDown.rows[0]!.reg).toBeNull();
      expect((await createMigrator(rollbackDb).migrateToLatest()).error).toBeUndefined();
      const afterUp = await sql<{ reg: string | null }>`
        SELECT to_regclass('provider_resource_balance_refresh')::text AS reg
      `.execute(rollbackDb);
      expect(afterUp.rows[0]!.reg).toBe("provider_resource_balance_refresh");
    } finally {
      await rollbackDb.destroy();
      await rollbackPg.stop();
    }
  });
});
