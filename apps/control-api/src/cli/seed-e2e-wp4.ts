import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { WP4_IDS } from "./seed-e2e-wp4-ids.js";
import { seedWp4ClosedMonth } from "./seed-e2e-wp4-closed-month.js";
import { seedWp4OfficialBalanceStates } from "./seed-e2e-wp4-balance-states.js";

// WP4_IDS 拆至 seed-e2e-wp4-ids.ts；此处再导出，
// apps/web/e2e/wp4-cost-official-balance.spec.ts 的 import 路径保持不变。
export { WP4_IDS };

/**
 * WP4（simplify-api-cost-and-official-balance）S6 浏览器证据夹具（全部合成数据）。
 *
 * 依赖 seed-e2e.ts 的安全门（127.0.0.1/_e2e）与 TRUNCATE 清库；本文件只做追加播种：
 * 1. 官方余额三态资源（provider code 用 "DeepSeek"——canonicalProviderCode 仅做
 *    trim+小写归一，"pool043-deepseek"/"pool042-deepseek" 不会命中 deepseek 判定；
 *    且 (enterprise_id, code) 唯一索引为精确字符串，"DeepSeek" 与 provider-review
 *    spec 自建的 "deepseek" 不冲突）：
 *    - OK：PROVIDER_SYNC＋balance_source=PROVIDER_API 快照 110（赠送 10＋充值 100，
 *      available=true）＋最新 attempt SUCCESS（next_sync_at 未来 → 展示 OK 态）；
 *    - FAILED 保鲜值：曾成功快照 50＋最新 attempt FAILED（s4-receipt §3 矩阵规则 5）。
 *    两个资源均无 credential_ciphertext → 手动刷新走 409 credential_missing（零真实上游）。
 *    UNSUPPORTED 态复用既有 zhipu 资源（E2E 智谱主资源），不新增。
 * 2. F01 估算半开窗夹具：输入 600＋缓存 400＋输出 200，计价规则 1/0.1/2 元每百万 →
 *    api_cost 0.00104 CNY（settled_at 落当月）；规则未设 source_status → 0093 默认
 *    UNVERIFIED＝"价格依据待核实"夹具。另加一条 USD 行做混币分列。
 * 3. 已关账历史月：CLOSED operating_bill_period＋冻结 operating_bill_version 快照
 *    （含期初/充值/期末旧资金轨迹值），供历史横幅与三卡保留断言。
 * 4. strict_writes_enabled 运行态＋一条历史 API 充值事件（ADMIN 来源）——
 *    "历史资金记录（旧口径，只读）"区块与来源标签夹具。
 * S3a-2 追加（WP5，全部挂 0330..0356 新键，不动既有键；不得破坏既有 7 个 e2e test）：
 * 5. 过期资源（G14/AT-OAB-04）：成功快照 40，collected_at 早于 P2 阈值 2 小时 →
 *    EXPIRED"数据过期"＋保鲜值 40；附"不可计算"供给预测快照（G19/G20/AT-OAB-13/14）。
 * 6. 从未成功资源（G15/AT-OAB-08）：无快照＋FAILED attempt（UPSTREAM_AUTH_FAILED/401）
 *    → "暂无官方数据"，不冒充 0 元。
 * 7. 同账户两资源（G16/AT-OAB-09）：同 provider_id（states 夹具 :173 的同账户表达）
 *    各快照 100＋SUCCESS attempt → 两行独立、无 200 合计。
 * 8. F02 费用质量行（G6/AT-ACE-07，当月）：已计价 1 CNY、已计价 2 CNY、有用量无价格
 *    （UNKNOWN_COST，0085 shape 要求金额与币种同时 NULL）→ 与 F01 叠加当月已计价
 *    部分 CNY 3.00104＋USD 0.5，估算 KNOWN_PARTIAL＋PRICE_MISSING。
 */

/** 与 official-balance-sync-writes.ts officialBalanceSyncDay 同口径（上海自然日）。 */
function shanghaiSyncDay(now: Date): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

