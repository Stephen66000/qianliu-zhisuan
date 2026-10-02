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
    expect(bill.summary).toMatchObject({ apiCost: "0.00000000", totalCost: "0.00000000",
      apiSpendStatus: "CALCULABLE", apiSpendReason: null, openingBalance: null, endingBalance: null,
      totalSpends: [{ currency: "CNY", amount: "0.00000000" }] });
    expect(bill.summary.rechargeAmounts).toEqual([{ currency: "CNY", amount: "0.00000000" }]);
    expect(bill.providers[0]).toMatchObject({ openingBalance: null, endingBalance: null,
      apiCost: "0.00000000", apiSpendStatus: "CALCULABLE" });
    expect(bill.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      "API_BALANCE_COST_UNKNOWN", "API_MONTH_OPENING_COST_UNKNOWN",
    ]));
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_COST_UNKNOWN");
    expect(bill.gaps.map((gap) => gap.code)).not.toContain("API_OPENING_BALANCE_MISSING");
    expect(bill.gaps.find((gap) => gap.code === "API_MONTH_OPENING_COST_UNKNOWN"))
      .toMatchObject({ requestRangeFrom: "2026-09-30T15:59:59.000Z",
        message: expect.stringContaining("1 个请求") });
    expect(bill.gaps.find((gap) => gap.code === "API_MONTH_OPENING_COST_UNKNOWN")?.message)
      .toContain("2026-09-30 23:59:59 ~ 2026-09-30 23:59:59（北京时间）");
    expect(billIncompleteReason(bill)).toBeNull();
    expect((await countFinanceGaps(db, f.enterpriseId, octoberStart, octoberEnd))
      .find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("0");
  });

  it("fails closed for an actual October unknown expense and retains its known part", async () => {
    const f = await fixture();
    await usage(f, "2026-10-01T00:00:00+08:00", "UNKNOWN_COST", null);
    const unknownOnly = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    expect(unknownOnly.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "API_COST_UNKNOWN", apiSpends: [], totalSpends: [] });
    await usage(f, "2026-10-01T00:00:01+08:00", "PRICED_USAGE", "3.25");
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null, apiSpendStatus: "INCOMPLETE",
      apiSpendReason: "API_COST_UNKNOWN", openingBalance: "240.00000000", endingBalance: null,
      apiSpends: [{ currency: "CNY", amount: "3.25000000" }] });
    expect(bill.gaps.find((gap) => gap.code === "API_COST_UNKNOWN"))
      .toMatchObject({ requestRangeFrom: "2026-09-30T16:00:00.000Z",
        message: expect.stringContaining("Period API 本期费用") });
    expect(bill.gaps.find((gap) => gap.code === "API_COST_UNKNOWN")?.message)
      .toContain("2026-10-01 00:00:00");
    expect(billIncompleteReason(bill)).toBe("API_COST_UNKNOWN");
    expect((await countFinanceGaps(db, f.enterpriseId, octoberStart, octoberEnd))
      .find((gap) => gap.code === "API_USAGE_COST_UNKNOWN")?.count).toBe("1");
  });

  it("renders an established zero-cost currency even when all balance facts are normal", async () => {
    const f = await fixture();
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-10");
    expect(bill.summary).toMatchObject({ totalCost: "0.00000000", apiSpendReason: null,
      openingBalance: "240.00000000", endingBalance: "240.00000000",
      totalSpends: [{ currency: "CNY", amount: "0.00000000" }] });
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
    expect(bill.summary.apiCost).toBeNull();
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
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendStatus: "INCOMPLETE", apiSpendReason: "API_USAGE_COST_NOT_MIGRATED",
      totalSpends: [{ currency: "CNY", amount: "42.00000000" }] });
  });

  it("does not manufacture September zero from a future October opening account", async () => {
    const f = await fixture("2026-10-01T00:00:00+08:00");
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "API_OPENING_BALANCE_MISSING", totalSpends: [] });
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
    expect(bill.providers.find((provider) => provider.providerResourceId === resourceId))
      .toMatchObject({ apiCost: `${cost}.00000000`, apiSpendStatus: "CALCULABLE",
        openingBalance: null, endingBalance: null });
    expect(bill.gaps).toContainEqual(expect.objectContaining({ code: "API_OPENING_BALANCE_MISSING",
      providerResourceId: resourceId }));
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
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "API_USAGE_COST_NOT_MIGRATED",
      totalSpends: [{ currency: "CNY", amount: "37.25010000" }] });
  });

  it("preserves NOT_MIGRATED as unknown when no aggregate exists", async () => {
    const f = await fixture();
    await usage(f, "2026-09-15T12:00:00+08:00", "NOT_MIGRATED", null);
    const bill = await new OperatingBillRepository(db, "DARK").getBill(f.enterpriseId, "2026-09");
    expect(bill.summary).toMatchObject({ apiCost: null, totalCost: null,
      apiSpendReason: "API_USAGE_COST_NOT_MIGRATED", totalSpends: [] });
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
    expect(bill.summary).toMatchObject({ apiCost: "37.25010000", totalCost: "37.25010000",
      apiSpendStatus: "CALCULABLE", totalSpends: [{ currency: "CNY", amount: "37.25010000" }] });
    expect(await loadWindowOperatingFinance(db, f.enterpriseId, start, new Date("2026-09-16T00:00:00+08:00")))
      .toMatchObject({ totalSpends: [], incompleteReason: "API_USAGE_COST_NOT_MIGRATED:1" });
  });
});
