import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest, OperatingBillAccountRepository, OperatingBillRepository,
  UsageRepository } from "../index.js";
import { loadLiveDepartmentBill } from "../repositories/department-cost-read-model.js";
import { loadUsageCostDispositionProjections, loadExcludedUsageCostLineIds } from "../repositories/usage-cost-disposition-projection.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const at = new Date("2026-09-28T12:00:00+08:00");

beforeAll(async () => {
  pg = await startPostgresContainer("usage_disposition_read");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function seed(costs: Array<string | null>, notMigrated = false) {
  const enterpriseId = randomUUID(); const adminId = randomUUID(); const providerId = randomUUID();
  const resourceId = randomUUID(); const principalId = randomUUID(); const keyId = randomUUID();
  const requestId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Cost disposition read" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: adminId, password_hash: "unused", status: "ACTIVE" }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId, code: "deepseek",
    name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
    provider_id: providerId, name: "API", mode: "API", credential_type: "API_KEY" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "Cost user" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: "ql-cost", key_digest: randomUUID() }).execute();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
    principal_id: principalId, principal_key_id: keyId, protocol: "OPENAI_CHAT", unified_model: "deepseek-chat",
    status: "CANCELLED", error_code: "client_cancelled", error_classification: "CLIENT_CANCELLED",
    started_at: at, finished_at: at }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: enterpriseId, provider_resource_id: resourceId, attempt_no: 1,
    upstream_model: "deepseek-chat", started_at: at, finished_at: at, response_committed: false,
    error_code: "client_cancelled", error_classification: "CLIENT_CANCELLED" })
    .returning("id").executeTakeFirstOrThrow();
  const lineIds: string[] = [];
  for (const cost of costs) {
    const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
      enterprise_id: enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: resourceId,
      input_tokens: 0n, output_tokens: 0n, cache_tokens: 0n, reasoning_tokens: 0n,
      usage_quality: "UNKNOWN", dedup_key: randomUUID(), created_at: at })
      .returning("id").executeTakeFirstOrThrow();
    const line = await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId,
      ai_request_id: requestId, upstream_attempt_id: attempt.id, usage_event_id: usage.id,
      provider_resource_id: resourceId, principal_id: principalId, resource_mode: "API",
      raw_input_tokens: 0n, raw_output_tokens: 0n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: cost, api_cost_currency: cost === null ? null : "CNY",
      api_cost_status: cost === null ? "UNKNOWN_COST" : "PRICED_USAGE", usage_quality: "UNKNOWN",
      settled_at: at, created_at: at }).returning("id").executeTakeFirstOrThrow();
    lineIds.push(line.id);
  }
  await db.insertInto("ledger_transaction").values({ enterprise_id: enterpriseId,
    ai_request_id: requestId, principal_id: principalId, total_input_tokens: 0n, total_output_tokens: 0n,
    total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n,
    total_api_cost: notMigrated ? null : "0", api_cost_status: notMigrated ? "NOT_MIGRATED" : "UNKNOWN_COST",
    usage_quality: "UNKNOWN", attempt_count: 1, status: "SETTLED", created_at: at }).execute();
  return { enterpriseId, adminId, resourceId, principalId, requestId, lineIds };
}

async function exclude(input: Awaited<ReturnType<typeof seed>>, lineId: string) {
  await sql`INSERT INTO provider_finance_usage_cost_disposition
    (enterprise_id, provider_resource_id, ledger_line_id, ai_request_id, decision,
      original_ledger_fact, server_cost_evidence, reason, evidence_ref,
      decided_by_admin_user_id, idempotency_key, request_hash)
    SELECT line.enterprise_id,line.provider_resource_id,line.id,line.ai_request_id,'EXCLUDE_NO_SERVER_COST',
      to_jsonb(line),'{}'::jsonb,'Owner confirmed no server fee record','read-test',
      ${input.adminId}::uuid,${randomUUID()},${"0".repeat(64)}
    FROM ledger_line line WHERE line.enterprise_id=${input.enterpriseId}::uuid AND line.id=${lineId}::uuid`.execute(db);
}

