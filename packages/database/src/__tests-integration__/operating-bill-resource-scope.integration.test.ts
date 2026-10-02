import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, OperatingBillRepository, ProviderFinanceRepository } from "../index.js";
import { insertOpeningBalanceTx } from "../repositories/provider-finance-activation-writes.js";
import { loadMonthlyOperatingCosts } from "../repositories/monthly-operating-cost.js";
import { operatingBillMonthRange } from "../repositories/operating-bill-month.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const archivedAt = new Date("2026-09-30T20:29:00+08:00");
const octoberAt = new Date("2026-10-01T01:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("operating_bill_resource_scope");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function tenant() {
  const enterpriseId = randomUUID(); const adminId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Monthly archived resources" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: `scope-${adminId}`, password_hash: "unused", status: "ACTIVE" }).execute();
  return { enterpriseId, adminId };
}

async function resource(enterpriseId: string, input: {
  archivedAt?: Date | null; providerArchivedAt?: Date | null; mode?: "API" | "CODING_PLAN";
} = {}) {
  const providerId = randomUUID(); const resourceId = randomUUID();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: `scope-${providerId.slice(0, 8)}`, name: "Scope provider", adapter_type: "OPENAI_COMPATIBLE",
    archived_at: input.providerArchivedAt ?? null }).execute();
  await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
    provider_id: providerId, name: "Scope resource", mode: input.mode ?? "API", credential_type: "API_KEY",
    created_at: new Date("2026-08-01T00:00:00+08:00"), archived_at: input.archivedAt ?? null }).execute();
  return resourceId;
}

async function reports(enterpriseId: string, month: string, expectedIds: string[]) {
  const { start, end } = operatingBillMonthRange(month);
  const [legacyCosts, legacyBill, financeViews, financeBill] = await Promise.all([
    loadMonthlyOperatingCosts(db, enterpriseId, start, end),
    new OperatingBillRepository(db, "OFF").getBill(enterpriseId, month),
    new ProviderFinanceRepository(db).listResourceFinanceViews(enterpriseId, month,
      new Date(Math.min(Date.now(), end.getTime() - 1))),
    new OperatingBillRepository(db, "DARK").getBill(enterpriseId, month),
  ]);
  for (const ids of [legacyCosts.resources.map((row) => row.resourceId),
    legacyBill.providers.map((row) => row.providerResourceId), financeViews.map((row) => row.resourceId),
    financeBill.providers.map((row) => row.providerResourceId)]) {
    expect(ids.sort()).toEqual([...expectedIds].sort());
  }
  for (const bill of [legacyBill, financeBill]) {
    expect(bill.gaps.filter((gap) => gap.providerResourceId
      && !expectedIds.includes(gap.providerResourceId))).toEqual([]);
    expect(bill.sourceFacts.balanceBridgeFacts?.map((row) => row.providerResourceId).sort())
      .toEqual(legacyCosts.resources.filter((row) => row.mode === "API").map((row) => row.resourceId).sort());
  }
  return { legacyCosts, legacyBill, financeViews, financeBill };
}

async function pricedUsage(enterpriseId: string, resourceId: string, at: Date) {
  const principalId = randomUUID(); const keyId = randomUUID(); const requestId = randomUUID();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "Scope user" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: "ql-scope", key_digest: randomUUID() }).execute();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
    principal_id: principalId, principal_key_id: keyId, protocol: "OPENAI_CHAT",
    unified_model: "scope-model", status: "SUCCEEDED", started_at: at, finished_at: at }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: enterpriseId, provider_resource_id: resourceId, attempt_no: 1,
    upstream_model: "scope-model", started_at: at, finished_at: at, response_committed: true,
    http_status: 200 }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
    enterprise_id: enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
    input_tokens: 1n, output_tokens: 1n, cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: requestId, created_at: at })
    .returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId, ai_request_id: requestId,
    upstream_attempt_id: attempt.id, usage_event_id: usage.id, provider_resource_id: resourceId,
    principal_id: principalId, resource_mode: "API", raw_input_tokens: 1n, raw_output_tokens: 1n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: "7", api_cost_currency: "CNY",
    api_cost_status: "PRICED_USAGE", usage_quality: "PROVIDER_REPORTED", settled_at: at,
    created_at: at, billing_rule_snapshot: { currency: "CNY" } }).execute();
}

