import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest } from "../index.js";
import {
  applyRecordedCostDisposition, previewRecordedCostDisposition,
  type RecordedCostDispositionInput,
} from "../repositories/provider-finance-recorded-cost-disposition.js";
import { loadUnknownCostRows } from "../repositories/provider-finance-balance-facts.js";
import { loadApiCostGaps } from "../repositories/provider-finance-api-cost-gaps.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
const at = new Date("2026-09-28T09:28:00+08:00");
const septemberStart = new Date("2026-09-01T00:00:00+08:00");
const octoberStart = new Date("2026-10-01T00:00:00+08:00");
const septemberEnd = new Date(octoberStart.getTime() - 1);

beforeAll(async () => {
  pg = await startPostgresContainer("recorded_cost_disposition_apply");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function tenant() {
  const enterpriseId = randomUUID(), adminId = randomUUID(), providerId = randomUUID();
  const resourceId = randomUUID(), principalId = randomUUID(), keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Recorded cost decision" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: adminId, password_hash: "test-only", status: "ACTIVE", role_code: "SUPER_ADMIN" }).execute();
  await db.insertInto("provider").values({ id: providerId, enterprise_id: enterpriseId,
    code: "deepseek", name: "Decision test provider", adapter_type: "OPENAI_COMPATIBLE" }).execute();
  await db.insertInto("provider_resource").values({ id: resourceId, enterprise_id: enterpriseId,
    provider_id: providerId, name: "Decision test API", mode: "API", credential_type: "API_KEY" }).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "Decision user" }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: "ql-decision", key_digest: randomUUID() }).execute();
  return { enterpriseId, adminId, resourceId, principalId, keyId };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function cancelledRequest(f: Tenant, committed = false) {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: f.enterpriseId,
    principal_id: f.principalId, principal_key_id: f.keyId, protocol: "chat", unified_model: "deepseek-chat",
    status: "FAILED", error_code: "client_cancelled", error_classification: "CLIENT_INVALID",
    started_at: at, finished_at: at, stream: true }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, attempt_no: 1, provider_resource_id: f.resourceId,
    upstream_model: "deepseek-chat", started_at: at, finished_at: at, http_status: 0,
    response_committed: committed, first_byte_at: committed ? at : null,
    error_code: "client_cancelled", error_classification: "CLIENT_INVALID", failure_layer: "CLIENT" })
    .returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, upstream_attempt_id: attempt.id, provider_resource_id: f.resourceId,
    input_tokens: 0n, output_tokens: 0n, cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "UNKNOWN", upstream_usage_id: null, dedup_key: `${requestId}:attempt1`, created_at: at })
    .returning("id").executeTakeFirstOrThrow();
  const line = await db.insertInto("ledger_line").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, usage_event_id: usage.id, upstream_attempt_id: attempt.id,
    provider_resource_id: f.resourceId, principal_id: f.principalId, resource_mode: "API",
    raw_input_tokens: 0n, raw_output_tokens: 0n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost_status: "UNKNOWN_COST", api_cost: null, api_cost_currency: null,
    billing_rule_snapshot: null, usage_quality: "UNKNOWN", settled_at: at, created_at: at })
    .returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_transaction").values({ ai_request_id: requestId,
    enterprise_id: f.enterpriseId, principal_id: f.principalId, total_input_tokens: 0n,
    total_output_tokens: 0n, total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n,
    total_api_cost: "0.00000000", api_cost_status: "UNKNOWN_COST", usage_quality: "UNKNOWN",
    attempt_count: 1, status: "SETTLED", created_at: at }).execute();
  return { requestId, attemptId: attempt.id, usageId: usage.id, lineId: line.id };
}

function input(f: Tenant, requestIds: string[]): RecordedCostDispositionInput {
  return { enterpriseId: f.enterpriseId, resourceId: f.resourceId, adminId: f.adminId, requestIds,
    operationKey: randomUUID(), reason: "Owner approved accounting from the recorded server costs",
    evidenceRef: "test:explicit-owner-instruction" };
}

async function originalFacts(f: Tenant) {
  return Promise.all([
    db.selectFrom("ai_request").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("id").execute(),
    db.selectFrom("upstream_attempt").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("id").execute(),
    db.selectFrom("usage_event").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("id").execute(),
    db.selectFrom("ledger_line").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("id").execute(),
    db.selectFrom("ledger_transaction").selectAll().where("enterprise_id", "=", f.enterpriseId).orderBy("id").execute(),
  ]);
}

