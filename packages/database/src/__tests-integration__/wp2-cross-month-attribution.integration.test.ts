/**
 * WP2-S6 集成测试：跨月归月（AT-AFR-07 后端，AFR-03）与续订（AT-AFR-08 后端，AFR-04）。
 *
 * 世界：已激活企业＋API 资源无任何资金账户/期初（S2/0094 后世界）；全程不建资金页面
 * 前提（无 provider_finance_event / provider_resource_finance_state 依赖）。
 *
 * 1. AT-AFR-07（AFR-03 跨入新月，企业时区 Asia/Shanghai 月界 11-30 23:59 → 12-01 00:02）：
 *    - 估算按 settled_at 半开窗口归月（api-cost-estimation.ts:31/:135 与 dashboard 同源）——
 *      23:59 结算行归 11 月、00:02 结算行归 12 月，新月用量与费用正常统计；
 *    - 员工额度按既有预占月合同：23:59 预占、00:02 结算仍归 11 月周期；新月预占开 12 月周期
 *      （既有管线级锚点＝apps/gateway/src/__tests-integration__/employee-monthly-quota.test.ts
 *      "new-month failover settles each attempt into its original reservation month"）；
 *    - 无任何资金页面访问/期初要求（AFR-03）。
 * 2. AT-AFR-08（AFR-04 续订）：API 无期初的已激活企业，CP 订阅到期 → Worker 同款任务入口
 *    runSubscriptionAutoRenewals 正常执行（模拟时间，不触发真实购买），自动续订开关与
 *    模板周期不变（既有机制锚点＝subscription-auto-renewal.integration.test.ts；本用例显式
 *    断言"API 无期初"前置）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import {
  createKysely,
  migrateToLatest,
  loadApiCostEstimation,
  EmployeeQuotaRepository,
  ProviderFinanceRepository,
  runSubscriptionAutoRenewals,
  getSubscriptionAutoRenewal,
} from "../index.js";
import { createAnalysisFixture } from "./fixtures/operating-analysis.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

const SHANGHAI_NOV_START = new Date("2026-11-01T00:00:00+08:00");
const SHANGHAI_DEC_START = new Date("2026-12-01T00:00:00+08:00");
const SHANGHAI_JAN_START = new Date("2027-01-01T00:00:00+08:00");
/** 企业时区月界：11-30 23:59（上海）与 12-01 00:02（上海）。 */
const NOV_LAST_2359 = new Date("2026-11-30T15:59:00Z");
const DEC_FIRST_0002 = new Date("2026-11-30T16:02:00Z");

beforeAll(async () => {
  pg = await startPostgresContainer("wp2_cross_month");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface World {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  resourceId: string;
  grantId: string;
}

/** 已激活企业＋API 资源，无任何资金账户/期初（ACE-03 同前提；每用例独立企业）。 */
async function world(): Promise<World> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({
    id: enterpriseId, name: "仟流测试-WP2跨月归月",
    timezone: "Asia/Shanghai", employee_quota_monthly_from: new Date("2026-10-01T00:00:00+08:00"),
  }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: adminId,
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  // 已激活（strict_writes_enabled）：S2 后世界。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-10-01T00:00:00+08:00"), activated_by_admin_user_id: adminId,
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "跨月员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_wp2cm", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "deepseek",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "wp2-cross-api",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  const grant = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    model_alias: "*", pool_model_alias: "*", quota_value: 1_000_000n,
    allow_overage: false, quota_basis: "RAW_TOKEN", status: "ACTIVE", valid_from: new Date(0),
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  return { enterpriseId, principalId, keyId, resourceId: resource.id, grantId: grant.id };
}

/** 一条已计价 API 账本行（settled_at 显式给定＝归月权威字段；不建任何资金表数据）。 */
async function seedPricedLine(w: World, input: { at: Date; cost: string }) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: w.enterpriseId, principal_id: w.principalId,
    principal_key_id: w.keyId, protocol: "chat", unified_model: "wp2-model",
    status: "SUCCEEDED", started_at: input.at, finished_at: input.at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: w.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: w.resourceId, upstream_model: "wp2-upstream",
    http_status: 200, response_committed: true, finished_at: input.at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: w.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: w.resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: input.at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    enterprise_id: w.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: w.resourceId, principal_id: w.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: input.cost, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    // F3：生产已计价行自 9bf1560 起冻结快照（含 sourceStatus）；夹具补齐生产形态，
    // 使估算依据不为 UNVERIFIED（本套件关注归月，不关注依据信息项）。
    billing_rule_snapshot: { sourceStatus: "VERIFIED" },
    usage_quality: "PROVIDER_REPORTED", settled_at: input.at, created_at: input.at,
  }).execute();
}

