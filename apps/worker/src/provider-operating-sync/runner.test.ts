import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, ProviderRepository } from "@qianliu/database";
import { encryptCredential, type ProviderOperatingFetch } from "@qianliu/provider-adapters";
import { runProviderOperatingSyncTick } from "./runner.js";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("pool20_025_operating_sync"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

function okFetch(balances: string[]): ProviderOperatingFetch {
  let calls = 0;
  const fn = vi.fn(async () => {
    const total = balances[Math.min(calls, balances.length - 1)];
    calls += 1;
    return { ok: true, status: 200, json: async () => ({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: total,
        granted_balance: "8", topped_up_balance: "60" }],
    }) };
  }) as unknown as ProviderOperatingFetch;
  return fn;
}

async function seedApiResource(
  db: ReturnType<typeof createKysely>, name: string, kekByte: number,
): Promise<{ enterpriseId: string; resourceId: string }> {
  const enterpriseId = randomUUID(); const providerId = randomUUID(); const resourceId = randomUUID();
  const kek = Buffer.alloc(32, kekByte);
  await db.insertInto("enterprise").values({ id: enterpriseId, name }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "DeepSeek API",
    mode: "API", credential_type: "API_KEY",
    credential_ciphertext: JSON.stringify(encryptCredential("sk-test", kek)),
  }).execute();
  return { enterpriseId, resourceId };
}

/** 用例隔离：runner 扫描只取 status ∈ ACTIVE/DEGRADED/EXHAUSTED（0005 CHECK 无
 * DELETED），用合法的 EXPIRED 让用例资源退出后续用例的扫描范围。 */
async function retireResource(db: ReturnType<typeof createKysely>, resourceId: string): Promise<void> {
  await db.updateTable("provider_resource").set({ status: "EXPIRED" })
    .where("id", "=", resourceId).execute();
}

