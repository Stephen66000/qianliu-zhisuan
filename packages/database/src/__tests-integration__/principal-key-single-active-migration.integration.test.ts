import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

describe("0023 Principal Key 单 ACTIVE 迁移", () => {
  it("修复历史重复 Key，并以 partial unique index 消除并发插入竞态", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      const migrated = await migrator.migrateTo(
        "0022_principal_key_minimum_model_permissions",
      );
      expect(migrated.error).toBeUndefined();

      await sql`
        INSERT INTO enterprise (id, name)
        VALUES ('31111111-1111-4111-8111-111111111111', 'single-active-key-test')
      `.execute(db);
      await sql`
        INSERT INTO principal (id, enterprise_id, type, name)
        VALUES (
          '32222222-2222-4222-8222-222222222222',
          '31111111-1111-4111-8111-111111111111',
          'EMPLOYEE',
          '历史重复 Key 主体'
        )
      `.execute(db);
      await sql`
        INSERT INTO principal_key (
          id, enterprise_id, principal_id, key_prefix, key_digest, status, created_at
        )
        VALUES
          (
            '33333333-3333-4333-8333-333333333331',
            '31111111-1111-4111-8111-111111111111',
            '32222222-2222-4222-8222-222222222222',
            'sk-old',
            'old-active-digest',
            'ACTIVE',
            '2026-01-01T00:00:00Z'
          ),
          (
            '33333333-3333-4333-8333-333333333332',
            '31111111-1111-4111-8111-111111111111',
            '32222222-2222-4222-8222-222222222222',
            'sk-new',
            'new-active-digest',
            'ACTIVE',
            '2026-02-01T00:00:00Z'
          )
      `.execute(db);

      const executed = await migrateToLatest(db);
      expect(executed).toContain("0023_principal_key_single_active");
      const keys = await sql`
        SELECT id, status, revoked_at
          FROM principal_key
         WHERE principal_id = '32222222-2222-4222-8222-222222222222'
         ORDER BY created_at
      `.execute(db);
      expect(keys.rows).toMatchObject([
        {
          id: "33333333-3333-4333-8333-333333333331",
          status: "REVOKED",
        },
        {
          id: "33333333-3333-4333-8333-333333333332",
          status: "ACTIVE",
          revoked_at: null,
        },
      ]);

      await expect(
        sql`
          INSERT INTO principal_key (
            enterprise_id, principal_id, key_prefix, key_digest, status
          )
          VALUES (
            '31111111-1111-4111-8111-111111111111',
            '32222222-2222-4222-8222-222222222222',
            'sk-racing',
            'racing-active-digest',
            'ACTIVE'
          )
        `.execute(db),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "principal_key_one_active_per_principal_uq",
      });

      expect(await migrateDown(db)).toBe("0037_client_identity");
      expect(await migrateDown(db)).toBe("0036_provider_model_discovery");
      expect(await migrateDown(db)).toBe("0035_deployment_log");
      expect(await migrateDown(db)).toBe("0034_supply_forecast_production");
      expect(await migrateDown(db)).toBe("0033_operating_bill");
      expect(await migrateDown(db)).toBe("0032_admin_lifecycle");
      expect(await migrateDown(db)).toBe("0031_gateway_stream_resilience");
      expect(await migrateDown(db)).toBe("0030_runtime_assurance_foundation");
      expect(await migrateDown(db)).toBe("0029_provider_quota_auto_calculation");
      expect(await migrateDown(db)).toBe("0028_enterprise_reference_guards");
      expect(await migrateDown(db)).toBe("0027_usage_ledger_filters");
      expect(await migrateDown(db)).toBe(
        "0026_provider_resource_operating_snapshot",
      );
      expect(await migrateDown(db)).toBe("0025_principal_archive");
      expect(await migrateDown(db)).toBe("0024_gateway_request_idempotency");
      expect(await migrateDown(db)).toBe("0023_principal_key_single_active");
      await sql`
        INSERT INTO principal_key (
          enterprise_id, principal_id, key_prefix, key_digest, status
        )
        VALUES (
          '31111111-1111-4111-8111-111111111111',
          '32222222-2222-4222-8222-222222222222',
          'sk-after-rollback',
          'after-rollback-active-digest',
          'ACTIVE'
        )
      `.execute(db);
      const activeAfterRollback = await sql`
        SELECT count(*)::int AS count
          FROM principal_key
         WHERE principal_id = '32222222-2222-4222-8222-222222222222'
           AND status = 'ACTIVE'
      `.execute(db);
      expect(activeAfterRollback.rows[0]).toEqual({ count: 2 });
    } finally {
      await db.destroy();
    }
  });
});
