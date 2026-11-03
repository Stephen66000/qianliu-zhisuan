import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, OperatingBillRepository } from "../index.js";
import { billIncompleteReason } from "../repositories/dashboard-home.js";
import { loadWindowOperatingFinance } from "../repositories/dashboard-home-costs.js";
import { countFinanceGaps } from "../repositories/provider-finance-gaps.js";
import { loadApiCostGaps } from "../repositories/provider-finance-api-cost-gaps.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
beforeAll(async () => {
  pg = await startPostgresContainer("finance_period_cost_integrity");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function fixture(openingAt = "2026-09-01T00:00:00+08:00") {
  const enterpriseId = randomUUID(), providerId = randomUUID(), resourceId = randomUUID();
  const principalId = randomUUID(), keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Period cost integrity" }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "deepseek", name: "Test provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
    provider_id: providerId, name: "Period API", mode: "API", credential_type: "API_KEY",
    created_at: new Date("2026-08-01T00:00:00+08:00") }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "Period user" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: "period", key_digest: randomUUID() }).execute();
  let openingAdminId: string | null = null;
  if (openingAt !== "2026-09-01T00:00:00+08:00") {
    openingAdminId = randomUUID();
    await db.insertInto("admin_user").values({ id: openingAdminId, enterprise_id: enterpriseId,
      username: openingAdminId, password_hash: "not-used", status: "ACTIVE" }).execute();
    await db.insertInto("provider_finance_runtime_state").values({ enterprise_id: enterpriseId,
      strict_writes_enabled: true, activated_at: new Date("2026-09-01T00:00:00+08:00"),
      activated_by_admin_user_id: openingAdminId }).execute();
    await db.insertInto("provider_resource_finance_state").values({ enterprise_id: enterpriseId,
      provider_resource_id: resourceId, state: "PENDING" }).execute();
  }
  const event = { enterprise_id: enterpriseId, provider_resource_id: resourceId,
    account_currency: "CNY" as const, cash_paid_cny: null, external_reference: null,
    reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
    description: "fixture evidence", evidence_ref: "fixture", source: "MIGRATION" as const,
    created_by_admin_user_id: null };
  await db.insertInto("provider_finance_event").values([
    { ...event, event_type: "API_OPENING_BALANCE", account_amount: "0",
      occurred_at: new Date(openingAt), idempotency_key: randomUUID(),
      source: openingAdminId ? "ADMIN" : "MIGRATION", created_by_admin_user_id: openingAdminId },
    { ...event, event_type: "API_RECHARGE", account_amount: "240", cash_paid_cny: "240",
      occurred_at: new Date(Math.max(new Date(openingAt).getTime() + 1,
        new Date("2026-09-02T00:00:00+08:00").getTime())), idempotency_key: randomUUID() },
  ]).execute();
  return { enterpriseId, providerId, resourceId, principalId, keyId, event };
}

async function usage(f: Awaited<ReturnType<typeof fixture>>, at: string,
  status: "PRICED_USAGE" | "UNKNOWN_COST" | "NOT_MIGRATED" | "CONFIRMED_ZERO_NO_UPSTREAM" | null,
  cost: string | null, createdAt = at, ruleCurrency?: "CNY" | "USD") {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: f.enterpriseId,
    principal_id: f.principalId, principal_key_id: f.keyId, protocol: "openai", unified_model: "model",
    status: "SUCCEEDED", started_at: new Date(at), finished_at: new Date(at) }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, attempt_no: 1, provider_resource_id: f.resourceId,
    upstream_model: "model", started_at: new Date(at), finished_at: new Date(at) })
    .returning("id").executeTakeFirstOrThrow();
  const event = await db.insertInto("usage_event").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: f.resourceId,
    input_tokens: 10n, output_tokens: 5n, cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: requestId, created_at: new Date(createdAt) })
    .returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({ ai_request_id: requestId, enterprise_id: f.enterpriseId,
    usage_event_id: event.id, upstream_attempt_id: attempt.id, provider_resource_id: f.resourceId,
    principal_id: f.principalId, resource_mode: "API", raw_input_tokens: 10n, raw_output_tokens: 5n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost_status: status, api_cost: cost,
    api_cost_currency: status === "PRICED_USAGE" ? "CNY" : null, usage_quality: "PROVIDER_REPORTED",
    billing_rule_snapshot: ruleCurrency ? { currency: ruleCurrency } : null,
    settled_at: new Date(at), created_at: new Date(createdAt) }).execute();
}