describe("operating bill resource scope", () => {
  it("keeps the pre-archive month and excludes empty later months for resource or provider archives", async () => {
    const { enterpriseId } = await tenant();
    const resourceArchived = await resource(enterpriseId, { archivedAt });
    const providerArchived = await resource(enterpriseId, { providerArchivedAt: archivedAt });
    const archivedAtMonthStart = await resource(enterpriseId, {
      archivedAt: new Date("2026-10-01T00:00:00+08:00"),
    });
    await pricedUsage(enterpriseId, resourceArchived, new Date("2026-09-25T12:00:00+08:00"));
    const september = await reports(enterpriseId, "2026-09", [resourceArchived, providerArchived, archivedAtMonthStart]);
    expect(september.financeBill.summary.apiSpends).toEqual([{ currency: "CNY", amount: "7.00000000" }]);
    const october = await reports(enterpriseId, "2026-10", [archivedAtMonthStart]);
    expect(october.financeBill.summary.apiCost).toBe("0.00000000");
    // Archiving at the boundary is not archiving before that month.
    await reports(enterpriseId, "2026-11", []);
  });

  it("retains archived resources with real monthly usage and its cost", async () => {
    const { enterpriseId } = await tenant();
    const resourceId = await resource(enterpriseId, { archivedAt, providerArchivedAt: archivedAt });
    await pricedUsage(enterpriseId, resourceId, octoberAt);
    const october = await reports(enterpriseId, "2026-10", [resourceId]);
    expect(october.legacyCosts.summary.ledgerApiCost).toBe("7.00000000");
    expect(october.financeViews[0]!.accounts[0]!.monthlyApiCost).toBe("7.00000000");
    expect(october.financeBill.summary.apiSpends).toEqual([{ currency: "CNY", amount: "7.00000000" }]);
    expect(october.financeBill.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "API_OPENING_BALANCE_MISSING", providerResourceId: resourceId }),
    ]));
  });

  it("carries both zero and nonzero financial accounts after resource and provider archives", async () => {
    const { enterpriseId, adminId } = await tenant();
    const ids: string[] = [];
    for (const amount of ["0", "100"]) {
      const resourceId = await resource(enterpriseId, { archivedAt, providerArchivedAt: archivedAt });
      ids.push(resourceId);
      await db.transaction().execute((trx) => insertOpeningBalanceTx(trx, {
        enterpriseId, adminId, resourceId, accountAmount: amount, accountCurrency: "CNY",
        description: "Historical opening", evidenceRef: "scope-test", idempotencyKey: randomUUID(),
        source: "MIGRATION",
      }));
    }
    const october = await reports(enterpriseId, "2026-10", ids);
    expect(october.financeViews.find((row) => row.resourceId === ids[0])!.accounts[0])
      .toMatchObject({ monthOpeningState: "NORMAL", monthOpeningBalance: "0.00000000",
        balanceState: "NORMAL", balance: "0.00000000" });
    expect(october.financeBill.summary.openingBalances).toEqual([{ currency: "CNY", amount: "100.00000000" }]);
    expect(october.financeBill.summary.endingBalances).toEqual([{ currency: "CNY", amount: "100.00000000" }]);
    expect(october.financeBill.gaps).toEqual([]);
  });

  it("retains monthly purchase and subscription payment facts even without API accounts", async () => {
    const { enterpriseId, adminId } = await tenant();
    const purchaseResource = await resource(enterpriseId, { archivedAt });
    const subscriptionResource = await resource(enterpriseId, { providerArchivedAt: archivedAt, mode: "CODING_PLAN" });
    await sql`INSERT INTO resource_purchase_record
      (enterprise_id, provider_resource_id, purchase_type, amount, currency, purchased_at, source, created_by)
      VALUES (${enterpriseId}::uuid, ${purchaseResource}::uuid, 'API_RECHARGE', 33, 'CNY',
        ${octoberAt}, 'ADMIN', ${adminId}::uuid)`.execute(db);
    await new ProviderFinanceRepository(db).recordSubscription({ enterpriseId, adminId,
      resourceId: subscriptionResource, accountAmount: "20", accountCurrency: "CNY", cashPaidCny: "20",
      occurredAt: octoberAt, idempotencyKey: randomUUID(), kind: "PURCHASE", productName: "Scope plan",
      periodStart: new Date("2026-10-01T00:00:00+08:00"),
      periodEndExclusive: new Date("2026-11-01T00:00:00+08:00") });
    const october = await reports(enterpriseId, "2026-10", [purchaseResource, subscriptionResource]);
    expect(october.legacyCosts.resources.find((row) => row.resourceId === purchaseResource)?.rechargeAmount)
      .toBe("33.00000000");
    expect(october.financeBill.summary.packageCosts).toEqual([{ currency: "CNY", amount: "20.00000000" }]);
    expect(await new ProviderFinanceRepository(db).getMonthlyFinanceSummary(enterpriseId, "2026-10"))
      .toMatchObject({ apiRecharges: [{ currency: "CNY", amount: "33.00000000" }],
        codingPlanFixedCostCny: "20.00000000", cashOutflowCny: "53.00000000" });
  });

  it("preserves legacy zero balance evidence without turning it into a finance opening", async () => {
    const { enterpriseId, adminId } = await tenant();
    const snapshotResource = await resource(enterpriseId, { archivedAt });
    const manualResource = await resource(enterpriseId, { providerArchivedAt: archivedAt });
    await db.insertInto("provider_resource_operating_snapshot").values({ enterprise_id: enterpriseId,
      provider_resource_id: snapshotResource, version: 1, source: "ADMIN", collected_at: archivedAt,
      currency: "CNY", current_balance: "0" }).execute();
    await new OperatingBillRepository(db).recordOpeningBalance({ enterpriseId, adminId, month: "2026-09",
      providerResourceId: manualResource, amount: "0", currency: "CNY", reason: "Legacy registration" });
    const october = await reports(enterpriseId, "2026-10", [snapshotResource, manualResource]);
    expect(october.legacyCosts.resources.find((row) => row.resourceId === snapshotResource)?.openingBalance)
      .toBe("0.00000000");
    expect(october.financeViews.every((row) => row.accounts.length === 0)).toBe(true);
  });
});
