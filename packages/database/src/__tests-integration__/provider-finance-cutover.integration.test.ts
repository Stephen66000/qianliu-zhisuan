import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

import {
  createKysely, GatewayLedgerRepository, migrateDown, migrateToLatest, ProviderFinanceCutoverRepository,
  OperatingBillRepository, ProviderFinanceRepository, PROVIDER_FINANCE_CUTOVER,
  PROVIDER_FINANCE_LEGACY_COST_CUTOFF,
  enableProjectAllocation, runDueAllocationRuns, projectAllocationTick,
} from "../index.js";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("provider_finance_cutover"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("provider finance cutover rehearsal", () => {
  it("reports manual blockers and only backfills four allowed usage fields", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID(); const adminId = randomUUID();
      const providerId = randomUUID(); const apiResourceId = randomUUID();
      const planResourceId = randomUUID(); const apiSnapshotId = randomUUID();
      const planSnapshotId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "Cutover Rehearsal" }).execute();
      await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
        username: "cutover-admin", password_hash: "unused", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
        code: "deepseek", name: "Cutover Provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values([
        { id: apiResourceId, enterprise_id: enterpriseId, provider_id: providerId,
          name: "API", mode: "API", credential_type: "API_KEY" },
        { id: planResourceId, enterprise_id: enterpriseId, provider_id: providerId,
          name: "Plan", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" },
      ]).execute();
      await sql`
        INSERT INTO provider_resource_operating_snapshot
          (id, enterprise_id, provider_resource_id, version, source, collected_at,
           currency, current_balance, package_name, package_cost, effective_from,
           effective_until, usage_calculation)
        VALUES
          (${apiSnapshotId}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid, 1, 'ADMIN',
           '2026-08-31T15:00:00Z', 'CNY', 50, NULL, NULL, NULL, NULL, 'MANUAL_SNAPSHOT'),
          (${planSnapshotId}::uuid, ${enterpriseId}::uuid, ${planResourceId}::uuid, 1, 'ADMIN',
           '2026-08-31T15:00:00Z', 'CNY', NULL, 'Kimi Plan', 199,
           '2026-08-18T16:00:00Z', '2026-09-19T16:00:00Z', 'MANUAL_SNAPSHOT')
      `.execute(db);
      await sql`
        INSERT INTO resource_purchase_record
          (enterprise_id, provider_resource_id, purchase_type, description, amount, currency,
           purchased_at, service_period_start, service_period_end, source, evidence_ref, created_by)
        VALUES
          (${enterpriseId}::uuid, ${apiResourceId}::uuid, 'API_RECHARGE', 'legacy api', 100,
           'CNY', '2026-09-02T01:00:00Z', NULL, NULL, 'ADMIN', 'legacy-api-proof', ${adminId}::uuid),
          (${enterpriseId}::uuid, ${planResourceId}::uuid, 'PACKAGE_PURCHASE', 'legacy plan', 199,
           'CNY', '2026-09-02T02:00:00Z', '2026-09-02', '2026-10-01', 'ADMIN',
           'legacy-plan-proof', ${adminId}::uuid)
      `.execute(db);
      const lineIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const principalId = randomUUID(); const principalKeyId = randomUUID();
      await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
        type: "EMPLOYEE", name: "Cutover User", department_label: null,
        person_id: null, owner_person_id: null }).execute();
      await db.insertInto("principal_key").values({ id: principalKeyId,
        enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "ql-cutover",
        key_digest: "cutover-digest", allowed_model_ids: [], ip_allowlist: [], expires_at: null,
        quota_limit: null, concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
      const requestIds: string[] = []; const attemptIds: string[] = []; const usageIds: string[] = [];
      const ledger = new GatewayLedgerRepository(db);
      for (let index = 0; index < 4; index += 1) {
        const requestId = randomUUID();
        const resourceId = index === 2 ? planResourceId : apiResourceId;
        await ledger.createRequest({ id: requestId, enterprise_id: enterpriseId,
          principal_id: principalId, principal_key_id: principalKeyId, protocol: "OPENAI_CHAT",
          unified_model: index === 2 ? "kimi-k2" : "deepseek-chat", unified_model_id: null });
        const attempt = await ledger.createAttempt({ ai_request_id: requestId,
          enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
          upstream_model: index === 2 ? "kimi-k2" : "deepseek-chat" });
        const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
          enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
          provider_resource_id: resourceId, input_tokens: 1n, output_tokens: 1n,
          cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
          dedup_key: `${requestId}:attempt1` });
        requestIds.push(requestId); attemptIds.push(attempt.id); usageIds.push(usage!.id);
      }
      await db.updateTable("ai_request").set({
        status: "SUCCEEDED", finished_at: new Date("2026-09-02T05:00:00Z"),
      }).where("id", "in", requestIds).execute();
        await sql`
          INSERT INTO ledger_line
            (id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
             provider_resource_id, principal_id, resource_mode, raw_input_tokens,
             raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, deducted_quota,
             api_cost, api_cost_currency, api_cost_status, subscription_period_id,
             settled_at, usage_quality, billing_rule_snapshot, created_at)
          VALUES
            (${lineIds[0]}::uuid, ${requestIds[0]}::uuid, ${enterpriseId}::uuid,
             ${usageIds[0]}::uuid, ${attemptIds[0]}::uuid, ${apiResourceId}::uuid,
             ${principalId}::uuid, 'API', 10, 2, 1, 0, NULL, 1, NULL, NULL, NULL, NULL,
             'PROVIDER_REPORTED', '{"currency":"CNY","ruleVersion":"v1"}'::jsonb,
             '2026-09-02T03:00:00Z'),
            (${lineIds[1]}::uuid, ${requestIds[1]}::uuid, ${enterpriseId}::uuid,
             ${usageIds[1]}::uuid, ${attemptIds[1]}::uuid, ${apiResourceId}::uuid,
             ${principalId}::uuid, 'API', 3, 1, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL,
             'ESTIMATED', NULL, '2026-09-02T04:00:00Z'),
            (${lineIds[2]}::uuid, ${requestIds[2]}::uuid, ${enterpriseId}::uuid,
             ${usageIds[2]}::uuid, ${attemptIds[2]}::uuid, ${planResourceId}::uuid,
             ${principalId}::uuid, 'CODING_PLAN', 8, 2, 4, 1, 20, NULL, NULL, NULL, NULL, NULL,
             'PROVIDER_REPORTED', '{"multiplier":"2"}'::jsonb, '2026-09-02T05:00:00Z'),
            (${lineIds[3]}::uuid, ${requestIds[3]}::uuid, ${enterpriseId}::uuid,
             ${usageIds[3]}::uuid, ${attemptIds[3]}::uuid, ${apiResourceId}::uuid,
             ${principalId}::uuid, 'API', 5, 1, 0, 0, NULL, 2, 'USD', NULL, NULL, NULL,
             'PROVIDER_REPORTED', '{"currency":"CNY","ruleVersion":"v1"}'::jsonb,
             '2026-09-02T06:00:00Z')
        `.execute(db);

      const cutover = new ProviderFinanceCutoverRepository(db);
      const before = await cutover.buildPreflightReport(enterpriseId);
      expect(before.ready).toBe(false);
      expect(before.openingCandidates).toEqual([
        expect.objectContaining({ resourceId: apiResourceId, amount: "50.00000000",
          status: "CANDIDATE" }),
      ]);
      expect(before.purchaseCandidates).toHaveLength(2);
      expect(before.purchaseCandidates.every((item) =>
        item.gaps.includes("CASH_PAID_CNY_MISSING"))).toBe(true);
      expect(before.carryoverCandidates).toEqual([
        expect.objectContaining({ resourceId: planResourceId, alreadyPrepared: false }),
      ]);
      expect(before.usage).toMatchObject({ apiRows: 3, codingPlanRows: 1,
        unclassifiedApiRows: 3, missingApiCurrencyRows: 1,
        conflictingApiCurrencyRows: 1, missingSettlementTimeRows: 4,
        missingSubscriptionPeriodRows: 1 });

      const dryRun = await cutover.backfillUsageFacts(enterpriseId);
      expect(dryRun).toMatchObject({ mode: "DRY_RUN",
        eligible: { settlementTime: 4, pricedApi: 1, confirmedZeroApi: 0,
          unknownApi: 1, codingPlanStatus: 1, codingPlanPeriod: 0 },
        changed: { settlementTime: 0, apiCostCurrency: 0,
          apiCostStatus: 0, subscriptionPeriod: 0 } });

      await new ProviderFinanceRepository(db).recordOpeningBalance({
        enterpriseId, resourceId: apiResourceId, adminId, accountAmount: "50",
        accountCurrency: "CNY", occurredAt: PROVIDER_FINANCE_CUTOVER,
        evidenceRef: "owner-confirmed-opening", idempotencyKey: randomUUID(),
      });
      const carryover = await db.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: planResourceId,
        finance_event_id: null, product_name: "Kimi Plan",
        period_start: new Date("2026-08-18T16:00:00Z"),
        period_end_exclusive: new Date("2026-09-19T16:00:00Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: planSnapshotId,
        reversed_by_event_id: null, created_by_admin_user_id: adminId,
      }).returning("id").executeTakeFirstOrThrow();

      const applied = await cutover.backfillUsageFacts(enterpriseId, true);
      expect(applied).toMatchObject({ mode: "APPLY",
        changed: { settlementTime: 4, apiCostCurrency: 1,
          apiCostStatus: 3, subscriptionPeriod: 1 }, nonTargetHashMismatches: 0,
        remainingGaps: expect.arrayContaining([
          { code: "API_USAGE_COST_UNCLASSIFIED", count: 2 },
          { code: "API_COST_CURRENCY_CONFLICT", count: 1 },
        ]) });
      expect(await db.selectFrom("ledger_line")
        .select(["api_cost_currency", "api_cost_status", "subscription_period_id", "settled_at"])
        .where("id", "=", lineIds[0]!).executeTakeFirst()).toMatchObject({
          api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
          subscription_period_id: null, settled_at: new Date("2026-09-02T03:00:00Z"),
        });
      expect(await db.selectFrom("ledger_line").select("subscription_period_id")
        .where("id", "=", lineIds[2]!).executeTakeFirst()).toEqual({
          subscription_period_id: carryover.id,
        });
      expect(await cutover.backfillUsageFacts(enterpriseId, true)).toMatchObject({
        changed: { settlementTime: 0, apiCostCurrency: 0,
          apiCostStatus: 0, subscriptionPeriod: 0 }, nonTargetHashMismatches: 0,
      });
      expect(await cutover.buildConservationReport(enterpriseId, "2026-09")).toMatchObject({
        passed: false, counts: { apiUsageRows: 3, pricedApiRows: 1,
          unknownApiRows: 2, codingPlanUsageRows: 1, attributedCodingPlanRows: 1,
          tokenFactMismatches: 4 },
        failures: expect.arrayContaining([
          { code: "LEGACY_PURCHASE_REQUIRES_REVIEW", count: 2 },
          { code: "TOKEN_FACT_MISMATCH", count: 4 },
        ]),
      });
      await db.deleteFrom("ledger_line").where("id", "=", lineIds[3]!).execute();
      const providerBalanceSnapshotId = randomUUID();
      await sql`INSERT INTO provider_resource_operating_snapshot
        (id,enterprise_id,provider_resource_id,version,source,collected_at,currency,
         current_balance,provider_balance_available,balance_source,usage_calculation)
        VALUES (${providerBalanceSnapshotId}::uuid,${enterpriseId}::uuid,${apiResourceId}::uuid,
          2,'PROVIDER_SYNC',${PROVIDER_FINANCE_LEGACY_COST_CUTOFF},'CNY',45,true,
          'PROVIDER_API','SYSTEM_LEDGER')`
        .execute(db);
      const resolutionInput = {
        enterpriseId, resourceId: apiResourceId, adminId, accountCurrency: "CNY" as const,
        windowStart: PROVIDER_FINANCE_CUTOVER,
        windowEndInclusive: PROVIDER_FINANCE_LEGACY_COST_CUTOFF,
        providerBalanceSnapshotId, evidenceRef: "provider-balance-gap-proof",
        idempotencyKey: randomUUID(),
      };
      const resolved = await cutover.resolveLegacyApiCostGap(resolutionInput);
      expect(resolved).toMatchObject({ providerConfirmedBalance: "45.00000000",
        localBalanceBeforeAdjustment: "49.00000000", knownApiCost: "1.00000000",
        missingApiCost: "4.00000000", unknownLineCount: "1", replayed: false });
      await expect(cutover.resolveLegacyApiCostGap(resolutionInput))
        .resolves.toMatchObject({ id: resolved.id, replayed: true });
      await expect(db.updateTable("provider_resource_operating_snapshot")
        .set({ current_balance: "44" }).where("id", "=", providerBalanceSnapshotId).execute())
        .rejects.toThrow(/sealed by a legacy cost resolution/);
      await expect(cutover.resolveLegacyApiCostGap({ ...resolutionInput,
        windowEndInclusive: new Date(PROVIDER_FINANCE_LEGACY_COST_CUTOFF.getTime() - 1),
        idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(cutover.resolveLegacyApiCostGap({ ...resolutionInput,
        resourceId: planResourceId, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ code: "INVALID_MODE" });
      const finance = new ProviderFinanceRepository(db);
      expect(await finance.listSubscriptionPeriods(enterpriseId, planResourceId)).toEqual([
        expect.objectContaining({ id: carryover.id, fixed_fee_amount: "199.00000000",
          token_usage: expect.objectContaining({ request_count: "1", input_tokens: "8",
            output_tokens: "2", cache_tokens: "4", reasoning_tokens: "1",
            true_tokens: "10" }) }),
      ]);
      expect(await finance.getCurrentBalance(enterpriseId, apiResourceId, "CNY",
        new Date("2026-09-02T05:00:00Z"))).toMatchObject({
        state: "INCOMPLETE_USAGE_COST", balance: null,
      });
      expect(await finance.getCurrentBalance(enterpriseId, apiResourceId, "CNY",
        new Date(PROVIDER_FINANCE_LEGACY_COST_CUTOFF.getTime() + 1))).toMatchObject({
        state: "NORMAL", balance: "45.00000000",
        components: { legacyCostAdjustments: "-4.00000000", usageDebits: "1.00000000" },
      });
      expect(await finance.getMonthlyFinanceSummary(enterpriseId, "2026-09")).toMatchObject({
        complete: true, apiOperatingCosts: [{ currency: "CNY", amount: "5.00000000" }],
        codingPlanFixedCostCny: "199.00000000", operatingCostCny: "204.00000000",
      });
      const operatingBill = await new OperatingBillRepository(db, "DARK")
        .getBill(enterpriseId, "2026-09");
      expect(operatingBill.summary.apiSpends).toEqual([
        { currency: "CNY", amount: "5.00000000" },
      ]);
      expect(operatingBill.gaps).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "API_NEGATIVE_BALANCE_BRIDGE" }),
        expect.objectContaining({ code: "API_COST_UNKNOWN" }),
      ]));
      expect(operatingBill.subjects).toEqual(expect.arrayContaining([
        expect.objectContaining({ principalId: "__unassigned_project__",
          apiCost: "4.00000000", totalAllocatedCost: "4.00000000" }),
      ]));
      expect((await cutover.buildPreflightReport(enterpriseId)).blockers)
        .not.toContainEqual(expect.objectContaining({ code: "API_USAGE_COST_UNCLASSIFIED" }));
      const afterResolution = await cutover.buildConservationReport(enterpriseId, "2026-09");
      expect(afterResolution.counts).toMatchObject({
        apiUsageRows: 2, pricedApiRows: 1, unknownApiRows: 0, resolvedLegacyApiRows: 1,
      });
      expect(afterResolution.failures)
        .not.toContainEqual(expect.objectContaining({ code: "API_USAGE_CLASSIFICATION_MISMATCH" }));
      await expect(migrateDown(db)).resolves.toBe("0077_project_allocation_compute");
      await expect(migrateDown(db)).resolves.toBe("0076_project_allocation_relations");
      await expect(migrateDown(db)).resolves.toBe("0075_provider_resource_archive");
      await expect(migrateDown(db)).resolves.toBe("0074_runtime_notification_recipients");
      await expect(migrateDown(db)).resolves.toBe("0073_credential_chat_probe");
      await expect(migrateDown(db)).resolves.toBe("0072_admin_roles_security");
      await expect(migrateDown(db)).resolves.toBe("0071_enterprise_contact_details");
      await expect(migrateDown(db)).resolves.toBe("0070_alert_recovery_evidence");
      await expect(migrateDown(db)).resolves.toBe("0069_auth_error_evidence");
      await expect(migrateDown(db)).resolves.toBe("0068_alert_resource_context");
      await expect(migrateDown(db)).resolves.toBe("0067_admin_cleanup");
      await expect(migrateDown(db)).resolves.toBe("0066_subscription_auto_renewal");
      await expect(migrateDown(db)).resolves.toBe("0065_principal_accounting_assignment");
      await expect(migrateDown(db)).resolves.toBe("0064_quota_pricing_and_policy_archive");
      await expect(migrateDown(db)).resolves.toBe("0063_operating_snapshot_subscription_period");
      await expect(migrateDown(db)).resolves.toBe("0062_resource_fact_reconciliation");
      await expect(migrateDown(db)).rejects.toThrow(/0061 rollback blocked/);
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it("returns GO candidate only when opening, monthly and balance conservation are complete", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID(); const adminId = randomUUID();
      const providerId = randomUUID(); const resourceId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "Green Rehearsal" }).execute();
      await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
        username: "green-admin", password_hash: "unused", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
        code: "green", name: "Green Provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values({ id: resourceId,
        enterprise_id: enterpriseId, provider_id: providerId, name: "Green API",
        mode: "API", credential_type: "API_KEY" }).execute();
      await new ProviderFinanceRepository(db).recordOpeningBalance({ enterpriseId,
        resourceId, adminId, accountAmount: "20", accountCurrency: "CNY",
        occurredAt: PROVIDER_FINANCE_CUTOVER, evidenceRef: "green-owner-confirmation",
        idempotencyKey: randomUUID() });
      await new ProviderFinanceRepository(db).recordOpeningBalance({ enterpriseId,
        resourceId, adminId, accountAmount: "5", accountCurrency: "USD",
        occurredAt: PROVIDER_FINANCE_CUTOVER, evidenceRef: "green-owner-confirmation-usd",
        idempotencyKey: randomUUID() });
      const cutover = new ProviderFinanceCutoverRepository(db);
      const preflight = await cutover.buildPreflightReport(enterpriseId);
      expect(preflight).toMatchObject({ ready: true, blockers: [] });
      expect(preflight.openingCandidates).toEqual([
        expect.objectContaining({ resourceId, currency: "CNY", status: "CONFIRMED" }),
        expect.objectContaining({ resourceId, currency: "USD", status: "CONFIRMED" }),
      ]);
      const conservation = await cutover.buildConservationReport(enterpriseId, "2026-09");
      expect(conservation).toMatchObject({ passed: true, monthlyComplete: true, failures: [] });
      expect(conservation.balances).toEqual([
        expect.objectContaining({ resourceId, currency: "CNY",
          state: "NORMAL", balance: "20.00000000", formulaMatches: true }),
        expect.objectContaining({ resourceId, currency: "USD",
          state: "NORMAL", balance: "5.00000000", formulaMatches: true }),
      ]);
      const activation = await cutover.activateStrictWrites(enterpriseId, adminId, "2026-10");
      expect(activation).toMatchObject({ replayed: false,
        conservation: { passed: true, failures: [] } });
      await expect(cutover.activateStrictWrites(enterpriseId, adminId, "2026-09"))
        .resolves.toMatchObject({ replayed: true, activatedAt: activation.activatedAt });
      const principalId = randomUUID(); const principalKeyId = randomUUID();
      await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
        type: "EMPLOYEE", name: "Strict Writer", department_label: null,
        person_id: null, owner_person_id: null }).execute();
      await db.insertInto("principal_key").values({ id: principalKeyId,
        enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "ql-strict",
        key_digest: randomUUID(), allowed_model_ids: [], ip_allowlist: [], expires_at: null,
        quota_limit: null, concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
      const ledger = new GatewayLedgerRepository(db); const requestId = randomUUID();
      await ledger.createRequest({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: principalKeyId, protocol: "OPENAI_CHAT",
        unified_model: "deepseek-chat", unified_model_id: null });
      const attempt = await ledger.createAttempt({ ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
        upstream_model: "deepseek-chat" });
      const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
        enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
        provider_resource_id: resourceId, input_tokens: 1n, output_tokens: 1n,
        cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `${requestId}:attempt1` });
      await expect(ledger.createLedgerLine({ ai_request_id: requestId,
        enterprise_id: enterpriseId, usage_event_id: usage!.id,
        upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
        principal_id: principalId, resource_mode: "API", raw_input_tokens: 1n,
        raw_output_tokens: 1n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
        api_cost: "0.01", usage_quality: "PROVIDER_REPORTED" }))
        .rejects.toThrow(/requires settlement and cost status/);
    } finally {
      await db.destroy();
    }
  }, 120_000);
  it("口径切换同事务推脏已启用账期 → 重算后归集口径更新（R05 收口项）", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID(); const adminId = randomUUID();
      const providerId = randomUUID(); const resourceId = randomUUID();
      await db.insertInto("enterprise").values({ id: enterpriseId, name: "Switch Enterprise" }).execute();
      await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
        username: "switch-admin", password_hash: "unused", status: "ACTIVE" }).execute();
      await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
        code: "switch", name: "Switch Provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
      await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
        provider_id: providerId, name: "Switch API", mode: "API", credential_type: "API_KEY" }).execute();
      await new ProviderFinanceRepository(db).recordOpeningBalance({ enterpriseId, resourceId,
        adminId, accountAmount: "20", accountCurrency: "CNY",
        occurredAt: PROVIDER_FINANCE_CUTOVER, evidenceRef: "switch-owner",
        idempotencyKey: randomUUID() });

      // 归集侧：员工 + 一条消费行（created_at 2026-09-20、settled_at 2026-10-03）：
      // 切换严格写口径后 account_at 由 created_at 变为 settled_at，该行移出 2026-09 账期。
      const principalId = randomUUID(); const keyId = randomUUID(); const requestId = randomUUID();
      await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
        type: "EMPLOYEE", name: "Switch Employee" }).execute();
      await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
        principal_id: principalId, key_prefix: "ql-switch", key_digest: randomUUID() }).execute();
      const at = new Date("2026-09-20T10:00:00+08:00");
      await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
        principal_id: principalId, principal_key_id: keyId, protocol: "openai",
        unified_model: "deepseek-chat", status: "SUCCEEDED", started_at: at,
        finished_at: new Date(at.getTime() + 1000) }).execute();
      const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
        enterprise_id: enterpriseId, attempt_no: 1, provider_resource_id: resourceId,
        upstream_model: "deepseek-chat", finished_at: new Date(at.getTime() + 1000),
        http_status: 200, response_committed: true }).returning("id").executeTakeFirstOrThrow();
      const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
        enterprise_id: enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
        input_tokens: 1_000n, output_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
        dedup_key: `switch-${requestId}`, created_at: at }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("ledger_line").values({ ai_request_id: requestId, enterprise_id: enterpriseId,
        usage_event_id: usage.id, upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
        principal_id: principalId, resource_mode: "API", raw_input_tokens: 1_000n,
        raw_output_tokens: 0n, raw_cache_tokens: 0n, api_cost: "1.0000",
        api_cost_status: "PRICED_USAGE", api_cost_currency: "CNY",
        usage_quality: "PROVIDER_REPORTED", created_at: at,
        settled_at: new Date("2026-10-03T09:00:00+08:00") }).execute();
      await db.insertInto("ledger_transaction").values({ ai_request_id: requestId,
        enterprise_id: enterpriseId, principal_id: principalId, total_input_tokens: 1_000n,
        total_output_tokens: 0n, total_cache_tokens: 0n, total_deducted_quota: 0n,
        total_api_cost: "1.0000", usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
        status: "SETTLED", created_at: at }).execute();

      await enableProjectAllocation(db, { enterpriseId, startMonth: "2026-09", actorAdminId: adminId });
      const before = await runDueAllocationRuns(db, "switch-worker");
      expect(before[0]?.status).toBe("SUCCEEDED");
      const beforeRun = await sql<{ id: string; digest: string | null; line_count: number }>`
        SELECT id, input_digest AS digest, source_line_count AS line_count
        FROM project_allocation_run WHERE enterprise_id = ${enterpriseId}
          AND period_month = '2026-09-01' AND is_current`.execute(db);
      expect(beforeRun.rows[0]?.line_count).toBe(1);

      // 切换严格写合同：与标志位翻转同事务把全部已启用账期推脏。
      const activation = await new ProviderFinanceCutoverRepository(db)
        .activateStrictWrites(enterpriseId, adminId, "2026-10");
      expect(activation).toMatchObject({ replayed: false, conservation: { passed: true } });
      const dirtyAfterSwitch = await sql<{ generation: string; dirty: boolean }>`
        SELECT generation::text, dirty FROM project_allocation_dirty
        WHERE enterprise_id = ${enterpriseId} AND period_month = '2026-09-01'`.execute(db);
      expect(dirtyAfterSwitch.rows[0]?.dirty).toBe(true);
      expect(BigInt(dirtyAfterSwitch.rows[0]!.generation)).toBeGreaterThan(1n);

      // 重算后口径更新：strict writes 下该行 account_at = settled_at（为空）→ 不再计入归集。
      const tick = await projectAllocationTick(db, "switch-worker");
      expect(tick.runsExecuted).toBeGreaterThanOrEqual(1);
      const afterRun = await sql<{ id: string; digest: string | null; line_count: number }>`
        SELECT id, input_digest AS digest, source_line_count AS line_count
        FROM project_allocation_run WHERE enterprise_id = ${enterpriseId}
          AND period_month = '2026-09-01' AND is_current`.execute(db);
      expect(afterRun.rows[0]?.id).not.toBe(beforeRun.rows[0]!.id);
      expect(afterRun.rows[0]?.line_count).toBe(0);
      expect(afterRun.rows[0]?.digest).not.toBe(beforeRun.rows[0]!.digest);
    } finally {
      await db.destroy();
    }
  });
});
