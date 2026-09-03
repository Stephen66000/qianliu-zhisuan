import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import { UsageAggregateRepository } from "../repositories/usage-aggregate-repository.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("w20_final_migration");
}, 120_000);

afterAll(async () => {
  await pg?.stop();
}, 60_000);

describe("W20-10 0045 到 0051 升级、回退与读模型重建", () => {
  it("同一 1.0 数据可升级、重建派生聚合、允许条件下 down 并再次升级", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      expect((await migrator.migrateTo("0045_zhipu_weekday_window_alias")).error).toBeUndefined();

      const enterpriseId = randomUUID();
      const principalId = randomUUID();
      const keyId = randomUUID();
      const requestId = randomUUID();
      const providerId = randomUUID();
      const resourceId = randomUUID();
      const occurredAt = new Date("2026-08-12T01:25:00.000Z");

      await db.insertInto("enterprise").values({ id: enterpriseId, name: "W20 1.0 升级企业" }).execute();
      await db.insertInto("principal").values({
        id: principalId,
        enterprise_id: enterpriseId,
        type: "EMPLOYEE",
        name: "1.0 升级员工",
      }).execute();
      await db.insertInto("principal_key").values({
        id: keyId,
        enterprise_id: enterpriseId,
        principal_id: principalId,
        key_prefix: "w20-migration",
        key_digest: randomUUID(),
        allowed_model_ids: [],
      }).execute();
      await db.insertInto("provider").values({
        id: providerId,
        enterprise_id: enterpriseId,
        code: "w20-migration-provider",
        name: "W20 迁移资源",
        adapter_type: "openai",
      }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId,
        enterprise_id: enterpriseId,
        provider_id: providerId,
        name: "W20 API",
        mode: "API",
        credential_type: "API_KEY",
      }).execute();
      await db.insertInto("ai_request").values({
        id: requestId,
        enterprise_id: enterpriseId,
        principal_id: principalId,
        principal_key_id: keyId,
        protocol: "openai",
        unified_model: "ql-w20-migration",
        status: "SUCCEEDED",
        started_at: occurredAt,
        finished_at: new Date(occurredAt.getTime() + 500),
      }).execute();
      const attempt = await db.insertInto("upstream_attempt").values({
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        attempt_no: 1,
        provider_resource_id: resourceId,
        upstream_model: "w20-upstream",
        finished_at: new Date(occurredAt.getTime() + 500),
        http_status: 200,
        response_committed: true,
      }).returning("id").executeTakeFirstOrThrow();
      const usage = await db.insertInto("usage_event").values({
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        upstream_attempt_id: attempt.id,
        provider_resource_id: resourceId,
        input_tokens: 100n,
        output_tokens: 20n,
        cache_tokens: 50n,
        reasoning_tokens: 5n,
        usage_quality: "PROVIDER_REPORTED",
        dedup_key: `w20-migration-${requestId}`,
        created_at: occurredAt,
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("ledger_line").values({
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        usage_event_id: usage.id,
        upstream_attempt_id: attempt.id,
        provider_resource_id: resourceId,
        principal_id: principalId,
        resource_mode: "API",
        raw_input_tokens: 100n,
        raw_output_tokens: 20n,
        raw_cache_tokens: 50n,
        raw_reasoning_tokens: 5n,
        deducted_quota: 120n,
        api_cost: "1.25000000",
        usage_quality: "PROVIDER_REPORTED",
        created_at: occurredAt,
      }).execute();
      await db.insertInto("ledger_transaction").values({
        ai_request_id: requestId,
        enterprise_id: enterpriseId,
        principal_id: principalId,
        total_input_tokens: 100n,
        total_output_tokens: 20n,
        total_cache_tokens: 50n,
        total_reasoning_tokens: 5n,
        total_deducted_quota: 120n,
        total_api_cost: "1.25000000",
        usage_quality: "PROVIDER_REPORTED",
        attempt_count: 1,
        status: "SETTLED",
        created_at: occurredAt,
      }).execute();

      const before = await sql<{
        principal_name: string;
        request_count: string;
        ledger_count: string;
        actual_tokens: string;
        api_cost: string;
      }>`
        SELECT p.name AS principal_name,
               count(DISTINCT ar.id)::text AS request_count,
               count(DISTINCT ll.id)::text AS ledger_count,
               coalesce(sum(ll.raw_input_tokens + ll.raw_output_tokens), 0)::text AS actual_tokens,
               coalesce(sum(ll.api_cost), 0)::numeric(24,8)::text AS api_cost
          FROM principal p
          LEFT JOIN ai_request ar ON ar.principal_id = p.id
          LEFT JOIN ledger_line ll ON ll.ai_request_id = ar.id
         WHERE p.enterprise_id = ${enterpriseId}::uuid AND p.id = ${principalId}::uuid
         GROUP BY p.name
      `.execute(db);
      expect(before.rows[0]).toEqual({
        principal_name: "1.0 升级员工",
        request_count: "1",
        ledger_count: "1",
        actual_tokens: "120",
        api_cost: "1.25000000",
      });

      const upgraded = await migrator.migrateToLatest();
      expect(upgraded.error).toBeUndefined();
      expect(upgraded.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0046_directory_import_foundation", "Success"],
        ["0047_usage_bucket_aggregate", "Success"],
        ["0048_department_cost_budget_and_purchase", "Success"],
        ["0049_resource_utilization_and_procurement_review", "Success"],
        ["0050_group2_policy_lifecycle", "Success"],
        ["0051_pool20_operating_sync_and_closing_confirmation", "Success"],
        ["0052_dispatch_restore_and_resource_utilization", "Success"],
        ["0053_operating_bill_opening_balance", "Success"],
        ["0054_usage_aggregate_settlement_time", "Success"],
        ["0055_upstream_error_evidence", "Success"],
        ["0056_resource_monthly_budget", "Success"],
        ["0057_model_discovery_v12", "Success"],
        ["0058_principal_grant_archive", "Success"],
        ["0059_provider_finance_ledger", "Success"],
        ["0060_provider_finance_legacy_cost_resolution", "Success"],
        ["0061_provider_finance_audit_hardening", "Success"],
      ]);

      const aggregates = new UsageAggregateRepository(db);
      await aggregates.markRequestDirty(enterpriseId, requestId);
      const dirty = (await aggregates.listDirtyBuckets("HOUR"))
        .find((bucket) => bucket.enterpriseId === enterpriseId);
      expect(dirty).toBeDefined();
      await aggregates.rebuildBucket(dirty!);
      const firstAggregate = await db.selectFrom("usage_bucket_aggregate")
        .select([
          "request_count", "input_tokens", "output_tokens", "cache_tokens",
          "reasoning_tokens", "deducted_quota", "api_cost", "dirty",
        ])
        .where("enterprise_id", "=", enterpriseId)
        .executeTakeFirstOrThrow();
      expect(firstAggregate).toEqual({
        request_count: "1",
        input_tokens: "100",
        output_tokens: "20",
        cache_tokens: "50",
        reasoning_tokens: "5",
        deducted_quota: "120",
        api_cost: "1.25000000",
        dirty: false,
      });

      // 读模型丢失时只清理派生表；重建不改写 Ledger，结果与首次一致。
      await db.deleteFrom("usage_bucket_aggregate").where("enterprise_id", "=", enterpriseId).execute();
      await db.deleteFrom("usage_aggregate_bucket_state").where("enterprise_id", "=", enterpriseId).execute();
      await db.deleteFrom("usage_aggregate_dirty_bucket").where("enterprise_id", "=", enterpriseId).execute();
      await aggregates.markRequestDirty(enterpriseId, requestId);
      const rebuild = (await aggregates.listDirtyBuckets("HOUR"))
        .find((bucket) => bucket.enterpriseId === enterpriseId);
      expect(rebuild).toBeDefined();
      await aggregates.rebuildBucket(rebuild!);
      const rebuiltAggregate = await db.selectFrom("usage_bucket_aggregate")
        .select([
          "request_count", "input_tokens", "output_tokens", "cache_tokens",
          "reasoning_tokens", "deducted_quota", "api_cost", "dirty",
        ])
        .where("enterprise_id", "=", enterpriseId)
        .executeTakeFirstOrThrow();
      expect(rebuiltAggregate).toEqual(firstAggregate);

      const v52Indexes = await sql<{ restore_idx: string | null; ledger_idx: string | null }>`
        SELECT to_regclass('public.dispatch_policy_active_restore_unique_idx')::text AS restore_idx,
               to_regclass('public.ledger_line_resource_month_cover_idx')::text AS ledger_idx
      `.execute(db);
      expect(v52Indexes.rows[0]).toEqual({
        restore_idx: "dispatch_policy_active_restore_unique_idx",
        ledger_idx: "ledger_line_resource_month_cover_idx",
      });
      const qualityConstraint = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conname = 'usage_event_quality_check'
      `.execute(db);
      expect(qualityConstraint.rows[0]?.definition).toContain("MIXED");
      await db.updateTable("usage_event").set({ usage_quality: "MIXED" })
        .where("enterprise_id", "=", enterpriseId).execute();
      expect(await migrateDown(db)).toBe("0061_provider_finance_audit_hardening");
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      expect(await migrateDown(db)).toBe("0059_provider_finance_ledger");
      expect(await migrateDown(db)).toBe("0058_principal_grant_archive");
      expect(await migrateDown(db)).toBe("0057_model_discovery_v12");
      expect(await migrateDown(db)).toBe("0056_resource_monthly_budget");
      expect(await migrateDown(db)).toBe("0055_upstream_error_evidence");
      await expect(migrateDown(db)).rejects.toThrow(/0054 contains MIXED usage facts/);
      await db.updateTable("usage_event").set({ usage_quality: "PROVIDER_REPORTED" })
        .where("enterprise_id", "=", enterpriseId).execute();

      expect(await migrateDown(db)).toBe("0054_usage_aggregate_settlement_time");
      const rolledBackQualityConstraint = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conname = 'usage_event_quality_check'
      `.execute(db);
      expect(rolledBackQualityConstraint.rows[0]?.definition).not.toContain("MIXED");
      expect(await migrateDown(db)).toBe("0053_operating_bill_opening_balance");
      expect(await migrateDown(db)).toBe("0052_dispatch_restore_and_resource_utilization");
      const v52Removed = await sql<{ restore_idx: string | null; ledger_idx: string | null }>`
        SELECT to_regclass('public.dispatch_policy_active_restore_unique_idx')::text AS restore_idx,
               to_regclass('public.ledger_line_resource_month_cover_idx')::text AS ledger_idx
      `.execute(db);
      expect(v52Removed.rows[0]).toEqual({ restore_idx: null, ledger_idx: null });
      expect(await migrateDown(db)).toBe("0051_pool20_operating_sync_and_closing_confirmation");
      expect(await migrateDown(db)).toBe("0050_group2_policy_lifecycle");
      expect(await migrateDown(db)).toBe("0049_resource_utilization_and_procurement_review");
      expect(await migrateDown(db)).toBe("0048_department_cost_budget_and_purchase");
      expect(await migrateDown(db)).toBe("0047_usage_bucket_aggregate");
      expect(await migrateDown(db)).toBe("0046_directory_import_foundation");

      const afterDown = await sql<{
        principal_name: string;
        request_count: string;
        ledger_count: string;
        actual_tokens: string;
        api_cost: string;
      }>`
        SELECT p.name AS principal_name,
               count(DISTINCT ar.id)::text AS request_count,
               count(DISTINCT ll.id)::text AS ledger_count,
               coalesce(sum(ll.raw_input_tokens + ll.raw_output_tokens), 0)::text AS actual_tokens,
               coalesce(sum(ll.api_cost), 0)::numeric(24,8)::text AS api_cost
          FROM principal p
          LEFT JOIN ai_request ar ON ar.principal_id = p.id
          LEFT JOIN ledger_line ll ON ll.ai_request_id = ar.id
         WHERE p.enterprise_id = ${enterpriseId}::uuid AND p.id = ${principalId}::uuid
         GROUP BY p.name
      `.execute(db);
      expect(afterDown.rows[0]).toEqual(before.rows[0]);
      const removed = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.usage_bucket_aggregate') AS reg
      `.execute(db);
      expect(removed.rows[0]?.reg).toBeNull();

      const reupgraded = await migrator.migrateToLatest();
      expect(reupgraded.error).toBeUndefined();
      expect(reupgraded.results?.map((result) => [result.migrationName, result.status])).toEqual([
        ["0046_directory_import_foundation", "Success"],
        ["0047_usage_bucket_aggregate", "Success"],
        ["0048_department_cost_budget_and_purchase", "Success"],
        ["0049_resource_utilization_and_procurement_review", "Success"],
        ["0050_group2_policy_lifecycle", "Success"],
        ["0051_pool20_operating_sync_and_closing_confirmation", "Success"],
        ["0052_dispatch_restore_and_resource_utilization", "Success"],
        ["0053_operating_bill_opening_balance", "Success"],
        ["0054_usage_aggregate_settlement_time", "Success"],
        ["0055_upstream_error_evidence", "Success"],
        ["0056_resource_monthly_budget", "Success"],
        ["0057_model_discovery_v12", "Success"],
        ["0058_principal_grant_archive", "Success"],
        ["0059_provider_finance_ledger", "Success"],
        ["0060_provider_finance_legacy_cost_resolution", "Success"],
        ["0061_provider_finance_audit_hardening", "Success"],
      ]);
      const restored = await sql<{ reg: string | null }>`
        SELECT to_regclass('public.usage_bucket_aggregate') AS reg
      `.execute(db);
      expect(restored.rows[0]?.reg).toBe("usage_bucket_aggregate");
    } finally {
      await db.destroy();
    }
  }, 180_000);

  it("0053 已有期初余额事实时拒绝破坏性回退", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const enterpriseId = randomUUID();
      const adminId = randomUUID();
      const providerId = randomUUID();
      const resourceId = randomUUID();
      const periodId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "0053 回退保护企业" }).execute();
      await db.insertInto("admin_user").values({
        id: adminId, enterprise_id: enterpriseId, username: `rollback-${randomUUID()}`,
        password_hash: "unused",
      }).execute();
      await db.insertInto("provider").values({
        id: providerId, enterprise_id: enterpriseId, code: `rollback-${randomUUID().slice(0, 8)}`,
        name: "0053 回退保护厂商", adapter_type: "openai",
      }).execute();
      await db.insertInto("provider_resource").values({
        id: resourceId, enterprise_id: enterpriseId, provider_id: providerId,
        name: "0053 API", mode: "API", credential_type: "API_KEY",
      }).execute();
      await db.insertInto("operating_bill_period").values({
        id: periodId, enterprise_id: enterpriseId, period_month: "2026-06-01", created_by: adminId,
      }).execute();
      const otherEnterpriseId = randomUUID();
      const otherAdminId = randomUUID();
      const otherPeriodId = randomUUID();
      await db.insertInto("enterprise").values({
        id: otherEnterpriseId, name: "0053 隔离账期企业",
      }).execute();
      await db.insertInto("admin_user").values({
        id: otherAdminId, enterprise_id: otherEnterpriseId,
        username: `rollback-other-${randomUUID()}`, password_hash: "unused",
      }).execute();
      await db.insertInto("operating_bill_period").values({
        id: otherPeriodId, enterprise_id: otherEnterpriseId,
        period_month: "2026-06-01", created_by: adminId,
      }).execute();
      await expect(db.insertInto("operating_bill_opening_balance").values({
        enterprise_id: enterpriseId, period_id: otherPeriodId, provider_resource_id: resourceId,
        version: 1, amount: "1", currency: "CNY", source: "MANUAL",
        reason: "跨企业账期应失败", created_by: adminId,
      }).execute()).rejects.toMatchObject({
        constraint: "operating_bill_opening_balance_period_tenant_fk",
      });
      await expect(db.insertInto("operating_bill_opening_balance").values({
        enterprise_id: enterpriseId, period_id: periodId, provider_resource_id: resourceId,
        version: 1, amount: "1", currency: "CNY", source: "MANUAL",
        reason: "跨企业操作人应失败", created_by: otherAdminId,
      }).execute()).rejects.toMatchObject({
        constraint: "operating_bill_opening_balance_actor_tenant_fk",
      });
      await db.insertInto("operating_bill_opening_balance").values({
        enterprise_id: enterpriseId, period_id: periodId, provider_resource_id: resourceId,
        version: 1, amount: "100", currency: "CNY", source: "MANUAL",
        reason: "回退保护", created_by: adminId,
      }).execute();
      await expect(db.updateTable("operating_bill_opening_balance")
        .set({ reason: "禁止改写" }).where("provider_resource_id", "=", resourceId)
        .execute()).rejects.toThrow(/append-only/i);
      await expect(db.deleteFrom("operating_bill_opening_balance")
        .where("provider_resource_id", "=", resourceId).execute()).rejects.toThrow(/append-only/i);
      expect(await migrateDown(db)).toBe("0061_provider_finance_audit_hardening");
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      expect(await migrateDown(db)).toBe("0059_provider_finance_ledger");
      expect(await migrateDown(db)).toBe("0058_principal_grant_archive");
      expect(await migrateDown(db)).toBe("0057_model_discovery_v12");
      expect(await migrateDown(db)).toBe("0056_resource_monthly_budget");
      expect(await migrateDown(db)).toBe("0055_upstream_error_evidence");
      expect(await migrateDown(db)).toBe("0054_usage_aggregate_settlement_time");
      await expect(migrateDown(db)).rejects.toThrow(/0053 contains opening balance facts/);
      expect(await db.selectFrom("operating_bill_opening_balance").select("id")
        .where("provider_resource_id", "=", resourceId).executeTakeFirst()).toBeDefined();
    } finally {
      await db.destroy();
    }
  }, 120_000);
});
