import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely, GatewayLedgerRepository, migrateToLatest, ProviderFinanceRepository,
  PROVIDER_FINANCE_CUTOVER } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { insertHistoricalUsageCostTx } from "../repositories/provider-finance-activation-writes.js";

let pg: PostgresTestInstance;
let enterpriseId: string;
let adminId: string;
let apiResourceId: string;
let planResourceId: string;
let principalId: string;
let principalKeyId: string;

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_repository");
  const db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  enterpriseId = randomUUID(); adminId = randomUUID();
  apiResourceId = randomUUID(); planResourceId = randomUUID();
  principalId = randomUUID(); principalKeyId = randomUUID();
  const providerId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Finance Repository" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "finance-repo-admin",
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId, enterprise_id: enterpriseId, code: "deepseek",
    name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE",
  }).execute();
  await db.insertInto("provider_resource").values([
    { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: "DeepSeek API", mode: "API", credential_type: "API_KEY",
      // F-P2-6：资源级期初不得早于资源创建时点——夹具资源为切换前既有资源。
      created_at: new Date("2026-08-01T00:00:00.000Z") },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
      name: "Plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
      created_at: new Date("2026-08-01T00:00:00.000Z") },
  ]).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "Finance User",
    department_label: null, person_id: null, owner_person_id: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: principalKeyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql-finance", key_digest: "finance-test-digest", allowed_model_ids: [],
    ip_allowlist: [], expires_at: null, quota_limit: null, concurrency_limit: null,
    last_used_at: null, revoked_at: null,
  }).execute();
  // F-P2-6 前置事实：资源级 ADMIN 期初要求企业已激活（0061 shape_check 要求
  // activated_at 与 activated_by_admin_user_id 成对，复合外键指向 admin_user）。
  await sql`
    INSERT INTO provider_finance_runtime_state
      (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id, updated_at)
    VALUES (${enterpriseId}::uuid, true, now(), ${adminId}::uuid, now())
    ON CONFLICT (enterprise_id) DO NOTHING
  `.execute(db);
  // 0083 触发器前置：资源级 ADMIN 期初要求资源处于 PENDING。
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: enterpriseId, provider_resource_id: apiResourceId, state: "PENDING",
  }).execute();
  await db.destroy();
}, 120_000);

afterAll(async () => { await pg?.stop(); }, 60_000);

