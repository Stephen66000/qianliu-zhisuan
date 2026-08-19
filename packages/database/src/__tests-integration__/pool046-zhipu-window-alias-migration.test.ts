import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import * as pool046Migration from "../../migrations/0045_zhipu_weekday_window_alias.js";

let pg: PostgresTestInstance;

const enterpriseId = "46000000-0000-4000-8000-000000000001";
const principalId = "46000000-0000-4000-8000-000000000002";
const keyId = "46000000-0000-4000-8000-000000000003";
const providerId = "46000000-0000-4000-8000-000000000004";
const resourceId = "46000000-0000-4000-8000-000000000005";
const otherProviderId = "46000000-0000-4000-8000-000000000006";
const otherResourceId = "46000000-0000-4000-8000-000000000007";
const targetRuleId = "46000000-0000-4000-8000-000000000008";
const otherRuleId = "46000000-0000-4000-8000-000000000009";
const policyId = "46000000-0000-4000-8000-000000000010";
const requestId = "46000000-0000-4000-8000-000000000011";
const attemptId = "46000000-0000-4000-8000-000000000012";
const usageId = "46000000-0000-4000-8000-000000000013";
const ledgerId = "46000000-0000-4000-8000-000000000014";
const legacyTargetRuleId = "46000000-0000-4000-8000-000000000015";
const currentPolicyId = "46000000-0000-4000-8000-000000000016";
const existingWeekdayRuleId = "46000000-0000-4000-8000-000000000017";

const allDays = [1, 2, 3, 4, 5, 6, 7];
const weekdays = [1, 2, 3, 4, 5];

