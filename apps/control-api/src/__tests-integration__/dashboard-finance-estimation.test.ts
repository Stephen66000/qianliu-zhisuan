/**
 * S3b（WP1 合同 §1.1 / §4a）集成证据：/dashboard 首页 finance 开/关两条路径的
 * API 金额同值——开路径 projectDashboardFinance 不再用资金读模型覆盖 API 分量，
 * 而是透传 getSummary 已经 applyApiCostEstimationToSpend（loadApiCostEstimation
 * 同源）供给的金额；套餐与充值字段保留资金读模型取值，总额按币种重算。
 * 依据：ACE-06/07、WP0 contracts.md C1、S3a 移交项（dashboard-projection.ts）。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, DashboardRepository,
  loadApiCostEstimation, type MonthlyFinanceSummary } from "@qianliu/database";
import { projectDashboardFinance } from "../provider-finance/dashboard-projection.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
// 2026-09 上海自然月；getSummary 以 anchor 决定当月窗口。
const start = new Date("2026-08-31T16:00:00.000Z");
const end = new Date("2026-09-30T16:00:00.000Z");
const anchor = new Date("2026-09-10T04:00:00.000Z");

beforeAll(async () => {
  pg = await startPostgresContainer("dashboard_finance_estimation");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function seedEnterpriseWithPricedUsage(cost: string): Promise<string> {
  const enterpriseId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "首页双路同源" }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_home", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "api 资源", mode: "API",
    credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  const requestId = randomUUID();
  const at = new Date("2026-09-05T10:00:00+08:00");
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "model",
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: resource.id, upstream_model: "model", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: resource.id, input_tokens: 1000n, output_tokens: 100n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: resource.id, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: cost, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    usage_quality: "PROVIDER_REPORTED", settled_at: at, created_at: at,
  }).execute();
  return enterpriseId;
}

/** 资金读模型汇总：故意给出与估算不同的 apiOperatingCosts，证明开路径不再覆盖 API 分量。 */
function financeSummary(overrides: Partial<MonthlyFinanceSummary> = {}): MonthlyFinanceSummary {
  return {
    month: "2026-09",
    timezone: "Asia/Shanghai",
    cashOutflowCny: "799.00000000",
    apiRecharges: [{ currency: "CNY", amount: "600.00000000" }],
    apiOperatingCosts: [{ currency: "CNY", amount: "108.43000000" }],
    codingPlanOrders: [],
    codingPlanFixedCostCny: "199.00000000",
    operatingCostCny: "307.43000000",
    operatingCostByCurrency: [{ currency: "CNY", amount: "307.43000000" }],
    currentApiBalances: [],
    currentApiBalancesComplete: true,
    complete: true,
    gaps: [],
    ...overrides,
  } as MonthlyFinanceSummary;
}

describe("/dashboard finance 开/关两路 API 金额同值（合同 §4a）", () => {
  it("开路径透传估算 API 金额；套餐/充值取资金读模型；总额＝套餐+估算", async () => {
    const enterpriseId = await seedEnterpriseWithPricedUsage("42.5");
    const estimation = await loadApiCostEstimation(db, enterpriseId, { start, end });
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "42.50000000" }]);

    const summary = await new DashboardRepository(db).getSummary(enterpriseId, anchor.getTime());
    // 关路径（finance 关＝getSummary 原样）：
    expect(summary.monthlyApiCost).toBe("42.50000000");
    expect(summary.monthlyApiCosts).toEqual([{ currency: "CNY", amount: "42.50000000" }]);
    expect(summary.monthlyApiCost).toBe(estimation.amounts[0]!.amount);

    // 开路径（/dashboard finance 开＝projectDashboardFinance 投影）：
    const projected = projectDashboardFinance(summary, financeSummary());
    expect(projected.monthlyApiCost).toBe(summary.monthlyApiCost);
    expect(projected.monthlyApiCosts).toEqual(summary.monthlyApiCosts);
    expect(projected.monthlyApiSpendReason).toBe(summary.monthlyApiSpendReason);
    // 套餐与充值保留资金读模型值；总额由套餐 199 + 估算 42.5 重算（资金 apiOperatingCosts 108.43 被弃用）。
    expect(projected).toMatchObject({
      monthlyPackagePayment: "199.00000000",
      monthlyTotalSpend: "241.50000000",
      monthlyTotalSpends: [{ currency: "CNY", amount: "241.50000000" }],
      monthlyRechargeAmount: "600.00000000",
      monthlyRechargeAmounts: [{ currency: "CNY", amount: "600.00000000" }],
    });
  });

  it("混币估算分量：开路径同样透传 null 与原因，不落回资金读模型金额", async () => {
    const enterpriseId = await seedEnterpriseWithPricedUsage("42.5");
    // 同资源追加一笔 USD 已计价行 → 估算按币种分列、scalar 置 null（ACE-07）。
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "usd-provider", name: "USD", adapter_type: "OPENAI_COMPATIBLE",
    }).returning("id").executeTakeFirstOrThrow();
    const usdResource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: "usd api", mode: "API",
      credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    const principal = await db.selectFrom("principal").select("id")
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
    const key = await db.selectFrom("principal_key").select("id")
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
    const requestId = randomUUID();
    const at = new Date("2026-09-06T10:00:00+08:00");
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: principal.id,
      principal_key_id: key.id, protocol: "chat", unified_model: "model",
      status: "SUCCEEDED", started_at: at, finished_at: at,
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
      provider_resource_id: usdResource.id, upstream_model: "model", http_status: 200,
      response_committed: true, finished_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
      provider_resource_id: usdResource.id, input_tokens: 10n, output_tokens: 10n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: requestId, created_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
      usage_event_id: usage.id, provider_resource_id: usdResource.id, principal_id: principal.id,
      resource_mode: "API", raw_input_tokens: 10n, raw_output_tokens: 10n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: "2", api_cost_currency: "USD", api_cost_status: "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", settled_at: at, created_at: at,
    }).execute();

    const estimation = await loadApiCostEstimation(db, enterpriseId, { start, end });
    expect(estimation.amounts).toEqual([
      { currency: "CNY", amount: "42.50000000" },
      { currency: "USD", amount: "2.00000000" },
    ]);

    const summary = await new DashboardRepository(db).getSummary(enterpriseId, anchor.getTime());
    // 关路径：混币 → scalar null + 币种不一致原因。
    expect(summary.monthlyApiCost).toBeNull();
    expect(summary.monthlyApiSpendReason).toContain("币种不一致");

    // 开路径：透传同一 null/原因与分列金额，绝不落回资金读模型的 108.43。
    const projected = projectDashboardFinance(summary, financeSummary());
    expect(projected.monthlyApiCost).toBeNull();
    expect(projected.monthlyApiCosts).toEqual(summary.monthlyApiCosts);
    expect(projected.monthlyApiSpendReason).toBe(summary.monthlyApiSpendReason);
    expect(projected.monthlyTotalSpend).toBeNull();
    // 总额分列与关路径（applyApiCostEstimationToSpend）语义一致：API 分量混币时不产出。
    expect(projected.monthlyTotalSpends).toEqual([]);
  });
});
