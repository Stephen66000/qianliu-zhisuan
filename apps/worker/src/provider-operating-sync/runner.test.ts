import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
      const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "68", granted_balance: "8", topped_up_balance: "60" }],
      }) })) as unknown as ProviderOperatingFetch;
      const now = new Date("2026-08-18T01:00:00Z");
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now })).resolves.toMatchObject({ snapshotsCreated: 1, failed: 0 });
      await expect(runProviderOperatingSyncTick({ db, kekBase64, fetch, now })).resolves.toMatchObject({ snapshotsCreated: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
      const success = await repo.listLatestOperatingSnapshots(enterpriseId);
      expect(success[0]).toMatchObject({
        source: "PROVIDER_SYNC", current_balance: "68.00000000", granted_balance: "8.00000000",
        topped_up_balance: "60.00000000", balance_source: "PROVIDER_API",
        current_period_cost: "20.00000000", cost_source: "ADMIN",
      });

      const failedFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as ProviderOperatingFetch;
      await expect(runProviderOperatingSyncTick({
        db, kekBase64, fetch: failedFetch, now: new Date("2026-08-19T01:00:00Z"),
      })).resolves.toMatchObject({ snapshotsCreated: 0, failed: 1 });
      expect(await repo.listOperatingSnapshotHistory(enterpriseId, resourceId)).toHaveLength(2);
      const states = await repo.listLatestOperatingSyncStates(enterpriseId);
      expect(states[0]).toMatchObject({ balance_status: "FAILED", cost_status: "NOT_SUPPORTED", error_code: "UPSTREAM_UNAVAILABLE" });
      expect(states[0]?.last_success_data_at?.toISOString()).toBe(now.toISOString());
    } finally {
      await db.destroy();
    }
  });
});
