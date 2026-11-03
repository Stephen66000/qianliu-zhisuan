import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { createKysely, GatewayLedgerRepository, migrateToLatest,
  ProviderFinanceActivationRepository } from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { hashPassword } from "../auth/password.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;
let cookie: string;
const enterpriseId = randomUUID(); const adminId = randomUUID();
const apiResourceId = randomUUID(); const planResourceId = randomUUID();
let deepseekProviderId: string;

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_api");
  db = createKysely(pg.connectionString); await migrateToLatest(db);
  const providerId = randomUUID();
  deepseekProviderId = providerId;
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
      name: "API", mode: "API", credential_type: "API_KEY",
      // F-P2-6：资源级期初不得早于资源创建——显式锚定创建时点，使期初/更正可用固定时点。
      created_at: new Date("2026-09-01T00:00:00.000Z") },
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

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); vi.useRealTimers(); }, 60_000);

/**
 * PFH-07：企业激活后新建 API 资源默认 PENDING，其期初只能通过资源级资金启用登记。
 * 测试中显式登记该状态，模拟“激活后新增资源”的期初流程起点。
 */
async function seedPendingFinanceState(resourceId: string) {
  await sql`
    INSERT INTO provider_resource_finance_state
      (enterprise_id, provider_resource_id, state, required_currencies)
    VALUES (${enterpriseId}::uuid, ${resourceId}::uuid, 'PENDING', '[]'::jsonb)
    ON CONFLICT (provider_resource_id) DO NOTHING
  `.execute(db);
}

afterEach(() => { vi.useRealTimers(); });