describe("ProviderFinanceRepository", () => {
  it("includes historical API usage cost in the monthly summary without changing the balance formula", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const isolatedEnterpriseId = randomUUID(); const isolatedAdminId = randomUUID();
      const isolatedProviderId = randomUUID(); const isolatedResourceId = randomUUID();
      const isolatedPrincipalId = randomUUID(); const isolatedKeyId = randomUUID();
      await db.insertInto("enterprise").values({ id: isolatedEnterpriseId,
        name: "Historical Cost Summary" }).execute();
      await db.insertInto("admin_user").values({ id: isolatedAdminId,
        enterprise_id: isolatedEnterpriseId, username: `historical-${isolatedAdminId}`,
        password_hash: "not-used", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: isolatedProviderId,
        enterprise_id: isolatedEnterpriseId, code: "deepseek", name: "DeepSeek",
        adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_finance_runtime_state").values({
        enterprise_id: isolatedEnterpriseId, strict_writes_enabled: true,
        activated_at: new Date("2026-09-01T00:00:00+08:00"),
        activated_by_admin_user_id: isolatedAdminId,
      }).execute();
      await db.insertInto("provider_resource").values({ id: isolatedResourceId,
        enterprise_id: isolatedEnterpriseId, provider_id: isolatedProviderId,
        name: "DeepSeek API", mode: "API", credential_type: "API_KEY",
        created_at: new Date("2026-08-01T00:00:00Z") }).execute();
      // 0094 退役种入触发器后 PENDING 行需夹具显式构造；0083 资源级 ADMIN 期初 DB 合同语义不变。
      await db.insertInto("provider_resource_finance_state").values({
        enterprise_id: isolatedEnterpriseId, provider_resource_id: isolatedResourceId,
        state: "PENDING" }).execute();
      await db.insertInto("principal").values({ id: isolatedPrincipalId,
        enterprise_id: isolatedEnterpriseId, type: "EMPLOYEE", name: "Cost User" }).execute();
      await db.insertInto("principal_key").values({ id: isolatedKeyId,
        enterprise_id: isolatedEnterpriseId, principal_id: isolatedPrincipalId,
        key_prefix: "ql-cost", key_digest: randomUUID() }).execute();

      const repo = new ProviderFinanceRepository(db);
      await repo.recordOpeningBalance({ enterpriseId: isolatedEnterpriseId,
        resourceId: isolatedResourceId, adminId: isolatedAdminId, accountAmount: "0",
        accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "opening-zero", idempotencyKey: randomUUID() });
      await repo.recordRecharge({ enterpriseId: isolatedEnterpriseId,
        resourceId: isolatedResourceId, adminId: isolatedAdminId, accountAmount: "600",
        accountCurrency: "CNY", cashPaidCny: "600",
        occurredAt: new Date("2026-09-03T09:27:00+08:00"),
        externalReference: "recharge-600", idempotencyKey: randomUUID() });
      await db.transaction().execute((trx) => insertHistoricalUsageCostTx(trx, {
        enterpriseId: isolatedEnterpriseId, resourceId: isolatedResourceId,
        adminId: isolatedAdminId, accountCurrency: "CNY", costAmount: "40.4572",
        occurredAt: new Date("2026-09-21T00:00:00+08:00"),
        description: "old database total", evidenceRef: "legacy-db",
        idempotencyKey: randomUUID(),
      }));

      const requestId = randomUUID();
      await db.insertInto("ai_request").values({ id: requestId,
        enterprise_id: isolatedEnterpriseId, principal_id: isolatedPrincipalId,
        principal_key_id: isolatedKeyId, protocol: "openai", unified_model: "deepseek-chat",
        status: "SUCCEEDED", started_at: new Date("2026-09-27T10:00:00+08:00"),
        finished_at: new Date("2026-09-27T10:00:01+08:00") }).execute();
      const attempt = await db.insertInto("upstream_attempt").values({
        ai_request_id: requestId, enterprise_id: isolatedEnterpriseId, attempt_no: 1,
        provider_resource_id: isolatedResourceId, upstream_model: "deepseek-chat",
        response_committed: true, started_at: new Date("2026-09-27T10:00:00+08:00"),
        finished_at: new Date("2026-09-27T10:00:01+08:00"), http_status: 200,
      }).returning("id").executeTakeFirstOrThrow();
      const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
        enterprise_id: isolatedEnterpriseId, upstream_attempt_id: attempt.id,
        provider_resource_id: isolatedResourceId, input_tokens: 1n, output_tokens: 1n,
        cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `historical-summary:${requestId}`,
        created_at: new Date("2026-09-27T10:00:01+08:00"),
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("ledger_line").values({ ai_request_id: requestId,
        enterprise_id: isolatedEnterpriseId, usage_event_id: usage.id,
        upstream_attempt_id: attempt.id, provider_resource_id: isolatedResourceId,
        principal_id: isolatedPrincipalId, resource_mode: "API", raw_input_tokens: 1n,
        raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
        api_cost: "64.09685484", api_cost_currency: "CNY",
        api_cost_status: "PRICED_USAGE", usage_quality: "PROVIDER_REPORTED",
        billing_rule_snapshot: { currency: "CNY", source: "summary-test" },
        settled_at: new Date("2026-09-27T10:00:01+08:00"),
        created_at: new Date("2026-09-27T10:00:01+08:00") }).execute();

      expect(await repo.getMonthlyFinanceSummary(isolatedEnterpriseId, "2026-09"))
        .toMatchObject({
          apiOperatingCosts: [{ currency: "CNY", amount: "104.55405484" }],
          operatingCostCny: "104.55405484",
          currentApiBalances: [{ currency: "CNY", amount: "495.44594516" }],
        });
      expect(await repo.listResourceFinanceViews(isolatedEnterpriseId, "2026-09",
        new Date("2026-09-27T12:00:00+08:00"))).toEqual([
        expect.objectContaining({ resourceId: isolatedResourceId,
          accounts: [expect.objectContaining({ currency: "CNY",
            monthlyApiCost: "104.55405484", balance: "495.44594516" })] }),
      ]);
      expect(await repo.getCurrentBalance(isolatedEnterpriseId, isolatedResourceId, "CNY",
        new Date("2026-09-27T12:00:00+08:00"))).toMatchObject({
        balance: "495.44594516",
        components: { recharges: "600.00000000", legacyCostAdjustments: "-40.45720000",
          usageDebits: "64.09685484" },
      });
    } finally { await db.destroy(); }
  });

  it("records one opening and recharge idempotently, then projects one balance", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      const opening = await repo.recordOpeningBalance({
        enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "50",
        accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "opening", idempotencyKey: randomUUID(),
      });
      const idempotencyKey = randomUUID();
      const input = {
        enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "100",
        accountCurrency: "CNY" as const, cashPaidCny: "100",
        occurredAt: new Date("2026-09-02T01:00:00.000Z"),
        externalReference: "finance-repo-pay-1", idempotencyKey,
      };
      const first = await repo.recordRecharge(input);
      const replay = await repo.recordRecharge(input);
      expect(replay).toMatchObject({ id: first.id, replayed: true });
      expect(first.replayed).toBe(false);
      const balance = await repo.getCurrentBalance(
        enterpriseId, apiResourceId, "CNY", new Date("2026-09-02T02:00:00.000Z"),
      );
      expect(balance).toMatchObject({
        state: "NORMAL", balance: "150.00000000",
        components: { openingBalance: "50.00000000", recharges: "100.00000000" },
      });
      expect(await db.selectFrom("provider_finance_event").selectAll()
        .where("provider_resource_id", "=", apiResourceId).execute()).toHaveLength(2);
      await repo.recordOpeningCorrection({
        enterpriseId, resourceId: apiResourceId, adminId, openingEventId: opening.id,
        accountAmount: "10", accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "opening-correction", idempotencyKey: randomUUID(),
      });
      // 断言迁移（WP2-S3 / AFR-01 / plan §4.1-R6）：API 资金事实的冲销已退役——
      // repo 守卫抛 API_FUNDING_RETIRED 且零写入（原“冲销后余额 60”分支不再可达）。
      const eventsBeforeReversal = await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", apiResourceId).execute();
      await expect(repo.reverseFinanceEvent({
        enterpriseId, eventId: first.id, adminId, reason: "wrong recharge",
        evidenceRef: "reversal-proof", idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: "API_FUNDING_RETIRED" });
      expect(await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", apiResourceId).execute())
        .toHaveLength(eventsBeforeReversal.length);
      // 冲销不再发生：余额 = 期初 50 + 更正 10 + 充值 100 = 160。
      expect(await repo.getCurrentBalance(
        enterpriseId, apiResourceId, "CNY", new Date("2026-09-02T02:00:00.000Z"),
      )).toMatchObject({ state: "NORMAL", balance: "160.00000000" });
      const financeCase = await repo.createReconciliationCase({
        enterpriseId, resourceId: apiResourceId, adminId, accountCurrency: "CNY",
        providerConfirmedBalance: "65", balanceAsOf: new Date("2026-09-02T02:00:00.000Z"),
        evidenceRef: "provider-balance-proof",
      });
      const confirmKey = randomUUID();
      await repo.confirmReconciliationCase({
        enterpriseId, caseId: financeCase.id, adminId, note: "confirmed difference",
        expectedVersion: 1, idempotencyKey: confirmKey,
      });
      await expect(repo.confirmReconciliationCase({
        enterpriseId, caseId: financeCase.id, adminId, note: "changed retry payload",
        expectedVersion: 1, idempotencyKey: confirmKey,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await repo.getCurrentBalance(
        enterpriseId, apiResourceId, "CNY", new Date("2026-09-02T02:00:00.000Z"),
      )).toMatchObject({ state: "NORMAL", balance: "65.00000000" });
      const rejectedCase = await repo.createReconciliationCase({
        enterpriseId, resourceId: apiResourceId, adminId, accountCurrency: "CNY",
        providerConfirmedBalance: "64", balanceAsOf: new Date("2026-09-02T02:00:00.000Z"),
        evidenceRef: "reject-proof",
      });
      const rejectKey = randomUUID();
      const rejected = await repo.rejectReconciliationCase({
        enterpriseId, caseId: rejectedCase.id, adminId, note: "provider evidence rejected",
        expectedVersion: 1, idempotencyKey: rejectKey,
      });
      expect(rejected).toMatchObject({ status: "REJECTED", decision: "REJECTED" });
      await expect(repo.rejectReconciliationCase({
        enterpriseId, caseId: rejectedCase.id, adminId, note: "provider evidence rejected",
        expectedVersion: 1, idempotencyKey: rejectKey,
      })).resolves.toMatchObject({ status: "REJECTED", decision: "REJECTED" });

      await db.insertInto("operating_bill_period").values({
        enterprise_id: enterpriseId, period_month: "2026-09-01", status: "CLOSED",
        current_version: 1, created_by: adminId,
      }).execute();
      try {
        await expect(repo.recordRecharge(input))
          .resolves.toMatchObject({ id: first.id, replayed: true });
      } finally {
        await db.updateTable("operating_bill_period").set({ status: "DRAFT" })
          .where("enterprise_id", "=", enterpriseId)
          .where("period_month", "=", "2026-09-01").execute();
      }
    } finally { await db.destroy(); }
  });

  it("writes a Coding Plan finance event and period atomically", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      const result = await repo.recordSubscription({
        enterpriseId, resourceId: planResourceId, adminId, kind: "PURCHASE",
        productName: "Kimi Coding Plan", accountAmount: "199", accountCurrency: "CNY",
        cashPaidCny: "199", occurredAt: new Date("2026-09-02T00:00:00.000Z"),
        periodStart: new Date("2026-09-01T16:00:00.000Z"),
        periodEndExclusive: new Date("2026-10-01T16:00:00.000Z"),
        externalReference: "finance-repo-plan-1", idempotencyKey: randomUUID(),
      });
      expect(result.event).toMatchObject({
        eventType: "CODING_PLAN_PURCHASE", accountAmount: "199.00000000",
      });
      expect(await db.selectFrom("provider_subscription_period").selectAll()
        .where("id", "=", result.periodId).executeTakeFirst()).toMatchObject({
        finance_event_id: result.event.id, product_name: "Kimi Coding Plan",
      });
      await expect(db.updateTable("provider_subscription_period")
        .set({ period_start: new Date("2026-09-02T16:00:00.000Z") })
        .where("id", "=", result.periodId).execute())
        .rejects.toThrow(/subscription period/);
      // 断言迁移（WP2-S3 / AFR-01）：API 充值（实付 100）不再被冲销（见上一用例的
      // API_FUNDING_RETIRED 迁移），9 月现金流出 = 100 + 套餐 199 = 299。
      expect(await repo.getMonthlyFinanceSummary(enterpriseId, "2026-09")).toMatchObject({
        cashOutflowCny: "299.00000000", codingPlanFixedCostCny: "199.00000000",
        operatingCostCny: "199.00000000", complete: true,
      });
    } finally { await db.destroy(); }
  });

  it("projects migrated carryover fee and full-period ledger usage without a finance event", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const resourceId = randomUUID();
      const provider = await db.selectFrom("provider").select("id")
        .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      await db.insertInto("provider_resource").values({ id: resourceId,
        enterprise_id: enterpriseId, provider_id: provider.id, name: "Carryover Plan",
        mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" }).execute();
      const legacySnapshot = await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 1,
        source: "ADMIN", collected_at: new Date("2026-08-03T00:00:00Z"),
        currency: "CNY", package_name: "Legacy Plan", package_cost: "199",
        total_quota: "300000000", quota_unit: "TOKEN",
        effective_from: new Date("2026-07-20T00:00:00Z"),
        effective_until: new Date("2026-08-19T00:00:00Z"),
        reset_cycle: "MONTHLY", usage_calculation: "SYSTEM_LEDGER",
      }).returning("id").executeTakeFirstOrThrow();
      const carryoverPeriodId = (await db.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        finance_event_id: null, product_name: "Carryover Plan",
        period_start: new Date("2026-08-18T16:00:00Z"),
        period_end_exclusive: new Date("2026-09-18T16:00:00Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: legacySnapshot.id,
        created_by_admin_user_id: adminId,
      }).returning("id").executeTakeFirstOrThrow()).id;
      await db.insertInto("provider_resource_operating_snapshot").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId, version: 2,
        source: "ADMIN", collected_at: new Date("2026-09-03T00:00:00Z"),
        currency: "CNY", package_name: "Unrelated overlap", package_cost: "999",
        total_quota: "1", quota_unit: "TOKEN",
        effective_from: new Date("2026-08-20T00:00:00Z"),
        effective_until: new Date("2026-09-10T00:00:00Z"),
        usage_calculation: "SYSTEM_LEDGER",
      }).execute();
      const requestId = randomUUID(); const attemptId = randomUUID(); const usageId = randomUUID();
      await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: principalKeyId, protocol: "chat",
        unified_model: "ql-k3", status: "SUCCEEDED",
        started_at: new Date("2026-08-20T00:00:00Z"),
        finished_at: new Date("2026-08-20T00:01:00Z") }).execute();
      await db.insertInto("upstream_attempt").values({ id: attemptId, ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
        upstream_model: "k3", response_committed: true,
        started_at: new Date("2026-08-20T00:00:00Z"),
        finished_at: new Date("2026-08-20T00:01:00Z"), http_status: 200 }).execute();
      await db.insertInto("usage_event").values({ id: usageId, ai_request_id: requestId,
        enterprise_id: enterpriseId, upstream_attempt_id: attemptId,
        provider_resource_id: resourceId, input_tokens: 100n, output_tokens: 23n,
        cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `carryover:${requestId}`, created_at: new Date("2026-08-20T00:01:00Z") }).execute();
      await db.insertInto("ledger_line").values({ ai_request_id: requestId,
        enterprise_id: enterpriseId, usage_event_id: usageId, upstream_attempt_id: attemptId,
        provider_resource_id: resourceId, principal_id: principalId, resource_mode: "CODING_PLAN",
        raw_input_tokens: 100n, raw_output_tokens: 23n, raw_cache_tokens: 0n,
        raw_reasoning_tokens: 0n, deducted_quota: 123n, api_cost: null,
        api_cost_status: "NOT_APPLICABLE", subscription_period_id: carryoverPeriodId,
        usage_quality: "PROVIDER_REPORTED", billing_rule_id: null, rule_version: null,
        multiplier: "1", billing_rule_snapshot: null,
        settled_at: new Date("2026-08-20T00:01:00Z"),
        created_at: new Date("2026-08-20T00:01:00Z") }).execute();
      const view = (await new ProviderFinanceRepository(db).listResourceFinanceViews(
        enterpriseId, "2026-09", new Date("2026-09-04T00:00:00Z"),
      )).find((item) => item.resourceId === resourceId);
      expect(view).toMatchObject({ monthlyPlanCashCny: "0.00000000", currentPeriod: {
        fixedFeeAmount: "199.00000000", fixedFeeCurrency: "CNY",
        fixedCashPaidCny: "199.00000000", trueTokens: "123", deductedQuota: "123",
        totalQuota: "300000000.00000000", quotaUnit: "TOKEN", requestCount: "1",
      } });
      const periods = await new ProviderFinanceRepository(db)
        .listSubscriptionPeriods(enterpriseId, resourceId);
      expect(periods?.[0]).toMatchObject({ fixed_fee_amount: "199.00000000",
        fixed_fee_currency: "CNY", fixed_cash_paid_cny: "199.00000000",
        token_usage: { request_count: "1", true_tokens: "123", deducted_quota: "123" } });
      expect(await new ProviderFinanceRepository(db).getSubscriptionPeriodUsage(
        enterpriseId, periods![0]!.id,
      )).toMatchObject({ tokenUsage: { request_count: "1", true_tokens: "123",
        deducted_quota: "123" } });
      await db.updateTable("ledger_line").set({ deducted_quota: null })
        .where("ai_request_id", "=", requestId).execute();
      const incomplete = (await new ProviderFinanceRepository(db).listResourceFinanceViews(
        enterpriseId, "2026-09", new Date("2026-09-04T00:00:00Z"),
      )).find((item) => item.resourceId === resourceId);
      expect(incomplete?.currentPeriod).toMatchObject({
        deductedQuota: null, deductedQuotaComplete: false,
      });
    } finally { await db.destroy(); }
  });

  it("requires a one-time confirmation for a duplicate without external reference", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      const base = {
        enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "2",
        accountCurrency: "CNY" as const, cashPaidCny: "2",
        occurredAt: new Date("2026-09-02T05:00:00.000Z"),
      };
      const originalKey = randomUUID();
      const original = await repo.recordRecharge({ ...base, idempotencyKey: originalKey });
      await expect(repo.recordRecharge({ ...base, idempotencyKey: originalKey }))
        .resolves.toMatchObject({ id: original.id, replayed: true });
      let detail: { candidateId: string; confirmationToken: string; requestHash: string } | undefined;
      try {
        await repo.recordRecharge({ ...base, idempotencyKey: randomUUID() });
      } catch (error) {
        detail = (error as { detail?: typeof detail }).detail;
      }
      expect(detail).toEqual(expect.objectContaining({
        candidateId: expect.any(String), confirmationToken: expect.any(String),
      }));
      // 断言迁移（WP2-S3 / AFR-01 / plan §4.1-R6）：API_RECHARGE 候选确认已退役——
      // repo 守卫抛 API_FUNDING_RETIRED；候选保持 PENDING、零事件写入。
      // （原“确认 201＋重放 replayed”成功断言迁移到下方隔离企业的 Coding Plan 候选用例。）
      const eventsBeforeConfirm = await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", apiResourceId).execute();
      await expect(repo.confirmDuplicateCandidate({
        enterpriseId, candidateId: detail!.candidateId, adminId,
        confirmationToken: detail!.confirmationToken, requestHash: detail!.requestHash,
        idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: "API_FUNDING_RETIRED" });
      expect(await db.selectFrom("provider_finance_duplicate_candidate").select("status")
        .where("id", "=", detail!.candidateId).executeTakeFirst()).toEqual({ status: "PENDING" });
      expect(await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", apiResourceId).execute())
        .toHaveLength(eventsBeforeConfirm.length);
      let expiredDetail: typeof detail;
      try {
        await repo.recordRecharge({ ...base, idempotencyKey: randomUUID() });
      } catch (error) {
        expiredDetail = (error as { detail?: typeof detail }).detail;
      }
      await db.updateTable("provider_finance_duplicate_candidate")
        .set({ expires_at: new Date("2026-09-01T00:00:00.000Z") })
        .where("id", "=", expiredDetail!.candidateId).execute();
      await expect(repo.confirmDuplicateCandidate({
        enterpriseId, candidateId: expiredDetail!.candidateId, adminId,
        confirmationToken: expiredDetail!.confirmationToken,
        requestHash: expiredDetail!.requestHash, idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await db.selectFrom("provider_finance_duplicate_candidate").select("status")
        .where("id", "=", expiredDetail!.candidateId).executeTakeFirst())
        .toEqual({ status: "EXPIRED" });
    } finally { await db.destroy(); }
  });

  it("serializes concurrent duplicate detection before committing money", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      const base = { enterpriseId, resourceId: apiResourceId, adminId,
        accountAmount: "3", accountCurrency: "CNY" as const, cashPaidCny: "3",
        occurredAt: new Date("2026-09-02T06:00:00.000Z") };
      const results = await Promise.allSettled([
        repo.recordRecharge({ ...base, idempotencyKey: randomUUID() }),
        repo.recordRecharge({ ...base, idempotencyKey: randomUUID() }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "DUPLICATE_CONFIRMATION_REQUIRED" },
      });
      expect(await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", apiResourceId)
        .where("event_type", "=", "API_RECHARGE").where("account_amount", "=", "3")
        .where("occurred_at", "=", base.occurredAt).execute()).toHaveLength(1);
    } finally { await db.destroy(); }
  });

  it("freezes the latest covering Coding Plan period at settlement", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const finance = new ProviderFinanceRepository(db);
      const earlier = await db.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: planResourceId,
        finance_event_id: null, product_name: "Earlier overlap",
        period_start: new Date("2026-08-31T16:00:00.000Z"),
        period_end_exclusive: new Date("2026-09-30T16:00:00.000Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: null,
        created_by_admin_user_id: adminId,
      }).returning("id").executeTakeFirstOrThrow();
      const later = await finance.recordSubscription({
        enterpriseId, resourceId: planResourceId, adminId, kind: "RENEWAL",
        productName: "Kimi Coding Plan overlap", accountAmount: "199", accountCurrency: "CNY",
        cashPaidCny: "199", occurredAt: new Date("2026-09-02T08:00:00.000Z"),
        periodStart: new Date("2026-09-01T16:00:00.000Z"),
        periodEndExclusive: new Date("2026-10-01T16:00:00.000Z"),
        externalReference: "finance-repo-plan-overlap", idempotencyKey: randomUUID(),
      });
      const ledger = new GatewayLedgerRepository(db);
      const requestId = randomUUID();
      await ledger.createRequest({
        id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
        principal_key_id: principalKeyId, protocol: "OPENAI_CHAT", unified_model: "kimi-k2",
        unified_model_id: null,
      });
      const attempt = await ledger.createAttempt({
        ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
        provider_resource_id: planResourceId, upstream_model: "kimi-k2",
      });
      const result = await ledger.createUsageAndLedgerLineIfAbsent({
        usage: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: planResourceId,
          input_tokens: 10n, output_tokens: 2n, cache_tokens: 8n, reasoning_tokens: 1n,
          usage_quality: "PROVIDER_REPORTED", dedup_key: `${requestId}:attempt1` },
        ledger_line: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: planResourceId,
          principal_id: principalId, resource_mode: "CODING_PLAN",
          raw_input_tokens: 10n, raw_output_tokens: 2n, raw_cache_tokens: 8n,
          raw_reasoning_tokens: 1n, deducted_quota: 24n, api_cost: null,
          api_cost_currency: null, api_cost_status: "NOT_APPLICABLE",
          settled_at: new Date("2026-09-03T00:00:00.000Z"),
          usage_quality: "PROVIDER_REPORTED" },
      });
      expect(result.line.subscription_period_id).toBe(later.periodId);
      const periods = await finance.listSubscriptionPeriods(enterpriseId, planResourceId);
      expect(periods.find((period) => period.id === later.periodId)?.token_usage)
        .toMatchObject({ request_count: "1", deducted_quota: "24" });
      expect(periods.find((period) => period.id === earlier.id)?.token_usage)
        .toMatchObject({ request_count: "0", deducted_quota: "0" });
      await expect(db.updateTable("ledger_line")
        .set({ settled_at: new Date("2026-11-03T00:00:00.000Z") })
        .where("id", "=", result.line.id).execute())
        .rejects.toThrow(/does not cover settlement time/);
    } finally { await db.destroy(); }
  });

  it("October opening carries September closing and excludes October midnight recharge", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const provider = await db.selectFrom("provider").select("id")
        .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      const resourceId = randomUUID();
      await db.insertInto("provider_resource").values({ id: resourceId,
        enterprise_id: enterpriseId, provider_id: provider.id, name: "Monthly carryover API",
        mode: "API", credential_type: "API_KEY", created_at: new Date("2026-08-01T00:00:00Z"),
      }).execute();
      // 0094 退役种入触发器后 PENDING 行需夹具显式构造；0083 资源级 ADMIN 期初 DB 合同语义不变。
      await db.insertInto("provider_resource_finance_state").values({
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        state: "PENDING" }).execute();
      const finance = new ProviderFinanceRepository(db);
      await finance.recordOpeningBalance({ enterpriseId, resourceId, adminId,
        accountAmount: "100", accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "September opening", idempotencyKey: randomUUID() });
      for (const [amount, at] of [["50", "2026-09-30T23:59:58+08:00"],
        ["20", "2026-10-01T00:00:00+08:00"]] as const) {
        await finance.recordRecharge({ enterpriseId, resourceId, adminId,
          accountAmount: amount, accountCurrency: "CNY", cashPaidCny: amount,
          occurredAt: new Date(at), externalReference: randomUUID(), idempotencyKey: randomUUID() });
      }
      const ledger = new GatewayLedgerRepository(db);
      const requestId = randomUUID();
      await ledger.createRequest({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: principalKeyId, protocol: "OPENAI_CHAT",
        unified_model: "deepseek-chat", unified_model_id: null });
      const attempt = await ledger.createAttempt({ ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
        upstream_model: "deepseek-chat" });
      await ledger.createUsageAndLedgerLineIfAbsent({
        usage: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
          input_tokens: 1n, output_tokens: 1n, cache_tokens: 0n, reasoning_tokens: 0n,
          usage_quality: "PROVIDER_REPORTED", dedup_key: `${requestId}:attempt1` },
        ledger_line: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
          principal_id: principalId, resource_mode: "API", raw_input_tokens: 1n,
          raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
          api_cost: "5", api_cost_status: "PRICED_USAGE", api_cost_currency: "CNY",
          settled_at: new Date("2026-09-30T23:59:59+08:00"), usage_quality: "PROVIDER_REPORTED" },
      });
      const septemberClosing = await finance.getCurrentBalance(enterpriseId, resourceId,
        "CNY", new Date("2026-09-30T23:59:59.999+08:00"));
      expect(septemberClosing).toMatchObject({ state: "NORMAL", balance: "145.00000000" });
      const october = await finance.listResourceFinanceViews(enterpriseId, "2026-10",
        new Date("2026-10-01T00:00:01+08:00"));
      expect(october.find((view) => view.resourceId === resourceId)?.accounts[0])
        .toMatchObject({ monthOpeningState: "NORMAL", monthOpeningBalance: septemberClosing!.balance,
          monthlyRecharge: "20.00000000", balance: "165.00000000" });
    } finally { await db.destroy(); }
  });

  it("fails closed when a post-cutover API cost fact is unclassified", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const provider = await db.selectFrom("provider").select("id")
        .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
      const incompleteResourceId = randomUUID();
      await db.insertInto("provider_resource").values({
        id: incompleteResourceId, enterprise_id: enterpriseId, provider_id: provider.id,
        name: "Incomplete API", mode: "API", credential_type: "API_KEY",
        created_at: new Date("2026-08-01T00:00:00.000Z"),
      }).execute();
      // 0094 退役种入触发器（原由 0081 自动播种）后 PENDING 行需夹具显式构造；
      // 0083 资源级 ADMIN 期初 DB 合同语义不变。
      await db.insertInto("provider_resource_finance_state").values({
        enterprise_id: enterpriseId, provider_resource_id: incompleteResourceId,
        state: "PENDING" }).execute();
      const finance = new ProviderFinanceRepository(db);
      await finance.recordOpeningBalance({
        enterpriseId, resourceId: incompleteResourceId, adminId, accountAmount: "10",
        accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "incomplete-opening", idempotencyKey: randomUUID(),
      });
      const ledger = new GatewayLedgerRepository(db);
      const requestId = randomUUID();
      await ledger.createRequest({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: principalKeyId, protocol: "OPENAI_CHAT",
        unified_model: "deepseek-chat", unified_model_id: null });
      const attempt = await ledger.createAttempt({ ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: incompleteResourceId,
        upstream_model: "deepseek-chat" });
      await ledger.createUsageAndLedgerLineIfAbsent({
        usage: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: incompleteResourceId,
          input_tokens: 1n, output_tokens: 1n, cache_tokens: 0n, reasoning_tokens: 0n,
          usage_quality: "PROVIDER_REPORTED", dedup_key: `${requestId}:attempt1` },
        ledger_line: { ai_request_id: requestId, enterprise_id: enterpriseId,
          upstream_attempt_id: attempt.id, provider_resource_id: incompleteResourceId,
          principal_id: principalId, resource_mode: "API", raw_input_tokens: 1n,
          raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
          // 0059 fact-shape：UNKNOWN_COST 须 api_cost 与 api_cost_currency 皆为 NULL。
          api_cost: null, api_cost_status: "UNKNOWN_COST",
          settled_at: new Date("2026-09-03T01:00:00.000Z"),
          usage_quality: "PROVIDER_REPORTED" },
      });
      expect(await finance.getCurrentBalance(enterpriseId, incompleteResourceId, "CNY",
        new Date("2026-09-03T02:00:00.000Z"))).toMatchObject({
        state: "INCOMPLETE_USAGE_COST", balance: null,
        gaps: [expect.objectContaining({ code: "API_USAGE_COST_UNKNOWN" })],
      });
      expect(await finance.getMonthlyFinanceSummary(enterpriseId, "2026-09")).toMatchObject({
        complete: false,
        gaps: expect.arrayContaining([
          { code: "API_USAGE_COST_UNKNOWN", count: 1 },
        ]),
      });
    } finally { await db.destroy(); }
  });

  it("returns archived and missing-opening states without fabricating zero", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      expect(await repo.getCurrentBalance(
        enterpriseId, apiResourceId, "USD", new Date("2026-08-31T15:59:59.000Z"),
      )).toMatchObject({ state: "LEGACY_ARCHIVED", balance: null });
      expect(await repo.getCurrentBalance(
        enterpriseId, apiResourceId, "USD", new Date("2026-09-02T02:00:00.000Z"),
      )).toMatchObject({ state: "MISSING_OPENING_BALANCE", balance: null });
    } finally { await db.destroy(); }
  });

  // WP2-S3（AFR-01 / plan §4.1-R6）：repo 守卫按事实模式拆分——隔离企业中验证
  // API 事实冲销抛 API_FUNDING_RETIRED、Coding Plan 事实冲销与候选确认照常。
  it("retires API funding facts at repo level while Coding Plan reversal and confirmation keep working", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const repo = new ProviderFinanceRepository(db);
      const isolatedEnterpriseId = randomUUID();
      const isolatedAdminId = randomUUID();
      const isolatedApiId = randomUUID();
      const isolatedPlanId = randomUUID();
      const isolatedProviderId = randomUUID();
      await db.insertInto("enterprise").values({ id: isolatedEnterpriseId,
        name: "Retirement Guards" }).execute();
      await db.insertInto("admin_user").values({ id: isolatedAdminId,
        enterprise_id: isolatedEnterpriseId, username: `retired-${isolatedAdminId}`,
        password_hash: "not-used", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: isolatedProviderId,
        enterprise_id: isolatedEnterpriseId, code: "deepseek", name: "DeepSeek",
        adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values([
        { id: isolatedApiId, enterprise_id: isolatedEnterpriseId, provider_id: isolatedProviderId,
          name: "Isolated API", mode: "API", credential_type: "API_KEY",
          created_at: new Date("2026-08-01T00:00:00Z") },
        { id: isolatedPlanId, enterprise_id: isolatedEnterpriseId, provider_id: isolatedProviderId,
          name: "Isolated Plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
          created_at: new Date("2026-08-01T00:00:00Z") },
      ]).execute();
      // 0083 ADMIN 期初触发器前置：企业已激活＋资源 PENDING。
      await db.insertInto("provider_finance_runtime_state").values({
        enterprise_id: isolatedEnterpriseId, strict_writes_enabled: true,
        activated_at: new Date("2026-09-01T00:00:00+08:00"),
        activated_by_admin_user_id: isolatedAdminId,
      }).execute();
      await db.insertInto("provider_resource_finance_state").values({
        enterprise_id: isolatedEnterpriseId, provider_resource_id: isolatedApiId,
        state: "PENDING" }).execute();

      // 1) API 事实冲销：同码拒绝、零写入（recordRecharge 经 recordSimpleEvent，
      //    守卫不在共享 Tx 原语上——直插/repo 写仍可用于历史夹具）。
      //    0083 触发器要求同币种期初先于充值存在，故期初夹具先行（MIGRATION 源钉切换时点）。
      await db.insertInto("provider_finance_event").values({
        enterprise_id: isolatedEnterpriseId, provider_resource_id: isolatedApiId,
        event_type: "API_OPENING_BALANCE", account_amount: "0", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: PROVIDER_FINANCE_CUTOVER, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: null, evidence_ref: "repo-guard-fixture",
        source: "MIGRATION", idempotency_key: randomUUID(),
        created_by_admin_user_id: isolatedAdminId,
      }).execute();
      const recharge = await repo.recordRecharge({ enterpriseId: isolatedEnterpriseId,
        resourceId: isolatedApiId, adminId: isolatedAdminId, accountAmount: "30",
        accountCurrency: "CNY", cashPaidCny: "30",
        occurredAt: new Date("2026-09-05T01:00:00+08:00"), evidenceRef: "repo-guard-recharge",
        idempotencyKey: randomUUID() });
      const apiEventsBefore = await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", isolatedApiId).execute();
      await expect(repo.reverseFinanceEvent({
        enterpriseId: isolatedEnterpriseId, eventId: recharge.id, adminId: isolatedAdminId,
        reason: "should be retired", evidenceRef: "reversal-proof",
        idempotencyKey: randomUUID(),
      })).rejects.toMatchObject({ code: "API_FUNDING_RETIRED" });
      expect(await db.selectFrom("provider_finance_event").select("id")
        .where("provider_resource_id", "=", isolatedApiId).execute())
        .toHaveLength(apiEventsBefore.length);

      // 2) Coding Plan 事实冲销照常：REVERSAL 事件落库、周期标记 reversed_by_event_id。
      const purchase = await repo.recordSubscription({
        enterpriseId: isolatedEnterpriseId, resourceId: isolatedPlanId,
        adminId: isolatedAdminId, kind: "PURCHASE", productName: "Kimi Coding Plan",
        accountAmount: "199", accountCurrency: "CNY", cashPaidCny: "199",
        occurredAt: new Date("2026-09-05T01:00:00+08:00"),
        periodStart: new Date("2026-09-04T16:00:00Z"),
        periodEndExclusive: new Date("2026-10-04T16:00:00Z"),
        externalReference: "repo-guard-plan-1", idempotencyKey: randomUUID(),
      });
      const reversed = await repo.reverseFinanceEvent({
        enterpriseId: isolatedEnterpriseId, eventId: purchase.event.id,
        adminId: isolatedAdminId, reason: "plan cancelled", evidenceRef: "reversal-proof",
        idempotencyKey: randomUUID(),
      });
      expect(reversed).toMatchObject({ eventType: "REVERSAL",
        reversalOfEventId: purchase.event.id, replayed: false });
      expect(await db.selectFrom("provider_subscription_period").select("reversed_by_event_id")
        .where("id", "=", purchase.periodId).executeTakeFirstOrThrow())
        .toEqual({ reversed_by_event_id: reversed.id });

      // 3) Coding Plan 重复候选确认照常：候选创建 → 确认消费 → 幂等重放。
      const purchaseBase = { enterpriseId: isolatedEnterpriseId, resourceId: isolatedPlanId,
        adminId: isolatedAdminId, kind: "PURCHASE" as const, productName: "Kimi Coding Plan",
        accountAmount: "5", accountCurrency: "CNY" as const, cashPaidCny: "5",
        occurredAt: new Date("2026-09-06T01:00:00+08:00"),
        periodStart: new Date("2026-09-05T16:00:00Z"),
        periodEndExclusive: new Date("2026-10-05T16:00:00Z"),
        evidenceRef: "repo-guard-duplicate" };
      await repo.recordSubscription({ ...purchaseBase, idempotencyKey: randomUUID() });
      let planDetail: { candidateId: string; confirmationToken: string; requestHash: string };
      try {
        await repo.recordSubscription({ ...purchaseBase, idempotencyKey: randomUUID() });
        throw new Error("expected DUPLICATE_CONFIRMATION_REQUIRED");
      } catch (error) {
        planDetail = (error as { detail: typeof planDetail }).detail;
      }
      const confirmationKey = randomUUID();
      const confirmed = await repo.confirmDuplicateCandidate({
        enterpriseId: isolatedEnterpriseId, candidateId: planDetail.candidateId,
        adminId: isolatedAdminId, confirmationToken: planDetail.confirmationToken,
        requestHash: planDetail.requestHash, idempotencyKey: confirmationKey,
      });
      // 套餐分支返回 { event, periodId }；重放标记在 event 内。
      expect(confirmed).toMatchObject({ event: { replayed: false },
        periodId: expect.any(String) });
      await expect(repo.confirmDuplicateCandidate({
        enterpriseId: isolatedEnterpriseId, candidateId: planDetail.candidateId,
        adminId: isolatedAdminId, confirmationToken: planDetail.confirmationToken,
        requestHash: planDetail.requestHash, idempotencyKey: confirmationKey,
      })).resolves.toMatchObject({ event: { replayed: true } });
      expect(await db.selectFrom("provider_finance_duplicate_candidate").select("status")
        .where("id", "=", planDetail.candidateId).executeTakeFirst())
        .toEqual({ status: "CONSUMED" });
    } finally { await db.destroy(); }
  });
});