beforeAll(async () => {
  pg = process.env.POOL046_MIGRATION_DATABASE_URL
    ? { connectionString: process.env.POOL046_MIGRATION_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("pool046_zhipu_window_alias");
}, 120_000);

afterAll(async () => { await pg?.stop(); }, 60_000);

describe("POOL-046 0045 智谱时段与 alias 迁移", () => {
  it("只迁移目标配置、保持历史账本不变，并支持幂等 up/down 与重放", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0044_operating_bill_model_identity")).error).toBeUndefined();

      await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-046" }).execute();
      await db.insertInto("principal").values({
        id: principalId,
        enterprise_id: enterpriseId,
        type: "EMPLOYEE",
        name: "王涛",
      }).execute();
      await db.insertInto("principal_key").values({
        id: keyId,
        enterprise_id: enterpriseId,
        principal_id: principalId,
        key_prefix: "ql_pool046",
        key_digest: "pool046-digest",
      }).execute();
      await db.insertInto("provider").values([
        {
          id: providerId,
          enterprise_id: enterpriseId,
          code: "zhipu",
          name: "智谱",
          adapter_type: "OPENAI_COMPATIBLE",
        },
        {
          id: otherProviderId,
          enterprise_id: enterpriseId,
          code: "other",
          name: "其他厂商",
          adapter_type: "OPENAI_COMPATIBLE",
        },
      ]).execute();
      await db.insertInto("provider_resource").values([
        {
          id: resourceId,
          enterprise_id: enterpriseId,
          provider_id: providerId,
          name: "智谱资源",
          mode: "CODING_PLAN",
          credential_type: "OAUTH",
        },
        {
          id: otherResourceId,
          enterprise_id: enterpriseId,
          provider_id: otherProviderId,
          name: "其他资源",
          mode: "CODING_PLAN",
          credential_type: "OAUTH",
        },
      ]).execute();

      await db.insertInto("dispatch_policy").values([
        {
          id: policyId,
          enterprise_id: enterpriseId,
          status: "PUBLISHED",
          match_unified_model: "qianliu-zhipu-glm-5-2",
          match_timezone: "Asia/Shanghai",
          match_days_of_week: JSON.stringify(weekdays) as unknown as number[],
          match_start_time: "14:00:00",
          match_end_time: "18:00:00",
          action: "REJECT",
          policy_version: "v2",
          priority: 10,
        },
        {
          id: currentPolicyId,
          enterprise_id: enterpriseId,
          status: "PUBLISHED",
          match_unified_model: "ql-glm-5.2",
          match_timezone: "Asia/Shanghai",
          match_days_of_week: JSON.stringify(weekdays) as unknown as number[],
          match_start_time: "14:00",
          match_end_time: "18:00",
          action: "REJECT",
          policy_version: "v2",
          priority: 10,
        },
      ]).execute();

      const targetWindows = [
        { timezone: "Asia/Shanghai", days_of_week: allDays, start_time: "14:00:00", end_time: "18:00:00" },
        { timezone: "Asia/Shanghai", days_of_week: allDays, start_time: "09:00", end_time: "10:00" },
      ];
      const migratedTargetWindow = {
        ...targetWindows[0],
        days_of_week: weekdays,
      };
      const weekdayWindow = {
        timezone: "Asia/Shanghai",
        days_of_week: weekdays,
        start_time: "14:00",
        end_time: "18:00",
      };
      await db.insertInto("billing_rule").values([
        {
          id: targetRuleId,
          enterprise_id: enterpriseId,
          provider_resource_id: resourceId,
          upstream_model: "glm-5.2",
          rule_type: "TIME_WINDOW",
          rule_version: "zhipu-peak-v2",
          effective_from: new Date("2026-01-01T00:00:00Z"),
          timezone: "Asia/Shanghai",
          days_of_week: JSON.stringify(allDays) as unknown as number[],
          start_time: "14:00:00",
          end_time: "18:00:00",
          time_windows: JSON.stringify(targetWindows) as unknown as typeof targetWindows,
          multiplier: "3",
        },
        {
          id: legacyTargetRuleId,
          enterprise_id: enterpriseId,
          provider_resource_id: resourceId,
          upstream_model: "5.2",
          rule_type: "TIME_WINDOW",
          rule_version: "zhipu-peak-v1",
          effective_from: new Date("2026-01-01T00:00:00Z"),
          timezone: "Asia/Shanghai",
          days_of_week: JSON.stringify(allDays) as unknown as number[],
          start_time: "14:00:00",
          end_time: "18:00:00",
          time_windows: JSON.stringify([targetWindows[0]]) as unknown as typeof targetWindows,
          multiplier: "3",
        },
        {
          id: existingWeekdayRuleId,
          enterprise_id: enterpriseId,
          provider_resource_id: resourceId,
          upstream_model: "glm-5.2",
          rule_type: "TIME_WINDOW",
          rule_version: "zhipu-peak-v2",
          effective_from: new Date("2026-01-01T00:00:00Z"),
          timezone: "Asia/Shanghai",
          days_of_week: JSON.stringify(weekdays) as unknown as number[],
          start_time: "14:00",
          end_time: "18:00",
          time_windows: JSON.stringify([weekdayWindow]) as unknown as typeof targetWindows,
          multiplier: "3",
        },
        {
          id: otherRuleId,
          enterprise_id: enterpriseId,
          provider_resource_id: otherResourceId,
          upstream_model: "glm-5.2",
          rule_type: "TIME_WINDOW",
          rule_version: "other-peak-v1",
          effective_from: new Date("2026-01-01T00:00:00Z"),
          timezone: "Asia/Shanghai",
          days_of_week: JSON.stringify(allDays) as unknown as number[],
          start_time: "14:00",
          end_time: "18:00",
          time_windows: JSON.stringify([targetWindows[0]]) as unknown as typeof targetWindows,
          multiplier: "3",
        },
      ]).execute();

      await db.insertInto("ai_request").values({
        id: requestId,
        enterprise_id: enterpriseId,
        principal_id: principalId,
        principal_key_id: keyId,
        protocol: "chat",
        unified_model: "qianliu-zhipu-glm-5-2",
        status: "SUCCEEDED",
      }).execute();
      await db.insertInto("upstream_attempt").values({
        id: attemptId,
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        attempt_no: 1,
        provider_resource_id: resourceId,
        upstream_model: "glm-5.2",
        response_committed: true,
      }).execute();
      await db.insertInto("usage_event").values({
        id: usageId,
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        upstream_attempt_id: attemptId,
        provider_resource_id: resourceId,
        input_tokens: 100n,
        output_tokens: 20n,
        cache_tokens: 0n,
        usage_quality: "PROVIDER_REPORTED",
        dedup_key: "pool046-usage",
      }).execute();
      const historicalSnapshot = {
        timezone: "Asia/Shanghai",
        days_of_week: allDays,
        start_time: "14:00",
        end_time: "18:00",
        multiplier: "3",
      };
      await db.insertInto("ledger_line").values({
        id: ledgerId,
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        usage_event_id: usageId,
        upstream_attempt_id: attemptId,
        provider_resource_id: resourceId,
        principal_id: principalId,
        resource_mode: "CODING_PLAN",
        raw_input_tokens: 100n,
        raw_output_tokens: 20n,
        raw_cache_tokens: 0n,
        deducted_quota: 360n,
        api_cost: null,
        usage_quality: "PROVIDER_REPORTED",
        billing_rule_id: targetRuleId,
        rule_version: "zhipu-peak-v2",
        multiplier: "3",
        billing_rule_snapshot: JSON.stringify(historicalSnapshot) as unknown as typeof historicalSnapshot,
      }).execute();

      const migrated = await migrator.migrateToLatest();
      expect(migrated.error).toBeUndefined();
      expect(migrated.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0045_zhipu_weekday_window_alias", "Success"],
        ["0046_directory_import_foundation", "Success"],
        ["0047_usage_bucket_aggregate", "Success"],
        ["0048_department_cost_budget_and_purchase", "Success"],
        ["0049_resource_utilization_and_procurement_review", "Success"],
        ["0050_group2_policy_lifecycle", "Success"],
        ["0051_pool20_operating_sync_and_closing_confirmation", "Success"],
        ["0052_dispatch_restore_and_resource_utilization", "Success"],
        ["0053_operating_bill_opening_balance", "Success"],
        ["0054_usage_aggregate_settlement_time", "Success"],
      ]);

      expect(await db.selectFrom("dispatch_policy")
        .select("match_unified_model").where("id", "=", policyId).executeTakeFirstOrThrow())
        .toEqual({ match_unified_model: "ql-glm-5.2" });
      expect(await db.selectFrom("dispatch_policy")
        .select("match_unified_model").where("id", "=", currentPolicyId).executeTakeFirstOrThrow())
        .toEqual({ match_unified_model: "ql-glm-5.2" });
      const migratedTarget = await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows", "updated_at"])
        .where("id", "=", targetRuleId).executeTakeFirstOrThrow();
      expect(migratedTarget.days_of_week).toEqual(weekdays);
      expect(migratedTarget.time_windows).toEqual([
        migratedTargetWindow,
        targetWindows[1],
      ]);
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", legacyTargetRuleId).executeTakeFirstOrThrow())
        .toEqual({ days_of_week: weekdays, time_windows: [migratedTargetWindow] });
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", existingWeekdayRuleId).executeTakeFirstOrThrow())
        .toEqual({ days_of_week: weekdays, time_windows: [weekdayWindow] });
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", otherRuleId).executeTakeFirstOrThrow())
        .toMatchObject({ days_of_week: allDays, time_windows: [targetWindows[0]] });
      expect(await db.selectFrom("ledger_line")
        .select(["deducted_quota", "billing_rule_snapshot"])
        .where("id", "=", ledgerId).executeTakeFirstOrThrow())
        .toEqual({ deducted_quota: "360", billing_rule_snapshot: historicalSnapshot });
      expect((await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM _migration_0045_pool046_backup
      `.execute(db)).rows[0]?.count).toBe("3");

      await pool046Migration.up(db);
      const afterSecondUp = await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows", "updated_at"])
        .where("id", "=", targetRuleId).executeTakeFirstOrThrow();
      expect(afterSecondUp).toEqual(migratedTarget);

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
      expect(await db.selectFrom("dispatch_policy")
        .select("match_unified_model").where("id", "=", policyId).executeTakeFirstOrThrow())
        .toEqual({ match_unified_model: "qianliu-zhipu-glm-5-2" });
      expect(await db.selectFrom("dispatch_policy")
        .select("match_unified_model").where("id", "=", currentPolicyId).executeTakeFirstOrThrow())
        .toEqual({ match_unified_model: "ql-glm-5.2" });
      const rolledBack = await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows", "updated_at"])
        .where("id", "=", targetRuleId).executeTakeFirstOrThrow();
      expect(rolledBack.days_of_week).toEqual(allDays);
      expect(rolledBack.time_windows).toEqual(targetWindows);
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", legacyTargetRuleId).executeTakeFirstOrThrow())
        .toEqual({ days_of_week: allDays, time_windows: [targetWindows[0]] });
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", existingWeekdayRuleId).executeTakeFirstOrThrow())
        .toEqual({ days_of_week: weekdays, time_windows: [weekdayWindow] });
      expect(await db.selectFrom("ledger_line")
        .select(["deducted_quota", "billing_rule_snapshot"])
        .where("id", "=", ledgerId).executeTakeFirstOrThrow())
        .toEqual({ deducted_quota: "360", billing_rule_snapshot: historicalSnapshot });
      expect((await sql<{ reg: string | null }>`
        SELECT to_regclass('_migration_0045_pool046_backup') AS reg
      `.execute(db)).rows[0]?.reg).toBeNull();

      await pool046Migration.down(db);
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows", "updated_at"])
        .where("id", "=", targetRuleId).executeTakeFirstOrThrow())
        .toEqual(rolledBack);

      const replayed = await migrator.migrateToLatest();
      expect(replayed.error).toBeUndefined();
      expect(replayed.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0045_zhipu_weekday_window_alias", "Success"],
        ["0046_directory_import_foundation", "Success"],
        ["0047_usage_bucket_aggregate", "Success"],
        ["0048_department_cost_budget_and_purchase", "Success"],
        ["0049_resource_utilization_and_procurement_review", "Success"],
        ["0050_group2_policy_lifecycle", "Success"],
        ["0051_pool20_operating_sync_and_closing_confirmation", "Success"],
        ["0052_dispatch_restore_and_resource_utilization", "Success"],
        ["0053_operating_bill_opening_balance", "Success"],
        ["0054_usage_aggregate_settlement_time", "Success"],
      ]);
      expect(await db.selectFrom("billing_rule")
        .select(["days_of_week", "time_windows"])
        .where("id", "=", targetRuleId).executeTakeFirstOrThrow())
        .toEqual({
          days_of_week: weekdays,
          time_windows: [
            migratedTargetWindow,
            targetWindows[1],
          ],
        });
    } finally {
      await db.destroy();
    }
  }, 120_000);
});
