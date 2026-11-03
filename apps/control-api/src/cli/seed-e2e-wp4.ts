import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { IDS } from "./seed-e2e-ids.js";

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
 */
export const WP4_IDS = {
  provider: "00000000-0000-4000-8000-000000000310",
  okResource: "00000000-0000-4000-8000-000000000311",
  failedResource: "00000000-0000-4000-8000-000000000312",
  okSnapshot: "00000000-0000-4000-8000-000000000313",
  failedSnapshot: "00000000-0000-4000-8000-000000000314",
  okAttempt: "00000000-0000-4000-8000-000000000315",
  failedAttempt: "00000000-0000-4000-8000-000000000316",
  billingRule: "00000000-0000-4000-8000-000000000317",
  f01Request: "00000000-0000-4000-8000-000000000318",
  f01Attempt: "00000000-0000-4000-8000-000000000319",
  f01Usage: "00000000-0000-4000-8000-000000000320",
  f01Line: "00000000-0000-4000-8000-000000000321",
  f01Transaction: "00000000-0000-4000-8000-000000000322",
  usdRequest: "00000000-0000-4000-8000-000000000323",
  usdAttempt: "00000000-0000-4000-8000-000000000324",
  usdUsage: "00000000-0000-4000-8000-000000000325",
  usdLine: "00000000-0000-4000-8000-000000000326",
  usdTransaction: "00000000-0000-4000-8000-000000000327",
  apiOpeningEvent: "00000000-0000-4000-8000-000000000329",
  apiRechargeEvent: "00000000-0000-4000-8000-000000000328",
} as const;

