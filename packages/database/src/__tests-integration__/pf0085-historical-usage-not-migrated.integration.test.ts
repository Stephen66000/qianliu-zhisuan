import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { createKysely } from "../kysely.js";
import { migrateDown, migrateToLatest } from "../migrator.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import type { Database } from "../kysely.js";
import { UsageOverviewRepository } from "../repositories/usage-overview-repository.js";
import { getStandardHomeSummary } from "../repositories/dashboard-home.js";
import { OperatingBillRepository } from "../repositories/operating-bill-repository.js";
import { insertLedgerTransaction } from "../repositories/gateway-ledger-settlement.js";

/**
 * 0085 定向迁移验证（加法 Schema、不可变 import_run、按模式金额约束与严格触发器）：
 *  - fresh DB 到 0085
 *  - 升级到 0085 后验证所有加法列与 CHECK 约束
 *  - 约束负例：NOT_MIGRATED 带金额被拒绝、非法 import_source 被拒绝、非法时间被拒绝
 *  - 严格触发器：
 *      * LEGACY_MAC_MINI + 有效 run + API + NOT_MIGRATED 允许通过；
 *      * LEGACY_MAC_MINI + 有效 run + CODING_PLAN + NOT_APPLICABLE (无 period) 允许通过；
 *      * 非导入请求禁止 NOT_MIGRATED；
 *      * 非导入 CODING_PLAN 仍强制要求 subscription_period。
 *  - down fail-closed：存在 NOT_MIGRATED、import_run 或 LEGACY_MAC_MINI 行时拒绝回滚（不伪造假零）
 */

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("pf_0085_historical_usage_not_migrated");
}, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

interface TestFixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  providerId: string;
  apiResourceId: string;
  planResourceId: string;
  runId: string;
}

type Executor = Kysely<Database> | Transaction<Database>;

async function seedFixture(db: Executor): Promise<TestFixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  const providerId = randomUUID();
  const apiResourceId = randomUUID();
  const planResourceId = randomUUID();
  const runId = randomUUID();

  await db.insertInto("enterprise").values({
    id: enterpriseId,
    name: `ent-0085-${randomUUID().slice(0, 8)}`,
  }).execute();

  await db.insertInto("admin_user").values({
    id: adminId,
    enterprise_id: enterpriseId,
    username: `admin-${randomUUID().slice(0, 8)}`,
    display_name: "Admin",
    password_hash: "hash",
    status: "ACTIVE",
  }).execute();

  await db.insertInto("principal").values({
    id: principalId,
    enterprise_id: enterpriseId,
    name: "Test Employee",
    type: "EMPLOYEE",
    status: "ACTIVE",
  }).execute();

  await db.insertInto("principal_key").values({
    id: keyId,
    enterprise_id: enterpriseId,
    principal_id: principalId,
    key_prefix: "ql_test_",
    key_digest: `digest_${randomUUID().replace(/-/g, "")}`,
    status: "ACTIVE",
  }).execute();

  await db.insertInto("provider").values({
    id: providerId,
    enterprise_id: enterpriseId,
    code: `prov-${randomUUID().slice(0, 8)}`,
    name: "Test Provider",
    adapter_type: "CUSTOM",
    status: "ACTIVE",
  }).execute();

  await db.insertInto("provider_resource").values({
    id: apiResourceId,
    enterprise_id: enterpriseId,
    provider_id: providerId,
    name: "API Resource",
    mode: "API",
    credential_type: "API_KEY",
    status: "ACTIVE",
  }).execute();

  await db.insertInto("provider_resource").values({
    id: planResourceId,
    enterprise_id: enterpriseId,
    provider_id: providerId,
    name: "Plan Resource",
    mode: "CODING_PLAN",
    credential_type: "API_KEY",
    status: "ACTIVE",
  }).execute();

  // 创建合法 historical_import_run
  await db.insertInto("historical_import_run").values({
    id: runId,
    enterprise_id: enterpriseId,
    manifest_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    source_package_hash: "0000000000000000000000000000000000000000000000000000000000000000",
    source_system: "LEGACY_MAC_MINI",
    window_start: new Date("2026-08-01T00:00:00+08:00"),
    window_end: new Date("2026-09-21T11:30:06.052+08:00"),
    total_requests: 29318,
    request_id_digest: "110d7086c355bd8e33cfa14f943d6e39",
    input_tokens: 2047346862n,
    output_tokens: 19647078n,
    cache_tokens: 1968679811n,
    reasoning_tokens: 11941273n,
    status: "RUNNING",
    baseline_summary: {
      totalRequests: 29318,
      attempts: 25996,
      usageEvents: 25811,
      ledgerLines: 25811,
      ledgerTransactions: 25984,
      routeCandidates: 26125,
      dispatchDecisions: 26182,
      attributionSnapshots: 25879,
      tokens: {
        input: "2047346862",
        output: "19647078",
        cache: "1968679811",
        reasoning: "11941273",
      },
      requestIdDigest: "110d7086c355bd8e33cfa14f943d6e39",
    },
  }).execute();

  // 激活严格财务写入触发器
  await sql`
    INSERT INTO provider_finance_runtime_state (
      enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at
    )
    VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
    ON CONFLICT (enterprise_id) DO UPDATE SET strict_writes_enabled = true;
  `.execute(db);

  return {
    enterpriseId,
    adminId,
    principalId,
    keyId,
    providerId,
    apiResourceId,
    planResourceId,
    runId,
  };
}

