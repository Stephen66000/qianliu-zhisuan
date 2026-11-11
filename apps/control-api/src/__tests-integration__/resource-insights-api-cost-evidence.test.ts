/**
 * 资源洞察 API 费用证据对齐同源估算（WP1 S3a / ACE-06）。
 *
 * 合同调查结论：listResourceUtilization 的 knownLedgerCosts（原为查询内 CTE 的
 * COALESCE(settled_at,created_at) 聚合）仅进入 loadMonthlyOperatingCosts 的
 * ledgerApiCost 字段，utilization 行输出链路并不消费；S3a 已将其数据源改为
 * loadApiCostEstimation（与 loadMonthlyOperatingCosts 相同的 operatingBillMonthRange
 * 期间、按资源范围）。本测试钉住两件事：
 *   1) 估算入口按同一资源范围/期间产出的金额字面值（即新证据值）；
 *   2) utilization 行的既有语义不回归（apiCost 仍为余额桥接 apiSpend，预算未配置时
 *      fail-closed 为 NOT_CONFIGURED）。
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, loadApiCostEstimation, migrateToLatest, operatingBillMonthRange,
  type Database } from "@qianliu/database";
import { listResourceUtilization } from "../resource-insights/query.js";

const enterpriseId = randomUUID();
const principalId = randomUUID();
const keyId = randomUUID();
const apiResourceId = randomUUID();
const month = "2026-09";
const range = operatingBillMonthRange(month);

let pg: PostgresTestInstance;
let db: Kysely<Database>;

beforeAll(async () => {
  pg = await startPostgresContainer("resource_insights_api_cost_evidence");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values({
    id: enterpriseId, name: "资源洞察证据对齐",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "员工",
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_ev", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("provider_resource").values({
    id: apiResourceId, enterprise_id: enterpriseId, provider_id: provider.id,
    name: "api 资源", mode: "API", credential_type: "API_KEY",
  }).execute();
}, 120_000);

afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

async function seedPricedLine(at: Date, cost: string): Promise<void> {
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "model",
    status: "SUCCEEDED", started_at: at, finished_at: at,
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: apiResourceId, upstream_model: "model", http_status: 200,
    response_committed: true, finished_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    provider_resource_id: apiResourceId, input_tokens: 100n, output_tokens: 10n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attempt.id,
    usage_event_id: usage.id, provider_resource_id: apiResourceId, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 100n, raw_output_tokens: 10n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: cost, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    usage_quality: "PROVIDER_REPORTED", settled_at: at, created_at: at,
  }).execute();
}

it("估算证据与 utilization 行同范围可核对：证据值＝loadApiCostEstimation 按资源范围的金额", async () => {
  await seedPricedLine(new Date("2026-09-05T10:00:00+08:00"), "3.30");
  const estimation = await loadApiCostEstimation(db, enterpriseId, {
    start: range.start, end: range.end, resourceIds: [apiResourceId],
  });
  expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "3.30000000" }]);
  expect(estimation.completeness).toBe("KNOWN_COMPLETE");

  const rows = await listResourceUtilization(db, enterpriseId, month);
  const row = rows.find((item) => item.resourceId === apiResourceId);
  expect(row).toBeDefined();
  // 既有语义不回归：apiCost 来自余额桥接 apiSpend（缺期初快照 → null、fail-closed）。
  expect(row).toMatchObject({
    mode: "API",
    apiCost: null,
    utilizationStatus: "NOT_CONFIGURED",
    notCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
  });
});

it("窗口外已计价行不进入估算证据（settled_at 半开窗口与统一入口一致）", async () => {
  await seedPricedLine(new Date("2026-10-05T10:00:00+08:00"), "9.99");
  const estimation = await loadApiCostEstimation(db, enterpriseId, {
    start: range.start, end: range.end, resourceIds: [apiResourceId],
  });
  // 9 月窗口只认 9 月结算行：3.30 不被 10 月行污染（金额与 completeness 均同源一致）。
  expect(estimation.amounts).toEqual([{ currency: "CNY", amount: "3.30000000" }]);
});
