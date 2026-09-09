import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("operating_period_0063"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0063 operating snapshot subscription period binding", () => {
  it("只允许额度配置关联同企业同资源的订阅周期", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      const baseline = await migrator.migrateTo("0062_resource_fact_reconciliation");
      expect(baseline.error).toBeUndefined();
      const before = await sql<{ exists: boolean }>`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name='provider_resource_operating_snapshot'
           AND column_name='subscription_period_id'
      ) AS exists`.execute(db);
      expect(before.rows[0]?.exists).toBe(false);

      expect(await migrateToLatest(db)).toContain("0063_operating_snapshot_subscription_period");
      const enterpriseId = randomUUID(); const adminId = randomUUID();
      const providerId = randomUUID(); const resourceId = randomUUID();
      const otherResourceId = randomUUID(); const periodId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "0063" }).execute();
      await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
        username: "0063-admin", password_hash: "unused", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
        code: "0063-provider", name: "0063-provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values([
        { id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
          name: "0063-plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
        { id: otherResourceId, enterprise_id: enterpriseId, provider_id: providerId,
          name: "0063-other", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
      ]).execute();
      await db.insertInto("provider_subscription_period").values({ id: periodId,
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        finance_event_id: null, product_name: "0063-plan",
        period_start: new Date("2026-08-31T16:00:00.000Z"),
        period_end_exclusive: new Date("2026-09-30T16:00:00.000Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: null,
        created_by_admin_user_id: adminId }).execute();
      await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        subscription_period_id: periodId, version: 1, source: "ADMIN",
        collected_at: new Date(), total_quota: "3000000000", quota_unit: "TOKEN",
      }).execute();
      await expect(db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: otherResourceId,
        subscription_period_id: periodId, version: 1, source: "ADMIN",
        collected_at: new Date(), total_quota: "1", quota_unit: "TOKEN",
      }).execute()).rejects.toThrow();

      expect(await migrateDown(db)).toBe("0070_alert_recovery_evidence");
      expect(await migrateDown(db)).toBe("0069_auth_error_evidence");
      expect(await migrateDown(db)).toBe("0068_alert_resource_context");
      expect(await migrateDown(db)).toBe("0067_admin_cleanup");
      expect(await migrateDown(db)).toBe("0066_subscription_auto_renewal");
      expect(await migrateDown(db)).toBe("0065_principal_accounting_assignment");
      expect(await migrateDown(db)).toBe("0064_quota_pricing_and_policy_archive");
      await expect(migrateDown(db)).rejects.toThrow(
        /0063 rollback blocked: subscription-bound operating facts exist/,
      );
      await db.deleteFrom("provider_resource_operating_snapshot")
        .where("provider_resource_id", "=", resourceId).execute();
      expect(await migrateDown(db)).toBe("0063_operating_snapshot_subscription_period");
      const after = await sql<{ exists: boolean }>`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name='provider_resource_operating_snapshot'
           AND column_name='subscription_period_id'
      ) AS exists`.execute(db);
      expect(after.rows[0]?.exists).toBe(false);
    } finally { await db.destroy(); }
  });
});