describe("WP3 官方余额同步解耦（OAB-03：独立于内部资金账本＋P1 周期门禁）", () => {
  it("周期门禁：P1 内重复 tick 跳过零上游调用；到点恢复；同日多次尝试各留一行；P1 可配置且非法值 fail-fast", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const { resourceId } = await seedApiResource(db, "周期门禁测试", 7);
      const fetch = okFetch(["68", "100", "100"]);
      const t0 = new Date("2026-08-18T01:00:00Z");

      // T0 首轮：同步成功，attempt.next_sync_at = T0 + P1（默认 15 分钟）。
      await expect(runProviderOperatingSyncTick({ db, kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch, now: t0 }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
      const attempt1 = await db.selectFrom("provider_resource_operating_sync_attempt")
        .selectAll().where("provider_resource_id", "=", resourceId)
        .orderBy("started_at", "desc").executeTakeFirstOrThrow();
      expect(attempt1.next_sync_at.toISOString()).toBe("2026-08-18T01:15:00.000Z");
      expect(attempt1.balance_status).toBe("SUCCESS");

      // T0 同刻重复 tick：P1 门禁命中，零上游调用、零快照、零新增 attempt。
      await expect(runProviderOperatingSyncTick({ db, kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch, now: t0 }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 0, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      // T0+60s 仍在 P1 窗口内：同样跳过。
      await expect(runProviderOperatingSyncTick({ db,
        kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch,
        now: new Date("2026-08-18T01:01:00Z") }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 0, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await db.selectFrom("provider_resource_operating_sync_attempt").select("id")
        .where("provider_resource_id", "=", resourceId).execute()).toHaveLength(1);

      // T0+15min（恰在 next_sync_at）：门禁放行，第二次同步成功——
      // 0095 放开 daily_uq 后同日第二次尝试各留一行 attempt＋一版快照。
      await expect(runProviderOperatingSyncTick({ db,
        kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch,
        now: new Date("2026-08-18T01:15:00Z") }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);
      const attempts = await db.selectFrom("provider_resource_operating_sync_attempt")
        .selectAll().where("provider_resource_id", "=", resourceId)
        .orderBy("started_at", "asc").execute();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.sync_day.toISOString()).toBe(attempts[1]!.sync_day.toISOString());
      expect(attempts[1]!.balance_status).toBe("SUCCESS");
      const snapshotCount = await db.selectFrom("provider_resource_operating_snapshot")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("provider_resource_id", "=", resourceId)
        .where("source", "=", "PROVIDER_SYNC").executeTakeFirstOrThrow();
      expect(Number(snapshotCount.count)).toBe(2);

      // P1 可配置：env 覆盖为 60s，next_sync_at 按 60s 写入。
      await expect(runProviderOperatingSyncTick({ db,
        kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch,
        now: new Date("2026-08-18T01:31:00Z"),
        env: { PROVIDER_OPERATING_SYNC_INTERVAL_MS: "60000" } }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      const attempt3 = await db.selectFrom("provider_resource_operating_sync_attempt")
        .selectAll().where("provider_resource_id", "=", resourceId)
        .orderBy("started_at", "desc").executeTakeFirstOrThrow();
      expect(attempt3.next_sync_at.toISOString()).toBe("2026-08-18T01:32:00.000Z");

      // P1 非法值 fail-fast：拒绝执行且不产生任何写入。
      await expect(runProviderOperatingSyncTick({ db,
        kekBase64: Buffer.alloc(32, 7).toString("base64"), fetch, now: t0,
        env: { PROVIDER_OPERATING_SYNC_INTERVAL_MS: "abc" } })).rejects.toThrow(/PROVIDER_OPERATING_SYNC_INTERVAL_MS/);
      expect(await db.selectFrom("provider_resource_operating_sync_attempt").select("id")
        .where("provider_resource_id", "=", resourceId).execute()).toHaveLength(3);
      await retireResource(db, resourceId);
    } finally {
      await db.destroy();
    }
  });

  it("资金模式 DARK/OFF 仍执行同步并写入快照（OAB-03 场景：不因旧资金开关关闭而跳过）；纯查询零资金事实写入", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const { enterpriseId, resourceId } = await seedApiResource(db, "资金模式无关测试", 9);
      const fetch = okFetch(["50"]);
      const now = new Date("2026-08-20T01:00:00Z");
      const kekBase64 = Buffer.alloc(32, 9).toString("base64");

      // 资金事实表（含未入 Kysely Database 类型的 resource_purchase_record 充值流水，
      // 用 raw sql 计数）：快照/attempt 之外零增量。
      const financeTables = [
        "provider_finance_event", "provider_subscription_period",
        "provider_finance_duplicate_candidate", "provider_finance_idempotency",
        "provider_finance_legacy_cost_resolution", "provider_finance_usage_cost_disposition",
        "operating_bill_resource_confirmation", "resource_purchase_record",
      ] as const;
      const countRows = async (table: (typeof financeTables)[number]): Promise<number> => {
        const result = await sql<{ count: number }>`
          SELECT count(*)::int AS count FROM ${sql.table(table)}
        `.execute(db);
        return result.rows[0]!.count;
      };
      const before = Object.fromEntries(await Promise.all(
        financeTables.map(async (t) => [t, await countRows(t)]),
      ));

      // OFF：仍同步（WP2 前该 env 会整体 skip——OAB-03 明确不得因旧资金开关跳过）。
      const offResult = await runProviderOperatingSyncTick({
        db, kekBase64, fetch, now, env: { PROVIDER_FINANCE_MODE: "OFF" },
      });
      expect(offResult).toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0,
        notSupported: 0, skippedQuiescentResources: 0 });
      expect("skipped" in offResult).toBe(false);
      // DARK：P1 到点后再次同步，同样不受资金模式影响。
      const darkResult = await runProviderOperatingSyncTick({
        db, kekBase64, fetch, now: new Date("2026-08-20T01:16:00Z"),
        env: { PROVIDER_FINANCE_MODE: "DARK" },
      });
      expect(darkResult).toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0,
        notSupported: 0, skippedQuiescentResources: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);

      const snapshots = await db.selectFrom("provider_resource_operating_snapshot")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("enterprise_id", "=", enterpriseId)
        .where("source", "=", "PROVIDER_SYNC").executeTakeFirstOrThrow();
      expect(Number(snapshots.count)).toBe(2);
      expect(await db.selectFrom("provider_resource_operating_sync_attempt").select("id")
        .where("enterprise_id", "=", enterpriseId).execute()).toHaveLength(2);

      // 纯查询断言：快照/attempt 之外零资金表增量（AT-OAB-04 后端锚点）。
      for (const table of financeTables) {
        expect(await countRows(table)).toBe(before[table]);
      }
      await retireResource(db, resourceId);
    } finally {
      await db.destroy();
    }
  });

  // F1 返修（R2）负向回归 b-3：恢复链免疫——写旁路时代的冒充行
  // （source='PROVIDER_SYNC' 而 balance_source=NULL）不得作为恢复证据解除
  // EXHAUSTED 隔离（runner 候选查询 D2 双滤后不再命中该行）。
  it("F1 冒充行免疫：balance_source=NULL 的 PROVIDER_SYNC 冒充行不触发耗尽资源恢复", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const { enterpriseId, resourceId } = await seedApiResource(db, "F1 冒充行恢复测试", 11);
      const kekBase64 = Buffer.alloc(32, 11).toString("base64");
      // 冒充行：collected_at 晚于隔离时刻、余额 123、available=true——若没有
      // balance_source 双滤，该行满足旧候选查询的全部条件。
      const isolatedAt = new Date("2026-08-21T01:00:00Z");
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: isolatedAt }).where("id", "=", resourceId).execute();
      await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 1,
        source: "PROVIDER_SYNC", collected_at: new Date("2026-08-21T01:30:00Z"),
        currency: "CNY", current_balance: "123",
        provider_balance_available: true, balance_source: null,
        usage_calculation: "MANUAL_SNAPSHOT",
      }).execute();
      // 上游不可用：本轮只留 FAILED attempt，不写任何真实官方快照。
      const failedFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as ProviderOperatingFetch;
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch: failedFetch,
        now: new Date("2026-08-21T02:00:00Z") }))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 0, failed: 1,
          notSupported: 0, skippedQuiescentResources: 0 });
      // 冒充行未触发恢复：资源保持 EXHAUSTED，无 BALANCE_SYNC_RECOVERED 事件。
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow())
        .toEqual({ status: "EXHAUSTED" });
      const recoveryEvents = await db.selectFrom("resource_status_event")
        .select("id").where("provider_resource_id", "=", resourceId)
        .where("reason", "=", "BALANCE_SYNC_RECOVERED").execute();
      expect(recoveryEvents).toHaveLength(0);
      // 快照仍只有冒充行 1 行；本轮 FAILED attempt 各留一行。
      const snapshots = await db.selectFrom("provider_resource_operating_snapshot")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("provider_resource_id", "=", resourceId).executeTakeFirstOrThrow();
      expect(Number(snapshots.count)).toBe(1);
      await retireResource(db, resourceId);
    } finally {
      await db.destroy();
    }
  });

  it("恢复链回归：新隔离被更新官方证据解除；证据不足不恢复；失败保鲜最后成功值与 last_success_data_at", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const { enterpriseId, resourceId } = await seedApiResource(db, "恢复链回归测试", 5);
      const principalId = randomUUID();
      const modelId = randomUUID();
      const upstreamModel = "deepseek-test-flash";
      await db.insertInto("principal").values({
        id: principalId, enterprise_id: enterpriseId, name: "余额恢复测试主体", type: "EMPLOYEE",
      }).execute();
      const key = await db.insertInto("principal_key").values({
        enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "test",
        key_digest: `recovery-${principalId}`, allowed_model_ids: sql`'[]'::jsonb`,
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("principal_grant").values({
        enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
        model_alias: "*", pool_model_alias: "*", quota_value: 1_000n, valid_from: new Date(0),
      }).execute();
      await db.insertInto("unified_model").values({
        id: modelId, enterprise_id: enterpriseId, alias: "ql-deepseek-flash", display_name: "DeepSeek Flash",
      }).execute();
      await db.insertInto("model_route").values({
        enterprise_id: enterpriseId, unified_model_id: modelId,
        provider_resource_id: resourceId, upstream_model: upstreamModel,
      }).execute();
      await db.insertInto("billing_rule").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, upstream_model: upstreamModel,
        rule_type: "API_PRICE", rule_version: "balance-recovery", effective_from: new Date(0),
        cache_miss_price: "0.000001",
      }).execute();
      const readKeyModels = async () => (await db.selectFrom("principal_key").select("allowed_model_ids")
        .where("id", "=", key.id).executeTakeFirstOrThrow()).allowed_model_ids;
      const clearKeyModels = () => db.updateTable("principal_key")
        .set({ allowed_model_ids: sql`'[]'::jsonb` }).where("id", "=", key.id).execute();
      const kekBase64 = Buffer.alloc(32, 5).toString("base64");
      const repo = new ProviderRepository(db);
      await repo.appendOperatingSnapshot(enterpriseId, resourceId, {
        source: "ADMIN", collected_at: new Date("2026-08-18T00:00:00Z"), currency: "CNY",
        recharge_amount: "100", current_balance: "80", current_period_cost: "20",
        balance_source: "ADMIN", cost_source: "ADMIN",
      });
      const fetch = okFetch(["68", "100", "100"]);
      const tick = (now: Date, fetchImpl: ProviderOperatingFetch = fetch) =>
        runProviderOperatingSyncTick({ db, kekBase64, fetch: fetchImpl, now });

      // T1：成功 68（快照 v2，available=true）。
      await expect(tick(new Date("2026-08-18T01:00:00Z")))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      // 新隔离（01:30）晚于 v2（01:00）。
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T01:30:00Z") })
        .where("id", "=", resourceId).execute();
      expect(await readKeyModels()).toEqual([]);
      // T2（P1 到点）：成功 100 → 快照 v3（01:45）晚于隔离时刻 → BALANCE_SYNC_RECOVERED → DEGRADED。
      await expect(tick(new Date("2026-08-18T01:45:00Z")))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "DEGRADED" });
      expect(await readKeyModels()).toEqual([modelId]);
      expect(await db.selectFrom("resource_status_event").select(["reason", "to_status"])
        .where("provider_resource_id", "=", resourceId).orderBy("id", "desc")
        .executeTakeFirstOrThrow()).toMatchObject({
        reason: "BALANCE_SYNC_RECOVERED", to_status: "DEGRADED",
      });

      // 再隔离（02:05，晚于 v3 01:45）→ T3 取得更新证据（v4，02:10）→ 再次恢复。
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T02:05:00Z") })
        .where("id", "=", resourceId).execute();
      await clearKeyModels();
      await expect(tick(new Date("2026-08-18T02:10:00Z")))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 1, failed: 0, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "DEGRADED" });
      expect(await readKeyModels()).toEqual([modelId]);

      // 证据不足：新隔离（02:30）后仅有 provider_balance_available=NULL 的快照（v5，02:50）
      // → 不恢复；本轮上游失败也只留 attempt 失败原因，不覆盖最后成功快照。
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T02:30:00Z") })
        .where("id", "=", resourceId).execute();
      await clearKeyModels();
      await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 5,
        source: "PROVIDER_SYNC", collected_at: new Date("2026-08-18T02:50:00Z"),
        currency: "CNY", current_balance: "100", provider_balance_available: null,
        balance_source: "PROVIDER_API", usage_calculation: "SYSTEM_LEDGER",
      }).execute();
      const failedFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as ProviderOperatingFetch;
      await expect(tick(new Date("2026-08-18T03:00:00Z"), failedFetch))
        .resolves.toEqual({ resourcesScanned: 1, snapshotsCreated: 0, failed: 1, notSupported: 0,
          skippedQuiescentResources: 0 });
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "EXHAUSTED" });
      expect(await readKeyModels()).toEqual([]);

      // 失败保鲜：快照历史不新增（v1 ADMIN＋v2/v3/v4 同步＋v5 直插 = 5）；
      // 最新 attempt FAILED/UPSTREAM_UNAVAILABLE；last_success_data_at = 最后成功采集时刻。
      expect(await repo.listOperatingSnapshotHistory(enterpriseId, resourceId)).toHaveLength(5);
      const states = await repo.listLatestOperatingSyncStates(enterpriseId);
      expect(states[0]).toMatchObject({ balance_status: "FAILED", cost_status: "NOT_SUPPORTED",
        error_code: "UPSTREAM_UNAVAILABLE" });
      expect(states[0]?.last_success_data_at?.toISOString()).toBe("2026-08-18T02:10:00.000Z");

      await expect(tick(new Date("2026-08-18T03:15:00Z"), okFetch(["0"])))
        .resolves.toMatchObject({ snapshotsCreated: 1, failed: 0 });
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "EXHAUSTED" });
      expect(await readKeyModels()).toEqual([]);
      await retireResource(db, resourceId);
    } finally {
      await db.destroy();
    }
  });
  it("EG-02 定向补充：NOT_SUPPORTED 分态留痕（非经营范围 code／缺凭证／适配器 null 余额）＋401 POFE 失败留痕；省略 now 用默认时钟", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const kekBase64 = Buffer.alloc(32, 13).toString("base64");
      const kek = Buffer.alloc(32, 13);
      const seedRaw = async (code: string, withCredential: boolean): Promise<{ enterpriseId: string; resourceId: string }> => {
        const enterpriseId = randomUUID(); const providerId = randomUUID(); const resourceId = randomUUID();
        await db.insertInto("enterprise").values({ id: enterpriseId, name: enterpriseId }).execute();
        await db.insertInto("provider").values({
          id: providerId, enterprise_id: enterpriseId, code, name: code,
          adapter_type: "OPENAI_COMPATIBLE",
        }).execute();
        await db.insertInto("provider_resource").values({
          id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
          name: "EG02 raw", mode: "API", credential_type: "API_KEY",
          ...(withCredential
            ? { credential_ciphertext: JSON.stringify(encryptCredential("sk-eg02", kek)) }
            : {}),
        }).execute();
        return { enterpriseId, resourceId };
      };
      // a) 非经营范围 code：canonical 不落在 deepseek/kimi/zhipu → PROVIDER_NOT_SUPPORTED。
      const a = await seedRaw("openai", true);
      // b) deepseek API 但缺凭证 → CREDENTIAL_MISSING。
      const b = await seedRaw("deepseek", false);
      // c) zhipu：canonical 在经营范围内、有凭证 → 适配器对非 deepseek 返回 null
      //    → PROVIDER_BALANCE_API_NOT_SUPPORTED（零上游调用）。
      const c = await seedRaw("zhipu", true);
      // d) deepseek 有凭证 + 上游 401 → 适配器抛 POFE("UNAUTHORIZED") → FAILED 留痕。
      const d = await seedRaw("deepseek", true);
      const unauthorizedFetch = vi.fn(async () => ({ ok: false, status: 401 })) as unknown as ProviderOperatingFetch;

      // 省略 now：覆盖默认 new Date() 分支；resourcesScanned＝4（三种 NOT_SUPPORTED＋1 失败）。
      const result = await runProviderOperatingSyncTick({ db, kekBase64, fetch: unauthorizedFetch });
      expect(result).toMatchObject({ resourcesScanned: 4, snapshotsCreated: 0,
        failed: 1, notSupported: 3, skippedQuiescentResources: 0 });

      const errorCodeOf = async (resourceId: string): Promise<{ balance_status: string; error_code: string | null; failure_reason: string | null }> =>
        (await db.selectFrom("provider_resource_operating_sync_attempt")
          .select(["balance_status", "error_code", "failure_reason"])
          .where("provider_resource_id", "=", resourceId)
          .orderBy("started_at", "desc").executeTakeFirstOrThrow());
      expect(await errorCodeOf(a.resourceId)).toMatchObject({
        balance_status: "NOT_SUPPORTED", error_code: "PROVIDER_NOT_SUPPORTED" });
      expect(await errorCodeOf(b.resourceId)).toMatchObject({
        balance_status: "NOT_SUPPORTED", error_code: "CREDENTIAL_MISSING" });
      expect(await errorCodeOf(c.resourceId)).toMatchObject({
        balance_status: "NOT_SUPPORTED", error_code: "PROVIDER_BALANCE_API_NOT_SUPPORTED" });
      expect(await errorCodeOf(d.resourceId)).toMatchObject({
        balance_status: "FAILED", error_code: "UNAUTHORIZED" });
      // a/b/c 未触达上游；d 恰一次（401）。
      expect(unauthorizedFetch).toHaveBeenCalledTimes(1);
      for (const { resourceId } of [a, b, c, d]) {
        expect(await db.selectFrom("provider_resource_operating_snapshot").select("id")
          .where("provider_resource_id", "=", resourceId).execute()).toHaveLength(0);
        await retireResource(db, resourceId);
      }
    } finally {
      await db.destroy();
    }
  });
});