export async function seedWp4CostOfficialBalance(
  db: Kysely<Database>,
  enterpriseId: string,
  adminId: string,
  principalId: string,
  keyId: string,
  now: Date,
): Promise<void> {
  const minuteAgo = (ms: number) => new Date(now.getTime() - ms);

  // ── 1. 官方余额三态（OK / FAILED 保鲜值）───────────────────────────
  await db.insertInto("provider").values({
    id: WP4_IDS.provider, enterprise_id: enterpriseId, code: "DeepSeek",
    name: "DeepSeek WP4 E2E", adapter_type: "deepseek",
  }).execute();
  await db.insertInto("provider_resource").values([
    {
      id: WP4_IDS.okResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE",
      // 0083 触发器要求期初事件不得早于资源创建；显式给早于事件的创建时间。
      created_at: minuteAgo(30 * 86_400_000),
    },
    {
      id: WP4_IDS.failedResource, enterprise_id: enterpriseId, provider_id: WP4_IDS.provider,
      name: "DeepSeek 官方余额 E2E（同步失败）", mode: "API", credential_type: "API_KEY",
      status: "ACTIVE",
      created_at: minuteAgo(30 * 86_400_000),
    },
  ]).execute();
  await db.insertInto("provider_resource_operating_snapshot").values([
    {
      id: WP4_IDS.okSnapshot, enterprise_id: enterpriseId, provider_resource_id: WP4_IDS.okResource,
      version: 1, source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: minuteAgo(60_000), currency: "CNY",
      recharge_amount: "100", current_balance: "110",
      granted_balance: "10", topped_up_balance: "100", provider_balance_available: true,
      balance_updated_at: minuteAgo(60_000),
    },
    {
      id: WP4_IDS.failedSnapshot, enterprise_id: enterpriseId, provider_resource_id: WP4_IDS.failedResource,
      version: 1, source: "PROVIDER_SYNC", balance_source: "PROVIDER_API",
      collected_at: minuteAgo(120_000), currency: "CNY",
      current_balance: "50", granted_balance: "0", topped_up_balance: "50",
      provider_balance_available: true, balance_updated_at: minuteAgo(120_000),
    },
  ]).execute();
  await db.insertInto("provider_resource_operating_sync_attempt").values([
    {
      id: WP4_IDS.okAttempt, enterprise_id: enterpriseId, provider_resource_id: WP4_IDS.okResource,
      sync_day: shanghaiSyncDay(now), balance_status: "SUCCESS", cost_status: "NOT_SUPPORTED",
      snapshot_id: WP4_IDS.okSnapshot, provider_data_at: minuteAgo(60_000),
      started_at: minuteAgo(120_000), completed_at: minuteAgo(119_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: null, failure_reason: null, adapter_version: "wp4-e2e-v1",
    },
    {
      id: WP4_IDS.failedAttempt, enterprise_id: enterpriseId, provider_resource_id: WP4_IDS.failedResource,
      sync_day: shanghaiSyncDay(now), balance_status: "FAILED", cost_status: "NOT_SUPPORTED",
      snapshot_id: null, provider_data_at: null,
      started_at: minuteAgo(30_000), completed_at: minuteAgo(29_000),
      next_sync_at: new Date(now.getTime() + 15 * 60_000),
      error_code: "UPSTREAM_UNAVAILABLE",
      failure_reason: "E2E 合成失败场景：官方余额查询不可达（保鲜值应保留上次成功 50）",
      adapter_version: "wp4-e2e-v1",
    },
  ]).execute();

  // ── 1b. S3a-2 官方余额状态扩展（过期／从未成功／同账户两 Key）─────────
  await seedWp4OfficialBalanceStates(db, enterpriseId, shanghaiSyncDay(now), now);

  // ── 2. F01 估算半开窗夹具（600/400/200 @ 1/0.1/2 元每百万 → 0.00104 CNY）──
  await db.insertInto("billing_rule").values({
    id: WP4_IDS.billingRule, enterprise_id: enterpriseId,
    provider_resource_id: WP4_IDS.okResource, upstream_model: "deepseek-v4-flash",
    rule_type: "API_PRICE", rule_version: "wp4-e2e-f01",
    effective_from: minuteAgo(24 * 3_600_000),
    cache_hit_price: "0.1", cache_miss_price: "1", output_price: "2",
    currency: "CNY", priority: 10, source: "M5_E2E_SEED",
  }).execute();
  const f01At = minuteAgo(10 * 60_000);
  await db.insertInto("ai_request").values({
    id: WP4_IDS.f01Request, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, idempotency_key: "wp4-e2e-f01-request",
    protocol: "chat", unified_model: "deepseek-v4-flash", stream: false,
    status: "SUCCEEDED", client_id: "m5-playwright",
    started_at: f01At, finished_at: new Date(f01At.getTime() + 400),
  }).execute();
  await db.insertInto("upstream_attempt").values({
    id: WP4_IDS.f01Attempt, ai_request_id: WP4_IDS.f01Request, enterprise_id: enterpriseId,
    attempt_no: 1, provider_resource_id: WP4_IDS.okResource,
    upstream_model: "deepseek-v4-flash", started_at: f01At,
    finished_at: new Date(f01At.getTime() + 400), http_status: 200, response_committed: true,
  }).execute();
  await db.insertInto("usage_event").values({
    id: WP4_IDS.f01Usage, ai_request_id: WP4_IDS.f01Request, enterprise_id: enterpriseId,
    upstream_attempt_id: WP4_IDS.f01Attempt, provider_resource_id: WP4_IDS.okResource,
    input_tokens: 600n, output_tokens: 200n, cache_tokens: 400n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: "wp4-e2e-f01", created_at: f01At,
  }).execute();
  await db.insertInto("ledger_line").values({
    id: WP4_IDS.f01Line, ai_request_id: WP4_IDS.f01Request, enterprise_id: enterpriseId,
    usage_event_id: WP4_IDS.f01Usage, upstream_attempt_id: WP4_IDS.f01Attempt,
    provider_resource_id: WP4_IDS.okResource, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 600n, raw_output_tokens: 200n,
    raw_cache_tokens: 400n, api_cost: "0.00104", api_cost_currency: "CNY",
    api_cost_status: "PRICED_USAGE", settled_at: f01At,
    usage_quality: "PROVIDER_REPORTED", billing_rule_id: WP4_IDS.billingRule,
    rule_version: "wp4-e2e-f01", multiplier: "1", created_at: f01At,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    id: WP4_IDS.f01Transaction, ai_request_id: WP4_IDS.f01Request, enterprise_id: enterpriseId,
    principal_id: principalId, total_input_tokens: 600n, total_output_tokens: 200n,
    total_cache_tokens: 400n, total_api_cost: "0.00104", api_cost_status: "PRICED_USAGE",
    overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: f01At,
  }).execute();

  // 混币分列夹具：同资源一条 USD 计价行（当前月）。
  const usdAt = minuteAgo(9 * 60_000);
  await db.insertInto("ai_request").values({
    id: WP4_IDS.usdRequest, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, idempotency_key: "wp4-e2e-usd-request",
    protocol: "chat", unified_model: "deepseek-v4-flash", stream: false,
    status: "SUCCEEDED", client_id: "m5-playwright",
    started_at: usdAt, finished_at: usdAt,
  }).execute();
  await db.insertInto("upstream_attempt").values({
    id: WP4_IDS.usdAttempt, ai_request_id: WP4_IDS.usdRequest, enterprise_id: enterpriseId,
    attempt_no: 1, provider_resource_id: WP4_IDS.okResource,
    upstream_model: "deepseek-v4-flash", started_at: usdAt, finished_at: usdAt,
    http_status: 200, response_committed: true,
  }).execute();
  await db.insertInto("usage_event").values({
    id: WP4_IDS.usdUsage, ai_request_id: WP4_IDS.usdRequest, enterprise_id: enterpriseId,
    upstream_attempt_id: WP4_IDS.usdAttempt, provider_resource_id: WP4_IDS.okResource,
    input_tokens: 1000n, output_tokens: 100n, cache_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: "wp4-e2e-usd", created_at: usdAt,
  }).execute();
  await db.insertInto("ledger_line").values({
    id: WP4_IDS.usdLine, ai_request_id: WP4_IDS.usdRequest, enterprise_id: enterpriseId,
    usage_event_id: WP4_IDS.usdUsage, upstream_attempt_id: WP4_IDS.usdAttempt,
    provider_resource_id: WP4_IDS.okResource, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, api_cost: "0.5", api_cost_currency: "USD",
    api_cost_status: "PRICED_USAGE", settled_at: usdAt,
    usage_quality: "PROVIDER_REPORTED", created_at: usdAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    id: WP4_IDS.usdTransaction, ai_request_id: WP4_IDS.usdRequest, enterprise_id: enterpriseId,
    principal_id: principalId, total_input_tokens: 1000n, total_output_tokens: 100n,
    total_cache_tokens: 0n, total_api_cost: "0.5", api_cost_status: "PRICED_USAGE",
    overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: usdAt,
  }).execute();

  // ── 2b. S3a-2 F02 费用质量行（G6/AT-ACE-07，既有 e2e 当月内追加三条）──
  // 已计价 1 CNY（F02-1）、已计价 2 CNY（F02-2）、有用量无价格（F02-3，不建
  // billing_rule 命中 → UNKNOWN_COST）。与 F01 叠加后当月已计价部分＝
  // CNY 3.00104（0.00104+1+2）＋USD 0.5；UNKNOWN 行使估算完整性 KNOWN_PARTIAL
  // ＋PRICE_MISSING 缺口，聚合层拒绝把已计价部分冒充完整总费用。
  const f02Request = (requestId: string, idempotencyKey: string, at: Date) => ({
    id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, idempotency_key: idempotencyKey,
    protocol: "chat", unified_model: "deepseek-v4-flash", stream: false,
    status: "SUCCEEDED", client_id: "m5-playwright",
    started_at: at, finished_at: at,
  });
  const f02AttemptRow = (attemptId: string, requestId: string, at: Date) => ({
    id: attemptId, ai_request_id: requestId, enterprise_id: enterpriseId,
    attempt_no: 1, provider_resource_id: WP4_IDS.okResource,
    upstream_model: "deepseek-v4-flash", started_at: at, finished_at: at,
    http_status: 200, response_committed: true,
  });
  const f02UsageRow = (usageId: string, requestId: string, attemptId: string,
    input: bigint, output: bigint, dedupKey: string, at: Date) => ({
    id: usageId, ai_request_id: requestId, enterprise_id: enterpriseId,
    upstream_attempt_id: attemptId, provider_resource_id: WP4_IDS.okResource,
    input_tokens: input, output_tokens: output, cache_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: dedupKey, created_at: at,
  });
  // F02-1：已计价 1 CNY（AT-ACE-07）。
  const f02aAt = minuteAgo(8 * 60_000);
  await db.insertInto("ai_request").values(
    f02Request(WP4_IDS.f02aRequest, "wp4-e2e-f02a-request", f02aAt)).execute();
  await db.insertInto("upstream_attempt").values(
    f02AttemptRow(WP4_IDS.f02aAttempt, WP4_IDS.f02aRequest, f02aAt)).execute();
  await db.insertInto("usage_event").values(
    f02UsageRow(WP4_IDS.f02aUsage, WP4_IDS.f02aRequest, WP4_IDS.f02aAttempt,
      500n, 100n, "wp4-e2e-f02a", f02aAt)).execute();
  await db.insertInto("ledger_line").values({
    id: WP4_IDS.f02aLine, ai_request_id: WP4_IDS.f02aRequest, enterprise_id: enterpriseId,
    usage_event_id: WP4_IDS.f02aUsage, upstream_attempt_id: WP4_IDS.f02aAttempt,
    provider_resource_id: WP4_IDS.okResource, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 500n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, api_cost: "1", api_cost_currency: "CNY",
    api_cost_status: "PRICED_USAGE", settled_at: f02aAt,
    usage_quality: "PROVIDER_REPORTED", created_at: f02aAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    id: WP4_IDS.f02aTransaction, ai_request_id: WP4_IDS.f02aRequest, enterprise_id: enterpriseId,
    principal_id: principalId, total_input_tokens: 500n, total_output_tokens: 100n,
    total_cache_tokens: 0n, total_api_cost: "1", api_cost_status: "PRICED_USAGE",
    overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: f02aAt,
  }).execute();
  // F02-2：已计价 2 CNY（AT-ACE-07）。
  const f02bAt = minuteAgo(7 * 60_000);
  await db.insertInto("ai_request").values(
    f02Request(WP4_IDS.f02bRequest, "wp4-e2e-f02b-request", f02bAt)).execute();
  await db.insertInto("upstream_attempt").values(
    f02AttemptRow(WP4_IDS.f02bAttempt, WP4_IDS.f02bRequest, f02bAt)).execute();
  await db.insertInto("usage_event").values(
    f02UsageRow(WP4_IDS.f02bUsage, WP4_IDS.f02bRequest, WP4_IDS.f02bAttempt,
      1000n, 200n, "wp4-e2e-f02b", f02bAt)).execute();
  await db.insertInto("ledger_line").values({
    id: WP4_IDS.f02bLine, ai_request_id: WP4_IDS.f02bRequest, enterprise_id: enterpriseId,
    usage_event_id: WP4_IDS.f02bUsage, upstream_attempt_id: WP4_IDS.f02bAttempt,
    provider_resource_id: WP4_IDS.okResource, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n,
    raw_cache_tokens: 0n, api_cost: "2", api_cost_currency: "CNY",
    api_cost_status: "PRICED_USAGE", settled_at: f02bAt,
    usage_quality: "PROVIDER_REPORTED", created_at: f02bAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    id: WP4_IDS.f02bTransaction, ai_request_id: WP4_IDS.f02bRequest, enterprise_id: enterpriseId,
    principal_id: principalId, total_input_tokens: 1000n, total_output_tokens: 200n,
    total_cache_tokens: 0n, total_api_cost: "2", api_cost_status: "PRICED_USAGE",
    overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: f02bAt,
  }).execute();
  // F02-3：有用量无价格（AT-ACE-07）——UNKNOWN_COST；0085 shape 约束要求
  // api_cost 与 api_cost_currency 同时为 NULL（绝不补零估算）。
  const f02uAt = minuteAgo(6 * 60_000);
  await db.insertInto("ai_request").values(
    f02Request(WP4_IDS.f02uRequest, "wp4-e2e-f02u-request", f02uAt)).execute();
  await db.insertInto("upstream_attempt").values(
    f02AttemptRow(WP4_IDS.f02uAttempt, WP4_IDS.f02uRequest, f02uAt)).execute();
  await db.insertInto("usage_event").values(
    f02UsageRow(WP4_IDS.f02uUsage, WP4_IDS.f02uRequest, WP4_IDS.f02uAttempt,
      300n, 50n, "wp4-e2e-f02u", f02uAt)).execute();
  await db.insertInto("ledger_line").values({
    id: WP4_IDS.f02uLine, ai_request_id: WP4_IDS.f02uRequest, enterprise_id: enterpriseId,
    usage_event_id: WP4_IDS.f02uUsage, upstream_attempt_id: WP4_IDS.f02uAttempt,
    provider_resource_id: WP4_IDS.okResource, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 300n, raw_output_tokens: 50n,
    raw_cache_tokens: 0n, api_cost: null, api_cost_currency: null,
    api_cost_status: "UNKNOWN_COST", settled_at: f02uAt,
    usage_quality: "PROVIDER_REPORTED", created_at: f02uAt,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    id: WP4_IDS.f02uTransaction, ai_request_id: WP4_IDS.f02uRequest, enterprise_id: enterpriseId,
    principal_id: principalId, total_input_tokens: 300n, total_output_tokens: 50n,
    total_cache_tokens: 0n, total_api_cost: null, api_cost_status: "UNKNOWN_COST",
    overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1,
    status: "SETTLED", created_at: f02uAt,
  }).execute();

  // ── 3. 已关账历史月（CLOSED＋冻结版本快照）─────────────────────────
  await seedWp4ClosedMonth(db, enterpriseId, adminId, principalId, now);

  // ── 4. strict_writes 运行态＋历史资金记录（旧口径，只读）来源标签夹具 ──
  await sql`
    INSERT INTO provider_finance_runtime_state
      (enterprise_id, strict_writes_enabled, activated_at, activated_by_admin_user_id)
    VALUES (${enterpriseId}::uuid, TRUE, ${now}, ${adminId}::uuid)
  `.execute(db);
  // 触发器 provider_finance_validate_event_contract（0083/0059）：
  // API 期初要求资源存在 PENDING provider_resource_finance_state 行（0081 门禁留档），
  // API 充值要求先有同币种 API 期初行——按旧口径事实链顺序补两行状态/事件。
  await sql`
    INSERT INTO provider_resource_finance_state
      (provider_resource_id, enterprise_id, state, required_currencies)
    VALUES (${WP4_IDS.okResource}::uuid, ${enterpriseId}::uuid, 'PENDING', '["CNY"]'::jsonb)
  `.execute(db);
  const eventMonthAt = minuteAgo(60_000);
  await db.insertInto("provider_finance_event").values({
    id: WP4_IDS.apiOpeningEvent, enterprise_id: enterpriseId,
    provider_resource_id: WP4_IDS.okResource, event_type: "API_OPENING_BALANCE",
    account_amount: "1000", account_currency: "CNY", cash_paid_cny: null,
    occurred_at: minuteAgo(120_000), external_reference: "wp4-e2e-legacy-opening",
    description: "E2E 历史 API 期初（旧口径夹具，只读展示）",
    evidence_ref: "wp4-e2e-proof-opening", source: "ADMIN",
    idempotency_key: "wp4-e2e-api-opening-legacy",
    created_by_admin_user_id: adminId, created_at: minuteAgo(120_000),
  }).execute();
  await db.insertInto("provider_finance_event").values({
    id: WP4_IDS.apiRechargeEvent, enterprise_id: enterpriseId,
    provider_resource_id: WP4_IDS.okResource, event_type: "API_RECHARGE",
    account_amount: "100", account_currency: "CNY", cash_paid_cny: "100",
    occurred_at: eventMonthAt, external_reference: "wp4-e2e-legacy-recharge",
    description: "E2E 历史 API 充值（旧口径夹具，只读展示）",
    evidence_ref: "wp4-e2e-proof", source: "ADMIN",
    idempotency_key: "wp4-e2e-api-recharge-legacy",
    created_by_admin_user_id: adminId, created_at: eventMonthAt,
  }).execute();
}
