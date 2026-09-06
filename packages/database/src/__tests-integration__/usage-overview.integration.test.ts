import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createKysely } from "../kysely.js";
import { migrateToLatest } from "../migrator.js";
import {
  UsageOverviewRepository,
  UsageOverviewSubjectNotFoundError,
} from "../repositories/usage-overview-repository.js";
import { UsageAggregateRepository } from "../repositories/usage-aggregate-repository.js";
import { UsageRepository } from "../repositories/usage-repository.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

function withoutCollectionStatus<T extends { collectionStatus: string }>(items: T[]) {
  return items.map(({ collectionStatus: _collectionStatus, ...item }) => item);
}

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const employeeOneId = randomUUID();
const employeeTwoId = randomUUID();
const projectId = randomUUID();
const attributionProjectId = randomUUID();
const emptyProjectId = randomUUID();
const adminId = randomUUID();
const dstEnterpriseId = randomUUID();
const dstEmployeeId = randomUUID();
const monthBoundaryEnterpriseId = randomUUID();
const monthBoundaryEmployeeId = randomUUID();

const monday = new Date("2026-08-09T16:00:00.000Z"); // 上海周一 00:00
const tuesday = new Date("2026-08-11T01:00:00.000Z");
const wednesday = new Date("2026-08-12T03:00:00.000Z");

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_usage_overview_test");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "周期用量企业", timezone: "Asia/Shanghai" },
    { id: otherEnterpriseId, name: "隔离企业", timezone: "Asia/Shanghai" },
    { id: dstEnterpriseId, name: "DST 企业", timezone: "America/New_York" },
    { id: monthBoundaryEnterpriseId, name: "上海月界企业", timezone: "Asia/Shanghai" },
  ]).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "usage-admin", password_hash: "test",
  }).execute();
  await db.insertInto("principal").values([
    { id: employeeOneId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "甲员工", department_label: "研发" },
    { id: employeeTwoId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "乙员工", department_label: "产品" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "甲项目", department_label: "研发" },
    { id: attributionProjectId, enterprise_id: enterpriseId, type: "PROJECT", name: "归集项目", department_label: "产品" },
    { id: emptyProjectId, enterprise_id: enterpriseId, type: "PROJECT", name: "空项目", department_label: "市场" },
  ]).execute();
  const otherEmployeeId = randomUUID();
  await db.insertInto("principal").values({
    id: otherEmployeeId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "隔离员工",
  }).execute();
  await db.insertInto("principal").values({
    id: dstEmployeeId, enterprise_id: dstEnterpriseId, type: "EMPLOYEE", name: "DST 员工",
  }).execute();
  await db.insertInto("principal").values({
    id: monthBoundaryEmployeeId,
    enterprise_id: monthBoundaryEnterpriseId,
    type: "EMPLOYEE",
    name: "月界员工",
  }).execute();

  await seedRequest(employeeOneId, monday, 100n, 20n, 50n, 5n, 120n, "1.25000000");
  const assignedRequestId = await seedRequest(
    employeeTwoId, tuesday, 200n, 30n, 80n, 7n, 230n, "0",
    enterpriseId, "SETTLED", "MIXED:PROVIDER_REPORTED+UNKNOWN",
  );
  await seedRequest(projectId, wednesday, 300n, 40n, 90n, 9n, 340n, "2.00000000");
  await seedRequest(employeeOneId, new Date("2026-08-09T15:59:59.999Z"), 999n, 1n, 0n, 0n, 1_000n, "9");
  await seedRequest(employeeOneId, new Date("2026-08-16T16:00:00.000Z"), 999n, 1n, 0n, 0n, 1_000n, "9");
  await seedRequest(otherEmployeeId, tuesday, 999n, 1n, 0n, 0n, 1_000n, "9", otherEnterpriseId);
  await seedRequest(employeeOneId, new Date("2026-08-13T03:00:00.000Z"), 777n, 7n, 0n, 0n, 784n, "7", enterpriseId, "PENDING");
  await seedRequest(dstEmployeeId, new Date("2026-03-01T05:00:00.000Z"), 10n, 1n, 0n, 0n, 11n, "0.1", dstEnterpriseId);
  await seedRequest(dstEmployeeId, new Date("2026-03-08T06:30:00.000Z"), 20n, 2n, 0n, 0n, 22n, "0.2", dstEnterpriseId);
  await seedRequest(dstEmployeeId, new Date("2026-03-08T07:30:00.000Z"), 30n, 3n, 0n, 0n, 33n, "0.3", dstEnterpriseId);
  await seedRequest(dstEmployeeId, new Date("2026-04-01T04:00:00.000Z"), 999n, 1n, 0n, 0n, 1_000n, "9", dstEnterpriseId);
  await seedRequest(monthBoundaryEmployeeId, new Date("2026-08-31T15:59:59.999Z"), 40n, 2n, 30n, 1n, 42n, "0", monthBoundaryEnterpriseId);
  await seedRequest(monthBoundaryEmployeeId, new Date("2026-08-31T16:00:00.000Z"), 50n, 3n, 20n, 2n, 53n, "0", monthBoundaryEnterpriseId, "SETTLED", "MIXED:PROVIDER_REPORTED+ESTIMATED", new Date("2026-08-31T15:59:00.000Z"));
  await db.insertInto("operating_bill_request_project_assignment").values({
    enterprise_id: enterpriseId,
    ai_request_id: assignedRequestId,
    project_principal_id: projectId,
    assigned_by: adminId,
  }).execute();
  await db.insertInto("request_attribution_snapshot").values({
    enterprise_id: enterpriseId,
    ai_request_id: assignedRequestId,
    source_principal_id: employeeTwoId,
    project_principal_id: attributionProjectId,
    cost_category: "PROJECT",
    attribution_source: "EMPLOYEE_PROJECT",
    request_occurred_at: tuesday,
    version: 1,
    snapshot_origin: "RUNTIME",
  }).execute();
}, 120_000);