describe("Migration 0085: Historical Usage NOT_MIGRATED and Import Run", () => {
  it("migrates from clean database to 0085 and verifies additive columns and constraints", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const applied = await migrateToLatest(db);
      expect(applied).toContain("0085_historical_usage_not_migrated");

      const f = await seedFixture(db);

      // 验证 ai_request 加法列：合法的 import_source 与 import_run_id
      const reqId = randomUUID();
      await db.insertInto("ai_request").values({
        id: reqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-08-15T10:00:00Z"),
        import_source: "LEGACY_MAC_MINI",
        import_run_id: f.runId,
      }).execute();

      // 负例：非法 import_source
      await expect(
        db.insertInto("ai_request").values({
          id: randomUUID(),
          enterprise_id: f.enterpriseId,
          principal_id: f.principalId,
          principal_key_id: f.keyId,
          protocol: "chat",
          unified_model: "test-model",
          status: "SUCCEEDED",
          started_at: new Date("2026-08-15T10:00:00Z"),
          import_source: "INVALID_SOURCE" as unknown as "LEGACY_MAC_MINI",
          import_run_id: f.runId,
        }).execute()
      ).rejects.toThrow(/ai_request_import_source_check/);
    } finally {
      await db.destroy();
    }
  });

  it("enforces shape constraints for NOT_MIGRATED on API and NOT_APPLICABLE on CODING_PLAN", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const f = await seedFixture(db);
      const reqId = randomUUID();
      const attemptId = randomUUID();
      const usageId = randomUUID();
      const lineId = randomUUID();
      const txId = randomUUID();

      await db.insertInto("ai_request").values({
        id: reqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-08-15T10:00:00Z"),
        import_source: "LEGACY_MAC_MINI",
        import_run_id: f.runId,
      }).execute();

      await db.insertInto("upstream_attempt").values({
        id: attemptId,
        ai_request_id: reqId,
        enterprise_id: f.enterpriseId,
        attempt_no: 1,
        provider_resource_id: f.apiResourceId,
        upstream_model: "test-model",
      }).execute();

      await db.insertInto("usage_event").values({
        id: usageId,
        ai_request_id: reqId,
        enterprise_id: f.enterpriseId,
        upstream_attempt_id: attemptId,
        provider_resource_id: f.apiResourceId,
        input_tokens: 100n,
        output_tokens: 50n,
        cache_tokens: 0n,
        usage_quality: "PROVIDER_REPORTED",
        dedup_key: `dedup-${randomUUID()}`,
      }).execute();

      // 负例 1：API 模式 NOT_MIGRATED 但带有 api_cost (违背 shape 约束)
      await expect(
        db.insertInto("ledger_line").values({
          id: lineId,
          ai_request_id: reqId,
          enterprise_id: f.enterpriseId,
          usage_event_id: usageId,
          upstream_attempt_id: attemptId,
          provider_resource_id: f.apiResourceId,
          principal_id: f.principalId,
          resource_mode: "API",
          raw_input_tokens: 100n,
          raw_output_tokens: 50n,
          raw_cache_tokens: 0n,
          api_cost: "0.01", // 非 NULL
          api_cost_status: "NOT_MIGRATED",
          usage_quality: "PROVIDER_REPORTED",
          settled_at: new Date("2026-08-15T10:00:01Z"),
        }).execute()
      ).rejects.toThrow(/NOT_MIGRATED ledger line must have NULL api_cost|ledger_line_api_cost_fact_shape_check/);

      // 正例 1：API 模式 NOT_MIGRATED 严格 api_cost IS NULL 且 api_cost_currency IS NULL
      await db.insertInto("ledger_line").values({
        id: lineId,
        ai_request_id: reqId,
        enterprise_id: f.enterpriseId,
        usage_event_id: usageId,
        upstream_attempt_id: attemptId,
        provider_resource_id: f.apiResourceId,
        principal_id: f.principalId,
        resource_mode: "API",
        raw_input_tokens: 100n,
        raw_output_tokens: 50n,
        raw_cache_tokens: 0n,
        api_cost: null,
        api_cost_currency: null,
        api_cost_status: "NOT_MIGRATED",
        usage_quality: "PROVIDER_REPORTED",
        settled_at: new Date("2026-08-15T10:00:01Z"),
        created_at: new Date("2026-08-15T10:00:01Z"),
      }).execute();

      // 正例 2：ledger_transaction 为 NOT_MIGRATED 且 total_api_cost IS NULL
      await db.insertInto("ledger_transaction").values({
        id: txId,
        ai_request_id: reqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        total_input_tokens: 100n,
        total_output_tokens: 50n,
        total_cache_tokens: 0n,
        total_deducted_quota: 0n,
        total_api_cost: null,
        api_cost_status: "NOT_MIGRATED",
        usage_quality: "PROVIDER_REPORTED",
        status: "SETTLED",
        created_at: new Date("2026-08-15T10:00:01Z"),
      }).execute();

      // Regression: the homepage reads employee rankings even when their fee is null.
      // Unknown historical fees retain their status and never become a zero charge.
      const anchor = new Date("2026-08-20T10:00:00Z");
      const overview = await new UsageOverviewRepository(db).getOverview({
        enterpriseId: f.enterpriseId, subjectType: "EMPLOYEE", period: "MONTH", anchor,
      });
      expect(overview.metrics).toMatchObject({ realTokens: "150", apiCost: null, apiCostStatus: "NOT_MIGRATED" });
      expect(overview.ranking[0]).toMatchObject({ realTokens: "150", apiCost: null, apiCostStatus: "NOT_MIGRATED" });
      expect(overview.trend.some(point => point.apiCostStatus === "NOT_MIGRATED" && point.apiCost === null)).toBe(true);
      const bill = await new OperatingBillRepository(db).getBill(f.enterpriseId, "2026-08");
      const home = await getStandardHomeSummary(db, { enterpriseId: f.enterpriseId, asOf: anchor, bill, financeRead: false });
      expect(home.activeEmployees.current).toBe(1);
      expect(home.tokenUsage.current.totalTokens).toBe("150");

      // 正例 3：Coding Plan 历史行：NOT_APPLICABLE + NULL period 通过严格触发器
      const planReqId = randomUUID();
      const planAttemptId = randomUUID();
      const planUsageId = randomUUID();
      const planLineId = randomUUID();

      await db.insertInto("ai_request").values({
        id: planReqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-08-16T10:00:00Z"),
        import_source: "LEGACY_MAC_MINI",
        import_run_id: f.runId,
      }).execute();

      await db.insertInto("upstream_attempt").values({
        id: planAttemptId,
        ai_request_id: planReqId,
        enterprise_id: f.enterpriseId,
        attempt_no: 1,
        provider_resource_id: f.planResourceId,
        upstream_model: "test-model",
      }).execute();

      await db.insertInto("usage_event").values({
        id: planUsageId,
        ai_request_id: planReqId,
        enterprise_id: f.enterpriseId,
        upstream_attempt_id: planAttemptId,
        provider_resource_id: f.planResourceId,
        input_tokens: 200n,
        output_tokens: 100n,
        cache_tokens: 0n,
        usage_quality: "PROVIDER_REPORTED",
        dedup_key: `dedup-${randomUUID()}`,
      }).execute();

      await db.insertInto("ledger_line").values({
        id: planLineId,
        ai_request_id: planReqId,
        enterprise_id: f.enterpriseId,
        usage_event_id: planUsageId,
        upstream_attempt_id: planAttemptId,
        provider_resource_id: f.planResourceId,
        principal_id: f.principalId,
        resource_mode: "CODING_PLAN",
        raw_input_tokens: 200n,
        raw_output_tokens: 100n,
        raw_cache_tokens: 0n,
        deducted_quota: 10n,
        api_cost: null,
        api_cost_currency: null,
        api_cost_status: "NOT_APPLICABLE",
        subscription_period_id: null, // 历史无 period 允许通过
        usage_quality: "PROVIDER_REPORTED",
        settled_at: new Date("2026-08-16T10:00:01Z"),
      }).execute();

      // 负例 3：普通运行时 Coding Plan 缺失 period 被严格拦截
      const normalReqId = randomUUID();
      const normalAttemptId = randomUUID();
      const normalUsageId = randomUUID();
      const normalLineId = randomUUID();

      await db.insertInto("ai_request").values({
        id: normalReqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-09-22T10:00:00Z"), // 运行时时间
        // 非导入请求
      }).execute();

      await db.insertInto("upstream_attempt").values({
        id: normalAttemptId,
        ai_request_id: normalReqId,
        enterprise_id: f.enterpriseId,
        attempt_no: 1,
        provider_resource_id: f.planResourceId,
        upstream_model: "test-model",
      }).execute();

      await db.insertInto("usage_event").values({
        id: normalUsageId,
        ai_request_id: normalReqId,
        enterprise_id: f.enterpriseId,
        upstream_attempt_id: normalAttemptId,
        provider_resource_id: f.planResourceId,
        input_tokens: 200n,
        output_tokens: 100n,
        cache_tokens: 0n,
        usage_quality: "PROVIDER_REPORTED",
        dedup_key: `dedup-${randomUUID()}`,
      }).execute();

      await expect(
        db.insertInto("ledger_line").values({
          id: normalLineId,
          ai_request_id: normalReqId,
          enterprise_id: f.enterpriseId,
          usage_event_id: normalUsageId,
          upstream_attempt_id: normalAttemptId,
          provider_resource_id: f.planResourceId,
          principal_id: f.principalId,
          resource_mode: "CODING_PLAN",
          raw_input_tokens: 200n,
          raw_output_tokens: 100n,
          raw_cache_tokens: 0n,
          deducted_quota: 10n,
          api_cost: null,
          api_cost_currency: null,
          api_cost_status: "NOT_APPLICABLE",
          subscription_period_id: null, // 非导入必须有 period
          usage_quality: "PROVIDER_REPORTED",
          settled_at: new Date("2026-09-22T10:00:01Z"),
        }).execute()
      ).rejects.toThrow(/active Coding Plan ledger line requires an attributed period/);

      // 正例 4（20260930 演练发现）：旧运行时 line 级 UNKNOWN_COST 但事务级 total_api_cost=0 占位的
      // 历史事实必须被 0085 约束接受（迁移绝不改写既有金额），状态保持 UNKNOWN_COST。
      const legacyUnknownReqId = randomUUID();
      const legacyUnknownAttemptId = randomUUID();
      const legacyUnknownUsageId = randomUUID();
      const legacyUnknownLineId = randomUUID();
      const legacyUnknownTxId = randomUUID();

      await db.insertInto("ai_request").values({
        id: legacyUnknownReqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-09-22T11:00:00Z"),
      }).execute();
      await db.insertInto("upstream_attempt").values({
        id: legacyUnknownAttemptId,
        ai_request_id: legacyUnknownReqId,
        enterprise_id: f.enterpriseId,
        attempt_no: 1,
        provider_resource_id: f.apiResourceId,
        upstream_model: "test-model",
      }).execute();
      await db.insertInto("usage_event").values({
        id: legacyUnknownUsageId,
        ai_request_id: legacyUnknownReqId,
        enterprise_id: f.enterpriseId,
        upstream_attempt_id: legacyUnknownAttemptId,
        provider_resource_id: f.apiResourceId,
        input_tokens: 10n,
        output_tokens: 5n,
        cache_tokens: 0n,
        usage_quality: "UNKNOWN",
        dedup_key: `dedup-${randomUUID()}`,
      }).execute();
      await db.insertInto("ledger_line").values({
        id: legacyUnknownLineId,
        ai_request_id: legacyUnknownReqId,
        enterprise_id: f.enterpriseId,
        usage_event_id: legacyUnknownUsageId,
        upstream_attempt_id: legacyUnknownAttemptId,
        provider_resource_id: f.apiResourceId,
        principal_id: f.principalId,
        resource_mode: "API",
        raw_input_tokens: 10n,
        raw_output_tokens: 5n,
        raw_cache_tokens: 0n,
        api_cost: null,
        api_cost_currency: null,
        api_cost_status: "UNKNOWN_COST",
        usage_quality: "UNKNOWN",
        settled_at: new Date("2026-09-22T11:00:01Z"),
      }).execute();
      // 正例：UNKNOWN_COST + 0.00000000 旧占位（4 条真实生产事实的形状）
      await db.insertInto("ledger_transaction").values({
        id: legacyUnknownTxId,
        ai_request_id: legacyUnknownReqId,
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        total_input_tokens: 10n,
        total_output_tokens: 5n,
        total_cache_tokens: 0n,
        total_deducted_quota: 0n,
        total_api_cost: "0.00000000",
        api_cost_status: "UNKNOWN_COST",
        usage_quality: "UNKNOWN",
        status: "SETTLED",
      }).execute();
      // 负例 4：UNKNOWN_COST + 非零金额仍被拒绝（不允许伪装未知金额）
      await expect(
        db.insertInto("ledger_transaction").values({
          id: randomUUID(),
          ai_request_id: legacyUnknownReqId,
          enterprise_id: f.enterpriseId,
          principal_id: f.principalId,
          total_input_tokens: 10n,
          total_output_tokens: 5n,
          total_cache_tokens: 0n,
          total_deducted_quota: 0n,
          total_api_cost: "1.23",
          api_cost_status: "UNKNOWN_COST",
          usage_quality: "UNKNOWN",
          status: "SETTLED",
        }).execute()
      ).rejects.toThrow(/ledger_transaction_api_cost_shape_check/);
    } finally {
      await db.destroy();
    }
  });

  it("runtime settlement writes the required status and preserves priced, unknown and plan facts after 0085", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const f = await seedFixture(db);
      const cases = [
        { mode: "API" as const, lineStatus: "PRICED_USAGE" as const, lineCost: "1.25000000", totalCost: "1.25000000", historical: false },
        { mode: "API" as const, lineStatus: "UNKNOWN_COST" as const, lineCost: null, totalCost: "0.00000000", historical: false },
        { mode: "CODING_PLAN" as const, lineStatus: "NOT_APPLICABLE" as const, lineCost: null, totalCost: "0.00000000", historical: true },
      ];
      for (const item of cases) {
        const requestId = randomUUID();
        const attemptId = randomUUID();
        const usageId = randomUUID();
        const at = new Date(item.historical ? "2026-08-16T10:00:00Z" : "2026-10-01T01:00:00Z");
        const resourceId = item.mode === "API" ? f.apiResourceId : f.planResourceId;
        await db.insertInto("ai_request").values({
          id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
          principal_key_id: f.keyId, protocol: "chat", unified_model: "runtime-compatibility",
          status: "SUCCEEDED", started_at: at,
          ...(item.historical ? { import_source: "LEGACY_MAC_MINI" as const, import_run_id: f.runId } : {}),
        }).execute();
        await db.insertInto("upstream_attempt").values({
          id: attemptId, ai_request_id: requestId, enterprise_id: f.enterpriseId,
          attempt_no: 1, provider_resource_id: resourceId, upstream_model: "runtime-compatibility",
        }).execute();
        await db.insertInto("usage_event").values({
          id: usageId, ai_request_id: requestId, enterprise_id: f.enterpriseId,
          upstream_attempt_id: attemptId, provider_resource_id: resourceId,
          input_tokens: 100n, output_tokens: 50n, cache_tokens: 0n,
          usage_quality: "PROVIDER_REPORTED", dedup_key: `runtime-compatibility-${requestId}`,
        }).execute();
        await db.insertInto("ledger_line").values({
          ai_request_id: requestId, enterprise_id: f.enterpriseId,
          usage_event_id: usageId, upstream_attempt_id: attemptId,
          provider_resource_id: resourceId, principal_id: f.principalId,
          resource_mode: item.mode, raw_input_tokens: 100n, raw_output_tokens: 50n,
          raw_cache_tokens: 0n, deducted_quota: 0n,
          api_cost: item.lineCost, api_cost_currency: item.lineCost === null ? null : "CNY",
          api_cost_status: item.lineStatus, usage_quality: "PROVIDER_REPORTED", settled_at: at,
        }).execute();
        const transaction = await insertLedgerTransaction(db, {
          ai_request_id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
          total_input_tokens: 100n, total_output_tokens: 50n, total_cache_tokens: 0n,
          total_deducted_quota: 0n, total_api_cost: item.totalCost,
          usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
        });
        expect(transaction.api_cost_status).toBe(item.lineStatus);
        expect(transaction.total_api_cost).toBe(item.totalCost);
      }
      const overview = await new UsageOverviewRepository(db).getOverview({
        enterpriseId: f.enterpriseId, subjectType: "EMPLOYEE", period: "TODAY", anchor: new Date(),
      });
      expect(overview.metrics).toMatchObject({ realTokens: "450", apiCost: null, apiCostStatus: "UNKNOWN_COST" });
      expect(overview.ranking[0]?.apiCost).toBeNull();
    } finally { await db.destroy(); }
  });

  it("fails closed on down migration when historical NOT_MIGRATED rows exist", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const f = await seedFixture(db);
      await db.insertInto("ai_request").values({
        id: randomUUID(),
        enterprise_id: f.enterpriseId,
        principal_id: f.principalId,
        principal_key_id: f.keyId,
        protocol: "chat",
        unified_model: "test-model",
        status: "SUCCEEDED",
        started_at: new Date("2026-08-15T10:00:00Z"),
        import_source: "LEGACY_MAC_MINI",
        import_run_id: f.runId,
      }).execute();

      // 此时数据库已包含历史行与 import_run，必须触发 fail-closed 阻断回退！
      await expect(migrateDown(db)).rejects.toThrow(
        /0085 rollback blocked: historical imported rows or NOT_MIGRATED rows exist/
      );
    } finally {
      await db.destroy();
    }
  });

  it("enforces strict immutability and controlled state machine on historical_import_run and run items", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const f = await seedFixture(db);

      // 1. 尝试修改 historical_import_run 的基线/身份字段 -> 阻断
      await expect(
        db.updateTable("historical_import_run")
          .set({ total_requests: 999 })
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/Baseline, identity, and pre-snapshots of historical_import_run cannot be modified/);

      // 2. 尝试删除 historical_import_run -> 阻断
      await expect(
        db.deleteFrom("historical_import_run")
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/historical_import_run records cannot be deleted/);

      // 3. 插入 run_item
      const itemId = randomUUID();
      await db.insertInto("historical_import_run_item").values({
        id: itemId,
        run_id: f.runId,
        enterprise_id: f.enterpriseId,
        entity_type: "ai_request",
        entity_id: "req-test-1",
        canonical_digest: "digest-test-1",
      }).execute();

      // 4. 尝试 UPDATE run_item -> 严格抛错
      await expect(
        db.updateTable("historical_import_run_item")
          .set({ canonical_digest: "tampered" })
          .where("id", "=", itemId)
          .execute()
      ).rejects.toThrow(/historical_import_run_item is append-only and strictly immutable: UPDATE is forbidden/);

      // 5. 尝试 DELETE run_item -> 严格抛错
      await expect(
        db.deleteFrom("historical_import_run_item")
          .where("id", "=", itemId)
          .execute()
      ).rejects.toThrow(/historical_import_run_item is append-only and strictly immutable: DELETE is forbidden/);

      // 6. 状态机流转：RUNNING -> COMPLETED (必须带 completed_at)
      await expect(
        db.updateTable("historical_import_run")
          .set({ status: "COMPLETED" })
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/completed_at must be set when transitioning historical_import_run to COMPLETED/);

      await db.updateTable("historical_import_run")
        .set({ status: "COMPLETED", completed_at: new Date() })
        .where("id", "=", f.runId)
        .execute();

      // 7. COMPLETED 状态下修改 completed_at 或快照 -> 阻断
      await expect(
        db.updateTable("historical_import_run")
          .set({ status: "RUNNING" })
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/COMPLETED historical_import_run can only transition to ROLLED_BACK/);

      // 8. COMPLETED -> ROLLED_BACK (必须带 rolled_back_at)
      await expect(
        db.updateTable("historical_import_run")
          .set({ status: "ROLLED_BACK" })
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/rolled_back_at must be set when transitioning historical_import_run to ROLLED_BACK/);

      await db.updateTable("historical_import_run")
        .set({
          status: "ROLLED_BACK",
          rolled_back_at: new Date(),
          rollback_summary: { reason: "test rollback" },
        })
        .where("id", "=", f.runId)
        .execute();

      // 9. 终态 ROLLED_BACK 严禁再次修改
      await expect(
        db.updateTable("historical_import_run")
          .set({ status: "COMPLETED" })
          .where("id", "=", f.runId)
          .execute()
      ).rejects.toThrow(/Terminal state ROLLED_BACK of historical_import_run is strictly immutable/);
    } finally {
      await db.destroy();
    }
  });
});
