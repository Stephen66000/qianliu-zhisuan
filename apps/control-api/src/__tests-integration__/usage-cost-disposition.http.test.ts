import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AdminRepository, createKysely, migrateToLatest } from "@qianliu/database";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { buildControlApi } from "../server.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: ReturnType<typeof buildControlApi>;
let cookie: string;
const enterpriseId = randomUUID(); const adminId = randomUUID();
const requestId = randomUUID(); const lineId = randomUUID();

beforeAll(async () => {
  pg = await startPostgresContainer("usage_disposition_http");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "Usage disposition HTTP" }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: "disposition-admin", password_hash: "unused", status: "ACTIVE" }).execute();
  const provider = await db.insertInto("provider").values({ enterprise_id: enterpriseId,
    code: "deepseek", name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE" }).returning("id").executeTakeFirstOrThrow();
  const resource = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId,
    provider_id: provider.id, name: "API", mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow();
  const principal = await db.insertInto("principal").values({ enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: "User" }).returning("id").executeTakeFirstOrThrow();
  const key = await db.insertInto("principal_key").values({ enterprise_id: enterpriseId,
    principal_id: principal.id, key_prefix: "ql-cost", key_digest: randomUUID() }).returning("id").executeTakeFirstOrThrow();
  const at = new Date("2026-09-28T12:00:00+08:00");
  await db.insertInto("ai_request").values({ id: requestId, enterprise_id: enterpriseId,
    principal_id: principal.id, principal_key_id: key.id, protocol: "OPENAI_CHAT", unified_model: "deepseek-chat",
    status: "CANCELLED", error_code: "client_cancelled", error_classification: "CLIENT_CANCELLED",
    started_at: at, finished_at: at }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({ ai_request_id: requestId,
    enterprise_id: enterpriseId, provider_resource_id: resource.id, attempt_no: 1, upstream_model: "deepseek-chat",
    response_committed: false, error_code: "client_cancelled", error_classification: "CLIENT_CANCELLED",
    started_at: at, finished_at: at }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({ ai_request_id: requestId, enterprise_id: enterpriseId,
    upstream_attempt_id: attempt.id, provider_resource_id: resource.id, input_tokens: 0n, output_tokens: 0n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "UNKNOWN", dedup_key: requestId, created_at: at })
    .returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({ id: lineId, ai_request_id: requestId, enterprise_id: enterpriseId,
    upstream_attempt_id: attempt.id, usage_event_id: usage.id, provider_resource_id: resource.id,
    principal_id: principal.id, resource_mode: "API", raw_input_tokens: 0n, raw_output_tokens: 0n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: null, api_cost_currency: null,
    api_cost_status: "UNKNOWN_COST", usage_quality: "UNKNOWN", created_at: at, settled_at: at }).execute();
  await db.insertInto("ledger_transaction").values({ ai_request_id: requestId, enterprise_id: enterpriseId,
    principal_id: principal.id, total_input_tokens: 0n, total_output_tokens: 0n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0", api_cost_status: "UNKNOWN_COST",
    usage_quality: "UNKNOWN", attempt_count: 1, status: "SETTLED", created_at: at }).execute();
  const token = generateSessionToken();
  await new AdminRepository(db).createSession(adminId, digestSessionToken(token), new Date(Date.now() + 60_000));
  cookie = `qianliu_admin_session=${token}`;
  app = buildControlApi(db);
  await app.ready();
}, 120_000);

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); }, 60_000);

it("projects the same explicit exclusion in the usage list, request settlement and raw metering", async () => {
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const before = await get(`/gateway-requests/${requestId}`);
  expect(before.statusCode).toBe(200);
  expect(before.json().settlement.apiCostStatus).toBe("UNKNOWN_COST");
  await sql`INSERT INTO provider_finance_usage_cost_disposition
    (enterprise_id,provider_resource_id,ledger_line_id,ai_request_id,decision,original_ledger_fact,
      server_cost_evidence,reason,evidence_ref,decided_by_admin_user_id,idempotency_key,request_hash)
    SELECT line.enterprise_id,line.provider_resource_id,line.id,line.ai_request_id,'EXCLUDE_NO_SERVER_COST',
      to_jsonb(line),'{}'::jsonb,'Owner confirmed no server fee record','http-read-test',
      ${adminId}::uuid,${randomUUID()},${"0".repeat(64)} FROM ledger_line line WHERE line.id=${lineId}::uuid`.execute(db);
  const [list, detail, attempts] = await Promise.all([
    get(`/usage?search=${requestId}`), get(`/gateway-requests/${requestId}`),
    get(`/gateway-requests/${requestId}/attempts`),
  ]);
  for (const response of [list, detail, attempts]) expect(response.statusCode).toBe(200);
  expect(list.json().records[0]).toMatchObject({ requestId, costStatus: "EXCLUDED_NO_RECORDED_COST", totalApiCost: "0.00000000" });
  expect(detail.json().settlement).toMatchObject({ apiCostStatus: "EXCLUDED_NO_RECORDED_COST", totalApiCost: "0.00000000" });
  expect(attempts.json().attempts[0].metering[0]).toMatchObject({ apiCostStatus: "EXCLUDED_NO_RECORDED_COST", apiCost: null });
  expect(attempts.json().ledgerLines[0]).toMatchObject({ apiCostStatus: "EXCLUDED_NO_RECORDED_COST", apiCost: null });
});
