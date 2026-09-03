import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown, migrateToLatest } from "../migrator.js";
import { GatewayLedgerRepository } from "../repositories/gateway-ledger-repository.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer();
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

describe("0021 billing_rule 多时间窗迁移", () => {
  it("旧单窗自动回填，且最近迁移可回滚/重建", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      const migrated = await migrator.migrateTo("0020_p0_billing_snapshot_and_reasoning_usage");
      expect(migrated.error).toBeUndefined();

      await sql`
        INSERT INTO enterprise (id, name)
        VALUES ('11111111-1111-4111-8111-111111111111', 'migration-test')
      `.execute(db);
      await sql`
        INSERT INTO billing_rule (
          enterprise_id, rule_type, rule_version, effective_from,
          timezone, days_of_week, start_time, end_time,
          cache_miss_price, currency
        )
        VALUES (
          '11111111-1111-4111-8111-111111111111',
          'API_PRICE', 'legacy-v1', NOW(),
          'Asia/Shanghai', '[1,2,3,4,5,6,7]'::jsonb, '09:00', '12:00',
          0.000001, 'CNY'
        )
      `.execute(db);

      const executed = await migrateToLatest(db);
      expect(executed).toContain("0021_billing_rule_multi_windows");
      const backfilled = await sql`
        SELECT time_windows
          FROM billing_rule
         WHERE rule_version = 'legacy-v1'
      `.execute(db);
      expect(backfilled.rows[0]).toEqual({
        time_windows: [{
          timezone: "Asia/Shanghai",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
          start_time: "09:00",
          end_time: "12:00",
        }],
      });

      const repository = new GatewayLedgerRepository(db);
      const multiWindow = await repository.createBillingRule({
        enterprise_id: "11111111-1111-4111-8111-111111111111",
        rule_type: "API_PRICE",
        rule_version: "multi-v1",
        effective_from: new Date(),
        time_windows: [
          {
            timezone: "Asia/Shanghai",
            days_of_week: [1, 2, 3, 4, 5, 6, 7],
            start_time: "09:00",
            end_time: "12:00",
          },
          {
            timezone: "Asia/Shanghai",
            days_of_week: [1, 2, 3, 4, 5, 6, 7],
            start_time: "14:00",
            end_time: "18:00",
          },
        ],
        cache_miss_price: "0.000001",
      });
      expect(multiWindow.time_windows).toHaveLength(2);
      expect(multiWindow).toMatchObject({
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "09:00",
        end_time: "12:00",
      });

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
      expect(await migrateDown(db)).toBe("0029_provider_quota_auto_calculation");
      expect(await migrateDown(db)).toBe("0028_enterprise_reference_guards");
      expect(await migrateDown(db)).toBe("0027_usage_ledger_filters");
      expect(await migrateDown(db)).toBe(
        "0026_provider_resource_operating_snapshot",
      );
      expect(await migrateDown(db)).toBe("0025_principal_archive");
      expect(await migrateDown(db)).toBe("0024_gateway_request_idempotency");
      expect(await migrateDown(db)).toBe("0023_principal_key_single_active");
      expect(await migrateDown(db)).toBe(
        "0022_principal_key_minimum_model_permissions",
      );
      expect(await migrateDown(db)).toBe("0021_billing_rule_multi_windows");
      const removed = await sql`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'billing_rule'
           AND column_name = 'time_windows'
      `.execute(db);
      expect(removed.rows).toHaveLength(0);
      const rollbackMirror = await sql`
        SELECT timezone, days_of_week, start_time, end_time
          FROM billing_rule
         WHERE rule_version = 'multi-v1'
      `.execute(db);
      expect(rollbackMirror.rows[0]).toEqual({
        timezone: "Asia/Shanghai",
        days_of_week: [1, 2, 3, 4, 5, 6, 7],
        start_time: "09:00",
        end_time: "12:00",
      });

      const rebuilt = await migrateToLatest(db);
      expect(rebuilt).toContain("0021_billing_rule_multi_windows");
      expect(rebuilt).toContain("0022_principal_key_minimum_model_permissions");
      expect(rebuilt).toContain("0023_principal_key_single_active");
      expect(rebuilt).toContain("0024_gateway_request_idempotency");
      expect(rebuilt).toContain("0025_principal_archive");
      expect(rebuilt).toContain("0026_provider_resource_operating_snapshot");
      expect(rebuilt).toContain("0027_usage_ledger_filters");
      expect(rebuilt).toContain("0028_enterprise_reference_guards");
      expect(rebuilt).toContain("0029_provider_quota_auto_calculation");
      expect(rebuilt).toContain("0030_runtime_assurance_foundation");
      expect(rebuilt).toContain("0031_gateway_stream_resilience");
    } finally {
      await db.destroy();
    }
  });
});
