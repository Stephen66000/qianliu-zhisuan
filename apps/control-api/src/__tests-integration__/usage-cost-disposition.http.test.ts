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
// D-1（走查 2026-11-04）：快照缺单价的已计价行——验证 /attempts 从 billing_rule
// 回退透出 billingPrices（只加字段不改语义，WP5 R3 先例）。
const pricedRequestId = randomUUID(); const pricedAttemptId = randomUUID();
const pricedUsageId = randomUUID(); const pricedLineId = randomUUID();
const billingRuleId = randomUUID();

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
  // D-1 夹具：billing_rule（单价 缓存 0.1／输入 1／输出 2 元每百万，与 wp4-e2e-f01
  // 同值）＋一条带 billing_rule_id 但无 billing_rule_snapshot 的已计价账本行。
  await db.insertInto("billing_rule").values({ id: billingRuleId, enterprise_id: enterpriseId,
    provider_resource_id: resource.id, upstream_model: "deepseek-chat",
    rule_type: "API_PRICE", rule_version: "wp4-e2e-f01", effective_from: at,
    cache_hit_price: "0.1", cache_miss_price: "1", output_price: "2",
    currency: "CNY", priority: 10, source: "M5_E2E_SEED" }).execute();
  await db.insertInto("ai_request").values({ id: pricedRequestId, enterprise_id: enterpriseId,
    principal_id: principal.id, principal_key_id: key.id, protocol: "OPENAI_CHAT",
    unified_model: "deepseek-chat", status: "SUCCEEDED", started_at: at, finished_at: at }).execute();
  const pricedAttempt = await db.insertInto("upstream_attempt").values({ id: pricedAttemptId,
    ai_request_id: pricedRequestId, enterprise_id: enterpriseId, provider_resource_id: resource.id,
    attempt_no: 1, upstream_model: "deepseek-chat", response_committed: true,
    started_at: at, finished_at: at }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("usage_event").values({ id: pricedUsageId, ai_request_id: pricedRequestId,
    enterprise_id: enterpriseId, upstream_attempt_id: pricedAttempt.id, provider_resource_id: resource.id,
    input_tokens: 600n, output_tokens: 200n, cache_tokens: 400n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: pricedRequestId, created_at: at }).execute();
  await db.insertInto("ledger_line").values({ id: pricedLineId, ai_request_id: pricedRequestId,
    enterprise_id: enterpriseId, usage_event_id: pricedUsageId, upstream_attempt_id: pricedAttempt.id,
    provider_resource_id: resource.id, principal_id: principal.id, resource_mode: "API",
    raw_input_tokens: 600n, raw_output_tokens: 200n, raw_cache_tokens: 400n,
    api_cost: "0.00104", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    settled_at: at, usage_quality: "PROVIDER_REPORTED", billing_rule_id: billingRuleId,
    rule_version: "wp4-e2e-f01", multiplier: "1", created_at: at }).execute();
  await db.insertInto("ledger_transaction").values({ ai_request_id: pricedRequestId,
    enterprise_id: enterpriseId, principal_id: principal.id, total_input_tokens: 600n,
    total_output_tokens: 200n, total_cache_tokens: 400n, total_api_cost: "0.00104",
    api_cost_status: "PRICED_USAGE", usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: at }).execute();
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
  // D-1：无价格证据的行不透出 billingPrices（null，前端维持"—"/缺口语义）。
  expect(attempts.json().attempts[0].metering[0].billingPrices).toBeNull();
});

// D-1（走查裁定 2026-11-04）：账本行缺 billing_rule_snapshot 时，/attempts 从
// billing_rule 回退透出单价三列（缓存/输入/输出＝0.1/1/2，列序勿装反），
// 使「计价决策」单价不再显示"—"；快照含单价时本字段为 null（走快照分支）。
it("exposes billingPrices from billing_rule when ledger line has no snapshot prices", async () => {
  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const attempts = await get(`/gateway-requests/${pricedRequestId}/attempts`);
  expect(attempts.statusCode).toBe(200);
  const expectedPrices = { cacheHitPrice: "0.1", cacheMissPrice: "1", outputPrice: "2", source: "BILLING_RULE" };
  expect(attempts.json().attempts[0].metering[0].billingPrices).toEqual(expectedPrices);
  expect(attempts.json().ledgerLines[0].billingPrices).toEqual(expectedPrices);
  expect(attempts.json().attempts[0].metering[0].billingRuleSnapshot).toBeNull();
});