async function assertReadCosts(input: Awaited<ReturnType<typeof seed>>, expectedCost: string | null) {
  const [legacyDepartment, financeDepartment, bill, accounts, detail] = await Promise.all([
    loadLiveDepartmentBill(db, input.enterpriseId, "2026-09", false),
    loadLiveDepartmentBill(db, input.enterpriseId, "2026-09", true),
    new OperatingBillRepository(db).getBill(input.enterpriseId, "2026-09"),
    new OperatingBillAccountRepository(db).listAccounts(input.enterpriseId, "2026-09", "EMPLOYEE"),
    new OperatingBillAccountRepository(db).getEmployeeDetail(input.enterpriseId, "2026-09", input.principalId),
  ]);
  for (const department of [legacyDepartment, financeDepartment]) {
    expect(department.totals.apiCost).toBe(expectedCost);
    expect(department.reasonCodes.includes("API_COST_UNKNOWN")).toBe(expectedCost === null);
  }
  expect(bill.summary.ledgerApiCost).toBe(expectedCost);
  expect(bill.subjects.find((row) => row.principalId === input.principalId)?.apiCost).toBe(expectedCost);
  expect(accounts.totals.apiCost).toBe(expectedCost);
  expect(detail.totals.apiCost).toBe(expectedCost);
}

describe("cost disposition read overlays", () => {
  it("excludes an exact unrecorded cancelled row across views without overwriting its original facts", async () => {
    const input = await seed([null]);
    await exclude(input, input.lineIds[0]!);
    const projected = (await loadUsageCostDispositionProjections(db, input.enterpriseId, [input.requestId]))
      .get(input.requestId);
    expect(projected).toMatchObject({ totalApiCost: "0.00000000", apiCostStatus: "EXCLUDED_NO_RECORDED_COST" });
    expect(await loadExcludedUsageCostLineIds(db, input.enterpriseId, input.requestId)).toEqual(new Set(input.lineIds));
    const listed = await new UsageRepository(db).list({ enterpriseId: input.enterpriseId });
    expect(listed.records[0]).toMatchObject({ totalApiCost: projected!.totalApiCost,
      costStatus: projected!.apiCostStatus, status: "CANCELLED" });
    await assertReadCosts(input, "0.00000000");
    // The legacy department query has a separate path when a Coding Plan exists.
    await sql`INSERT INTO provider_resource (enterprise_id,provider_id,name,mode,credential_type)
      SELECT enterprise_id,provider_id,'Legacy plan','CODING_PLAN','API_KEY' FROM provider_resource
      WHERE id=${input.resourceId}::uuid`.execute(db);
    const legacyWithPlan = await loadLiveDepartmentBill(db, input.enterpriseId, "2026-09", false);
    expect(legacyWithPlan.totals.apiCost).toBe("0.00000000");
    expect(legacyWithPlan.reasonCodes).not.toContain("API_COST_UNKNOWN");
    expect(await db.selectFrom("ledger_line").select(["api_cost", "api_cost_status"])
      .where("id", "=", input.lineIds[0]!).executeTakeFirstOrThrow())
      .toEqual({ api_cost: null, api_cost_status: "UNKNOWN_COST" });
    expect(await db.selectFrom("ledger_transaction").select("api_cost_status")
      .where("ai_request_id", "=", input.requestId).executeTakeFirstOrThrow())
      .toEqual({ api_cost_status: "UNKNOWN_COST" });
    expect((await loadUsageCostDispositionProjections(db, randomUUID(), [input.requestId])).size).toBe(0);
  });

  it("keeps actual recorded fees when another line is excluded", async () => {
    const input = await seed([null, "3.25000000"]);
    await exclude(input, input.lineIds[0]!);
    expect((await new UsageRepository(db).list({ enterpriseId: input.enterpriseId })).records[0])
      .toMatchObject({ totalApiCost: "3.25000000", costStatus: "PRICED_USAGE", costCurrency: "CNY" });
    await assertReadCosts(input, "3.25000000");
  });

  it("leaves unhandled unknown lines and their department gaps visible", async () => {
    const input = await seed([null, null]);
    expect((await loadUsageCostDispositionProjections(db, input.enterpriseId, [input.requestId])).size).toBe(0);
    await exclude(input, input.lineIds[0]!);
    expect((await new UsageRepository(db).list({ enterpriseId: input.enterpriseId })).records[0])
      .toMatchObject({ totalApiCost: null, costStatus: "UNKNOWN_COST" });
    await assertReadCosts(input, null);
  });

  it("preserves an explicit NOT_MIGRATED request total", async () => {
    const input = await seed([null], true);
    await exclude(input, input.lineIds[0]!);
    expect((await new UsageRepository(db).list({ enterpriseId: input.enterpriseId })).records[0])
      .toMatchObject({ totalApiCost: null, costStatus: "NOT_MIGRATED", costNotMigrated: true });
  });
});