/** 与 official-balance-sync-writes.ts officialBalanceSyncDay 同口径（上海自然日）。 */
function shanghaiSyncDay(now: Date): Date {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

/** 上海时区的上一个月（YYYY-MM），供已关账历史月夹具。 */
function previousShanghaiMonth(now: Date): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth(); // 0-based
  const targetYear = month === 0 ? year - 1 : year;
  const targetMonth = month === 0 ? 12 : month;
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
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

  // ── 3. 已关账历史月（CLOSED＋冻结版本快照）─────────────────────────
  const closedMonth = previousShanghaiMonth(now);
  const closedMonthStart = `${closedMonth}-01`;
  const nextMonthStart = (() => {
    const year = Number(closedMonth.slice(0, 4));
    const month = Number(closedMonth.slice(5, 7));
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
  })();
  const frozenSnapshot = {
    month: closedMonth,
    timezone: "Asia/Shanghai",
    periodStart: `${closedMonthStart}T00:00:00+08:00`,
    periodEnd: `${nextMonthStart}T00:00:00+08:00`,
    status: "CLOSED",
    version: 1,
    generatedAt: now.toISOString(),
    closedAt: now.toISOString(),
    closedBy: adminId,
    closeNote: "E2E 合成关账：历史口径保留夹具（WP4）",
    summary: {
      totalCost: "396.00000000",
      apiCost: "96.00000000",
      ledgerApiCost: "96.00000000",
      openingBalance: "1000.00000000",
      monthlyRecharge: "100.00000000",
      apiSpendStatus: "CALCULABLE",
      apiSpendReason: null,
      packageCost: "300.00000000",
      endingBalance: "1004.00000000",
      endingBalanceCurrency: "CNY",
      openingBalances: [{ currency: "CNY", amount: "1000.00000000" }],
      rechargeAmounts: [{ currency: "CNY", amount: "100.00000000" }],
      endingBalances: [{ currency: "CNY", amount: "1004.00000000" }],
      apiSpends: [{ currency: "CNY", amount: "96.00000000" }],
      packageCosts: [{ currency: "CNY", amount: "300.00000000" }],
      totalSpends: [{ currency: "CNY", amount: "396.00000000" }],
      planUtilization: "42.0",
      activePrincipalCount: 1,
      confirmedValueAmount: "0",
      confirmedNonMonetaryCount: 0,
      unallocatedCost: "0",
    },
    providers: [
      {
        providerResourceId: WP4_IDS.okResource, providerCode: "DeepSeek",
        providerName: "DeepSeek WP4 E2E", resourceName: "DeepSeek 官方余额 E2E",
        mode: "API", currency: "CNY", openingBalanceCurrency: "CNY",
        rechargeAmounts: [{ currency: "CNY", amount: "100.00000000" }],
        endingBalanceCurrency: "CNY", apiSpendCurrency: "CNY",
        apiCost: "96.00000000", ledgerApiCost: "96.00000000",
        openingBalance: "1000.00000000", rechargeAmount: "100.00000000",
        apiSpendStatus: "CALCULABLE", apiSpendReason: null,
        packageCost: "0", totalCost: "96.00000000", endingBalance: "1004.00000000",
        totalQuota: null, usedQuota: null, remainingQuota: null, quotaUnit: null,
        utilization: null, activePrincipalCount: 1, status: "ACTIVE",
        planAssessment: null, idleEntitlementCost: null, assessmentBasis: null,
        purchases: [], servicePeriodStart: null, servicePeriodEnd: null,
        operatingSnapshotSource: null,
        requestRange: { from: null, to: null, count: 0 },
        factFingerprint: "wp4-e2e-closed-month-api",
        confirmation: { status: "NOT_APPLICABLE", note: "E2E 合成夹具",
          confirmedBy: null, confirmedAt: null, version: 1, matchesCurrentFacts: false },
      },
      {
        providerResourceId: IDS.isolatedResource, providerCode: "zhipu",
        providerName: "智谱 E2E", resourceName: "E2E 待恢复资源",
        mode: "CODING_PLAN", currency: "CNY",
        apiCost: "0", packageCost: "300.00000000", packageCostCurrency: "CNY",
        totalCost: "300.00000000", endingBalance: null,
        totalQuota: "100000", usedQuota: "42000", remainingQuota: "58000",
        quotaUnit: "TOKEN", utilization: "42.0", activePrincipalCount: 1,
        status: "CREDENTIAL_INVALID", planAssessment: "UNDERUSED",
        idleEntitlementCost: "150", assessmentBasis: "按未使用比例折算，不代表退款",
        purchases: [], servicePeriodStart: null, servicePeriodEnd: null,
        operatingSnapshotSource: null,
        requestRange: { from: null, to: null, count: 0 },
        factFingerprint: "wp4-e2e-closed-month-plan",
        confirmation: { status: "NOT_APPLICABLE", note: "E2E 合成夹具",
          confirmedBy: null, confirmedAt: null, version: 1, matchesCurrentFacts: false },
      },
    ],
    subjects: [
      {
        principalId, principalName: "E2E 固定员工", principalType: "EMPLOYEE",
        providers: ["DeepSeek WP4 E2E", "智谱 E2E"],
        inputTokens: "1600", outputTokens: "300", cacheTokens: "400",
        reasoningTokens: "0", totalTokens: "2300", deductedQuota: "42000",
        apiCost: "96.00000000", packageAllocatedCost: "300.00000000",
        totalAllocatedCost: "396.00000000", activeDays: 2, requestCount: 2,
      },
    ],
    values: [],
    gaps: [],
    sourceFacts: { ledgerLineCount: 0, operatingSnapshotIds: [] },
  };
  const [period] = await db.insertInto("operating_bill_period").values({
    enterprise_id: enterpriseId, period_month: closedMonthStart,
    status: "CLOSED", current_version: 1, created_by: adminId,
  }).returning("id").execute();
  await db.insertInto("operating_bill_version").values({
    enterprise_id: enterpriseId, period_id: period!.id, version: 1,
    snapshot: frozenSnapshot, close_note: "E2E 合成关账：历史口径保留夹具（WP4）",
    closed_by: adminId, closed_at: now,
  }).execute();
  await db.insertInto("operating_bill_event").values({
    enterprise_id: enterpriseId, period_id: period!.id, action: "CLOSED",
    version: 1, reason: "E2E 合成关账", actor_admin_id: adminId, metadata: { source: "wp4-e2e-seed" },
  }).execute();

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
