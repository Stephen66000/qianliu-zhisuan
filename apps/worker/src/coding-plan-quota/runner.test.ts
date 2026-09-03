import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createKysely, migrateToLatest } from "@qianliu/database";
import { encryptCredential, type QuotaFetch } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

import { runCodingPlanQuotaTick } from "./runner.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("coding_plan_quota_recovery");
}, 120_000);

afterAll(async () => {
  await pg?.stop();
}, 60_000);

describe("Coding Plan 额度同步恢复", () => {
  it("只在到期时访问厂商，并用当次额度证据自动解除隔离", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID();
      const providerId = randomUUID();
      const resourceId = randomUUID();
      const modelId = randomUUID();
      const principalId = randomUUID();
      const kek = Buffer.alloc(32, 9);
      const kekBase64 = kek.toString("base64");
      await db.insertInto("enterprise").values({
        id: enterpriseId,
        name: "额度同步恢复测试",
      }).execute();
      await db.insertInto("provider").values({
        id: providerId,
        enterprise_id: enterpriseId,
        code: "kimi",
        name: "Kimi",
        adapter_type: "OPENAI_COMPATIBLE",
        status: "ACTIVE",
      }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId,
        enterprise_id: enterpriseId,
        provider_id: providerId,
        name: "Kimi Coding Plan",
        mode: "CODING_PLAN",
        credential_type: "SUBSCRIPTION_SESSION",
        credential_ciphertext: JSON.stringify(encryptCredential("kimi-test", kek)),
        status: "CREDENTIAL_INVALID",
        cooldown_until: null,
        credential_refresh_status: "FAILED",
        refresh_error_classification: "OAUTH_REFRESH_REJECTED",
      }).execute();
      await db.insertInto("unified_model").values({
        id: modelId,
        enterprise_id: enterpriseId,
        alias: "ql-k3-recovery",
        display_name: "K3 Recovery",
        status: "ACTIVE",
      }).execute();
      await db.insertInto("model_route").values({
        enterprise_id: enterpriseId,
        unified_model_id: modelId,
        provider_resource_id: resourceId,
        upstream_model: "k3",
        enabled: true,
      }).execute();
      await db.insertInto("billing_rule").values({
        enterprise_id: enterpriseId,
        provider_resource_id: resourceId,
        upstream_model: "k3",
        rule_type: "MODEL_TIER",
        rule_version: "quota-recovery-v1",
        effective_from: new Date("2026-01-01T00:00:00.000Z"),
        multiplier: "1",
        enabled: true,
      }).execute();
      await db.insertInto("principal").values({
        id: principalId,
        enterprise_id: enterpriseId,
        type: "EMPLOYEE",
        name: "额度恢复员工",
        status: "ACTIVE",
      }).execute();
      await db.insertInto("principal_key").values({
        enterprise_id: enterpriseId,
        principal_id: principalId,
        key_prefix: "quota-recovery",
        key_digest: randomUUID(),
        allowed_model_ids: JSON.stringify([]) as unknown as string[],
        status: "ACTIVE",
      }).execute();
      const grant = await db.insertInto("principal_grant").values({
        enterprise_id: enterpriseId,
        principal_id: principalId,
        provider: "kimi",
        model_alias: "*",
        pool_model_alias: "*",
        quota_value: 10_000n,
        status: "ACTIVE",
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();

      const fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          usage: {
            limit: "100", used: "37", remaining: "63",
            resetTime: "2026-09-08T04:00:00.000Z",
          },
          limits: [{
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: {
              limit: "100", used: "0", remaining: "100",
              resetTime: "2026-09-03T17:00:00.000Z",
            },
          }],
        }),
      })) as unknown as QuotaFetch;
      const now = new Date("2026-09-03T12:00:00.000Z");

      await expect(runCodingPlanQuotaTick({ db, kekBase64, fetch, now }))
        .resolves.toEqual({
          resourcesScanned: 1,
          windowsUpserted: 2,
          resourcesRecovered: 1,
          failed: 0,
        });
      expect((await db.selectFrom("provider_resource").select([
        "status", "cooldown_until", "credential_refresh_status", "refresh_error_classification",
      ])
        .where("id", "=", resourceId).executeTakeFirstOrThrow())).toEqual({
        status: "DEGRADED",
        cooldown_until: null,
        credential_refresh_status: "OK",
        refresh_error_classification: null,
      });
      expect(await db.selectFrom("resource_status_event").select(["reason", "actor"])
        .where("provider_resource_id", "=", resourceId).execute()).toEqual([
        { reason: "QUOTA_SYNC_RECOVERED", actor: "system" },
      ]);
      expect((await db.selectFrom("principal_key").select("allowed_model_ids")
        .where("principal_id", "=", principalId).where("status", "=", "ACTIVE")
        .executeTakeFirstOrThrow()).allowed_model_ids).toEqual([modelId]);

      await expect(runCodingPlanQuotaTick({
        db,
        kekBase64,
        fetch,
        now: new Date(now.getTime() + 30_000),
      })).resolves.toMatchObject({ resourcesScanned: 0, resourcesRecovered: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);

      const dueAt = new Date(now.getTime() + 2 * 60 * 60_000);
      await db.updateTable("provider_resource").set({
        status: "RATE_LIMITED",
        cooldown_until: dueAt,
      }).where("id", "=", resourceId).execute();
      await expect(runCodingPlanQuotaTick({
        db,
        kekBase64,
        fetch,
        now: new Date(dueAt.getTime() - 1),
      })).resolves.toMatchObject({ resourcesScanned: 0, resourcesRecovered: 0 });
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(runCodingPlanQuotaTick({
        db,
        kekBase64,
        fetch,
        now: dueAt,
      })).resolves.toMatchObject({ resourcesScanned: 1, resourcesRecovered: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await db.destroy();
    }
  });
});