describe("WP2-S6 跨月归月（AT-AFR-07 后端，AFR-03）", () => {
  it("估算按 settled_at 归月：11-30 23:59 与 12-01 00:02 结算分列 11/12 月，新月用量与费用正常统计，无资金前提", async () => {
    const w = await world();
    await seedPricedLine(w, { at: NOV_LAST_2359, cost: "0.00100000" });
    await seedPricedLine(w, { at: DEC_FIRST_0002, cost: "0.00200000" });

    // 11 月半开窗口 [12-01 00:00+08, 01-01 00:00+08)：只含 23:59 结算行。
    const november = await loadApiCostEstimation(db, w.enterpriseId, {
      start: SHANGHAI_NOV_START, end: SHANGHAI_DEC_START,
    });
    expect(november.completeness).toBe("KNOWN_COMPLETE");
    expect(november.amounts).toEqual([{ currency: "CNY", amount: "0.00100000" }]);
    expect(november.gaps).toEqual([]);

    // 12 月窗口：00:02（上海）结算行归 12 月，新月费用正常统计（AFR-03 跨入新月）。
    const december = await loadApiCostEstimation(db, w.enterpriseId, {
      start: SHANGHAI_DEC_START, end: SHANGHAI_JAN_START,
    });
    expect(december.completeness).toBe("KNOWN_COMPLETE");
    expect(december.amounts).toEqual([{ currency: "CNY", amount: "0.00200000" }]);
    expect(december.gaps).toEqual([]);

    // 无任何资金页面访问/期初要求：企业无资金事件、资源无 finance_state 行（0094 后世界）。
    const financeEvents = await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", w.enterpriseId).execute();
    expect(financeEvents).toEqual([]);
    const financeStates = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", w.enterpriseId).execute();
    expect(financeStates).toEqual([]);
  });

  it("员工额度按既有预占月合同：23:59 预占、00:02 结算仍归 11 月周期；新月预占开 12 月周期", async () => {
    const w = await world();
    const quota = new EmployeeQuotaRepository(db);

    // 请求 A：11-30 23:59 预占（11 月周期开账）。
    const requestA = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestA, enterprise_id: w.enterpriseId, principal_id: w.principalId,
      principal_key_id: w.keyId, protocol: "chat", unified_model: "wp2-model",
      status: "IN_PROGRESS", started_at: NOV_LAST_2359,
    }).execute();
    const reserveA = await quota.reserveEmployeeQuota({
      enterpriseId: w.enterpriseId, principalId: w.principalId, provider: "deepseek",
      modelAlias: "wp2-model", requestId: requestA, attemptNo: 1,
      basis: "RAW_TOKEN", estimatedCost: 1200n, now: NOV_LAST_2359,
    });
    expect(reserveA.mode).toBe("MONTHLY");
    expect(reserveA.decision).toBe("ALLOW");
    expect(reserveA.periodId).toBeDefined();
    const periodNovId = reserveA.periodId!;

    // 结算发生在跨月之后（12-01 00:02 上海）：仍归预占月（11 月）合同。
    await quota.settleEmployeeQuota({
      enterpriseId: w.enterpriseId, usageId: reserveA.usageId!, periodId: periodNovId,
      actual: 1200n, now: DEC_FIRST_0002,
    });

    // 请求 B：新月（12-01 00:02 上海）预占 → 开 12 月周期。
    const requestB = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestB, enterprise_id: w.enterpriseId, principal_id: w.principalId,
      principal_key_id: w.keyId, protocol: "chat", unified_model: "wp2-model",
      status: "IN_PROGRESS", started_at: DEC_FIRST_0002,
    }).execute();
    const reserveB = await quota.reserveEmployeeQuota({
      enterpriseId: w.enterpriseId, principalId: w.principalId, provider: "deepseek",
      modelAlias: "wp2-model", requestId: requestB, attemptNo: 1,
      basis: "RAW_TOKEN", estimatedCost: 800n, now: DEC_FIRST_0002,
    });
    expect(reserveB.mode).toBe("MONTHLY");
    expect(reserveB.decision).toBe("ALLOW");
    expect(reserveB.periodId).not.toBe(periodNovId);

    const periods = await db.selectFrom("principal_quota_period").selectAll()
      .where("enterprise_id", "=", w.enterpriseId)
      .where("principal_id", "=", w.principalId)
      .orderBy("period_key").execute();
    expect(periods.map((p) => [p.period_key, p.timezone])).toEqual([
      ["2026-11", "Asia/Shanghai"], ["2026-12", "Asia/Shanghai"],
    ]);
    expect(periods[0]!.id).toBe(periodNovId);
    expect(periods[1]!.id).toBe(reserveB.periodId);

    // 用量各归其预占月：A（00:02 结算）留在 11 月，B 在 12 月。
    const usages = await db.selectFrom("principal_quota_usage").selectAll()
      .where("enterprise_id", "=", w.enterpriseId)
      .where("grant_id", "=", w.grantId).execute();
    const usageA = usages.find((u) => u.request_id === requestA)!;
    const usageB = usages.find((u) => u.request_id === requestB)!;
    expect(usageA.period_id).toBe(periodNovId);
    expect(usageA).toMatchObject({ status: "SETTLED", actual: "1200", settled_at: DEC_FIRST_0002 });
    expect(usageB.period_id).toBe(reserveB.periodId);
    expect(usageB).toMatchObject({ status: "RESERVED", estimate: "800" });

    // 周期数字：11 月已用 1200（含跨月结算），12 月仅新预占 800（reserved）。
    expect(periods[0]).toMatchObject({ used_value: "1200", reserved_value: "0" });
    expect(periods[1]).toMatchObject({ used_value: "0", reserved_value: "800" });
  });
});