const octoberStart = new Date("2026-10-01T00:00:00+08:00");
const octoberEnd = new Date("2026-11-01T00:00:00+08:00");

describe("monthly expenses remain independent of accumulated balance uncertainty", () => {
  it("preserves explicit CNY zero in October and historical balance gaps without fabricating carryover", async () => {
    const f = await fixture();
    await usage(f, "2026-09-21T12:00:00+08:00", "PRICED_USAGE", "72.34567891");
    // Delayed insertion must not move the settled September expense into October.
    await usage(f, "2026-09-30T23:59:59+08:00", "UNKNOWN_COST", null, "2026-10-01T00:00:01+08:00");
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    // 断言迁移（WP2-S5 B / WP1 合同 §4 裁定 2）：summary 金额切同源估算——10 月窗口
    // 无已结算行（未知行 settled_at 落在 9 月）→ 估算精确 0；apiSpends/totalSpends 为
    // 估算按币种分列（无计价行 → 空分列＋精确 0 标量）。
    expect(bill.summary).toMatchObject({ apiCost: "0.00000000", totalCost: "0.00000000",
      apiSpendStatus: "CALCULABLE", apiSpendReason: null, openingBalance: null, endingBalance: null,
      totalSpends: [] });
    expect(bill.summary.rechargeAmounts).toEqual([{ currency: "CNY", amount: "0.00000000" }]);
    expect(bill.providers[0]).toMatchObject({ openingBalance: null, endingBalance: null,
      apiCost: "0.00000000", apiSpendStatus: "CALCULABLE" });
    // 断言迁移（WP2-S5 / AFR-07＋WP2 plan §4.5）：API_BALANCE_COST_UNKNOWN /
    // API_MONTH_OPENING_COST_UNKNOWN 等资金域质量码对当前期停产（"余额暂无法确认"
    // "月初结转不可计算"提示随资金管理退役；历史资金信息不参与当前费用完整性判断）；
    // API_OPENING_BALANCE_MISSING/API_COST_UNKNOWN 缺席语义照旧（:104 原断言）。
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_COST_UNKNOWN");
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_OPENING_BALANCE_MISSING");
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_BALANCE_COST_UNKNOWN");
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_MONTH_OPENING_COST_UNKNOWN");
    expect(bill.gaps).toEqual([]);
    expect(billIncompleteReason(bill)).toBeNull();
    expect((await countFinanceGaps(db, f.enterpriseId, octoberStart, octoberEnd))
      .find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("0");
  });

  it("fails closed for an actual October unknown expense and retains its known part", async () => {
    const f = await fixture();
    await usage(f, "2026-10-01T00:00:00+08:00", "UNKNOWN_COST", null);
    const unknownOnly = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    // 断言迁移（WP2-S5 B）：apiSpendReason 切估算缺口码口径（KNOWN_PARTIAL →
    // INCOMPLETE＋apiEstimationGapText；UNKNOWN_COST 状态行用量已知、价格缺失 →
    // PRICE_MISSING:1，即"待计价请求"缺口，ACE-04 场景1）。
    expect(unknownOnly.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "PRICE_MISSING:1", apiSpends: [], totalSpends: [] });
    await usage(f, "2026-10-01T00:00:01+08:00", "PRICED_USAGE", "3.25");
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    // 断言迁移（WP2-S5 B）：apiSpendReason 切估算缺口码口径（已知部分 3.25 照出，
    // ACE-04"展示已计价部分＋缺口说明"；缺口码 PRICE_MISSING:1 同上注）。
    expect(bill.summary).toMatchObject({ apiCost: "3.25000000", totalCost: null, apiSpendStatus: "INCOMPLETE",
      apiSpendReason: "PRICE_MISSING:1", openingBalance: "240.00000000", endingBalance: null,
      provisionalEndingBalances: [{ currency: "CNY", amount: "236.75000000" }],
      apiSpends: [{ currency: "CNY", amount: "3.25000000" }] });
    expect(bill.gaps.find((gap) => gap.code === "API_COST_UNKNOWN"))
      .toMatchObject({ requestRangeFrom: "2026-09-30T16:00:00.000Z",
        message: expect.stringContaining("Period API 本期费用") });
    expect(bill.gaps.find((gap) => gap.code === "API_COST_UNKNOWN")?.message)
      .toContain("2026-10-01 00:00:00");
    // 断言迁移（WP2-S5 B）：billIncompleteReason 透传估算缺口码口径。
    expect(billIncompleteReason(bill)).toBe("PRICE_MISSING:1");
    expect((await countFinanceGaps(db, f.enterpriseId, octoberStart, octoberEnd))
      .find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("1");
  });

  it("renders an established zero-cost currency even when all balance facts are normal", async () => {
    const f = await fixture();
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    // 断言迁移（WP2-S5 B）：金额切估算——无计价行 → 精确 0 标量＋空分列。
    expect(bill.summary).toMatchObject({ totalCost: "0.00000000", apiSpendReason: null,
      openingBalance: "240.00000000", endingBalance: "240.00000000",
      totalSpends: [] });
    expect(bill.summary.provisionalEndingBalances).toEqual([]);
    expect(billIncompleteReason(bill)).toBeNull();
    expect(bill.gaps).toEqual([]);
  });

  it("uses the same unknown and currency rules in expense projection and finance summaries", async () => {
    const f = await fixture();
    const at = "2026-10-01T00:00:00+08:00";
    await usage(f, at, null, "1");
    await usage(f, at, "PRICED_USAGE", "2", at, "USD");
    await usage(f, at, "CONFIRMED_ZERO_NO_UPSTREAM", "0");
    const financeGaps = await countFinanceGaps(db, f.enterpriseId, octoberStart, octoberEnd);
    expect(financeGaps.slice(0, 3)).toEqual([
      { code: "API_USAGE_COST_UNKNOWN", count: "1" },
      { code: "API_COST_CURRENCY_MISSING", count: "1" },
      { code: "API_COST_CURRENCY_CONFLICT", count: "1" },
    ]);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    // 断言迁移（WP2-S5 B / ACE-04）：单币种已计价部分照出（缺币种行不入桶、计
    // CURRENCY_MISSING 缺口，不阻止 CNY 已知金额展示）。
    expect(bill.summary.apiCost).toBe("2.00000000");
    expect(bill.summary.provisionalEndingBalances).toEqual([]);
    expect(bill.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      "API_COST_UNKNOWN", "API_COST_CURRENCY_MISSING", "API_COST_CURRENCY_CONFLICT",
    ]));
  });

  it("keeps August expenses unknown when an account was only opened in September", async () => {
    const f = await fixture();
    await usage(f, "2026-08-15T12:00:00+08:00", "NOT_MIGRATED", null);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-08");
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendStatus: "INCOMPLETE", apiSpendReason: "API_LEGACY_ARCHIVED",
      totalSpends: [], openingBalance: null, endingBalance: null });
    expect(bill.providers[0]).toMatchObject({ apiCost: null, totalCost: null, apiSpendStatus: "INCOMPLETE" });
    expect(billIncompleteReason(bill)).toBe("API_LEGACY_ARCHIVED");
  });

  it("does not turn NOT_MIGRATED into zero without a matching resource and period cost total", async () => {
    const f = await fixture();
    const otherResourceId = randomUUID();
    await db.insertInto("provider_resource").values({ id: otherResourceId, enterprise_id: f.enterpriseId,
      provider_id: f.providerId, name: "Other API", mode: "API", credential_type: "API_KEY",
      created_at: new Date("2026-08-01T00:00:00+08:00") }).execute();
    const start = new Date("2026-09-01T00:00:00+08:00");
    await usage(f, "2026-09-15T12:00:00+08:00", "NOT_MIGRATED", null);
    // Neither another resource's amount nor this resource's earlier coverage closes this row.
    await db.insertInto("provider_finance_event").values([
      { ...f.event, provider_resource_id: otherResourceId,
        event_type: "API_OPENING_BALANCE", account_amount: "100",
        occurred_at: start, idempotency_key: randomUUID() },
      { ...f.event, provider_resource_id: otherResourceId,
        event_type: "API_HISTORICAL_USAGE_COST", account_amount: "-40",
        occurred_at: new Date("2026-09-21T00:00:00+08:00"), idempotency_key: randomUUID() },
      { ...f.event, event_type: "API_HISTORICAL_USAGE_COST", account_amount: "-2",
        occurred_at: new Date("2026-09-10T00:00:00+08:00"), idempotency_key: randomUUID() },
    ]).execute();
    expect(await loadApiCostGaps(db, f.enterpriseId, start, octoberStart))
      .toEqual([expect.objectContaining({ code: "API_USAGE_COST_NOT_MIGRATED", count: "1" })]);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    // 断言迁移（WP2-S5 B）：apiSpendReason 切估算缺口码口径（NOT_MIGRATED:1）；
    // totalSpends 切估算 apiSpends（无计价行 → 空分列；原 42.00 来自资金读模型的
    // 历史聚合事件金额，估算权威下不再并入 summary 金额段，历史金额经 gaps 的
    // AFR-06 域与只读历史入口保留）。
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendStatus: "INCOMPLETE", apiSpendReason: "NOT_MIGRATED:1",
      totalSpends: [] });
  });

  it("does not manufacture September zero from a future October opening account", async () => {
    const f = await fixture("2026-10-01T00:00:00+08:00");
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    // 断言迁移（WP2-S5 B / AFR-07 场景1＋ACE-03）：9 月零金额来自估算窗口内无结算行
    // （与 10 月期初账户无关，仍非"由期初推定"）；资金域缺口码 API_OPENING_BALANCE_MISSING
    // 对当前期停产，不再由缺期初驱动费用缺失语义。
    expect(bill.summary).toMatchObject({ apiCost: "0.00000000", totalCost: "0.00000000",
      apiSpendStatus: "CALCULABLE", apiSpendReason: null, totalSpends: [] });
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_OPENING_BALANCE_MISSING");
  });

  it.each(["7", "0"])("keeps a priced CNY %s expense complete even when that account has no opening", async (cost) => {
    const f = await fixture();
    const resourceId = randomUUID();
    await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: f.enterpriseId,
      provider_id: f.providerId, name: "Priced without opening", mode: "API", credential_type: "API_KEY",
      created_at: new Date("2026-08-01T00:00:00+08:00") }).execute();
    await usage({ ...f, resourceId }, "2026-10-01T00:00:00+08:00", "PRICED_USAGE", cost);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    expect(bill.summary).toMatchObject({ apiCost: `${cost}.00000000`, totalCost: `${cost}.00000000`,
      apiSpendStatus: "CALCULABLE", apiSpendReason: null,
      totalSpends: [{ currency: "CNY", amount: `${cost}.00000000` }] });
    expect(bill.summary.provisionalEndingBalances).toEqual([]);
    expect(bill.providers.find((provider) => provider.providerResourceId === resourceId))
      .toMatchObject({ apiCost: `${cost}.00000000`, apiSpendStatus: "CALCULABLE",
        openingBalance: null, endingBalance: null });
    // 断言迁移（WP2-S5 / AFR-07 场景1）：缺期初不再产生 API_OPENING_BALANCE_MISSING
    // 缺口（费用已计价时不显示"待补期初"、不据此隐藏费用估算）。
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_OPENING_BALANCE_MISSING");
    expect(bill.sourceFacts.providerFinance?.resourceViews.find((view) => view.resourceId === resourceId)?.accounts[0])
      .toMatchObject({ currency: "CNY", hasMonthlyApiCostFacts: true });
  });

  it("does not let a CNY aggregate cover currency-less imported usage when a USD account also exists", async () => {
    const f = await fixture();
    await usage(f, "2026-09-15T12:00:00+08:00", "NOT_MIGRATED", null);
    await db.insertInto("provider_finance_event").values([
      { ...f.event, event_type: "API_OPENING_BALANCE", account_currency: "USD", account_amount: "0",
        occurred_at: new Date("2026-09-01T00:00:00+08:00"), idempotency_key: randomUUID() },
      { ...f.event, event_type: "API_HISTORICAL_USAGE_COST", account_amount: "-37.2501",
        occurred_at: new Date("2026-09-21T00:00:00+08:00"), idempotency_key: randomUUID() },
    ]).execute();
    const start = new Date("2026-09-01T00:00:00+08:00");
    expect(await loadApiCostGaps(db, f.enterpriseId, start, octoberStart))
      .toEqual([expect.objectContaining({ code: "API_USAGE_COST_NOT_MIGRATED", count: "1" })]);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    // 断言迁移（WP2-S5 B）：apiSpendReason 切估算缺口码口径；totalSpends 切估算分列
    // （缺币种遗留行不入桶，历史聚合金额不再并入 summary 金额段，同 test 6 注）。
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "NOT_MIGRATED:1",
      totalSpends: [] });
  });

  it("preserves NOT_MIGRATED as unknown when no aggregate exists", async () => {
    const f = await fixture();
    await usage(f, "2026-09-15T12:00:00+08:00", "NOT_MIGRATED", null);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    // 断言迁移（WP2-S5 B）：apiSpendReason 切估算缺口码口径。
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "NOT_MIGRATED:1", totalSpends: [] });
  });

  it("uses a covering historical total once and does not apply it to an earlier comparison window", async () => {
    const f = await fixture();
    await usage(f, "2026-09-15T12:00:00+08:00", "NOT_MIGRATED", null);
    await db.insertInto("provider_finance_event").values({ ...f.event,
      event_type: "API_HISTORICAL_USAGE_COST", account_amount: "-37.2501",
      occurred_at: new Date("2026-09-21T00:00:00+08:00"), idempotency_key: randomUUID() }).execute();
    const start = new Date("2026-09-01T00:00:00+08:00");
    expect(await loadApiCostGaps(db, f.enterpriseId, start, octoberStart)).toEqual([]);
    expect(await loadWindowOperatingFinance(db, f.enterpriseId, start, octoberStart))
      .toMatchObject({ totalSpends: [{ currency: "CNY", amount: "37.25010000" }], incompleteReason: null });
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    // 断言迁移（WP2-S5 B / WP1 合同 §4 裁定 1 记录的权威分工）：历史聚合覆盖语义属
    // loadApiCostGaps（缺口段/home 窗口段，上方断言照旧）；账单 summary 金额权威为
    // loadApiCostEstimation（不消费历史聚合事件）→ NOT_MIGRATED 行计缺口、金额置缺。
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendStatus: "INCOMPLETE", apiSpendReason: "NOT_MIGRATED:1", totalSpends: [] });
    expect(await loadWindowOperatingFinance(db, f.enterpriseId, start, new Date("2026-09-16T00:00:00+08:00")))
      .toMatchObject({ totalSpends: [], incompleteReason: "API_USAGE_COST_NOT_MIGRATED:1" });
  });
});