afterAll(async () => {
  if (db) await db.destroy();
  if (pg) await pg.stop();
}, 60_000);

async function seedRequest(
  principalId: string,
  at: Date,
  input: bigint,
  output: bigint,
  cache: bigint,
  reasoning: bigint,
  deducted: bigint,
  cost: string,
  entId = enterpriseId,
  ledgerStatus = "SETTLED",
  usageQuality = "PROVIDER_REPORTED",
  startedAt = at,
): Promise<string> {
  let key = await db.selectFrom("principal_key")
    .select("id")
    .where("enterprise_id", "=", entId)
    .where("principal_id", "=", principalId)
    .where("status", "=", "ACTIVE")
    .executeTakeFirst();
  key ??= await db.insertInto("principal_key").values({
    enterprise_id: entId,
    principal_id: principalId,
    key_prefix: `test-${randomUUID().slice(0, 8)}`,
    key_digest: randomUUID(),
    allowed_model_ids: [],
    status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow();
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId,
    enterprise_id: entId,
    principal_id: principalId,
    principal_key_id: key.id,
    protocol: "openai",
    unified_model: "ql-test",
    status: "SUCCEEDED",
    started_at: startedAt,
    finished_at: new Date(startedAt.getTime() + 1_000),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId,
    enterprise_id: entId,
    principal_id: principalId,
    total_input_tokens: input,
    total_output_tokens: output,
    total_cache_tokens: cache,
    total_reasoning_tokens: reasoning,
    total_deducted_quota: deducted,
    total_api_cost: cost,
    usage_quality: usageQuality,
    attempt_count: 1,
    status: ledgerStatus,
    created_at: at,
  }).execute();
  return requestId;
}