async function writes(f: Tenant) {
  return {
    dispositions: await db.selectFrom("provider_finance_usage_cost_disposition").selectAll()
      .where("enterprise_id", "=", f.enterpriseId).orderBy("ledger_line_id").execute(),
    audits: await db.selectFrom("operation_log").selectAll().where("enterprise_id", "=", f.enterpriseId)
      .where("action", "=", "provider_finance.recorded_cost_disposition").execute(),
  };
}

describe("exact server-recorded-cost decisions", () => {
  it("excludes only the four previewed rows, preserves raw evidence, and replays without a second audit", async () => {
    const f = await tenant();
    const selected = [];
    for (let n = 0; n < 4; n++) selected.push(await cancelledRequest(f, n < 2));
    const preview = await previewRecordedCostDisposition(db, input(f, selected.map(r => r.requestId)));
    // A later fifth matching cancellation must not be absorbed by apply.
    const fifth = await cancelledRequest(f);
    const before = await originalFacts(f);
    const applied = await applyRecordedCostDisposition(db, preview);
    expect(applied).toMatchObject({ requestCount: 4, replayed: false });
    expect(new Set(applied.dispositionIds).size).toBe(4);
    expect(await originalFacts(f)).toEqual(before);
    const stored = await writes(f);
    expect(stored.dispositions.map(r => r.ledger_line_id).sort()).toEqual(selected.map(r => r.lineId).sort());
    expect(stored.dispositions.every(r => r.decision === "EXCLUDE_NO_SERVER_COST"
      && r.reason === preview.input.reason && r.evidence_ref === preview.input.evidenceRef
      && r.decided_by_admin_user_id === f.adminId && r.request_hash === preview.hash)).toBe(true);
    expect(stored.dispositions.every(r => r.original_ledger_fact.api_cost_status === "UNKNOWN_COST"
      && r.original_ledger_fact.api_cost === null)).toBe(true);
    expect(stored.audits).toHaveLength(1);
    expect(stored.audits[0]?.change_summary).toMatchObject({
      originalLedgerFactsPreserved: true, decision: "EXCLUDE_NO_SERVER_COST",
      requestIds: preview.input.requestIds, baselineHash: preview.hash,
    });
    expect(await loadUnknownCostRows(db, { enterpriseId: f.enterpriseId, resourceId: f.resourceId,
      asOf: septemberEnd })).toEqual([{ id: fifth.lineId, ai_request_id: fifth.requestId }]);
    expect(await loadApiCostGaps(db, f.enterpriseId, septemberStart, octoberStart))
      .toEqual([expect.objectContaining({ code: "API_USAGE_COST_UNKNOWN", count: "1", requestCount: "1" })]);
    const replay = await applyRecordedCostDisposition(db, preview);
    expect(replay).toMatchObject({ requestCount: 4, replayed: true });
    expect(replay.dispositionIds.sort()).toEqual(applied.dispositionIds.sort());
    expect(await writes(f)).toEqual(stored);
  });

  it.each(["pricing", "dispatch"] as const)("refuses nonzero %s evidence even when ledger usage is zero", async source => {
    const f = await tenant(), request = await cancelledRequest(f);
    if (source === "pricing") {
      await db.updateTable("ledger_line").set({ billing_rule_snapshot: { apiCost: "0.125", currency: "CNY" } })
        .where("id", "=", request.lineId).execute();
    } else {
      await db.insertInto("dispatch_decision").values({ enterprise_id: f.enterpriseId,
        ai_request_id: request.requestId, final_action: "ALLOW", reason_code: "NO_MATCH",
        actual_cost: "0.125", decided_at: at }).execute();
    }
    await expect(previewRecordedCostDisposition(db, input(f, [request.requestId])))
      .rejects.toThrow("pricing or dispatch contains actual cost");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it("rejects a whole approved batch if one row gains recorded pricing after preview", async () => {
    const f = await tenant(), first = await cancelledRequest(f), second = await cancelledRequest(f);
    const preview = await previewRecordedCostDisposition(db, input(f, [first.requestId, second.requestId]));
    await db.updateTable("ledger_line").set({ billing_rule_snapshot: { apiCost: "0.5", currency: "CNY" } })
      .where("id", "=", second.lineId).execute();
    await expect(applyRecordedCostDisposition(db, preview)).rejects.toThrow("server facts changed since preview");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it("rejects foreign tenant requests and administrators without creating a partial disposition", async () => {
    const f = await tenant(), other = await tenant();
    const localRequest = await cancelledRequest(f), foreignRequest = await cancelledRequest(other);
    await expect(previewRecordedCostDisposition(db, input(f, [localRequest.requestId, foreignRequest.requestId])))
      .rejects.toThrow("request must be terminal and unsuccessful");
    await expect(previewRecordedCostDisposition(db, { ...input(f, [localRequest.requestId]), adminId: other.adminId }))
      .rejects.toThrow("active tenant owner required");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
    expect(await writes(other)).toEqual({ dispositions: [], audits: [] });
  });

  it("rejects apply when the owner is disabled after preview", async () => {
    const f = await tenant(), request = await cancelledRequest(f);
    const preview = await previewRecordedCostDisposition(db, input(f, [request.requestId]));
    await db.updateTable("admin_user").set({ status: "DISABLED" }).where("id", "=", f.adminId).execute();
    await expect(applyRecordedCostDisposition(db, preview)).rejects.toThrow("active tenant owner required");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it.each(["2026-09-01", "2026-10-01"])("refuses a closed affected month %s and detects a close after preview", async periodMonth => {
    const f = await tenant(), request = await cancelledRequest(f);
    const preview = await previewRecordedCostDisposition(db, input(f, [request.requestId]));
    await db.insertInto("operating_bill_period").values({ enterprise_id: f.enterpriseId,
      period_month: periodMonth, status: "CLOSED", created_by: f.adminId }).execute();
    await expect(applyRecordedCostDisposition(db, preview)).rejects.toThrow("server facts changed since preview");
    await expect(previewRecordedCostDisposition(db, input(f, [request.requestId])))
      .rejects.toThrow("affected operating bill is closed");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it("rejects an expired preview without any writes", async () => {
    const f = await tenant(), request = await cancelledRequest(f);
    const preview = await previewRecordedCostDisposition(db, input(f, [request.requestId]));
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(preview.expiresAt) + 1);
    await expect(applyRecordedCostDisposition(db, preview)).rejects.toThrow("preview expired");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it("does not allow extending the approved preview lifetime by changing its expiry", async () => {
    const f = await tenant(), request = await cancelledRequest(f);
    const preview = await previewRecordedCostDisposition(db, input(f, [request.requestId]));
    await expect(applyRecordedCostDisposition(db, { ...preview,
      expiresAt: new Date(Date.parse(preview.expiresAt) + 86_400_000).toISOString() }))
      .rejects.toThrow("preview was modified");
    expect(await writes(f)).toEqual({ dispositions: [], audits: [] });
  });

  it("rejects reuse of an operation key with a different decision reason", async () => {
    const f = await tenant(), request = await cancelledRequest(f);
    const approved = input(f, [request.requestId]);
    await applyRecordedCostDisposition(db, await previewRecordedCostDisposition(db, approved));
    const changed = await previewRecordedCostDisposition(db, { ...approved, reason: "Different authorization" });
    await expect(applyRecordedCostDisposition(db, changed)).rejects.toThrow("idempotency conflict");
    const stored = await writes(f);
    expect(stored.dispositions).toHaveLength(1);
    expect(stored.audits).toHaveLength(1);
    expect(stored.dispositions[0]?.reason).toBe(approved.reason);
  });

  it("does not broaden an existing operation key to a disjoint request set", async () => {
    const f = await tenant(), first = await cancelledRequest(f), second = await cancelledRequest(f);
    const approved = input(f, [first.requestId]);
    await applyRecordedCostDisposition(db, await previewRecordedCostDisposition(db, approved));
    const changed = await previewRecordedCostDisposition(db, { ...approved, requestIds: [second.requestId] });
    await expect(applyRecordedCostDisposition(db, changed)).rejects.toThrow("idempotency conflict");
    const stored = await writes(f);
    expect(stored.dispositions.map(row => row.ledger_line_id)).toEqual([first.lineId]);
    expect(stored.audits).toHaveLength(1);
  });
});
