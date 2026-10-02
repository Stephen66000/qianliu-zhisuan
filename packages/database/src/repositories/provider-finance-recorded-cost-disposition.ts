import { createHash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { guardOperatingBillLedgerWrite, operatingBillMonthAt } from "./operating-bill-write-barrier.js";
import { PROVIDER_FINANCE_CUTOVER } from "./provider-finance-types.js";

export interface RecordedCostDispositionInput {
  enterpriseId: string;
  resourceId: string;
  adminId: string;
  requestIds: string[];
  operationKey: string;
  reason: string;
  evidenceRef: string;
}
type Fact = Record<string, unknown>;
export interface RecordedCostDispositionPreview {
  input: RecordedCostDispositionInput;
  createdAt: string;
  expiresAt: string;
  hash: string;
  facts: { requests: Fact[]; attempts: Fact[]; usages: Fact[]; lines: Fact[]; transactions: Fact[]; periods: Fact[]; dispatch: Fact[] };
}
type Executor = Kysely<Database> | Transaction<Database>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Recorded cost disposition: ${message}`);
}
function validateInput(input: RecordedCostDispositionInput): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  requireFact([input.enterpriseId, input.resourceId, input.adminId, ...input.requestIds].every(id => uuid.test(id)), "invalid identity");
  requireFact(input.requestIds.length > 0 && input.requestIds.length <= 20
    && new Set(input.requestIds).size === input.requestIds.length, "explicit unique request set required");
  requireFact(input.reason.trim() && input.evidenceRef.trim() && input.operationKey.trim()
    && input.operationKey.length <= 120, "reason, authorization evidence and operation key required");
}
async function facts(db: Executor, input: RecordedCostDispositionInput): Promise<RecordedCostDispositionPreview["facts"]> {
  const ids = sql`ARRAY[${sql.join([...input.requestIds].sort().map(id => sql`${id}::uuid`))}]::uuid[]`;
  const tenant = input.enterpriseId;
  const queries = await Promise.all([
    sql<{ fact: Fact }>`SELECT to_jsonb(r) AS fact FROM ai_request r
      WHERE r.enterprise_id=${tenant}::uuid AND r.id=ANY(${ids}) ORDER BY r.id`.execute(db),
    sql<{ fact: Fact }>`SELECT jsonb_build_object('id',a.id,'ai_request_id',a.ai_request_id,
      'provider_resource_id',a.provider_resource_id,'attempt_no',a.attempt_no,
      'started_at',a.started_at,'first_byte_at',a.first_byte_at,'finished_at',a.finished_at,
      'http_status',a.http_status,'error_code',a.error_code,'error_classification',a.error_classification,
      'response_committed',a.response_committed) AS fact FROM upstream_attempt a
      WHERE a.enterprise_id=${tenant}::uuid AND a.ai_request_id=ANY(${ids}) ORDER BY a.id`.execute(db),
    sql<{ fact: Fact }>`SELECT to_jsonb(u) AS fact FROM usage_event u
      WHERE u.enterprise_id=${tenant}::uuid AND u.ai_request_id=ANY(${ids}) ORDER BY u.id`.execute(db),
    sql<{ fact: Fact }>`SELECT to_jsonb(l) AS fact FROM ledger_line l
      WHERE l.enterprise_id=${tenant}::uuid AND l.ai_request_id=ANY(${ids}) ORDER BY l.id`.execute(db),
    sql<{ fact: Fact }>`SELECT to_jsonb(t) AS fact FROM ledger_transaction t
      WHERE t.enterprise_id=${tenant}::uuid AND t.ai_request_id=ANY(${ids}) ORDER BY t.id`.execute(db),
    sql<{ fact: Fact }>`SELECT jsonb_build_object('id',p.id,'period_month',p.period_month,'status',p.status) AS fact
      FROM operating_bill_period p WHERE p.enterprise_id=${tenant}::uuid
      AND p.period_month >= (SELECT date_trunc('month', MIN(COALESCE(l.settled_at,l.created_at)) AT TIME ZONE 'Asia/Shanghai')::date
        FROM ledger_line l WHERE l.enterprise_id=${tenant}::uuid AND l.ai_request_id=ANY(${ids}))
      ORDER BY p.period_month`.execute(db),
    sql<{ fact: Fact }>`SELECT jsonb_build_object('id',d.id,'ai_request_id',d.ai_request_id,
      'actual_cost',d.actual_cost) AS fact FROM dispatch_decision d
      WHERE d.enterprise_id=${tenant}::uuid AND d.ai_request_id=ANY(${ids}) ORDER BY d.id`.execute(db),
  ]);
  const [requests, attempts, usages, lines, transactions, periods, dispatch] = queries.map(q => q.rows.map(row => row.fact));
  return { requests: requests!, attempts: attempts!, usages: usages!, lines: lines!, transactions: transactions!, periods: periods!, dispatch: dispatch! };
}

async function validateFacts(db: Executor, input: RecordedCostDispositionInput, state: RecordedCostDispositionPreview["facts"]): Promise<void> {
  const admin = await db.selectFrom("admin_user").select("id").where("enterprise_id", "=", input.enterpriseId)
    .where("id", "=", input.adminId).where("status", "=", "ACTIVE").where("role_code", "=", "SUPER_ADMIN")
    .where("archived_at", "is", null).executeTakeFirst();
  requireFact(admin, "active tenant owner required");
  requireFact(state.periods.every(p => p.status !== "CLOSED"), "affected operating bill is closed");
  for (const requestId of input.requestIds) {
    const requests = state.requests.filter(r => r.id === requestId);
    const lines = state.lines.filter(r => r.ai_request_id === requestId);
    const usages = state.usages.filter(r => r.ai_request_id === requestId);
    const attempts = state.attempts.filter(r => r.ai_request_id === requestId);
    const transactions = state.transactions.filter(r => r.ai_request_id === requestId);
    requireFact(requests.length === 1 && ["FAILED", "CANCELLED"].includes(String(requests[0]!.status)), "request must be terminal and unsuccessful");
    requireFact(lines.length === 1 && usages.length === 1 && attempts.length === 1 && transactions.length === 1,
      "only the explicitly inspected single-attempt request is supported");
    const line = lines[0]!, usage = usages[0]!, attempt = attempts[0]!, transaction = transactions[0]!;
    requireFact(line.provider_resource_id === input.resourceId && usage.provider_resource_id === input.resourceId
      && attempt.provider_resource_id === input.resourceId && line.usage_event_id === usage.id
      && line.upstream_attempt_id === attempt.id && usage.upstream_attempt_id === attempt.id,
      "resource or attempt identity changed");
    requireFact(String(attempt.error_code).toLowerCase() === "client_cancelled" && attempt.finished_at,
      "request is not the inspected client cancellation");
    requireFact(line.resource_mode === "API" && line.api_cost_status === "UNKNOWN_COST"
      && line.api_cost === null && line.api_cost_currency === null && line.legacy_cost_resolution_id === null
      && line.settled_at, "recorded cost or another resolution exists");
    requireFact(Date.parse(String(line.settled_at)) >= PROVIDER_FINANCE_CUTOVER.getTime()
      && Date.parse(String(line.settled_at)) <= Date.now(), "settlement outside the current financial ledger");
    requireFact(transaction.status === "SETTLED" && transaction.api_cost_status === "UNKNOWN_COST"
      && (transaction.total_api_cost === null || Number(transaction.total_api_cost) === 0), "request has recorded cost");
    const billing = line.billing_rule_snapshot as Record<string, unknown> | null;
    requireFact((billing?.apiCost === null || billing?.apiCost === undefined || Number(billing.apiCost) === 0)
      && state.dispatch.filter(d => d.ai_request_id === requestId)
        .every(d => d.actual_cost === null || Number(d.actual_cost) === 0), "pricing or dispatch contains actual cost");
    requireFact(["raw_input_tokens", "raw_output_tokens", "raw_cache_tokens", "raw_reasoning_tokens"]
      .every(k => Number(line[k]) === 0)
      && ["input_tokens", "output_tokens", "cache_tokens", "reasoning_tokens"].every(k => Number(usage[k]) === 0)
      && ["total_input_tokens", "total_output_tokens", "total_cache_tokens", "total_reasoning_tokens"]
        .every(k => Number(transaction[k]) === 0)
      && usage.upstream_usage_id === null, "server contains usage evidence; do not exclude it");
  }
}

export async function previewRecordedCostDisposition(
  db: Kysely<Database>, input: RecordedCostDispositionInput,
): Promise<RecordedCostDispositionPreview> {
  validateInput(input);
  return db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const state = await facts(trx, input);
    await validateFacts(trx, input, state);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 30 * 60_000).toISOString();
    return { input, createdAt, expiresAt,
      hash: digest({ input, createdAt, expiresAt, facts: state }), facts: state };
  });
}

export async function applyRecordedCostDisposition(
  db: Kysely<Database>, preview: RecordedCostDispositionPreview,
): Promise<{ dispositionIds: string[]; requestCount: number; replayed: boolean }> {
  const input = preview.input;
  validateInput(input);
  const identity = { input, createdAt: preview.createdAt, expiresAt: preview.expiresAt };
  requireFact(preview.hash === digest({ ...identity, facts: preview.facts }), "preview was modified");
  requireFact(Date.parse(preview.expiresAt) - Date.parse(preview.createdAt) === 30 * 60_000,
    "invalid preview lifetime");
  return db.transaction().setIsolationLevel("serializable").execute(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recorded-cost:${input.enterpriseId}:${input.resourceId}`}::text,0))`.execute(trx);
    const operationIdempotencyKey = `recorded-cost:${input.operationKey}`;
    const operation = await trx.selectFrom("provider_finance_idempotency")
      .select(["request_hash", "response_snapshot"]).where("enterprise_id", "=", input.enterpriseId)
      .where("provider_resource_id", "=", input.resourceId)
      .where("idempotency_key", "=", operationIdempotencyKey).executeTakeFirst();
    if (operation) {
      requireFact(operation.request_hash === preview.hash, "idempotency conflict");
      const response = operation.response_snapshot as { dispositionIds: string[]; requestCount: number };
      return { ...response, replayed: true };
    }
    const keys = preview.facts.lines.map(l => `${input.operationKey}:${String(l.id)}`);
    const prior = await trx.selectFrom("provider_finance_usage_cost_disposition").select(["id", "request_hash", "ledger_line_id"])
      .where("enterprise_id", "=", input.enterpriseId).where("idempotency_key", "in", keys).execute();
    if (prior.length) {
      requireFact(prior.length === keys.length && prior.every(p => p.request_hash === preview.hash), "idempotency conflict");
      return { dispositionIds: prior.map(p => p.id), requestCount: input.requestIds.length, replayed: true };
    }
    requireFact(Date.now() <= Date.parse(preview.expiresAt) && Date.now() >= Date.parse(preview.createdAt), "preview expired");
    // Lock the exact published request facts, never discover a broader cancellation set.
    await trx.selectFrom("ai_request").select("id").where("enterprise_id", "=", input.enterpriseId)
      .where("id", "in", input.requestIds).orderBy("id").forUpdate().execute();
    await trx.selectFrom("ledger_line").select("id").where("enterprise_id", "=", input.enterpriseId)
      .where("id", "in", preview.facts.lines.map(l => String(l.id))).orderBy("id").forUpdate().execute();
    const state = await facts(trx, input);
    requireFact(digest({ ...identity, facts: state }) === preview.hash, "server facts changed since preview");
    await validateFacts(trx, input, state);
    const earliest = state.lines.map(l => operatingBillMonthAt(new Date(String(l.settled_at)))).sort()[0]!;
    const current = operatingBillMonthAt(new Date());
    for (let month = earliest; month <= current;) {
      await guardOperatingBillLedgerWrite(trx, input.enterpriseId, new Date(`${month}-01T00:00:00+08:00`));
      const [year, number] = month.split("-").map(Number);
      month = number === 12 ? `${year! + 1}-01` : `${year}-${String(number! + 1).padStart(2, "0")}`;
    }
    const dispositionIds: string[] = [];
    for (const line of state.lines) {
      const requestId = String(line.ai_request_id);
      const row = await trx.insertInto("provider_finance_usage_cost_disposition").values({
        enterprise_id: input.enterpriseId, provider_resource_id: input.resourceId,
        ledger_line_id: String(line.id), ai_request_id: requestId, decision: "EXCLUDE_NO_SERVER_COST",
        original_ledger_fact: line,
        server_cost_evidence: { request: state.requests.find(r => r.id === requestId),
          attempts: state.attempts.filter(r => r.ai_request_id === requestId),
          usage: state.usages.filter(r => r.ai_request_id === requestId),
          transactions: state.transactions.filter(r => r.ai_request_id === requestId),
          dispatch: state.dispatch.filter(r => r.ai_request_id === requestId) },
        reason: input.reason, evidence_ref: input.evidenceRef, decided_by_admin_user_id: input.adminId,
        idempotency_key: `${input.operationKey}:${String(line.id)}`, request_hash: preview.hash,
      }).returning("id").executeTakeFirstOrThrow();
      dispositionIds.push(row.id);
    }
    await trx.insertInto("operation_log").values({ enterprise_id: input.enterpriseId,
      actor_source: "ADMIN", admin_user_id: input.adminId, action: "provider_finance.recorded_cost_disposition",
      target_type: "provider_resource", target_id: input.resourceId, result: "SUCCESS", failure_reason: null,
      change_summary: { decision: "EXCLUDE_NO_SERVER_COST", requestIds: input.requestIds,
        ledgerLineIds: state.lines.map(l => l.id), dispositionIds, baselineHash: preview.hash,
        reason: input.reason, evidenceRef: input.evidenceRef, originalLedgerFactsPreserved: true },
    }).execute();
    const response = { dispositionIds, requestCount: input.requestIds.length, replayed: false };
    await trx.insertInto("provider_finance_idempotency").values({ enterprise_id: input.enterpriseId,
      provider_resource_id: input.resourceId, idempotency_key: operationIdempotencyKey,
      request_hash: preview.hash, response_snapshot: response }).execute();
    return response;
  });
}