describe("W20-04 UsageOverviewRepository", () => {
  const anchor = new Date("2026-08-12T04:00:00.000Z");

  it("员工本周固定周一至周日，真实 Token 不重复缓存且不跨企业", async () => {
    const result = await new UsageOverviewRepository(db).getOverview({
      enterpriseId, subjectType: "EMPLOYEE", period: "WEEK", anchor,
    });

    expect(result.range).toEqual({
      from: "2026-08-09T16:00:00.000Z",
      to: "2026-08-16T16:00:00.000Z",
    });
    expect(result.metrics).toMatchObject({
      activeSubjects: 2,
      requestCount: "2",
      inputTokens: "300",
      outputTokens: "50",
      cacheTokens: "130",
      reasoningTokens: "12",
      realTokens: "350",
      apiCost: "1.25000000",
      deductedQuota: "350",
      usageQuality: "UNKNOWN",
      providerReportedCount: 1,
      unknownCount: 1,
    });
    expect(result.trend).toHaveLength(7);
    expect(result.trend.map((point) => point.label)).toEqual([
      "周一", "周二", "周三", "周四", "周五", "周六", "周日",
    ]);
    expect(result.trend.reduce((sum, point) => sum + BigInt(point.realTokens), 0n)).toBe(350n);
    expect(result.ranking.map((item) => item.subjectName)).toEqual(["乙员工", "甲员工"]);
    expect(result.source).toBe("LIVE_LEDGER");
    expect(result.stale).toBe(false);
  });

  it("项目视图优先最新归属快照并回退项目直发事实", async () => {
    const direct = await new UsageOverviewRepository(db).getOverview({
      enterpriseId, subjectType: "PROJECT", subjectId: projectId, period: "WEEK", anchor,
    });
    expect(direct.metrics).toMatchObject({
      activeSubjects: 1, requestCount: "1", realTokens: "340", apiCost: "2.00000000",
    });
    const attributed = await new UsageOverviewRepository(db).getOverview({
      enterpriseId,
      subjectType: "PROJECT",
      subjectId: attributionProjectId,
      period: "WEEK",
      anchor,
    });
    expect(attributed.metrics).toMatchObject({
      activeSubjects: 1, requestCount: "1", realTokens: "230", apiCost: "0",
    });
    expect(attributed.ranking[0]).toMatchObject({
      subjectId: attributionProjectId, subjectName: "归集项目",
    });
  });

  it("用量关键词匹配姓名、部门和项目归属，保留快照优先级与分页总数", async () => {
    const repo = new UsageRepository(db);
    const attributed = await repo.list({ enterpriseId, search: "归集", limit: 1 });
    expect(attributed.total).toBe(1);
    expect(attributed.records[0]?.principalId).toBe(employeeTwoId);
    const nextPage = await repo.list({ enterpriseId, search: "归集", limit: 1, offset: 1 });
    expect(nextPage.total).toBe(1);
    expect(nextPage.records).toHaveLength(0);
    const direct = await repo.list({ enterpriseId, search: "甲项目" });
    expect(direct.total).toBe(1);
    expect(direct.records[0]?.principalId).toBe(projectId);
    const employee = await repo.list({ enterpriseId, search: "乙员工" });
    expect(employee.records.map((row) => row.requestId)).toEqual(attributed.records.map((row) => row.requestId));
    const department = await repo.list({ enterpriseId, search: "产品" });
    expect(department.records.map((row) => row.requestId)).toEqual(attributed.records.map((row) => row.requestId));
    expect((await repo.list({ enterpriseId: otherEnterpriseId, search: "归集" })).total).toBe(0);
    expect((await repo.list({ enterpriseId, search: "归集%" })).total).toBe(0);
    expect((await repo.list({ enterpriseId, search: "归集_" })).total).toBe(0);
  });

  it("空主体仍返回完整 24 小时零趋势，错类型主体不泄露", async () => {
    const empty = await new UsageOverviewRepository(db).getOverview({
      enterpriseId, subjectType: "PROJECT", subjectId: emptyProjectId, period: "TODAY", anchor,
    });
    expect(empty.metrics.activeSubjects).toBe(0);
    expect(empty.metrics.realTokens).toBe("0");
    expect(empty.metrics.usageQuality).toBe("NO_DATA");
    expect(empty.trend).toHaveLength(24);
    expect(empty.trend.every((point) => point.requestCount === "0")).toBe(true);

    await expect(new UsageOverviewRepository(db).getOverview({
      enterpriseId, subjectType: "EMPLOYEE", subjectId: projectId, period: "MONTH", anchor,
    })).rejects.toBeInstanceOf(UsageOverviewSubjectNotFoundError);
  });

  it("概览与请求明细在员工/项目口径下守恒，且排除未结算事务", async () => {
    const overviewRepository = new UsageOverviewRepository(db);
    const usageRepository = new UsageRepository(db);
    const employeeOverview = await overviewRepository.getOverview({
      enterpriseId, subjectType: "EMPLOYEE", period: "WEEK", anchor,
    });
    const employeeDetails = await usageRepository.list({
      enterpriseId,
      subjectType: employeeOverview.detailQuery.subjectType,
      principalId: employeeOverview.detailQuery.principalId ?? undefined,
      projectId: employeeOverview.detailQuery.projectId ?? undefined,
      from: new Date(employeeOverview.detailQuery.from),
      toExclusive: new Date(employeeOverview.detailQuery.toExclusive),
      settledOnly: employeeOverview.detailQuery.settledOnly,
      limit: 500,
    });
    expect(employeeOverview.detailQuery).toMatchObject({ subjectType: "EMPLOYEE", settledOnly: true });
    expectConservation(employeeOverview.metrics, employeeDetails.records);
    expect(employeeDetails.total).toBe(2);

    const projectOverview = await overviewRepository.getOverview({
      enterpriseId, subjectType: "PROJECT", subjectId: attributionProjectId, period: "WEEK", anchor,
    });
    const projectDetails = await usageRepository.list({
      enterpriseId,
      subjectType: projectOverview.detailQuery.subjectType,
      projectId: projectOverview.detailQuery.projectId ?? undefined,
      from: new Date(projectOverview.detailQuery.from),
      toExclusive: new Date(projectOverview.detailQuery.toExclusive),
      settledOnly: projectOverview.detailQuery.settledOnly,
      limit: 500,
    });
    expectConservation(projectOverview.metrics, projectDetails.records);
    expect(projectDetails.records[0]?.principalId).toBe(employeeTwoId);
  });

  it("跨月与 DST 边界使用企业时区半开区间", async () => {
    const repository = new UsageOverviewRepository(db);
    const month = await repository.getOverview({
      enterpriseId: dstEnterpriseId,
      subjectType: "EMPLOYEE",
      period: "MONTH",
      anchor: new Date("2026-03-15T12:00:00.000Z"),
    });
    expect(month.range).toEqual({
      from: "2026-03-01T05:00:00.000Z",
      to: "2026-04-01T04:00:00.000Z",
    });
    expect((new Date(month.range.to).getTime() - new Date(month.range.from).getTime()) / 3_600_000).toBe(743);
    expect(month.metrics).toMatchObject({ requestCount: "3", realTokens: "66" });

    const dstDay = await repository.getOverview({
      enterpriseId: dstEnterpriseId,
      subjectType: "EMPLOYEE",
      period: "TODAY",
      anchor: new Date("2026-03-08T16:00:00.000Z"),
    });
    expect(dstDay.range).toEqual({
      from: "2026-03-08T05:00:00.000Z",
      to: "2026-03-09T04:00:00.000Z",
    });
    expect((new Date(dstDay.range.to).getTime() - new Date(dstDay.range.from).getTime()) / 3_600_000).toBe(23);
    expect(dstDay.metrics).toMatchObject({ requestCount: "2", realTokens: "55" });
    expect(dstDay.trend.reduce((sum, point) => sum + BigInt(point.realTokens), 0n)).toBe(55n);
  });

  it("POOL20-045：上海月末开始、下月结算严格按结算时间分月且真实 Token 不含缓存", async () => {
    const repository = new UsageOverviewRepository(db);
    const august = await repository.getOverview({
      enterpriseId: monthBoundaryEnterpriseId,
      subjectType: "EMPLOYEE",
      period: "MONTH",
      anchor: new Date("2026-08-15T00:00:00.000Z"),
    });
    const september = await repository.getOverview({
      enterpriseId: monthBoundaryEnterpriseId,
      subjectType: "EMPLOYEE",
      period: "MONTH",
      anchor: new Date("2026-09-15T00:00:00.000Z"),
    });
    expect(august.range).toEqual({
      from: "2026-07-31T16:00:00.000Z",
      to: "2026-08-31T16:00:00.000Z",
    });
    expect(august.metrics).toMatchObject({
      requestCount: "1", inputTokens: "40", outputTokens: "2",
      cacheTokens: "30", reasoningTokens: "1", realTokens: "42",
    });
    expect(september.metrics).toMatchObject({
      requestCount: "1", inputTokens: "50", outputTokens: "3",
      cacheTokens: "20", reasoningTokens: "2", realTokens: "53",
      usageQuality: "ESTIMATED", estimatedCount: 1, mixedCount: 0,
    });
    const septemberDetails = await new UsageRepository(db).list({
      enterpriseId: monthBoundaryEnterpriseId, settledOnly: true,
      from: new Date(september.range.from), toExclusive: new Date(september.range.to),
    });
    expect(septemberDetails.records).toHaveLength(1);
    expect(septemberDetails.records[0]?.startedAt).toBe("2026-08-31T15:59:00.000Z");
  });

  it("0047 建立可重建聚合表且初始不伪装已有缓存", async () => {
    const rows = await db.selectFrom("usage_bucket_aggregate").selectAll().execute();
    expect(rows).toEqual([]);
  });

  it("完整桶水位时实际读聚合，与 LIVE 账本的指标趋势排名一致", async () => {
    const fixedNow = new Date("2026-08-12T04:00:00.000Z");
    const query = {
      enterpriseId,
      subjectType: "EMPLOYEE" as const,
      period: "WEEK" as const,
      anchor: fixedNow,
    };
    const overview = new UsageOverviewRepository(db, () => fixedNow);
    const live = await overview.getOverview(query);
    const liveProject = await overview.getOverview({
      enterpriseId,
      subjectType: "PROJECT",
      subjectId: attributionProjectId,
      period: "WEEK",
      anchor: fixedNow,
    });
    expect(live.source).toBe("LIVE_LEDGER");

    await new UsageAggregateRepository(db).rebuildRange({
      enterpriseId,
      from: new Date("2026-08-09T16:00:00.000Z"),
      to: new Date("2026-08-16T16:00:00.000Z"),
    });
    const cached = await overview.getOverview(query);
    expect(cached).toMatchObject({
      source: "BUCKET_AGGREGATE",
      stale: false,
      metrics: live.metrics,
      ranking: live.ranking,
      detailQuery: live.detailQuery,
    });
    expect(withoutCollectionStatus(cached.trend)).toEqual(withoutCollectionStatus(live.trend));
    expect(live.trend.every((point) => point.collectionStatus === "MISSING")).toBe(true);
    expect(cached.trend.every((point) => point.collectionStatus === (
      new Date(point.bucketEnd) <= fixedNow ? "COMPLETE" : "MISSING"
    ))).toBe(true);
    expect(cached.generatedAt).not.toBe(live.generatedAt);
    const cachedProject = await overview.getOverview({
      enterpriseId,
      subjectType: "PROJECT",
      subjectId: attributionProjectId,
      period: "WEEK",
      anchor: fixedNow,
    });
    expect(cachedProject).toMatchObject({
      source: "BUCKET_AGGREGATE",
      metrics: liveProject.metrics,
      ranking: liveProject.ranking,
    });
    expect(withoutCollectionStatus(cachedProject.trend)).toEqual(
      withoutCollectionStatus(liveProject.trend),
    );
  });

  it("DST 23 小时日的 HOUR 聚合趋势与 LIVE 同源守恒", async () => {
    const fixedNow = new Date("2026-03-08T16:00:00.000Z");
    const query = {
      enterpriseId: dstEnterpriseId,
      subjectType: "EMPLOYEE" as const,
      period: "TODAY" as const,
      anchor: fixedNow,
    };
    const overview = new UsageOverviewRepository(db, () => fixedNow);
    const live = await overview.getOverview(query);
    await new UsageAggregateRepository(db).rebuildRange({
      enterpriseId: dstEnterpriseId,
      from: new Date("2026-03-08T05:00:00.000Z"),
      to: new Date("2026-03-09T04:00:00.000Z"),
    });
    const cached = await overview.getOverview(query);
    expect(live.trend).toHaveLength(23);
    expect(cached).toMatchObject({
      source: "BUCKET_AGGREGATE",
      stale: false,
      metrics: live.metrics,
      ranking: live.ranking,
    });
    expect(withoutCollectionStatus(cached.trend)).toEqual(withoutCollectionStatus(live.trend));
    expect(cached.trend.every((point) => point.collectionStatus === (
      new Date(point.bucketEnd) <= fixedNow ? "COMPLETE" : "MISSING"
    ))).toBe(true);
    expect(cached.trend.reduce((sum, point) => sum + BigInt(point.realTokens), 0n)).toBe(55n);
  });

  it("缺少真实空桶水位或桶变 dirty 时回退 LIVE，不把缺数据伪装成 0", async () => {
    const fixedNow = new Date("2026-08-12T04:00:00.000Z");
    const query = {
      enterpriseId,
      subjectType: "EMPLOYEE" as const,
      period: "WEEK" as const,
      anchor: fixedNow,
    };
    const aggregate = new UsageAggregateRepository(db);
    const overview = new UsageOverviewRepository(db, () => fixedNow);
    const mondayStart = new Date("2026-08-09T16:00:00.000Z");
    await db.deleteFrom("usage_aggregate_bucket_state")
      .where("enterprise_id", "=", enterpriseId)
      .where("bucket_granularity", "=", "DAY")
      .where("bucket_start", "=", mondayStart)
      .execute();
    const missing = await overview.getOverview(query);
    expect(missing.source).toBe("LIVE_LEDGER");
    expect(missing.metrics.realTokens).toBe("350");

    await aggregate.rebuildBucket({
      enterpriseId,
      bucketGranularity: "DAY",
      bucketStart: mondayStart,
      timezone: "Asia/Shanghai",
    });
    const request = await db.selectFrom("ledger_transaction").select("ai_request_id")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", employeeTwoId)
      .executeTakeFirstOrThrow();
    await aggregate.markRequestDirty(enterpriseId, request.ai_request_id);
    const dirty = await overview.getOverview(query);
    expect(dirty.source).toBe("LIVE_LEDGER");
    expect(dirty.metrics).toEqual(missing.metrics);
    await aggregate.rebuildDirtyBuckets("DAY");
  });

  it("聚合完整但最旧数据时间超过 10 分钟时稳定返回 stale 和数据时间", async () => {
    const fixedNow = new Date("2026-08-12T04:00:00.000Z");
    const staleAt = new Date(fixedNow.getTime() - 11 * 60_000);
    await db.updateTable("usage_aggregate_bucket_state")
      .set({ generated_at: staleAt })
      .where("enterprise_id", "=", enterpriseId)
      .where("bucket_granularity", "=", "DAY")
      .execute();
    const result = await new UsageOverviewRepository(db, () => fixedNow).getOverview({
      enterpriseId,
      subjectType: "EMPLOYEE",
      period: "WEEK",
      anchor: fixedNow,
    });
    expect(result.source).toBe("BUCKET_AGGREGATE");
    expect(result.stale).toBe(true);
    expect(result.generatedAt).toBe(staleAt.toISOString());
    expect(result.metrics.realTokens).toBe("350");
  });
});

