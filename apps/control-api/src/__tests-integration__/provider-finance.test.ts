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

  it("automatic renewal control is tenant-authenticated and cancellation is idempotent", async () => {
    const providerId=randomUUID(), resourceId=randomUUID();
    await db.insertInto("provider").values({id:providerId,enterprise_id:enterpriseId,code:"kimi",name:"Kimi",adapter_type:"OPENAI_COMPATIBLE"}).execute();
    await db.insertInto("provider_resource").values({id:resourceId,enterprise_id:enterpriseId,provider_id:providerId,name:"Kimi",mode:"CODING_PLAN",credential_type:"SUBSCRIPTION_SESSION"}).execute();
    const url=`/provider-resources/${resourceId}/finance/auto-renewal`;
    expect((await app.inject({method:"POST",url:url+"/cancel",payload:{}})).statusCode).toBe(401);
    const initial=await app.inject({method:"GET",url,headers:{cookie}});
    expect(initial.statusCode).toBe(200);expect(initial.json()).toMatchObject({enabled:true});
    for (let i=0;i<2;i++) {
      const cancelled=await app.inject({method:"POST",url:url+"/cancel",headers:{cookie},payload:{}});
      expect(cancelled.statusCode).toBe(200);expect(cancelled.json()).toEqual({enabled:false});
    }
    expect((await app.inject({method:"GET",url,headers:{cookie}})).json().enabled).toBe(false);
    expect((await app.inject({method:"POST",url:`/provider-resources/${randomUUID()}/finance/auto-renewal/cancel`,headers:{cookie},payload:{}})).statusCode).toBe(404);
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
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId, provider_resource_id: planResourceId, version: 1,
      source: "ADMIN", collected_at: new Date("2026-09-02T00:00:00.000Z"),
      total_quota: "1000", quota_unit: "TOKEN", used_quota: null, remaining_quota: null,
      effective_from: new Date("2026-09-01T16:00:00.000Z"),
      effective_until: new Date("2026-10-01T16:00:00.000Z"),
      usage_calculation: "SYSTEM_LEDGER",
    }).execute();
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
      operatingCostCny: "199.00000000", currentApiBalances: [
        { currency: "CNY", amount: "65.00000000" },
      ], currentApiBalancesComplete: true, complete: true,
    });
    const resourceFinance = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(resourceFinance.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: planResourceId,
        monthlyPlanCashCny: "199.00000000",
        currentPeriod: expect.objectContaining({ id: periodId, trueTokens: "0" }) }),
    ]));
    const ledger = new GatewayLedgerRepository(db);
    const planRequestIds: string[] = [];
    for (const [index, tokens] of [300n, 100n, 50n].entries()) {
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
      planRequestIds.push(requestId);
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
        deducted_quota: tokens,
        api_cost_status: "NOT_APPLICABLE", settled_at: new Date("2026-09-03T00:00:00.000Z"),
        usage_quality: "PROVIDER_REPORTED" } });
      const finishedAt = new Date("2026-09-03T00:00:01.000Z");
      await ledger.updateAttemptResult(attempt.id, { http_status: 200,
        response_committed: true, first_byte_at: finishedAt, finished_at: finishedAt,
        error_classification: null, error_code: null });
      await ledger.finalizeLedgerSettlementIfAbsent({ ai_request_id: requestId,
        enterprise_id: enterpriseId, principal_id: principalId,
        total_input_tokens: tokens, total_output_tokens: 0n, total_cache_tokens: 0n,
        total_reasoning_tokens: 0n, total_deducted_quota: tokens, total_api_cost: "0",
        usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED" });
      if (index === 2) {
        await db.updateTable("ledger_line").set({ created_at: new Date("2026-08-31T15:59:00.000Z") })
          .where("enterprise_id", "=", enterpriseId).where("ai_request_id", "=", requestId).execute();
      }
    }
    const projectId = randomUUID();
    await db.insertInto("principal").values({ id: projectId, enterprise_id: enterpriseId,
      type: "PROJECT", name: "Finance Project", department_label: null,
      person_id: null, owner_person_id: null }).execute();
    await db.insertInto("operating_bill_request_project_assignment").values({
      enterprise_id: enterpriseId, ai_request_id: planRequestIds[0]!,
      project_principal_id: projectId, assigned_by: adminId, reason: "项目请求只归项目",
    }).execute();
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
        totalQuota: "1000", usedQuota: "450", remainingQuota: "550",
        utilizationRate: "0.45000000", utilizationBasis: "CODING_PLAN_SUBSCRIPTION_PERIOD",
        notCalculableReason: null, servicePeriodStart: "2026-09-02",
        servicePeriodEnd: "2026-10-02" }),
      expect.objectContaining({ resourceId: apiResourceId, currentBalance: "65.00000000" }),
    ]));
    const dashboard = await app.inject({ method: "GET", url: "/dashboard", headers: { cookie } });
    expect(dashboard.json()).toMatchObject({ monthlyPackagePayment: "199.00000000",
      monthlyTotalSpend: "199.00000000" });
    const bill = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09", headers: { cookie } });
    const billBody = bill.json();
    expect(billBody).toMatchObject({ status: "DRAFT",
      summary: { packageCost: "199.00000000", totalCost: "199.00000000",
        unallocatedCost: "0.00000000" },
      sourceFacts: { providerFinance: { resourceViews: expect.any(Array) } } });
    expect(billBody.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalName: "Finance Employee 1",
        packageAllocatedCost: "0.00000000" }),
      expect.objectContaining({ principalName: "Finance Employee 2",
        packageAllocatedCost: "44.22000000" }),
      expect.objectContaining({ principalName: "Finance Employee 3",
        packageAllocatedCost: "22.11000000" }),
      expect.objectContaining({ principalName: "Finance Project", principalType: "PROJECT",
        packageAllocatedCost: "132.67000000" }),
    ]));
    expect(billBody.subjects.reduce((sum: number, subject: { packageAllocatedCost: string }) =>
      sum + Number(subject.packageAllocatedCost), 0)).toBe(199);
    const departments = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09/departments", headers: { cookie } });
    expect(departments.json()).toMatchObject({
      totals: { packageCost: "199.00000000", totalCost: "199.00000000" },
      conservation: { status: "BALANCED" },
    });

    const unknownPrincipalId = randomUUID(); const unknownKeyId = randomUUID();
    await db.insertInto("principal").values({ id: unknownPrincipalId, enterprise_id: enterpriseId,
      type: "EMPLOYEE", name: "Unknown API Employee", department_label: null,
      person_id: null, owner_person_id: null }).execute();
    await db.insertInto("principal_key").values({ id: unknownKeyId, enterprise_id: enterpriseId,
      principal_id: unknownPrincipalId, key_prefix: "ql-finance-unknown", key_digest: randomUUID(),
      allowed_model_ids: [], ip_allowlist: [], expires_at: null, quota_limit: null,
      concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
    const usdOpening = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/opening-balances`, headers: { cookie },
      payload: { account_currency: "USD", account_amount: "10",
        occurred_at: "2026-08-31T16:00:00.000Z", evidence_ref: "usd-opening",
        idempotency_key: randomUUID() } });
    expect(usdOpening.statusCode).toBe(201);
    const usdRequestId = randomUUID();
    await ledger.createRequest({ id: usdRequestId, enterprise_id: enterpriseId,
      principal_id: unknownPrincipalId, principal_key_id: unknownKeyId, protocol: "OPENAI_CHAT",
      unified_model: "deepseek-chat", unified_model_id: null });
    const usdAttempt = await ledger.createAttempt({ ai_request_id: usdRequestId,
      enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: apiResourceId,
      upstream_model: "deepseek-chat" });
    await ledger.createUsageAndLedgerLineIfAbsent({ usage: { ai_request_id: usdRequestId,
      enterprise_id: enterpriseId, upstream_attempt_id: usdAttempt.id,
      provider_resource_id: apiResourceId, input_tokens: 2n, output_tokens: 1n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${usdRequestId}:attempt1` }, ledger_line: { ai_request_id: usdRequestId,
      enterprise_id: enterpriseId, upstream_attempt_id: usdAttempt.id,
      provider_resource_id: apiResourceId, principal_id: unknownPrincipalId,
      resource_mode: "API", raw_input_tokens: 2n, raw_output_tokens: 1n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: "3",
      api_cost_status: "PRICED_USAGE", api_cost_currency: "USD",
      settled_at: new Date("2026-09-03T00:30:00.000Z"), usage_quality: "PROVIDER_REPORTED" } });
    const usdFinishedAt = new Date("2026-09-03T00:30:01.000Z");
    await ledger.updateAttemptResult(usdAttempt.id, { http_status: 200,
      response_committed: true, first_byte_at: usdFinishedAt, finished_at: usdFinishedAt,
      error_classification: null, error_code: null });
    await ledger.finalizeLedgerSettlementIfAbsent({ ai_request_id: usdRequestId,
      enterprise_id: enterpriseId, principal_id: unknownPrincipalId,
      total_input_tokens: 2n, total_output_tokens: 1n, total_cache_tokens: 0n,
      total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "3",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED" });
    const multiCurrencyBill = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09", headers: { cookie } });
    expect(multiCurrencyBill.json()).toMatchObject({ summary: {
      apiSpends: expect.arrayContaining([{ currency: "USD", amount: "3.00000000" }]),
      totalSpends: expect.arrayContaining([{ currency: "USD", amount: "3.00000000" }]),
    } });

    const unknownRequestId = randomUUID();
    await ledger.createRequest({ id: unknownRequestId, enterprise_id: enterpriseId,
      principal_id: unknownPrincipalId, principal_key_id: unknownKeyId, protocol: "OPENAI_CHAT",
      unified_model: "deepseek-chat", unified_model_id: null });
    const unknownAttempt = await ledger.createAttempt({ ai_request_id: unknownRequestId,
      enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: apiResourceId,
      upstream_model: "deepseek-chat" });
    await ledger.createUsageAndLedgerLineIfAbsent({ usage: { ai_request_id: unknownRequestId,
      enterprise_id: enterpriseId, upstream_attempt_id: unknownAttempt.id,
      provider_resource_id: apiResourceId, input_tokens: 1n, output_tokens: 1n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `${unknownRequestId}:attempt1` }, ledger_line: {
      ai_request_id: unknownRequestId, enterprise_id: enterpriseId,
      upstream_attempt_id: unknownAttempt.id, provider_resource_id: apiResourceId,
      principal_id: unknownPrincipalId, resource_mode: "API", raw_input_tokens: 1n,
      raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: null, api_cost_status: "UNKNOWN_COST", api_cost_currency: null,
      settled_at: new Date("2026-09-03T01:00:00.000Z"),
      usage_quality: "PROVIDER_REPORTED" } });
    const unknownFinishedAt = new Date("2026-09-03T01:00:01.000Z");
    await ledger.updateAttemptResult(unknownAttempt.id, { http_status: 200,
      response_committed: true, first_byte_at: unknownFinishedAt, finished_at: unknownFinishedAt,
      error_classification: null, error_code: null });
    await ledger.finalizeLedgerSettlementIfAbsent({ ai_request_id: unknownRequestId,
      enterprise_id: enterpriseId, principal_id: unknownPrincipalId,
      total_input_tokens: 1n, total_output_tokens: 1n, total_cache_tokens: 0n,
      total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED" });
    const incompleteDepartments = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09/departments", headers: { cookie } });
    expect(incompleteDepartments.json()).toMatchObject({
      totals: { apiCost: null, totalCost: null },
      reasonCodes: expect.arrayContaining(["API_COST_UNKNOWN"]),
    });
  });

  it("保存额度配置后立即更新当前订阅周期，并继承登记金额", async () => {
    const resources = await app.inject({ method: "GET",
      url: "/provider-resources", headers: { cookie } });
    const resource = resources.json().resources.find(
      (item: { id: string }) => item.id === planResourceId,
    );
    const saved = await app.inject({ method: "PATCH",
      url: `/provider-resources/${planResourceId}`, headers: { cookie },
      payload: { expected_version: resource.version, operating_snapshot: {
        source: "ADMIN", collected_at: new Date().toISOString(),
        package_name: "Kimi Coding Plan", total_quota: "3000", quota_unit: "TOKEN",
        reset_cycle: "MONTHLY", reset_anchor_at: "2026-10-01T16:00:00.000Z",
      } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().resource.operating_snapshot).toMatchObject({
      version: 2, source: "ADMIN", package_name: "Kimi Coding Plan",
      package_cost: "199.00000000", currency: "CNY",
      total_quota: "3000.00000000", quota_unit: "TOKEN",
      effective_from: "2026-09-01T16:00:00.000Z",
      effective_until: "2026-10-01T16:00:00.000Z",
      usage_calculation: "SYSTEM_LEDGER",
    });
    const history = await db.selectFrom("provider_resource_operating_snapshot")
      .select(["version", "total_quota", "package_cost", "effective_from", "effective_until"])
      .where("provider_resource_id", "=", planResourceId).orderBy("version").execute();
    expect(history).toEqual([
      { version: 1, total_quota: "1000.00000000", package_cost: null,
        effective_from: new Date("2026-09-01T16:00:00.000Z"),
        effective_until: new Date("2026-10-01T16:00:00.000Z") },
      { version: 2, total_quota: "3000.00000000", package_cost: "199.00000000",
        effective_from: new Date("2026-09-01T16:00:00.000Z"),
        effective_until: new Date("2026-10-01T16:00:00.000Z") },
    ]);

    const finance = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(finance.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: planResourceId,
        currentPeriod: expect.objectContaining({ fixedFeeAmount: "199.00000000",
          totalQuota: "3000.00000000", deductedQuota: "450" }) }),
    ]));
    const utilization = await app.inject({ method: "GET",
      url: "/provider-resources/utilization?month=2026-09", headers: { cookie } });
    expect(utilization.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: planResourceId, packageCost: "199.00000000",
        totalQuota: "3000", usedQuota: "450", remainingQuota: "2550",
        utilizationRate: "0.15000000" }),
    ]));
    const overview = await app.inject({ method: "GET",
      url: "/provider-resources/usage-overview", headers: { cookie } });
    expect(overview.json().providerSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerCode: "deepseek", mode: "CODING_PLAN",
        packageCost: "199.00000000", totalQuota: "3000.00000000",
        usedQuota: "450.00000000", remainingQuota: "2550.00000000" }),
    ]));
  });

  it("历史迁移周期的新额度保存后取代无周期配置", async () => {
    const provider = await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", planResourceId).executeTakeFirstOrThrow();
    const resourceId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: resourceId, enterprise_id: enterpriseId, provider_id: provider.provider_id,
      name: "Migrated Kimi", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).execute();
    const sourceSnapshotId = randomUUID();
    await db.insertInto("provider_resource_operating_snapshot").values([
      { id: sourceSnapshotId, enterprise_id: enterpriseId,
        provider_resource_id: resourceId, version: 1,
        source: "ADMIN", collected_at: new Date("2026-08-03T00:00:00.000Z"),
        currency: "CNY", package_name: "Kimi Coding Plan", package_cost: "199",
        total_quota: "300000000", quota_unit: "TOKEN",
        effective_from: new Date("2026-08-18T16:00:00.000Z"),
        effective_until: new Date("2026-09-18T16:00:00.000Z"),
        reset_cycle: "MONTHLY", reset_anchor_at: new Date("2026-09-18T16:00:00.000Z"),
        usage_calculation: "SYSTEM_LEDGER" },
      { enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-04T11:27:01.000Z"),
        package_name: "Kimi Coding Plan", package_cost: null,
        total_quota: "3000000000", quota_unit: "TOKEN",
        effective_from: null, effective_until: null,
        reset_cycle: "MONTHLY", reset_anchor_at: new Date("2026-09-18T16:00:00.000Z"),
        usage_calculation: "SYSTEM_LEDGER" },
    ]).execute();
    await db.insertInto("provider_subscription_period").values({
      enterprise_id: enterpriseId, provider_resource_id: resourceId,
      finance_event_id: null, product_name: "Kimi Coding Plan",
      period_start: new Date("2026-08-18T16:00:00.000Z"),
      period_end_exclusive: new Date("2026-09-18T16:00:00.000Z"),
      source: "MIGRATED_CARRYOVER", migration_source_record_id: sourceSnapshotId,
      created_by_admin_user_id: adminId,
    }).execute();
    const resource = await db.selectFrom("provider_resource").select("version")
      .where("id", "=", resourceId).executeTakeFirstOrThrow();
    const saved = await app.inject({ method: "PATCH",
      url: `/provider-resources/${resourceId}`, headers: { cookie },
      payload: { expected_version: resource.version, operating_snapshot: {
        source: "ADMIN", collected_at: new Date().toISOString(),
        package_name: "Kimi Coding Plan", total_quota: "3000000000", quota_unit: "TOKEN",
        reset_cycle: "MONTHLY", reset_anchor_at: "2026-09-18T16:00:00.000Z",
      } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().resource.operating_snapshot).toMatchObject({
      version: 3, package_cost: "199.00000000", currency: "CNY",
      total_quota: "3000000000.00000000",
      effective_from: "2026-08-18T16:00:00.000Z",
      effective_until: "2026-09-18T16:00:00.000Z",
      subscription_period_id: expect.any(String),
    });
    const finance = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(finance.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId,
        currentPeriod: expect.objectContaining({ fixedFeeAmount: "199.00000000",
          totalQuota: "3000000000.00000000" }) }),
    ]));
  });

  it("没有当前订阅周期时拒绝保存额度，不留半成品", async () => {
    const provider = await db.selectFrom("provider_resource").select("provider_id")
      .where("id", "=", planResourceId).executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.provider_id,
      name: "No current period", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returning(["id", "version"]).executeTakeFirstOrThrow();
    const response = await app.inject({ method: "PATCH",
      url: `/provider-resources/${resource.id}`, headers: { cookie },
      payload: { expected_version: resource.version, operating_snapshot: {
        source: "ADMIN", collected_at: new Date().toISOString(),
        package_name: "No period", total_quota: "1000", quota_unit: "TOKEN",
        reset_cycle: "MONTHLY", reset_anchor_at: "2026-09-18T16:00:00.000Z",
      } } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: "current_subscription_period_required",
      message: "当前没有有效订阅周期，请先在充值与订阅中登记当前周期",
    });
    expect(await db.selectFrom("provider_resource").select("version")
      .where("id", "=", resource.id).executeTakeFirstOrThrow()).toEqual({
      version: resource.version,
    });
    expect(await db.selectFrom("provider_resource_operating_snapshot").select("id")
      .where("provider_resource_id", "=", resource.id).execute()).toHaveLength(0);
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
      expect(close.statusCode, close.body).toBe(200);
      expect(close.json()).toMatchObject({ status: "CLOSED",
        sourceFacts: { providerFinance: { resourceViews: expect.any(Array) },
          departmentBill: { conservation: { status: "UNKNOWN" },
            reasonCodes: expect.arrayContaining(["API_COST_UNKNOWN"]) } } });
    } finally {
      await darkApp.close();
      if (prior === undefined) delete process.env.PROVIDER_FINANCE_MODE;
      else process.env.PROVIDER_FINANCE_MODE = prior;
    }
  });
});
