import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  createKysely,
  migrateDown,
  migrateToLatest,
  type Database,
} from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { rollbackTo } from "./migration-rollback.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_ra_w01");
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

async function schemaFingerprint(db: Kysely<Database>): Promise<string> {
  const result = await sql<{ fingerprint: string }>`
    WITH schema_items AS (
      SELECT 'column' AS kind,
             table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '') AS definition
        FROM information_schema.columns
       WHERE table_schema = 'public'
      UNION ALL
      SELECT 'constraint' AS kind,
             conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid, true) AS definition
        FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
      UNION ALL
      SELECT 'index' AS kind,
             tablename || '.' || indexname || ':' || indexdef AS definition
        FROM pg_indexes
       WHERE schemaname = 'public'
    )
    SELECT md5(string_agg(kind || ':' || definition, E'\n' ORDER BY kind, definition)) AS fingerprint
      FROM schema_items
  `.execute(db);
  return result.rows[0]!.fingerprint;
}

describe("RA-W01 0030 运行保障底座迁移", () => {
  it("空库升级、依次回滚 0031/0030、重升后 Schema 指纹一致", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const executed = await migrateToLatest(db);
      expect(executed).toContain("0030_runtime_assurance_foundation");

      const expectedTables = [
        "availability_event",
        "availability_rule",
        "availability_rule_version",
        "notification_delivery",
        "notification_endpoint",
        "person",
        "person_external_identity",
      ];
      const tables = await sql<{ table_name: string }>`
        SELECT table_name
          FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY(${expectedTables})
         ORDER BY table_name
      `.execute(db);
      expect(tables.rows.map((row) => row.table_name)).toEqual(expectedTables);

      const enterpriseBoundaryColumns = await sql<{ table_name: string; column_name: string }>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ANY(${expectedTables})
           AND column_name IN ('tenant_id', 'enterprise_id')
         ORDER BY table_name, column_name
      `.execute(db);
      expect(enterpriseBoundaryColumns.rows).toEqual([
        { table_name: "person", column_name: "enterprise_id" },
        { table_name: "person_external_identity", column_name: "enterprise_id" },
      ]);

      const principalColumns = await sql<{ column_name: string }>`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'principal'
           AND column_name IN ('person_id', 'owner_person_id', 'version')
         ORDER BY column_name
      `.execute(db);
      expect(principalColumns.rows.map((row) => row.column_name)).toEqual([
        "owner_person_id",
        "person_id",
        "version",
      ]);

      const before = await schemaFingerprint(db);
      // 回滚链锚定「目标迁移」而非「当时的迁移头」（惯例见 migration-rollback.ts docstring）。
      const rolledBackLedger = await rollbackTo(db, "0072_admin_roles_security");
      expect(rolledBackLedger.at(-1)).toBe("0072_admin_roles_security");
      expect(await migrateDown(db)).toBe("0071_enterprise_contact_details");
      expect(await migrateDown(db)).toBe("0070_alert_recovery_evidence");
      expect(await migrateDown(db)).toBe("0069_auth_error_evidence");
      expect(await migrateDown(db)).toBe("0068_alert_resource_context");
      expect(await migrateDown(db)).toBe("0067_admin_cleanup");
      expect(await migrateDown(db)).toBe("0066_subscription_auto_renewal");
      expect(await migrateDown(db)).toBe("0065_principal_accounting_assignment");
      expect(await migrateDown(db)).toBe("0064_quota_pricing_and_policy_archive");
      expect(await migrateDown(db)).toBe("0063_operating_snapshot_subscription_period");
      expect(await migrateDown(db)).toBe("0062_resource_fact_reconciliation");
      expect(await migrateDown(db)).toBe("0061_provider_finance_audit_hardening");
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      expect(await migrateDown(db)).toBe("0059_provider_finance_ledger");
    expect(await migrateDown(db)).toBe("0058_principal_grant_archive");
    expect(await migrateDown(db)).toBe("0057_model_discovery_v12");
    expect(await migrateDown(db)).toBe("0056_resource_monthly_budget");
      expect(await migrateDown(db)).toBe("0055_upstream_error_evidence");
      expect(await migrateDown(db)).toBe("0054_usage_aggregate_settlement_time");
      expect(await migrateDown(db)).toBe("0053_operating_bill_opening_balance");
      expect(await migrateDown(db)).toBe("0052_dispatch_restore_and_resource_utilization");
      expect(await migrateDown(db)).toBe("0051_pool20_operating_sync_and_closing_confirmation");
      expect(await migrateDown(db)).toBe("0050_group2_policy_lifecycle");
      expect(await migrateDown(db)).toBe("0049_resource_utilization_and_procurement_review");
      expect(await migrateDown(db)).toBe("0048_department_cost_budget_and_purchase");
      expect(await migrateDown(db)).toBe("0047_usage_bucket_aggregate");
      expect(await migrateDown(db)).toBe("0046_directory_import_foundation");
      expect(await migrateDown(db)).toBe("0045_zhipu_weekday_window_alias");
      expect(await migrateDown(db)).toBe("0044_operating_bill_model_identity");
      expect(await migrateDown(db)).toBe("0043_single_owner_rule_history");
      expect(await migrateDown(db)).toBe("0042_alias_ql_format");
      expect(await migrateDown(db)).toBe("0041_provider_quota_window");
      expect(await migrateDown(db)).toBe("0040_employee_model_rule_pool_quotas");
      expect(await migrateDown(db)).toBe("0039_principal_provider_pool");
      expect(await migrateDown(db)).toBe("0038_employee_model_authorization_rule");
      expect(await migrateDown(db)).toBe("0037_client_identity");
      expect(await migrateDown(db)).toBe("0036_provider_model_discovery");
      expect(await migrateDown(db)).toBe("0035_deployment_log");
      expect(await migrateDown(db)).toBe("0034_supply_forecast_production");
      expect(await migrateDown(db)).toBe("0033_operating_bill");
      expect(await migrateDown(db)).toBe("0032_admin_lifecycle");
      expect(await migrateDown(db)).toBe("0031_gateway_stream_resilience");
      expect(await migrateDown(db)).toBe("0030_runtime_assurance_foundation");
      const regAfterRollback = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.availability_rule') AS reg
      `.execute(db);
      expect(regAfterRollback.rows[0]!.reg).toBeNull();

      const rebuilt = await migrateToLatest(db);
      expect(rebuilt).toContain("0030_runtime_assurance_foundation");
      expect(rebuilt).toContain("0031_gateway_stream_resilience");
      const after = await schemaFingerprint(db);
      expect(after).toBe(before);
    } finally {
      await db.destroy();
    }
  });
});
