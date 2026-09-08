import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely, migrateDown, migrateToLatest } from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer("provider_finance_ledger"); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0059 provider finance ledger contract", () => {
  it("enforces tenant, mode, signed adjustment, immutable facts and exact reversal", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterpriseId = randomUUID();
      const otherEnterpriseId = randomUUID();
      const providerId = randomUUID();
      const apiResourceId = randomUUID();
      const planResourceId = randomUUID();
      const adminId = randomUUID();
      await db.insertInto("enterprise").values([
        { id: enterpriseId, name: "Finance Contract" },
        { id: otherEnterpriseId, name: "Other Tenant" },
      ]).execute();
      await db.insertInto("admin_user").values({
        id: adminId, enterprise_id: enterpriseId, username: "finance-admin",
        password_hash: "not-used", status: "ACTIVE",
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
      await expect(db.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: planResourceId,
        finance_event_id: null, product_name: "Owner-confirmed carryover",
        period_start: new Date("2026-08-18T16:00:00.000Z"),
        period_end_exclusive: new Date("2026-09-18T16:00:00.000Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: null,
        reversed_by_event_id: null, created_by_admin_user_id: adminId,
      }).execute()).resolves.toBeDefined();
      await expect(db.insertInto("provider_subscription_period").values({
        enterprise_id: enterpriseId, provider_resource_id: planResourceId,
        finance_event_id: null, product_name: "Carryover without evidence",
        period_start: new Date("2026-07-18T16:00:00.000Z"),
        period_end_exclusive: new Date("2026-08-18T16:00:00.000Z"),
        source: "MIGRATED_CARRYOVER", migration_source_record_id: null,
        reversed_by_event_id: null, created_by_admin_user_id: null,
      }).execute()).rejects.toThrow();
      const cutover = new Date("2026-08-31T16:00:00.000Z");
      await db.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        event_type: "API_OPENING_BALANCE", account_amount: "0", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: cutover, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
        description: null, evidence_ref: "opening-proof", source: "ADMIN",
        idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await expect(db.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        event_type: "API_OPENING_BALANCE", account_amount: "0", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: cutover, external_reference: null,
        reversal_of_event_id: null, correction_of_event_id: null, reconciliation_case_id: null,
        description: null, evidence_ref: "duplicate", source: "ADMIN",
        idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
      }).execute()).rejects.toThrow();
      const recharge = await db.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        event_type: "API_RECHARGE", account_amount: "100", account_currency: "CNY",
        cash_paid_cny: "100", occurred_at: new Date("2026-09-02T01:00:00.000Z"),
        external_reference: "pay-1", reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: null, evidence_ref: null, source: "ADMIN",
        idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
      }).returningAll().executeTakeFirstOrThrow();
      await expect(db.updateTable("provider_finance_event").set({ account_amount: "101" })
        .where("id", "=", recharge.id).execute()).rejects.toThrow(/append-only/);
      await db.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        event_type: "REVERSAL", account_amount: "-100", account_currency: "CNY",
        cash_paid_cny: "-100", occurred_at: recharge.occurred_at,
        external_reference: null, reversal_of_event_id: recharge.id,
        correction_of_event_id: null, reconciliation_case_id: null,
        description: "wrong recharge", evidence_ref: "reverse-proof", source: "SYSTEM_REVERSAL",
        idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
      }).execute();
      await expect(db.insertInto("provider_finance_event").values({
        enterprise_id: enterpriseId, provider_resource_id: planResourceId,
        event_type: "API_RECHARGE", account_amount: "1", account_currency: "CNY",
        cash_paid_cny: "1", occurred_at: new Date("2026-09-02T02:00:00.000Z"),
        external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: null, description: null, evidence_ref: null, source: "ADMIN",
        idempotency_key: randomUUID(), created_by_admin_user_id: adminId,
      }).execute()).rejects.toThrow(/requires API resource/);
      await expect(sql`
        INSERT INTO provider_finance_event
          (enterprise_id, provider_resource_id, event_type, account_amount, account_currency,
           occurred_at, source, idempotency_key)
        VALUES (${otherEnterpriseId}::uuid, ${apiResourceId}::uuid, 'API_OPENING_BALANCE',
                0, 'CNY', ${cutover}, 'MIGRATION', ${randomUUID()})
      `.execute(db)).rejects.toThrow();
      await expect(sql`
        INSERT INTO provider_finance_event
          (enterprise_id, provider_resource_id, event_type, account_amount, account_currency,
           cash_paid_cny, occurred_at, source, idempotency_key)
        VALUES (${enterpriseId}::uuid, ${apiResourceId}::uuid, 'API_RECHARGE',
          1, 'CNY', 1, '2026-09-02T05:00:00Z', 'ADMIN', ${randomUUID()})
      `.execute(db)).rejects.toThrow();
      const receiptKey = randomUUID();
      await db.insertInto("provider_finance_idempotency").values({
        enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
        idempotency_key: receiptKey, request_hash: "a".repeat(64), response_snapshot: {},
      }).execute();
      await expect(db.updateTable("provider_finance_idempotency")
        .set({ request_hash: "b".repeat(64) }).where("idempotency_key", "=", receiptKey)
        .execute()).rejects.toThrow(/append-only/);
    } finally {
      await db.destroy();
    }
  });

  it("closes a reconciliation case only with its exact signed adjustment", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const enterprise = await db.selectFrom("enterprise").select("id")
        .where("name", "=", "Finance Contract").executeTakeFirstOrThrow();
      const resource = await db.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterprise.id).where("mode", "=", "API")
        .executeTakeFirstOrThrow();
      const admin = await db.selectFrom("admin_user").select("id")
        .where("enterprise_id", "=", enterprise.id).executeTakeFirstOrThrow();
      const caseRow = await db.insertInto("provider_finance_reconciliation_case").values({
        enterprise_id: enterprise.id, provider_resource_id: resource.id, account_currency: "CNY",
        local_balance: "-5", provider_confirmed_balance: "0", difference_amount: "5",
        balance_as_of: new Date("2026-09-02T03:00:00.000Z"), fact_watermark: {},
        evidence_ref: "provider-proof", opened_by_admin_user_id: admin.id,
        decided_by_admin_user_id: null, adjustment_event_id: null, decision: null,
        decision_note: null, decision_idempotency_key: null, decided_at: null, resolved_at: null,
      }).returningAll().executeTakeFirstOrThrow();
      await db.transaction().execute(async (trx) => {
        const event = await trx.insertInto("provider_finance_event").values({
          enterprise_id: enterprise.id, provider_resource_id: resource.id,
          event_type: "API_BALANCE_RECONCILIATION", account_amount: "5", account_currency: "CNY",
          cash_paid_cny: null, occurred_at: caseRow.balance_as_of, external_reference: null,
          reversal_of_event_id: null, correction_of_event_id: null,
          reconciliation_case_id: caseRow.id, description: null, evidence_ref: "provider-proof",
          source: "RECONCILIATION", idempotency_key: randomUUID(),
          created_by_admin_user_id: admin.id,
        }).returning("id").executeTakeFirstOrThrow();
        await trx.updateTable("provider_finance_reconciliation_case").set({
          status: "RESOLVED", decision: "CONFIRMED", adjustment_event_id: event.id,
          decided_by_admin_user_id: admin.id, decided_at: new Date(), resolved_at: new Date(),
          version: 2,
        }).where("id", "=", caseRow.id).execute();
      });
      expect(await db.selectFrom("provider_finance_reconciliation_case").select("status")
        .where("id", "=", caseRow.id).executeTakeFirst()).toEqual({ status: "RESOLVED" });
      await expect(db.updateTable("provider_finance_reconciliation_case")
        .set({ decision_note: "mutated" }).where("id", "=", caseRow.id).execute())
        .rejects.toThrow(/terminal reconciliation case is immutable/);
      const orphanCase = await db.insertInto("provider_finance_reconciliation_case").values({
        enterprise_id: enterprise.id, provider_resource_id: resource.id, account_currency: "CNY",
        local_balance: "1", provider_confirmed_balance: "2", difference_amount: "1",
        balance_as_of: new Date("2026-09-02T04:00:00.000Z"), fact_watermark: {},
        evidence_ref: "orphan-proof", opened_by_admin_user_id: admin.id,
        decided_by_admin_user_id: null, adjustment_event_id: null, decision: null,
        decision_note: null, decision_idempotency_key: null, decided_at: null, resolved_at: null,
      }).returning("id").executeTakeFirstOrThrow();
      await expect(db.insertInto("provider_finance_event").values({
        enterprise_id: enterprise.id, provider_resource_id: resource.id,
        event_type: "API_BALANCE_RECONCILIATION", account_amount: "1", account_currency: "CNY",
        cash_paid_cny: null, occurred_at: new Date("2026-09-02T04:00:00.000Z"),
        external_reference: null, reversal_of_event_id: null, correction_of_event_id: null,
        reconciliation_case_id: orphanCase.id, description: null, evidence_ref: "orphan-proof",
        source: "RECONCILIATION", idempotency_key: randomUUID(),
        created_by_admin_user_id: admin.id,
      }).execute()).rejects.toThrow(/not closed by its resolved case/);
      const shape = await sql<{ definition: string }>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conname='ledger_line_api_cost_fact_shape_check'
      `.execute(db);
      expect(shape.rows[0]?.definition).toContain("CONFIRMED_ZERO_NO_UPSTREAM");
      const plan = await db.selectFrom("provider_resource").select("id")
        .where("enterprise_id", "=", enterprise.id).where("mode", "=", "CODING_PLAN")
        .executeTakeFirstOrThrow();
      await expect(db.insertInto("provider_finance_event").values({
        enterprise_id: enterprise.id, provider_resource_id: plan.id,
        event_type: "CODING_PLAN_PURCHASE", account_amount: "199", account_currency: "CNY",
        cash_paid_cny: "199", occurred_at: new Date("2026-09-02T00:00:00.000Z"),
        external_reference: "orphan-plan", reversal_of_event_id: null,
        correction_of_event_id: null, reconciliation_case_id: null,
        description: null, evidence_ref: null, source: "ADMIN",
        idempotency_key: randomUUID(), created_by_admin_user_id: admin.id,
      }).execute()).rejects.toThrow(/missing its period/);
    } finally {
      await db.destroy();
    }
  });

  it("blocks destructive rollback after provider finance facts exist", async () => {
    const db = createKysely(pg.connectionString);
    try {
      expect(await migrateDown(db)).toBe("0067_alert_resource_context");
      expect(await migrateDown(db)).toBe("0066_admin_cleanup");
      expect(await migrateDown(db)).toBe("0065_principal_accounting_assignment");
      expect(await migrateDown(db)).toBe("0064_quota_pricing_and_policy_archive");
      expect(await migrateDown(db)).toBe("0063_operating_snapshot_subscription_period");
      expect(await migrateDown(db)).toBe("0062_resource_fact_reconciliation");
      expect(await migrateDown(db)).toBe("0061_provider_finance_audit_hardening");
      expect(await migrateDown(db)).toBe("0060_provider_finance_legacy_cost_resolution");
      await expect(migrateDown(db)).rejects.toThrow(/0059 rollback blocked/);
    } finally {
      await db.destroy();
    }
  });
});
