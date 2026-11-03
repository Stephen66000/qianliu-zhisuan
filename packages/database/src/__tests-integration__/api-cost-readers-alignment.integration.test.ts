/**
 * 跨读取方同源核对集成测试（WP1 S3a 合同 §1.3 / ACE-06 服务层）。
 *
 * 同一 fixture 下证明以下读取方对同一范围/期间/币种的 API 金额字面值相等：
 *   1) loadApiCostEstimation（C1 统一入口）；
 *   2) DashboardRepository.getSummary 的 monthlyApiCost(s)（首页 API 分量）；
 *   3) getResourceUsageOverview 的 API 汇总行 monthlyCost（用量总览，基础层注入，
 *      即 finance 关路径；finance 开路径由 consumer-projection.test.ts 证明恒等透传）；
 *   4) loadWindowOperatingFinance 的 totalSpends（同期窗口；金额段已切同源估算）。
 * 另覆盖：无任何资金表数据时估算照常产生（ACE-03/AT-ACE-05）、混币不混加（ACE-07）、
 * 同期窗口保留合法历史费用处置域（AFR-06：窗口内历史聚合覆盖 NOT_MIGRATED）。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, DashboardRepository, loadApiCostEstimation,
  loadWindowOperatingFinance } from "../index.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
// 2026-09 上海自然月：[2026-08-31T16:00Z, 2026-09-30T16:00Z)。
const start = new Date("2026-08-31T16:00:00.000Z");
const end = new Date("2026-09-30T16:00:00.000Z");
const anchor = new Date("2026-09-10T04:00:00.000Z");

beforeAll(async () => {
  pg = await startPostgresContainer("api_cost_readers_alignment");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

interface Fixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  resourceId: string;
}

/** 独立企业；绝不写 provider_finance_event/快照/期初/资金账户（ACE-03 前提）。 */
async function fixture(): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "跨读取方核对" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: adminId,
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_align", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "api 资源", mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  return { enterpriseId, adminId, principalId, keyId, resourceId: resource.id };
}

interface SeedLineInput {
  at: Date;
  cost: string | null;
  currency?: string | null;
  status: "PRICED_USAGE" | "CONFIRMED_ZERO_NO_UPSTREAM" | "UNKNOWN_COST" | "NOT_MIGRATED";
  resourceOverride?: string;
}

async function seedLine(f: Fixture, input: SeedLineInput): Promise<void> {
  const requestId = randomUUID();
  const resourceId = input.resourceOverride ?? f.resourceId;
  const at = input.at;
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: f.enterpriseId, principal_id: f.principalId,
    principal_key_id: f.keyId, protocol: "chat", unified_model: "model",
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: resourceId, upstream_model: "model", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: resourceId, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    enterprise_id: f.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: resourceId, principal_id: f.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: input.cost,
    // 0085 shape：CONFIRMED_ZERO 行 api_cost=0 且币种必须为 NULL。
    api_cost_currency: (input.cost === null || input.currency === null
      || input.status === "CONFIRMED_ZERO_NO_UPSTREAM")
      ? null : input.currency ?? "CNY",
    api_cost_status: input.status,
    usage_quality: "PROVIDER_REPORTED",
    settled_at: at, created_at: at,
  }).execute();
}

