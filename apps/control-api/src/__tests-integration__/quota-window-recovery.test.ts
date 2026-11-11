import { afterEach, expect, it, vi } from "vitest";
import { QuotaBlockRepository } from "@qianliu/database";
import { encryptCredential } from "@qianliu/provider-adapters";
import { adminCookie, app, db, seedProviderResource } from "./w19-admin-fixture.js";

afterEach(() => vi.unstubAllGlobals());

it("syncs an exhausted Zhipu resource before its scheduled reset and recovers only with fresh quota", async () => {
  const { resource } = await seedProviderResource("ACTIVE", "CODING_PLAN");
  await db.updateTable("provider_resource").set({
    credential_ciphertext: JSON.stringify(encryptCredential("zhipu-test", app.credentialKek)),
  }).where("id", "=", resource.id).execute();
  const quota = new QuotaBlockRepository(db);
  const now = new Date();
  const resetAt = new Date(now.getTime() + 86_400_000);
  const captured = (await quota.captureQuotaQueryToken(resource.id, now))!;
  await quota.commitQuotaQueryResult({
    token: captured.token,
    source: "PROVIDER_SYNC",
    adapterVersion: "test",
    providerDataAt: null,
    now,
    windows: [{
      windowType: "WEEKLY", limit: "100", used: "100", remaining: "0",
      unit: "PERCENT", ratio: "1", resetAt, unsupported: false,
    }],
  });
  const getState = () => db.selectFrom("provider_resource")
    .select(["status", "cooldown_until", "quota_block_state"])
    .where("id", "=", resource.id).executeTakeFirstOrThrow();
  expect(await getState()).toMatchObject({ status: "EXHAUSTED", cooldown_until: resetAt });

  let weeklyUsed = 100;
  const fetch = vi.fn(async () => Response.json({
    data: { limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: weeklyUsed, nextResetTime: resetAt.getTime() },
    ] },
  }));
  vi.stubGlobal("fetch", fetch);
  const sync = () => app.inject({
    method: "POST", url: `/provider-resources/${resource.id}/quota-sync`,
    headers: { cookie: adminCookie },
  });
  const stillExhausted = await sync();
  expect(stillExhausted.statusCode).toBe(200);
  expect(stillExhausted.json().commit.status).toBe("COMMITTED");
  expect((await getState()).status).toBe("EXHAUSTED");

  weeklyUsed = 1;
  const recovered = await sync();
  expect(recovered.statusCode).toBe(200);
  expect(recovered.json().commit.status).toBe("COMMITTED");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await getState()).toEqual({ status: "DEGRADED", cooldown_until: null, quota_block_state: null });
});
