import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  AdminWriteRepository,
  AlertEventRepository,
  createKysely,
  DashboardRepository,
  DispatchPolicyRepository,
  migrateDown,
  migrateToLatest,
  ProviderRepository,
  type Database,
} from "../index.js";

describe.sequential("POOL-010 厂商资源经营快照", () => {
  let pg: PostgresTestInstance;
  let db: Database;
  const enterpriseId = randomUUID();
  let resourceId: string;

  beforeAll(async () => {
    pg = await startPostgresContainer();
    db = createKysely(pg.connectionString);
    await migrateToLatest(db);
    await db.insertInto("enterprise").values({
      id: enterpriseId,
      name: "POOL-010 测试企业",
    }).execute();
  }, 120_000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (pg) await pg.stop();
  }, 60_000);

  it("厂商购买额度与主体 Grant 分列，既有未知值不伪造 0", async () => {
    const providerRepo = new ProviderRepository(db);
    const provider = await providerRepo.createProvider({
      enterprise_id: enterpriseId,
      code: "kimi",
      name: "Kimi",
      adapter_type: "kimi",
    });
    const collectedAt = new Date(Date.now() - 60_000);
    const resource = await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "Kimi 套餐",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
      operating_snapshot: {
        source: "ADMIN",
        collected_at: collectedAt,
        currency: "CNY",
        package_name: "团队版",
        package_cost: "299",
        total_quota: "100000",
        used_quota: "25000",
        remaining_quota: "75000",
        quota_unit: "TOKEN",
        reset_cycle: "MONTHLY",
        next_reset_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    resourceId = resource.id;

    const principal = await db.insertInto("principal").values({
      enterprise_id: enterpriseId,
      type: "EMPLOYEE",
      name: "额度较大的员工",
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("principal_grant").values({
      enterprise_id: enterpriseId,
      principal_id: principal.id,
      provider: "kimi",
      model_alias: "qianliu-kimi",
      quota_value: 220000n,
    }).execute();

    const dashboard = await new DashboardRepository(db).getSummary(enterpriseId);
    expect(dashboard.resourceBreakdown).toHaveLength(1);
    expect(dashboard.resourceBreakdown[0]).toMatchObject({
      totalQuota: "100000.00000000",
      usedQuota: "25000.00000000",
      remainingQuota: "75000.00000000",
      quotaUnit: "TOKEN",
      allocatedQuota: "220000",
    });

    const unknownProvider = await providerRepo.createProvider({
      enterprise_id: enterpriseId,
      code: "deepseek",
      name: "DeepSeek",
      adapter_type: "deepseek",
    });
    await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: unknownProvider.id,
      name: "未同步 API",
      mode: "API",
      credential_type: "API_KEY",
    });
    const unknown = (await new DashboardRepository(db).getSummary(enterpriseId))
      .resourceBreakdown.find((item) => item.providerCode === "deepseek");
    expect(unknown).toMatchObject({
      totalQuota: null,
      usedQuota: null,
      remainingQuota: null,
      currentBalance: null,
      rechargeAmount: null,
    });

    const syncedApi = await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "Kimi API 已同步",
      mode: "API",
      credential_type: "API_KEY",
      operating_snapshot: {
        source: "ADMIN",
        collected_at: new Date(),
        currency: "CNY",
        recharge_amount: "100",
        current_balance: "80",
        current_period_cost: "20",
      },
    });
    // 模拟升级前脏字段：API 快照即使残留额度列，聚合也必须只采用金额口径。
    await db
      .updateTable("provider_resource_operating_snapshot")
      .set({
        total_quota: "100",
        used_quota: "20",
        remaining_quota: "80",
        quota_unit: "TOKEN",
      })
      .where("provider_resource_id", "=", syncedApi.id)
      .execute();
    // 套餐快照即使残留 API 金额列，也不得污染首页余额/本期费用。
    await db
      .updateTable("provider_resource_operating_snapshot")
      .set({
        recharge_amount: "999",
        current_balance: "888",
        current_period_cost: "111",
      })
      .where("provider_resource_id", "=", resourceId)
      .where("version", "=", 1)
      .execute();
    await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "Kimi API 未同步",
      mode: "API",
      credential_type: "API_KEY",
    });
    const splitDashboard = await new DashboardRepository(db).getSummary(enterpriseId);
    const split = splitDashboard.resourceBreakdown
      .filter((item) => item.providerCode === "kimi");
    const plan = split.find((item) => item.mode === "CODING_PLAN");
    const api = split.find((item) => item.mode === "API");
    expect(plan?.allocatedQuota).toBe("220000");
    expect(plan).toMatchObject({
      currentBalance: null,
      currentPeriodCost: null,
      rechargeAmount: null,
    });
    expect(api).toMatchObject({
      totalQuota: null,
      usedQuota: null,
      remainingQuota: null,
      quotaUnit: null,
      allocatedQuota: null,
      rechargeAmount: null,
      currentBalance: null,
      currentPeriodCost: null,
    });
    expect(splitDashboard.monthlyRechargeAmount).toBeNull();
    expect(splitDashboard.monthlyPackagePayment).toBe("299.00000000");
  });

  it("API 预测按最新余额匹配，不把额度字段混入首页或调度比例", async () => {
    const providerRepo = new ProviderRepository(db);
    const provider = await providerRepo.createProvider({
      enterprise_id: enterpriseId,
      code: "api-forecast",
      name: "API 预测厂商",
      adapter_type: "deepseek",
    });
    const collectedAt = new Date(Date.now() - 2_000);
    const resource = await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "API 余额资源",
      mode: "API",
      credential_type: "API_KEY",
      operating_snapshot: {
        source: "PROVIDER_SYNC",
        collected_at: collectedAt,
        currency: "CNY",
        recharge_amount: "100",
        current_balance: "80",
        current_period_cost: "20",
      },
    });
    await db
      .updateTable("provider_resource_operating_snapshot")
      .set({
        total_quota: "100",
        used_quota: "20",
        remaining_quota: "80",
        quota_unit: "TOKEN",
      })
      .where("provider_resource_id", "=", resource.id)
      .execute();
    await db.insertInto("supply_forecast").values({
      enterprise_id: enterpriseId,
      provider_resource_id: resource.id,
      rate_24h: "40",
      forecast_exhaust_at: new Date(Date.now() + 60 * 60 * 1000),
      coverage_hours: "1",
      remaining_quota: "80",
      confidence: "HIGH",
      data_points: 100,
      algorithm_version: "pool010-api-balance",
      snapshot_at: new Date(collectedAt.getTime() + 1_000),
    }).execute();

    const dashboard = await new DashboardRepository(db).getSummary(enterpriseId);
    const api = dashboard.resourceBreakdown.find((item) => item.providerCode === "api-forecast");
    expect(api).toMatchObject({
      totalQuota: null,
      usedQuota: null,
      remainingQuota: null,
      quotaUnit: null,
      rechargeAmount: "100.00000000",
      currentBalance: "80.00000000",
      currentPeriodCost: "20.00000000",
      currentRate24h: "40",
    });

    const dispatch = await new DispatchPolicyRepository(db)
      .resolveResourceOperatingInput(enterpriseId, resource.id);
    expect(dispatch.remainingQuotaRatio).toBeNull();
    expect(dispatch.forecastExhaustRisk).toBe(true);

    const alerts = await new AlertEventRepository(db).evaluate(enterpriseId);
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        alertKey: `RESOURCE_UNAVAILABLE:exhaust:${resource.id}`,
      }),
    ]));
  });

  it("系统按当前重置周期汇总资源账本，并自动计算剩余与下一重置", async () => {
    const providerRepo = new ProviderRepository(db);
    const provider = await providerRepo.createProvider({
      enterprise_id: enterpriseId,
      code: "auto-quota",
      name: "自动额度厂商",
      adapter_type: "kimi",
    });
    const anchor = new Date("2026-07-01T00:00:00+08:00");
    const resource = await providerRepo.createResource({
      enterprise_id: enterpriseId,
      provider_id: provider.id,
      name: "自动统计套餐",
      mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION",
      operating_snapshot: {
        source: "ADMIN",
        collected_at: anchor,
        total_quota: "1000",
        quota_unit: "TOKEN",
        effective_from: anchor,
        reset_cycle: "MONTHLY",
        reset_anchor_at: anchor,
        reset_timezone: "Asia/Shanghai",
        usage_calculation: "SYSTEM_LEDGER",
      },
    });
    const principal = await db.insertInto("principal").values({
      enterprise_id: enterpriseId,
      type: "EMPLOYEE",
      name: "自动额度员工",
    }).returningAll().executeTakeFirstOrThrow();
    const key = await db.insertInto("principal_key").values({
      enterprise_id: enterpriseId,
      principal_id: principal.id,
      key_prefix: "sk-auto",
      key_digest: randomUUID(),
    }).returningAll().executeTakeFirstOrThrow();
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId,
      enterprise_id: enterpriseId,
      principal_id: principal.id,
      principal_key_id: key.id,
      protocol: "chat",
      unified_model: "auto-model",
      status: "SUCCEEDED",
      started_at: new Date("2026-07-10T08:00:00+08:00"),
      finished_at: new Date("2026-07-10T08:00:01+08:00"),
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId,
      enterprise_id: enterpriseId,
      attempt_no: 1,
      provider_resource_id: resource.id,
      upstream_model: "auto-model",
      started_at: new Date("2026-07-10T08:00:00+08:00"),
      finished_at: new Date("2026-07-10T08:00:01+08:00"),
      response_committed: true,
    }).returningAll().executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId,
      enterprise_id: enterpriseId,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resource.id,
      input_tokens: 100n,
      output_tokens: 25n,
      usage_quality: "PROVIDER_REPORTED",
      dedup_key: randomUUID(),
      created_at: new Date("2026-07-10T08:00:01+08:00"),
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId,
      enterprise_id: enterpriseId,
      usage_event_id: usage.id,
      upstream_attempt_id: attempt.id,
      provider_resource_id: resource.id,
      principal_id: principal.id,
      resource_mode: "CODING_PLAN",
      raw_input_tokens: 100n,
      raw_output_tokens: 25n,
      raw_cache_tokens: 0n,
      deducted_quota: 125n,
      usage_quality: "PROVIDER_REPORTED",
      created_at: new Date("2026-07-10T08:00:01+08:00"),
    }).execute();

    const current = (await providerRepo.listCurrentOperatingSnapshots(
      enterpriseId,
      new Date("2026-07-15T12:00:00+08:00"),
    )).find((snapshot) => snapshot.provider_resource_id === resource.id);
    expect(current).toMatchObject({
      total_quota: "1000.00000000",
      used_quota: "125.00000000",
      remaining_quota: "875.00000000",
      usage_calculation: "SYSTEM_LEDGER",
    });
    expect(current?.next_reset_at?.toISOString()).toBe("2026-07-31T16:00:00.000Z");

    const history = await providerRepo.listOperatingSnapshotHistory(
      enterpriseId,
      resource.id,
    );
    expect(history[0]).toMatchObject({ used_quota: null, remaining_quota: null });
  });

  it("编辑和周期重置只追加新快照，旧快照与历史预测不重算", async () => {
    const adminWriteRepo = new AdminWriteRepository(db);
    const before = await db.selectFrom("provider_resource")
      .selectAll().where("id", "=", resourceId).executeTakeFirstOrThrow();
    const resetCollectedAt = new Date();
    const updated = await adminWriteRepo.updateProviderResource(
      enterpriseId,
      resourceId,
      before.version,
      {
        operating_snapshot: {
          source: "PROVIDER_SYNC",
          collected_at: resetCollectedAt,
          currency: "CNY",
          package_name: "团队版",
          package_cost: "299",
          total_quota: "100000",
          used_quota: "0",
          remaining_quota: "100000",
          quota_unit: "TOKEN",
          reset_cycle: "MONTHLY",
          next_reset_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
        },
      },
    );
    expect(updated).not.toBeNull();

    const snapshots = await db.selectFrom("provider_resource_operating_snapshot")
      .selectAll()
      .where("provider_resource_id", "=", resourceId)
      .orderBy("version")
      .execute();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({
      version: 1,
      total_quota: "100000.00000000",
      used_quota: "25000.00000000",
      remaining_quota: "75000.00000000",
    });
    expect(snapshots[1]).toMatchObject({
      version: 2,
      used_quota: "0.00000000",
      remaining_quota: "100000.00000000",
    });

    // 旧预测快照保留，但早于当前经营快照，不能继续驱动当前调度风险。
    await db.insertInto("supply_forecast").values({
      enterprise_id: enterpriseId,
      provider_resource_id: resourceId,
      rate_24h: "10000",
      forecast_exhaust_at: new Date(Date.now() + 60 * 60 * 1000),
      coverage_hours: "1",
      remaining_quota: "75000",
      confidence: "HIGH",
      data_points: 100,
      not_calculable_reason: null,
      algorithm_version: "pool010-test",
      snapshot_at: new Date(resetCollectedAt.getTime() - 1000),
    }).execute();
    const dispatch = await new DispatchPolicyRepository(db)
      .resolveResourceOperatingInput(enterpriseId, resourceId);
    expect(dispatch.remainingQuotaRatio).toBe(1);
    expect(dispatch.forecastExhaustRisk).toBe(false);
  });

  it("0025～0029 可连续回滚并重新升级", async () => {
    let rolledBack: string | null;
    do {
      rolledBack = await migrateDown(db);
    } while (rolledBack !== null && !rolledBack.startsWith("0025_"));
    expect(rolledBack).toMatch(/^0025_/);
    const afterDown = await sql<{ table_name: string | null }>`
      SELECT to_regclass('provider_resource_operating_snapshot')::text AS table_name
    `.execute(db);
    expect(afterDown.rows[0]?.table_name).toBeNull();
    await migrateToLatest(db);
    const afterUp = await sql<{ table_name: string | null }>`
      SELECT to_regclass('provider_resource_operating_snapshot')::text AS table_name
    `.execute(db);
    expect(afterUp.rows[0]?.table_name).toBe("provider_resource_operating_snapshot");
  });
});