describe("WP2-S6 续订（AT-AFR-08 后端，AFR-04）", () => {
  it("API 无期初的已激活企业：CP 订阅到期 → 自动续订任务正常执行（模拟时间），开关与周期不变", async () => {
    // 夹具：kimi=CODING_PLAN 资源，deepseek=API 资源（全程零资金事实）；激活企业。
    const t = await createAnalysisFixture(db);
    const resourceId = t.resources.get("kimi")!;
    const apiResourceId = t.resources.get("deepseek")!;
    await sql`INSERT INTO provider_finance_runtime_state (enterprise_id,strict_writes_enabled,activated_at,activated_by_admin_user_id,updated_at)
      VALUES (${t.enterpriseId}::uuid,true,now(),${t.adminId}::uuid,now())`.execute(db);

    // AFR-04 前置（显式断言）：企业无任何 API 资金期初/事件，API 资源无 finance_state 行。
    const apiStates = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", apiResourceId).execute();
    expect(apiStates).toEqual([]);
    const apiEvents = await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", t.enterpriseId).execute();
    expect(apiEvents).toEqual([]);

    const input = {
      enterpriseId: t.enterpriseId, resourceId, adminId: t.adminId, kind: "PURCHASE" as const,
      productName: "Kimi", accountAmount: "199", accountCurrency: "CNY" as const,
      cashPaidCny: "199", occurredAt: new Date("2026-09-01T00:00:00+08:00"),
      periodStart: new Date("2026-09-01T00:00:00+08:00"),
      periodEndExclusive: new Date("2026-09-02T00:00:00+08:00"), idempotencyKey: randomUUID(),
    };
    await new ProviderFinanceRepository(db).recordSubscription(input);
    const templateBefore = await db.selectFrom("provider_subscription_period").selectAll()
      .where("enterprise_id", "=", t.enterpriseId)
      .where("provider_resource_id", "=", resourceId).execute();
    const switchBefore = (await db.selectFrom("provider_resource").select("subscription_auto_renew_enabled")
      .where("id", "=", resourceId).executeTakeFirstOrThrow()).subscription_auto_renew_enabled;
    expect(switchBefore).toBe(true);

    // Worker 同款任务入口（apps/worker/src/subscription-renewal/runner.ts 包装）：
    // 到期时点运行，不触发任何真实购买（source=SYSTEM_RENEWAL 本地事件）。
    const run = await runSubscriptionAutoRenewals(db, new Date("2026-09-02T00:00:00+08:00"));
    expect(run.failures).toEqual([]);
    expect(run.created).toBe(1);

    // 续订事实：SYSTEM_RENEWAL 现金事件＋RENEWAL 周期（按模板日历 09-02→09-03）。
    const events = await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", t.enterpriseId)
      .where("source", "=", "SYSTEM_RENEWAL").execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "CODING_PLAN_RENEWAL", account_amount: "199.00000000",
      account_currency: "CNY", cash_paid_cny: "199.00000000", source: "SYSTEM_RENEWAL",
      occurred_at: new Date("2026-09-02T00:00:00+08:00"),
    });
    const renewedPeriod = await db.selectFrom("provider_subscription_period").selectAll()
      .where("finance_event_id", "=", events[0]!.id).executeTakeFirstOrThrow();
    expect(renewedPeriod).toMatchObject({
      period_start: new Date("2026-09-02T00:00:00+08:00"),
      period_end_exclusive: new Date("2026-09-03T00:00:00+08:00"), source: "RENEWAL",
    });

    // 自动续订开关与模板周期不变；下个到期点顺延；重复 tick 不重复扣费。
    expect((await db.selectFrom("provider_resource").select("subscription_auto_renew_enabled")
      .where("id", "=", resourceId).executeTakeFirstOrThrow()).subscription_auto_renew_enabled).toBe(true);
    const templateAfter = await db.selectFrom("provider_subscription_period").selectAll()
      .where("enterprise_id", "=", t.enterpriseId)
      .where("provider_resource_id", "=", resourceId)
      .where("id", "=", templateBefore[0]!.id).execute();
    expect(templateAfter).toEqual(templateBefore);
    expect((await getSubscriptionAutoRenewal(db, t.enterpriseId, resourceId)).nextRenewalAt)
      .toBe(new Date("2026-09-03T00:00:00+08:00").toISOString());
    const rerun = await runSubscriptionAutoRenewals(db, new Date("2026-09-02T00:00:00+08:00"));
    expect(rerun.created).toBe(0);
    expect((await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", t.enterpriseId)
      .where("source", "=", "SYSTEM_RENEWAL").execute())).toHaveLength(1);

    // 全程仅套餐域事实：续订不产生任何 API 资金事件（AFR-04 不要求补 API 资金记录）。
    const eventTypes = (await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", t.enterpriseId).execute()).map((e) => e.event_type);
    expect(eventTypes.every((type) => type.startsWith("CODING_PLAN"))).toBe(true);
  });
});