function expectConservation(
  metrics: { requestCount: string; inputTokens: string; outputTokens: string; cacheTokens: string; reasoningTokens: string; realTokens: string; apiCost: string; deductedQuota: string },
  records: Array<{ totalInputTokens: string; totalOutputTokens: string; totalCacheTokens: string; totalReasoningTokens: string; totalApiCost: string; totalDeductedQuota: string }>,
) {
  const sum = (field: keyof (typeof records)[number]) => records.reduce((total, row) => total + BigInt(row[field]), 0n).toString();
  expect(String(records.length)).toBe(metrics.requestCount);
  expect(sum("totalInputTokens")).toBe(metrics.inputTokens);
  expect(sum("totalOutputTokens")).toBe(metrics.outputTokens);
  expect(sum("totalCacheTokens")).toBe(metrics.cacheTokens);
  expect(sum("totalReasoningTokens")).toBe(metrics.reasoningTokens);
  expect(records.reduce((total, row) => total + BigInt(row.totalInputTokens) + BigInt(row.totalOutputTokens), 0n).toString()).toBe(metrics.realTokens);
  expect(sum("totalDeductedQuota")).toBe(metrics.deductedQuota);
  expect(records.reduce((total, row) => total + Number(row.totalApiCost), 0)).toBeCloseTo(Number(metrics.apiCost), 8);
}
