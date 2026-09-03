import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, GatewayLedgerRepository, migrateToLatest } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let cookie: string;
const enterpriseId = randomUUID(); const adminId = randomUUID();
const apiResourceId = randomUUID(); const planResourceId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_api");
  db = createKysely(pg.connectionString); await migrateToLatest(db);
  const providerId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Finance API" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "finance-api-admin",
    password_hash: await hashPassword("Finance-API-Test!"), status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "deepseek",
    name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE",
  }).execute();
  await db.insertInto("provider_resource").values([
    { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: "API", mode: "API", credential_type: "API_KEY" },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: "Plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
  ]).execute();
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db); await app.ready();
  const login = await app.inject({ method: "POST", url: "/auth/login",
    payload: { username: "finance-api-admin", password: "Finance-API-Test!" } });
  const setCookie = login.headers["set-cookie"];
  cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;
}, 120_000);

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); }, 60_000);

describe("provider finance routes", () => {
  it("does not expose ACTIVE writes before the database contract is activated", async () => {
    try {
      const response = await app.inject({ method: "POST",
        url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
        payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "finance_write_contract_inactive" });
    } finally {
      await sql`
        INSERT INTO provider_finance_runtime_state
          (enterprise_id, strict_writes_enabled, activated_at,
           activated_by_admin_user_id, updated_at)
        VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
      `.execute(db);
    }
  });

  it("records opening and recharge then returns the same projected balance", async () => {
    const opening = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/opening-balances`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "50",
        occurred_at: "2026-08-31T16:00:00.000Z", evidence_ref: "opening",
        idempotency_key: randomUUID() } });
    expect(opening.statusCode).toBe(201);
    const openingId = opening.json().event.id as string;
    const rechargeKey = randomUUID();
    const rechargePayload = { account_currency: "CNY", account_amount: "100", cash_paid_cny: "100",
      occurred_at: "2026-09-02T01:00:00.000Z", external_reference: "api-pay-1",
      idempotency_key: rechargeKey };
    const recharge = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: rechargePayload });
    expect(recharge.statusCode).toBe(201);
    const rechargeId = recharge.json().event.id as string;
    const rechargeReplay = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: rechargePayload });
    expect(rechargeReplay.statusCode).toBe(200);
    expect(rechargeReplay.json().event).toMatchObject({ id: rechargeId, replayed: true });
    const balance = await app.inject({ method: "GET",
      url: `/provider-resources/${apiResourceId}/finance/balance?currency=CNY&as_of=2026-09-02T02:00:00.000Z`,
      headers: { cookie } });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ state: "NORMAL", balance: "150.00000000" });
    const correction = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/opening-balance-corrections`, headers: { cookie },
      payload: { opening_event_id: openingId, account_currency: "CNY", account_amount: "10",
        occurred_at: "2026-08-31T16:00:00.000Z", evidence_ref: "correction",
        idempotency_key: randomUUID() } });
    expect(correction.statusCode).toBe(201);
    const reversal = await app.inject({ method: "POST",
      url: `/provider-finance-events/${rechargeId}/reversal`, headers: { cookie },
      payload: { reason: "wrong recharge", evidence_ref: "reversal", idempotency_key: randomUUID() } });
    expect(reversal.statusCode).toBe(201);
    const createdCase = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/reconciliation-cases`, headers: { cookie },
      payload: { account_currency: "CNY", provider_confirmed_balance: "65",
        balance_as_of: "2026-09-02T02:00:00.000Z", evidence_ref: "provider-proof" } });
    expect(createdCase.statusCode).toBe(201);
    const caseId = createdCase.json().case.id as string;
    const confirmKey = randomUUID();
    const confirmed = await app.inject({ method: "POST",
      url: `/provider-finance-reconciliation-cases/${caseId}/confirm`, headers: { cookie },
      payload: { expected_version: 1, note: "confirm", idempotency_key: confirmKey } });
    expect(confirmed.statusCode).toBe(200);
    const replay = await app.inject({ method: "POST",
      url: `/provider-finance-reconciliation-cases/${caseId}/confirm`, headers: { cookie },
      payload: { expected_version: 1, note: "confirm", idempotency_key: confirmKey } });
    expect(replay.statusCode).toBe(200);
    const after = await app.inject({ method: "GET",
      url: `/provider-resources/${apiResourceId}/finance/balance?currency=CNY&as_of=2026-09-02T02:00:00.000Z`,
      headers: { cookie } });
    expect(after.json()).toMatchObject({ state: "NORMAL", balance: "65.00000000" });
    const history = await app.inject({ method: "GET",
      url: `/provider-resources/${apiResourceId}/finance/events?type=API_RECHARGE`,
      headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ total: 1,
      items: [expect.objectContaining({ id: rechargeId, eventType: "API_RECHARGE" })] });
    const cases = await app.inject({ method: "GET",
      url: "/provider-finance/reconciliation-cases?status=RESOLVED", headers: { cookie } });
    expect(cases.statusCode).toBe(200);
    expect(cases.json()).toMatchObject({ total: 1,
      items: [expect.objectContaining({ id: caseId, status: "RESOLVED" })] });
    const resources = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(resources.statusCode).toBe(200);
    expect(resources.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: apiResourceId, mode: "API",
        accounts: [expect.objectContaining({ currency: "CNY", balanceState: "NORMAL",
          balance: "65.00000000", monthlyRecharge: "0.00000000" })] }),
    ]));
  });

  it("records a Coding Plan and exposes its service period", async () => {
    const response = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/subscriptions`, headers: { cookie },
      payload: { kind: "PURCHASE", product_name: "Kimi Coding Plan",
        account_currency: "CNY", account_amount: "199", cash_paid_cny: "199",
        occurred_at: "2026-09-02T00:00:00.000Z", service_period_start: "2026-09-02",
        external_reference: "plan-pay-1", idempotency_key: randomUUID() } });
    expect(response.statusCode).toBe(201);
    const periodId = response.json().periodId as string;
    const periods = await app.inject({ method: "GET",
      url: `/provider-resources/${planResourceId}/subscription-periods`, headers: { cookie } });
    expect(periods.statusCode).toBe(200);
    expect(periods.json().periods).toEqual([expect.objectContaining({
      product_name: "Kimi Coding Plan",
      period_start: "2026-09-01T16:00:00.000Z",
      period_end_exclusive: "2026-10-01T16:00:00.000Z",
      current_status: "ACTIVE",
      fixed_fee_amount: "199.00000000", fixed_fee_currency: "CNY",
      fixed_cash_paid_cny: "199.00000000",
      token_usage: expect.objectContaining({ input_tokens: "0", output_tokens: "0",
        cache_tokens: "0", reasoning_tokens: "0", true_tokens: "0" }),
    })]);
    const usage = await app.inject({ method: "GET",
      url: `/provider-subscription-periods/${periodId}/usage`, headers: { cookie } });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toMatchObject({ period: { id: periodId },
      tokenUsage: { request_count: "0", true_tokens: "0" } });
    const summary = await app.inject({ method: "GET",
      url: "/provider-finance/summary?month=2026-09", headers: { cookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({
      cashOutflowCny: "199.00000000", codingPlanFixedCostCny: "199.00000000",
      operatingCostCny: "199.00000000", complete: true,
    });
    const resourceFinance = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(resourceFinance.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: planResourceId,
        monthlyPlanCashCny: "199.00000000",
        currentPeriod: expect.objectContaining({ id: periodId, trueTokens: "0" }) }),
    ]));
    const ledger = new GatewayLedgerRepository(db);
    for (const [index, tokens] of [300n, 100n].entries()) {
      const principalId = randomUUID(); const keyId = randomUUID(); const requestId = randomUUID();
      await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
        type: "EMPLOYEE", name: `Finance Employee ${index + 1}`, department_label: null,
        person_id: null, owner_person_id: null }).execute();
      await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
        principal_id: principalId, key_prefix: `ql-finance-${index}`, key_digest: randomUUID(),
        allowed_model_ids: [], ip_allowlist: [], expires_at: null, quota_limit: null,
        concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
      await ledger.createRequest({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: keyId, protocol: "OPENAI_CHAT",
        unified_model: "kimi-k2", unified_model_id: null });
      const attempt = await ledger.createAttempt({ ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: planResourceId,
        upstream_model: "kimi-k2" });
      await ledger.createUsageAndLedgerLineIfAbsent({ usage: { ai_request_id: requestId,
        enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
        provider_resource_id: planResourceId, input_tokens: tokens, output_tokens: 0n,
        cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `${requestId}:attempt1` }, ledger_line: { ai_request_id: requestId,
        enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
        provider_resource_id: planResourceId, principal_id: principalId,
        resource_mode: "CODING_PLAN", raw_input_tokens: tokens, raw_output_tokens: 0n,
        raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: null,
        api_cost_status: "NOT_APPLICABLE", settled_at: new Date("2026-09-03T00:00:00.000Z"),
        usage_quality: "PROVIDER_REPORTED" } });
      const finishedAt = new Date("2026-09-03T00:00:01.000Z");
      await ledger.updateAttemptResult(attempt.id, { http_status: 200,
        response_committed: true, first_byte_at: finishedAt, finished_at: finishedAt,
        error_classification: null, error_code: null });
      await ledger.finalizeLedgerSettlementIfAbsent({ ai_request_id: requestId,
        enterprise_id: enterpriseId, principal_id: principalId,
        total_input_tokens: tokens, total_output_tokens: 0n, total_cache_tokens: 0n,
        total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0",
        usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED" });
    }
    const providerResources = await app.inject({ method: "GET",
      url: "/provider-resources", headers: { cookie } });
    expect(providerResources.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: planResourceId,
        finance: expect.objectContaining({ monthlyPlanCashCny: "199.00000000" }) }),
    ]));
    const utilization = await app.inject({ method: "GET",
      url: "/provider-resources/utilization?month=2026-09", headers: { cookie } });
    expect(utilization.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: planResourceId, packageCost: "199.00000000",
        servicePeriodStart: "2026-09-01", servicePeriodEnd: "2026-10-01" }),
      expect.objectContaining({ resourceId: apiResourceId, currentBalance: "65.00000000" }),
    ]));
    const dashboard = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(dashboard.json()).toMatchObject({ monthlyPackagePayment: "199.00000000",
      monthlyTotalSpend: "199.00000000" });
    const bill = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09", headers: { cookie } });
    expect(bill.json()).toMatchObject({ status: "DRAFT",
      summary: { packageCost: "199.00000000", totalCost: "199.00000000",
        unallocatedCost: "0.00000000" },
      sourceFacts: { providerFinance: { resourceViews: expect.any(Array) } } });
    expect(bill.json().subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalName: "Finance Employee 1",
        packageAllocatedCost: "149.25000000" }),
      expect.objectContaining({ principalName: "Finance Employee 2",
        packageAllocatedCost: "49.75000000" }),
    ]));
    const departments = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09/departments", headers: { cookie } });
    expect(departments.json()).toMatchObject({
      totals: { packageCost: "199.00000000", totalCost: "199.00000000" },
      conservation: { status: "BALANCED" },
    });
  });

  it("requires and consumes a persisted duplicate confirmation", async () => {
    const base = { account_currency: "CNY", account_amount: "4", cash_paid_cny: "4",
      occurred_at: "2026-09-02T07:00:00.000Z" };
    const first = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { ...base, idempotency_key: randomUUID() } });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { ...base, idempotency_key: randomUUID() } });
    expect(duplicate.statusCode).toBe(409);
    const detail = duplicate.json().detail as {
      candidateId: string; confirmationToken: string; requestHash: string;
    };
    const confirmationKey = randomUUID();
    const confirmationPayload = { confirmation_token: detail.confirmationToken,
      request_hash: detail.requestHash, idempotency_key: confirmationKey };
    const confirmed = await app.inject({ method: "POST",
      url: `/provider-finance-duplicate-candidates/${detail.candidateId}/confirm`,
      headers: { cookie }, payload: confirmationPayload });
    expect(confirmed.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST",
      url: `/provider-finance-duplicate-candidates/${detail.candidateId}/confirm`,
      headers: { cookie }, payload: confirmationPayload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().event).toMatchObject({ id: confirmed.json().event.id, replayed: true });
  });

  it("rejects cross-mode finance writes", async () => {
    const response = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
    expect(response.statusCode).toBe(409);
    const duplicateReference = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "3", cash_paid_cny: "3",
        occurred_at: "2026-09-02T06:00:00.000Z", external_reference: "api-pay-1",
        idempotency_key: randomUUID() } });
    expect(duplicateReference.statusCode).toBe(409);
    expect(duplicateReference.json()).toMatchObject({ error: "finance_contract_conflict" });
    const missingPeriods = await app.inject({ method: "GET",
      url: `/provider-resources/${randomUUID()}/subscription-periods`, headers: { cookie } });
    expect(missingPeriods.statusCode).toBe(404);
    const oldSnapshotWrite = await app.inject({ method: "PATCH",
      url: `/provider-resources/${apiResourceId}`, headers: { cookie },
      payload: { expected_version: 1, operating_snapshot: { source: "ADMIN",
        collected_at: "2026-09-03T00:00:00.000Z", currency: "CNY",
        current_balance: "999" } } });
    expect(oldSnapshotWrite.statusCode).toBe(409);
    expect(oldSnapshotWrite.json()).toMatchObject({ error: "finance_entry_moved" });
  });

  it("DARK模式允许只读但隐藏全部资金写入口", async () => {
    const prior = process.env.PROVIDER_FINANCE_MODE;
    process.env.PROVIDER_FINANCE_MODE = "DARK";
    const { buildControlApi } = await import("../server.js");
    const darkApp = buildControlApi(db); await darkApp.ready();
    try {
      const read = await darkApp.inject({ method: "GET",
        url: `/provider-resources/${apiResourceId}/finance/balance?currency=CNY`, headers: { cookie } });
      expect(read.statusCode).toBe(200);
      const session = await darkApp.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
      expect(session.json().providerFinanceMode).toBe("DARK");
      const resources = await darkApp.inject({ method: "GET",
        url: "/provider-resources", headers: { cookie } });
      expect(resources.json().resources.find((item: { id: string }) => item.id === apiResourceId)
        .finance).toBeTruthy();
      const write = await darkApp.inject({ method: "POST",
        url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
        payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
      expect(write.statusCode).toBe(404);
      const close = await darkApp.inject({ method: "POST",
        url: "/operating-bills/2026-09/close", headers: { cookie },
        payload: { allow_incomplete: true, note: "finance projection freeze" } });
      expect(close.statusCode).toBe(200);
      expect(close.json()).toMatchObject({ status: "CLOSED",
        sourceFacts: { providerFinance: { resourceViews: expect.any(Array) },
          departmentBill: { conservation: { status: "BALANCED" } } } });
    } finally {
      await darkApp.close();
      if (prior === undefined) delete process.env.PROVIDER_FINANCE_MODE;
      else process.env.PROVIDER_FINANCE_MODE = prior;
    }
  });
});
