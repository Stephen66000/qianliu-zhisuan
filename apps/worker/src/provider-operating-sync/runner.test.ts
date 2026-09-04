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

describe("POOL20-025 每日经营同步", () => {
  it("成功追加不可变快照；同日幂等；失败只留原因并保鲜最后成功值", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID(); const providerId = randomUUID(); const resourceId = randomUUID();
      const kek = Buffer.alloc(32, 7); const kekBase64 = kek.toString("base64");
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "经营同步测试" }).execute();
      const adminId = randomUUID();
      await db.insertInto("admin_user").values({
        id: adminId, enterprise_id: enterpriseId, username: "sync-admin",
        password_hash: "not-used", status: "ACTIVE",
      }).execute();
      await db.insertInto("provider").values({
        id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE",
      }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId, enterprise_id: enterpriseId, provider_id: providerId, name: "DeepSeek API",
        mode: "API", credential_type: "API_KEY", credential_ciphertext: JSON.stringify(encryptCredential("sk-test", kek)),
      }).execute();
      const repo = new ProviderRepository(db);
      await repo.appendOperatingSnapshot(enterpriseId, resourceId, {
        source: "ADMIN", collected_at: new Date("2026-08-01T00:00:00Z"), currency: "CNY",
        recharge_amount: "100", current_balance: "80", current_period_cost: "20",
        balance_source: "ADMIN", cost_source: "ADMIN",
      });
      let balanceCalls = 0;
      const fetch = vi.fn(async () => {
        balanceCalls += 1;
        return { ok: true, status: 200, json: async () => ({
        is_available: true,
        balance_infos: [{
          currency: "CNY", total_balance: balanceCalls > 1 ? "100" : "68",
          granted_balance: "8", topped_up_balance: balanceCalls > 1 ? "92" : "60",
        }],
        }) };
      }) as unknown as ProviderOperatingFetch;
      const now = new Date("2026-08-18T01:00:00Z");
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now })).resolves.toMatchObject({ snapshotsCreated: 1, failed: 0 });
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now })).resolves.toMatchObject({ snapshotsCreated: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T01:30:00Z") })
        .where("id", "=", resourceId).execute();
      await sql`
        INSERT INTO resource_purchase_record
          (enterprise_id, provider_resource_id, purchase_type, amount, currency,
           purchased_at, source, created_by, created_at)
        VALUES (${enterpriseId}::uuid, ${resourceId}::uuid, 'API_RECHARGE', 100, 'CNY',
                '2026-08-18T02:00:00Z'::timestamptz, 'ADMIN', ${adminId}::uuid,
                '2026-08-18T02:00:00Z'::timestamptz)
      `.execute(db);
      const afterRecharge = new Date("2026-08-18T03:00:00Z");
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now: afterRecharge }))
        .resolves.toMatchObject({ snapshotsCreated: 1, failed: 0 });
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now: afterRecharge }))
        .resolves.toMatchObject({ snapshotsCreated: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);
      const success = await repo.listLatestOperatingSnapshots(enterpriseId);
      expect(success[0]).toMatchObject({
        source: "PROVIDER_SYNC", current_balance: "100.00000000", granted_balance: "8.00000000",
        topped_up_balance: "92.00000000", balance_source: "PROVIDER_API",
        current_period_cost: "20.00000000", cost_source: "ADMIN",
      });
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "DEGRADED" });
      expect(await db.selectFrom("resource_status_event").select(["reason", "to_status"])
        .where("provider_resource_id", "=", resourceId).orderBy("id", "desc")
        .executeTakeFirstOrThrow()).toMatchObject({
        reason: "BALANCE_SYNC_RECOVERED", to_status: "DEGRADED",
      });
      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T02:30:00Z") })
        .where("id", "=", resourceId).execute();
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now: afterRecharge }))
        .resolves.toMatchObject({ snapshotsCreated: 0, failed: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "DEGRADED" });

      await db.updateTable("provider_resource").set({ status: "EXHAUSTED",
        updated_at: new Date("2026-08-18T04:00:00Z") })
        .where("id", "=", resourceId).execute();
      await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 4,
        source: "PROVIDER_SYNC", collected_at: new Date("2026-08-18T05:00:00Z"),
        currency: "CNY", current_balance: "100", provider_balance_available: null,
        balance_source: "PROVIDER_API", usage_calculation: "SYSTEM_LEDGER",
      }).execute();
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch,
        now: new Date("2026-08-18T06:00:00Z") }))
        .resolves.toMatchObject({ snapshotsCreated: 0, failed: 0 });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await db.selectFrom("provider_resource").select("status")
        .where("id", "=", resourceId).executeTakeFirstOrThrow()).toEqual({ status: "EXHAUSTED" });

      const failedFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as ProviderOperatingFetch;
      await expect(runProviderOperatingSyncTick({
        db, kekBase64, fetch: failedFetch, now: new Date("2026-08-19T01:00:00Z"),
      })).resolves.toMatchObject({ snapshotsCreated: 0, failed: 1 });
      expect(await repo.listOperatingSnapshotHistory(enterpriseId, resourceId)).toHaveLength(4);
      const states = await repo.listLatestOperatingSyncStates(enterpriseId);
      expect(states[0]).toMatchObject({ balance_status: "FAILED", cost_status: "NOT_SUPPORTED", error_code: "UPSTREAM_UNAVAILABLE" });
      expect(states[0]?.last_success_data_at?.toISOString()).toBe(now.toISOString());
    } finally {
      await db.destroy();
    }
  });
});
