import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

import {
  createKysely, GatewayLedgerRepository, migrateToLatest, ProviderFinanceCutoverRepository,
  ProviderFinanceRepository, PROVIDER_FINANCE_CUTOVER,
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
        code: "cutover", name: "Cutover Provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
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
    } finally {
      await db.destroy();
    }
  }, 120_000);

  it("returns GO candidate only when opening, monthly and balance conservation are complete", async () => {
    const db = createKysely(pg.connectionString);
    try {
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
    } finally {
      await db.destroy();
    }
  }, 120_000);
});
