import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer } from "@qianliu/testing";
import { createKysely, migrateDown } from "../index.js";
import { createMigrator } from "../migrator.js";

describe.sequential("POOL20-047 API 资源月预算迁移", () => {
  it("约束月份、版本和当前指针，已有事实时拒绝破坏性回退", async () => {
    const pg = await startPostgresContainer("pool047_budget_migration");
    const db = createKysely(pg.connectionString);
    try {
      expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
      const enterpriseId = randomUUID();
      const adminId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL20-047" }).execute();
      await db.insertInto("admin_user").values({
        id: adminId,
        enterprise_id: enterpriseId,
        username: "pool047",
        display_name: "POOL47",
        password_hash: "test",
      }).execute();
      const provider = await db.insertInto("provider").values({
        enterprise_id: enterpriseId,
        code: "pool047",
        name: "POOL47",
        adapter_type: "openai",
      }).returning("id").executeTakeFirstOrThrow();
      const resource = await db.insertInto("provider_resource").values({
        enterprise_id: enterpriseId,
        provider_id: provider.id,
        name: "POOL47 API",
        mode: "API",
        credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("provider_resource_monthly_budget").values({
        enterprise_id: enterpriseId,
        provider_resource_id: resource.id,
        month: "2026-08-01",
        version: 1,
        status: "ACTIVE",
        amount: "100",
        currency: "CNY",
        created_by: adminId,
        idempotency_key: randomUUID(),
        request_hash: "a".repeat(64),
        response_snapshot: {},
      }).execute();
      await expect(db.insertInto("provider_resource_monthly_budget").values({
        enterprise_id: enterpriseId,
        provider_resource_id: resource.id,
        month: "2026-08-01",
        version: 2,
        status: "ACTIVE",
        amount: "200",
        currency: "CNY",
        created_by: adminId,
        idempotency_key: randomUUID(),
        request_hash: "b".repeat(64),
        response_snapshot: {},
      }).execute()).rejects.toThrow();
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      expect(await migrateDown(db)).toBe("0059_provider_finance_ledger");
      expect(await migrateDown(db)).toBe("0058_principal_grant_archive");
      expect(await migrateDown(db)).toBe("0057_model_discovery_v12");
      await expect(migrateDown(db)).rejects.toThrow(/0056 contains resource monthly budget facts/);
      await db.deleteFrom("provider_resource_monthly_budget").execute();
      expect(await migrateDown(db)).toBe("0056_resource_monthly_budget");
      const table = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM information_schema.tables
         WHERE table_name = 'provider_resource_monthly_budget'
      `.execute(db);
      expect(table.rows[0]?.count).toBe("0");
      expect((await createMigrator(db).migrateToLatest()).error).toBeUndefined();
    } finally {
      await db.destroy();
      await pg.stop();
    }
  }, 120_000);
});