describe("provider finance routes", () => {
  it("retired API funding writes return 410 regardless of activation state (AFR-01/P4)", async () => {
    // 断言迁移（WP2-S3 / AFR-01）：原断言 503 finance_write_contract_inactive 钉的是
    // W4 经 requireActive 的旧门禁；退役后 W1-W4/W9-W11 在 requireAuth 之后无条件 410，
    // 与激活状态/strict_writes_enabled 无关，故 503 分支不再可达。
    try {
      const response = await app.inject({ method: "POST",
        url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
        payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ error: "api_funding_management_retired" });
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

  it("retired API funding writes keep historical facts readable and write nothing (AFR-01/AT-AFR-02)", async () => {
    // 断言迁移（WP2-S3 / AFR-01 / plan §4.1）：原“期初→充值→幂等重放→更正→冲销→对账
    // 创建/确认”成功链全部经退役写入口（W1/W3/W4/W7/W9/W10），退役后路由不再生产事实。
    // 历史事实改为直插构造（S2 夹具模式：显式 PENDING 行＋事件行），最终资金状态与原链路
    // 一致（余额 65＝期初 50＋更正 10＋充值 100−对账调整 95），后续 W5 用例的读模型断言不受影响。
    await seedPendingFinanceState(apiResourceId);
    const openingRow = await db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "50", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: new Date("2026-09-02T01:00:00.000Z"),
      external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: "资源生效时点期初余额（直插历史事实）",
      evidence_ref: "opening", source: "ADMIN", idempotency_key: randomUUID(),
      created_by_admin_user_id: adminId,
    }).returningAll().executeTakeFirstOrThrow();
    await db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_OPENING_BALANCE_CORRECTION", account_amount: "10", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: openingRow.occurred_at,
      external_reference: null, reversal_of_event_id: null,
      correction_of_event_id: openingRow.id, reconciliation_case_id: null,
      description: "期初更正（直插历史事实）", evidence_ref: "correction",
      source: "ADMIN", idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
    }).execute();
    const rechargeRow = await db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_RECHARGE", account_amount: "100", account_currency: "CNY",
      cash_paid_cny: "100", occurred_at: new Date("2026-09-02T01:00:00.000Z"),
      external_reference: "api-pay-1", reversal_of_event_id: null,
      correction_of_event_id: null, reconciliation_case_id: null,
      description: "DeepSeek 控制台充值（直插历史事实）", evidence_ref: "recharge-proof",
      source: "ADMIN", idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
    }).returningAll().executeTakeFirstOrThrow();
    // 对账历史：调整事件与案件关闭必须同事务（0059 一致性触发器，参照 ledger 夹具模式）；
    // 0083 要求调整金额与案件差值一致（160 → 厂商确认 65，差值 -95）。
    const caseRow = await db.transaction().execute(async (trx) => {
      const financeCase = await trx.insertInto("provider_finance_reconciliation_case").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId, account_currency: "CNY",
        local_balance: "160", provider_confirmed_balance: "65", difference_amount: "-95",
        balance_as_of: new Date("2026-09-02T02:00:00.000Z"), fact_watermark: {},
        evidence_ref: "provider-proof", opened_by_admin_user_id: adminId,
        decided_by_admin_user_id: null, adjustment_event_id: null, decision: null,
        decision_note: null, decision_idempotency_key: null, decided_at: null, resolved_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      const reconciliationRow = await trx.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        event_type: "API_BALANCE_RECONCILIATION", account_amount: "-95", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: financeCase.balance_as_of, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: financeCase.id, description: null, evidence_ref: "provider-proof",
        source: "RECONCILIATION", idempotency_key: randomUUID(),
        created_by_admin_user_id: adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("provider_finance_reconciliation_case").set({
        status: "RESOLVED", decision: "CONFIRMED", adjustment_event_id: reconciliationRow.id,
        decided_by_admin_user_id: adminId, decided_at: new Date(), resolved_at: new Date(),
        version: 2,
      }).where("id", "=", financeCase.id).execute();
      return financeCase;
    });

    const factCounts = async () => ({
      events: await db.selectFrom("provider_finance_event").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      candidates: await db.selectFrom("provider_finance_duplicate_candidate").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      cases: await db.selectFrom("provider_finance_reconciliation_case").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      idempotency: await db.selectFrom("provider_finance_idempotency").select("idempotency_key")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
    });
    const before = await factCounts();

    // 退役写入口（W1/W3/W4/W9/W10＋W7 对 API 事件的冲销）：一律 410＋固定错误码。
    const retiredWrites: Array<[string, string, Record<string, unknown>]> = [
      ["/provider-resources/:id/finance/opening-balances",
        `/provider-resources/${apiResourceId}/finance/opening-balances`,
        { account_currency: "CNY", account_amount: "1", occurred_at: "2026-09-02T01:00:00.000Z",
          evidence_ref: "should-not-write", idempotency_key: randomUUID() }],
      ["/provider-resources/:id/finance/opening-balance-corrections",
        `/provider-resources/${apiResourceId}/finance/opening-balance-corrections`,
        { opening_event_id: openingRow.id, account_currency: "CNY", account_amount: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", evidence_ref: "should-not-write",
          idempotency_key: randomUUID() }],
      ["/provider-resources/:id/finance/recharges",
        `/provider-resources/${apiResourceId}/finance/recharges`,
        { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() }],
      ["/provider-finance-events/:id/reversal（API 事实，repo 守卫）",
        `/provider-finance-events/${rechargeRow.id}/reversal`,
        { reason: "wrong recharge", evidence_ref: "reversal", idempotency_key: randomUUID() }],
      ["/provider-resources/:id/finance/reconciliation-cases",
        `/provider-resources/${apiResourceId}/finance/reconciliation-cases`,
        { account_currency: "CNY", provider_confirmed_balance: "70",
          balance_as_of: "2026-09-02T02:00:00.000Z", evidence_ref: "should-not-write" }],
      ["/provider-finance-reconciliation-cases/:id/confirm",
        `/provider-finance-reconciliation-cases/${caseRow.id}/confirm`,
        { expected_version: 2, note: "confirm", idempotency_key: randomUUID() }],
    ];
    for (const [name, url, payload] of retiredWrites) {
      const response = await app.inject({ method: "POST", url, headers: { cookie }, payload });
      expect(response.statusCode, `${name} -> ${response.body}`).toBe(410);
      expect(response.json()).toMatchObject({ error: "api_funding_management_retired" });
    }
    expect(await factCounts()).toEqual(before);

    // 读端点照常返回历史数据（GET 全部保留）。
    const balance = await app.inject({ method: "GET",
      url: `/provider-resources/${apiResourceId}/finance/balance?currency=CNY&as_of=2026-09-02T02:00:00.000Z`,
      headers: { cookie } });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toMatchObject({ state: "NORMAL", balance: "65.00000000" });
    const history = await app.inject({ method: "GET",
      url: `/provider-resources/${apiResourceId}/finance/events?type=API_RECHARGE&from=2026-09-01T00:00:00%2B08:00&to=2026-10-01T00:00:00%2B08:00`,
      headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ total: 1,
      items: [expect.objectContaining({ id: rechargeRow.id, eventType: "API_RECHARGE" })] });
    const cases = await app.inject({ method: "GET",
      url: "/provider-finance/reconciliation-cases?status=RESOLVED", headers: { cookie } });
    expect(cases.statusCode).toBe(200);
    expect(cases.json()).toMatchObject({ total: 1,
      items: [expect.objectContaining({ id: caseRow.id, status: "RESOLVED" })] });
    const resources = await app.inject({ method: "GET",
      url: "/provider-finance/resources?month=2026-09", headers: { cookie } });
    expect(resources.statusCode).toBe(200);
    expect(resources.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: apiResourceId, mode: "API",
        accounts: [expect.objectContaining({ currency: "CNY", balanceState: "NORMAL",
          // 断言迁移（WP2-S3 / AFR-01）：原 0 是“充值 100 被冲销 -100”的净值；冲销退役后
          // 月度充值读数保留历史事实原值 100。
          balance: "65.00000000", monthlyRecharge: "100.00000000" })] }),
    ]));
  });

  it("records a Coding Plan and exposes its service period", async () => {
    // 九月事实的当前周期测试固定业务 Date，HTTP/PG 与计时器保持真实。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T04:00:00.000Z"));
    const response = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/subscriptions`, headers: { cookie },
      payload: { kind: "PURCHASE", product_name: "Kimi Coding Plan",
        account_currency: "CNY", account_amount: "199", cash_paid_cny: "199",
        occurred_at: "2026-09-02T00:00:00.000Z", service_period_start: "2026-09-02",
        external_reference: "plan-pay-1", description: "Kimi 套餐首购",
        evidence_ref: "plan-proof",
        idempotency_key: randomUUID() } });
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
      current_status: new Date("2026-10-01T16:00:00.000Z").getTime() <= Date.now() ? "EXPIRED" : "ACTIVE",
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
      // 断言迁移（WP2-S3 / AFR-01）：直插历史事实中的 API 充值实付（100）不再被冲销
      // （W7 对 API 事实的冲销已退役，见上一用例），9 月现金流出 = 100 + 套餐 199 = 299。
      // 余额口径不变（对账调整 -95 后仍为 65）。
      cashOutflowCny: "299.00000000", codingPlanFixedCostCny: "199.00000000",
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
      // 断言迁移（WP4-S2 / WP2 遗留②收口＋AFR-07）：utilization API 行不再从资金账户
      // 投影内部余额（资金账户 65.00 退出展示），currentBalance 恒 null。
      expect.objectContaining({ resourceId: apiResourceId, currentBalance: null }),
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
    // 断言迁移（WP2-S3 / AFR-01）：美元期初原经 W1（201）；W1 退役后历史事实改直插构造
    // （多币种期初必须与既有 CNY 期初同点，0083 触发器校验同前）。后续 USD 账单断言不变。
    const usdOpening = await db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "10", account_currency: "USD",
      cash_paid_cny: null, occurred_at: new Date("2026-09-02T01:00:00.000Z"),
      external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
      reconciliation_case_id: null, description: "美元账户期初余额", evidence_ref: "usd-opening",
      source: "ADMIN", idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
    }).returningAll().executeTakeFirstOrThrow();
    expect(usdOpening.event_type).toBe("API_OPENING_BALANCE");
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
      total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: null,
      api_cost_status: "UNKNOWN_COST",
      usage_quality: "PROVIDER_REPORTED", attempt_count: 1, request_status: "SUCCEEDED" });
    const incompleteDepartments = await app.inject({ method: "GET",
      url: "/operating-bills/2026-09/departments", headers: { cookie } });
    expect(incompleteDepartments.json()).toMatchObject({
      totals: { apiCost: null, totalCost: null },
      reasonCodes: expect.arrayContaining(["API_COST_UNKNOWN"]),
    });

    // PFH-07：必要币种期初登记完成后，资源级资金就绪解除调度门禁
    await new ProviderFinanceActivationRepository(db).markResourceFinanceReady({
      enterpriseId, resourceId: apiResourceId, adminId,
      requiredCurrencies: ["CNY", "USD"], now: new Date(),
    });
    expect((await db.selectFrom("provider_resource_finance_state").select(["state"])
      .where("provider_resource_id", "=", apiResourceId).executeTakeFirstOrThrow()).state).toBe("READY");
  });

  it("保存额度配置后立即更新当前订阅周期，并继承登记金额", async () => {
    // 九月事实的当前周期测试固定业务 Date，HTTP/PG 与计时器保持真实。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T04:00:00.000Z"));
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
    // 夹具按当前上海自然月派生：绑定守卫要求 period_start <= now < period_end_exclusive，
    // 硬编码周期一旦过期就会被 409 拒绝并把该用例变成日期定时炸弹（F-2）。
    const shanghaiNow = new Date(Date.now() + 8 * 3600_000);
    const shanghaiYear = shanghaiNow.getUTCFullYear();
    const shanghaiMonth = shanghaiNow.getUTCMonth();
    const periodStart = new Date(Date.UTC(shanghaiYear, shanghaiMonth, 1) - 8 * 3600_000);
    const periodEndExclusive = new Date(Date.UTC(shanghaiYear, shanghaiMonth + 1, 1) - 8 * 3600_000);
    const currentMonth = `${shanghaiYear}-${String(shanghaiMonth + 1).padStart(2, "0")}`;
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
        effective_from: periodStart,
        effective_until: periodEndExclusive,
        reset_cycle: "MONTHLY", reset_anchor_at: periodEndExclusive,
        usage_calculation: "SYSTEM_LEDGER" },
      { enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-04T11:27:01.000Z"),
        package_name: "Kimi Coding Plan", package_cost: null,
        total_quota: "3000000000", quota_unit: "TOKEN",
        effective_from: null, effective_until: null,
        reset_cycle: "MONTHLY", reset_anchor_at: periodEndExclusive,
        usage_calculation: "SYSTEM_LEDGER" },
    ]).execute();
    await db.insertInto("provider_subscription_period").values({
      enterprise_id: enterpriseId, provider_resource_id: resourceId,
      finance_event_id: null, product_name: "Kimi Coding Plan",
      period_start: periodStart,
      period_end_exclusive: periodEndExclusive,
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
        reset_cycle: "MONTHLY", reset_anchor_at: periodEndExclusive.toISOString(),
      } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().resource.operating_snapshot).toMatchObject({
      version: 3, package_cost: "199.00000000", currency: "CNY",
      total_quota: "3000000000.00000000",
      effective_from: periodStart.toISOString(),
      effective_until: periodEndExclusive.toISOString(),
      subscription_period_id: expect.any(String),
    });
    const finance = await app.inject({ method: "GET",
      url: `/provider-finance/resources?month=${currentMonth}`, headers: { cookie } });
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

  it("consumes a persisted Coding Plan duplicate confirmation; API recharge candidates are retired (AFR-01)", async () => {
    // 断言迁移（WP2-S3 / AFR-01 / plan §4.1）：原用例经 W4 充值产生并确认 API_RECHARGE 候选；
    // W4 退役后充值候选不可再经路由产生/确认。拆分为——
    // 1) CP 候选确认走仍存活的 W5（原成功/幂等断言保留在套餐域）；
    // 2) API_RECHARGE 候选改为直插夹具，确认断言 410 且候选保持 PENDING、零写入。
    const purchaseBase = { kind: "PURCHASE", product_name: "Kimi Coding Plan",
      account_currency: "CNY", account_amount: "4", cash_paid_cny: "4",
      occurred_at: "2026-09-02T07:00:00.000Z", service_period_start: "2026-09-02",
      service_period_end: "2026-10-02", description: "重复候选套餐",
      evidence_ref: "duplicate-plan-proof" };
    const first = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/subscriptions`, headers: { cookie },
      payload: { ...purchaseBase, idempotency_key: randomUUID() } });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/subscriptions`, headers: { cookie },
      payload: { ...purchaseBase, idempotency_key: randomUUID() } });
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
    expect(await db.selectFrom("provider_finance_duplicate_candidate").select("status")
      .where("id", "=", detail.candidateId).executeTakeFirst()).toEqual({ status: "CONSUMED" });

    // API_RECHARGE 候选（直插夹具）：token 哈希复刻 repo 的 stableHash（sha256(JSON.stringify(token))）。
    const confirmationToken = "retired-api-candidate-token";
    const tokenHash = createHash("sha256")
      .update(JSON.stringify(confirmationToken)).digest("hex");
    const retiredCandidate = await db.insertInto("provider_finance_duplicate_candidate").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_RECHARGE", request_hash: "a".repeat(64),
      request_payload: { accountAmount: "7", accountCurrency: "CNY", cashPaidCny: "7",
        occurredAt: "2026-09-02T07:00:00.000Z", description: null, evidenceRef: null,
        productName: null, autoRenew: null, periodStart: null, periodEndExclusive: null },
      confirmation_token_hash: tokenHash,
      expires_at: new Date(Date.now() + 15 * 60_000), created_by_admin_user_id: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    const eventsBefore = await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length);
    const retiredConfirm = await app.inject({ method: "POST",
      url: `/provider-finance-duplicate-candidates/${retiredCandidate.id}/confirm`,
      headers: { cookie },
      payload: { confirmation_token: confirmationToken, request_hash: "a".repeat(64),
        idempotency_key: randomUUID() } });
    expect(retiredConfirm.statusCode).toBe(410);
    expect(retiredConfirm.json()).toMatchObject({ error: "api_funding_management_retired" });
    // 候选保持 PENDING、零事件写入。
    expect(await db.selectFrom("provider_finance_duplicate_candidate").select("status")
      .where("id", "=", retiredCandidate.id).executeTakeFirst()).toEqual({ status: "PENDING" });
    expect(await db.selectFrom("provider_finance_event").select("id")
      .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length))
      .toBe(eventsBefore);
  });

  it("retired funding writes win over cross-mode validation; mode guards stay for live endpoints", async () => {
    // 断言迁移（WP2-S3 / AFR-01 / plan §4.1）：跨模式充值（W4 on CP 资源）与重复外部引用
    // （W4 的 409 finance_contract_conflict）都经退役入口，410 优先于模式/合同校验（路由层
    // 不再校验）。W5/W6/A3/A4 与快照守卫的跨模式语义保留（下方 GET 404 与 PATCH 409 原样）。
    const response = await app.inject({ method: "POST",
      url: `/provider-resources/${planResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: "2026-09-02T01:00:00.000Z", description: "跨模式充值应被拒绝",
        evidence_ref: "cross-mode-proof", idempotency_key: randomUUID() } });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: "api_funding_management_retired" });
    const duplicateReference = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "3", cash_paid_cny: "3",
        occurred_at: "2026-09-02T06:00:00.000Z", external_reference: "api-pay-1",
        description: "重复外部引用应被拒绝", evidence_ref: "duplicate-ref-proof",
        idempotency_key: randomUUID() } });
    expect(duplicateReference.statusCode).toBe(410);
    expect(duplicateReference.json()).toMatchObject({ error: "api_funding_management_retired" });
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

  // 断言迁移（WP2-S3 / AFR-01 / plan §4.1）：原 F-P1-4“资源级资金启用闭环”（PFH-07）
  // 经 W1 期初＋W2 readiness 完成 PENDING → READY；两入口均已退役（410），该闭环不再
  // 生产可达。PENDING 存量的调度拦截已由迁移 0094＋准入解除移除（S2），本用例保留为
  // 退役后行为回归：readiness/期初一律 410，资金状态行保持 PENDING 不被提升。
  it("retired readiness and opening endpoints cannot promote a PENDING resource", async () => {
    const newResourceId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: newResourceId, enterprise_id: enterpriseId, provider_id: deepseekProviderId,
      name: "Post-activation API", mode: "API", credential_type: "API_KEY",
    }).execute();
    // 激活已不可逆：已存在即不动（0061 的不可逆触发器会拒绝 UPDATE）。
    await sql`
      INSERT INTO provider_finance_runtime_state
        (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
      VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
      ON CONFLICT (enterprise_id) DO NOTHING
    `.execute(db);
    await seedPendingFinanceState(newResourceId);

    // 1) readiness：410（原 200 PENDING 阻断语义随入口退役）。
    const before = await app.inject({ method: "POST",
      url: `/provider-resources/${newResourceId}/finance/readiness`, headers: { cookie }, payload: {} });
    expect(before.statusCode, before.body).toBe(410);
    expect(before.json()).toMatchObject({ error: "api_funding_management_retired" });

    // 2) 资源级期初（W1）：410（原 201 成功登记语义随入口退役）。
    const opening = await app.inject({ method: "POST",
      url: `/provider-resources/${newResourceId}/finance/opening-balances`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "50",
        occurred_at: new Date().toISOString(), description: "新资源期初余额",
        evidence_ref: "post-activation-opening", idempotency_key: randomUUID() } });
    expect(opening.statusCode, opening.body).toBe(410);
    expect(opening.json()).toMatchObject({ error: "api_funding_management_retired" });

    // 3) 复试 readiness 与幂等重放：仍 410；状态行保持 PENDING（零写入）。
    for (let i = 0; i < 2; i += 1) {
      const replay = await app.inject({ method: "POST",
        url: `/provider-resources/${newResourceId}/finance/readiness`, headers: { cookie }, payload: {} });
      expect(replay.statusCode).toBe(410);
      expect(replay.json()).toMatchObject({ error: "api_funding_management_retired" });
    }
    const pending = await sql<{ state: string; version: number }>`
      SELECT state, version FROM provider_resource_finance_state
       WHERE provider_resource_id = ${newResourceId}::uuid`.execute(db);
    expect(pending.rows[0]).toEqual({ state: "PENDING", version: 1 });
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
      // 断言迁移（WP2-S3 / AFR-01 / P4）：退役写入口移除 requireActive 后，DARK 模式同样
      // 返回 410（退役是既成事实，与模式开关无关）；OFF 模式路由整体不注册仍 404。
      const write = await darkApp.inject({ method: "POST",
        url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
        payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
      expect(write.statusCode).toBe(410);
      expect(write.json()).toMatchObject({ error: "api_funding_management_retired" });
      const retiredOpening = await darkApp.inject({ method: "POST",
        url: `/provider-resources/${apiResourceId}/finance/opening-balances`, headers: { cookie },
        payload: { account_currency: "CNY", account_amount: "1",
          occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: randomUUID() } });
      expect(retiredOpening.statusCode).toBe(410);
      expect(retiredOpening.json()).toMatchObject({ error: "api_funding_management_retired" });
      // W5/W6（存活入口）在 DARK 下保持 404（requireActive 原样）。
      const planWrite = await darkApp.inject({ method: "POST",
        url: `/provider-resources/${planResourceId}/finance/subscriptions`, headers: { cookie },
        payload: { kind: "PURCHASE", product_name: "Kimi Coding Plan", account_currency: "CNY",
          account_amount: "1", cash_paid_cny: "1", occurred_at: "2026-09-02T01:00:00.000Z",
          service_period_start: "2026-09-02", idempotency_key: randomUUID() } });
      expect(planWrite.statusCode).toBe(404);
      const planRenewal = await darkApp.inject({ method: "POST",
        url: `/provider-resources/${planResourceId}/finance/auto-renewal/cancel`,
        headers: { cookie }, payload: {} });
      expect(planRenewal.statusCode).toBe(404);
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

  // 断言迁移（WP2-S3 / AFR-01 / plan §4.1）：原 PFH-06/PFH-07“期初证据必填＋企业初始化
  // 旁路拦截”用例的四个断言分别钉 W1 的 409 scope_conflict 与 W1/W4 的 400 证据校验；
  // 退役后入口在 requireAuth 之后不做 body 校验、不查资金状态，原 409/400 分支不可达，
  // 一律迁移为 410（旁路语义由 S4 的初始化草稿拒绝承接，见 plan §4.4）。
  it("retired initialization-bypass entrypoints return 410 without validation", async () => {
    const legacyResourceId = randomUUID();
    await db.insertInto("provider_resource").values({
      id: legacyResourceId, enterprise_id: enterpriseId, provider_id: deepseekProviderId,
      name: "Legacy API", mode: "API", credential_type: "API_KEY",
    }).execute();
    // 该资源在激活前已存在：不存在资源级资金状态记录，属于企业初始化范围。
    await sql`DELETE FROM provider_resource_finance_state
      WHERE enterprise_id = ${enterpriseId}::uuid
        AND provider_resource_id = ${legacyResourceId}::uuid`.execute(db);

    const bypass = await app.inject({ method: "POST",
      url: `/provider-resources/${legacyResourceId}/finance/opening-balances`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "10",
        occurred_at: "2026-08-31T16:00:00.000Z", description: "越权补写期初",
        evidence_ref: "legacy-opening", idempotency_key: randomUUID() } });
    expect(bypass.statusCode).toBe(410);
    expect(bypass.json()).toMatchObject({ error: "api_funding_management_retired" });

    const missingEvidence = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/opening-balances`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "10",
        occurred_at: "2026-08-31T16:00:00.000Z", idempotency_key: randomUUID() } });
    expect(missingEvidence.statusCode).toBe(410);
    expect(missingEvidence.json()).toMatchObject({ error: "api_funding_management_retired" });

    const rechargeWithoutEvidence = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: "2026-09-02T01:00:00.000Z", description: "缺证据充值",
        idempotency_key: randomUUID() } });
    expect(rechargeWithoutEvidence.statusCode).toBe(410);
    const blankEvidence = await app.inject({ method: "POST",
      url: `/provider-resources/${apiResourceId}/finance/recharges`, headers: { cookie },
      payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: "2026-09-02T01:00:00.000Z", description: "空证据充值",
        evidence_ref: "   ", idempotency_key: randomUUID() } });
    expect(blankEvidence.statusCode).toBe(410);
    expect(blankEvidence.json()).toMatchObject({ error: "api_funding_management_retired" });
  });

  // AT-AFR-02 参数化负向用例（WP2-S3）：7 个退役端点 × 合法认证 → 410＋固定错误码＋
  // 资金事实/候选/对账/幂等表零增量；未认证 → 401（requireAuth 先行）。
  it.each([
    ["W1 opening-balances", "/provider-resources/:id/finance/opening-balances",
      { account_currency: "CNY", account_amount: "1", occurred_at: "2026-09-02T01:00:00.000Z",
        evidence_ref: "param", idempotency_key: "param-w1" }],
    ["W2 readiness", "/provider-resources/:id/finance/readiness", {}],
    ["W3 opening-balance-corrections", "/provider-resources/:id/finance/opening-balance-corrections",
      { opening_event_id: "00000000-0000-4000-8000-000000000000", account_currency: "CNY",
        account_amount: "1", occurred_at: "2026-09-02T01:00:00.000Z", evidence_ref: "param",
        idempotency_key: "param-w3" }],
    ["W4 recharges", "/provider-resources/:id/finance/recharges",
      { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: "2026-09-02T01:00:00.000Z", idempotency_key: "param-w4" }],
    ["W9 reconciliation-cases", "/provider-resources/:id/finance/reconciliation-cases",
      { account_currency: "CNY", provider_confirmed_balance: "1",
        balance_as_of: "2026-09-02T02:00:00.000Z", evidence_ref: "param" }],
    ["W10 reconciliation-case confirm", "/provider-finance-reconciliation-cases/:id/confirm",
      { expected_version: 1, note: "param", idempotency_key: "param-w10" }],
    ["W11 reconciliation-case reject", "/provider-finance-reconciliation-cases/:id/reject",
      { expected_version: 1, note: "param", idempotency_key: "param-w11" }],
  ])("%s：已认证 410 且零写入，未认证 401", async (_name, template, payload) => {
    const url = template
      .replace(":id/finance", `${apiResourceId}/finance`)
      .replace("reconciliation-cases/:id", `reconciliation-cases/${randomUUID()}`);
    const factCounts = async () => ({
      events: await db.selectFrom("provider_finance_event").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      candidates: await db.selectFrom("provider_finance_duplicate_candidate").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      cases: await db.selectFrom("provider_finance_reconciliation_case").select("id")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
      idempotency: await db.selectFrom("provider_finance_idempotency").select("idempotency_key")
        .where("enterprise_id", "=", enterpriseId).execute().then((rows) => rows.length),
    });
    const before = await factCounts();
    const unauthenticated = await app.inject({ method: "POST", url, payload });
    expect(unauthenticated.statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url, headers: { cookie }, payload });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: "api_funding_management_retired",
      message: "API 内部资金管理已退出，请使用官方账户余额与 API费用估算",
    });
    expect(await factCounts()).toEqual(before);
  });
});