describe("跨读取方同源核对（ACE-06 服务层）", () => {
  it("首页/用量总览/同期窗口/统一估算四读取方同范围同币种金额字面值相等", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "1.05", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-06T10:00:00+08:00"), cost: "0",
      status: "CONFIRMED_ZERO_NO_UPSTREAM" });
    // WP2-S5（AFR-07）：OPENING_BALANCE_MISSING 已停产（countFinanceGaps 恒 0），
    // 期初事件对窗口缺口段不再有影响；该插入保留为"期初事件不改变金额段"的反控制。
    await db.insertInto("provider_finance_event").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "100", account_currency: "CNY",
      occurred_at: start, source: "MIGRATION", description: "fixture opening",
      evidence_ref: "fixture-only", created_by_admin_user_id: f.adminId,
      idempotency_key: randomUUID(),
    }).execute();

    const estimation = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "1.05000000" }]);
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");

    const summary = await new DashboardRepository(db).getSummary(
      f.enterpriseId, anchor.getTime(),
    );
    expect(summary.monthlyApiCosts).toEqual([{ currency: "CNY", amount: "1.05000000" }]);
    expect(summary.monthlyApiCost).toBe("1.05000000");
    expect(summary.monthlyApiSpendReason).toBeNull();

    const overview = await new DashboardRepository(db)
      .getResourceUsageOverview(f.enterpriseId, anchor.getTime());
    const apiSummary = overview.providerSummaries.find((row) => row.mode === "API");
    expect(apiSummary).toBeDefined();
    expect(apiSummary).toMatchObject({
      providerCode: "deepseek",
      monthlyCost: "1.05000000",
      monthlyCostReason: null,
      currency: "CNY",
    });

    const window = await loadWindowOperatingFinance(db, f.enterpriseId, start, end);
    expect(window.totalSpends).toEqual([{ currency: "CNY", amount: "1.05000000" }]);
    expect(window.incompleteReason).toBeNull();
  });

  it("没有任何资金表数据时各读取方照常产出同源估算（ACE-03/AT-ACE-05 服务层）", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-08T10:00:00+08:00"), cost: "2.50", status: "PRICED_USAGE" });
    const events = await db.selectFrom("provider_finance_event")
      .where("enterprise_id", "=", f.enterpriseId).execute();
    expect(events).toHaveLength(0);

    const estimation = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    const summary = await new DashboardRepository(db).getSummary(
      f.enterpriseId, anchor.getTime(),
    );
    const overview = await new DashboardRepository(db)
      .getResourceUsageOverview(f.enterpriseId, anchor.getTime());
    const window = await loadWindowOperatingFinance(db, f.enterpriseId, start, end);
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "2.50000000" }]);
    expect(summary.monthlyApiCost).toBe("2.50000000");
    expect(overview.providerSummaries.find((row) => row.mode === "API"))
      .toMatchObject({ monthlyCost: "2.50000000" });
    expect(window.totalSpends).toEqual([{ currency: "CNY", amount: "2.50000000" }]);
    // 断言迁移（WP2-S5 / AFR-07＋WP2 plan §4.5，WP1 合同 §4 裁定 1 收口）：
    // countFinanceGaps 停产 OPENING_BALANCE_MISSING（恒 0）——无任何资金表数据时
    // 估算照常产生且窗口无"待补期初"提示（ACE-03 场景1 的正面语义）。
    expect(window.incompleteReason).toBeNull();
  });

  it("混币按币种分列、绝不混加（ACE-07）：首页为 null+分列，总览为明确币种不一致", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-05T10:00:00+08:00"), cost: "1.05", status: "PRICED_USAGE" });
    await seedLine(f, { at: new Date("2026-09-06T10:00:00+08:00"), cost: "2.00",
      currency: "USD", status: "PRICED_USAGE" });

    const estimation = await loadApiCostEstimation(db, f.enterpriseId, { start, end });
    expect(estimation.amounts).toEqual([
      { currency: "CNY", amount: "1.05000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);

    const summary = await new DashboardRepository(db).getSummary(
      f.enterpriseId, anchor.getTime(),
    );
    expect(summary.monthlyApiCosts).toEqual([
      { currency: "CNY", amount: "1.05000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);
    expect(summary.monthlyApiCost).toBeNull();
    expect(summary.monthlyApiSpendReason).toContain("币种不一致");

    const overview = await new DashboardRepository(db)
      .getResourceUsageOverview(f.enterpriseId, anchor.getTime());
    expect(overview.providerSummaries.find((row) => row.mode === "API")).toMatchObject({
      monthlyCost: null,
      monthlyCostReason: "币种不一致：CNY、USD",
    });

    const window = await loadWindowOperatingFinance(db, f.enterpriseId, start, end);
    expect(window.totalSpends).toEqual([
      { currency: "CNY", amount: "1.05000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);
  });

  it("同期窗口保留 AFR-06：窗口内历史聚合覆盖 NOT_MIGRATED 行，窗口外仍标记缺口", async () => {
    const f = await fixture();
    await seedLine(f, { at: new Date("2026-09-18T16:52:15+08:00"), cost: null, status: "NOT_MIGRATED" });
    await db.insertInto("provider_finance_event").values({
      enterprise_id: f.enterpriseId, provider_resource_id: f.resourceId,
      event_type: "API_HISTORICAL_USAGE_COST", account_amount: "-37.2501",
      account_currency: "CNY", occurred_at: new Date("2026-09-21T00:00:00+08:00"),
      source: "MIGRATION", description: "Synthetic historical aggregate",
      evidence_ref: "fixture-only", created_by_admin_user_id: f.adminId,
      idempotency_key: randomUUID(),
    }).execute();

    const whole = await loadWindowOperatingFinance(db, f.enterpriseId, start, end);
    expect(whole.totalSpends).toEqual([{ currency: "CNY", amount: "37.25010000" }]);
    expect(whole.incompleteReason).toBeNull();

    const shorter = await loadWindowOperatingFinance(db, f.enterpriseId, start,
      new Date("2026-09-19T11:13:00+08:00"));
    expect(shorter.totalSpends).toEqual([]);
    expect(shorter.incompleteReason).toContain("API_USAGE_COST_NOT_MIGRATED");
  });
});
