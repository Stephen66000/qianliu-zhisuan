import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import {
  createKysely,
  GatewayLedgerRepository,
  isEnterpriseQuiescent,
  migrateToLatest,
  PROVIDER_FINANCE_CUTOVER,
} from "@qianliu/database";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { hashPassword } from "../auth/password.js";

/**
 * WP07 本地业务验收（OpenSpec 6.3；计划 v1.2 §9 WP07）。
 *
 * 与 WP03/WP04/WP05 的分工：那些工作包证明"实现正确"（原子性、锁、幂等、HTTP 合同、Web 交互）；
 * 本套件只证明**业务可验收**——一个**完全合成**的隔离企业能否经 Control API + 真实 PostgreSQL
 * 走通 `NO_GO → GO_CANDIDATE → ACTIVATED`，并在激活后用管理员可见的读模型把账算清楚。
 *
 * ## 数据性质声明（合成、非真实）
 *
 * - 本文件创建的企业、资源、管理员、用量与金额**全部是合成测试数据**（`SYNTHETIC-WP07` 前缀），
 *   **不是**任何真实厂商、真实企业或真实业务金额；不存在真实充值、真实购买或真实用量。
 * - 运行环境是**一次性 Testcontainer**（`postgres:17-alpine`，随用随销毁）；
 *   **不连接任何生产数据库**，**不访问任何厂商上游**，全部事实由本文件的 SQL/HTTP 直接写入。
 * - 路由：事实注入用 SQL，**业务链路全部经 Control API**（登录会话 + `/provider-finance/*`），
 *   不直接调用协调器伪造 `ACTIVATED` 结论。
 *
 * ## 时间锚点
 *
 * 迁移守卫与"当前周期"语义都按**上海自然月**判定，因此所有事实锚点都从**上海自然月**派生：
 * 取当前上海月；若今天距离该月 1 日不足 6 天（锚点会落到未来、被快照上界裁掉），
 * 则回退到上一个上海月。两种情况下所有锚点都严格早于 `now`。
 *
 * ## 结论演进（v1 NO-GO → v2 GO）
 *
 * 首次验收时验收点 1～5 的链路全部走通，但**发现产品缺陷 D-1**：`MIGRATED` 关闭的旧购买记录被
 * "新账本（`provider_finance_event`）+ 旧账本（`resource_purchase_record`）"**重复计入**，
 * 使月度资金摘要与经营账单的套餐金额翻倍（199 → 398）。v1 以两个 `it.fails` 固定该缺陷并 NO-GO 上报。
 *
 * v2：按授权在**写入侧**做最小修复（`legacySourceMarker`，未动四处聚合读模型、未新增迁移），
 * §10 的两条缺陷钉已改为**正向断言**——金额各只计一次、排除标记命中、孤儿计数 0，
 * 且业务订单引用仍保留在关闭审计里。
 */

const SYNTHETIC_TAG = "SYNTHETIC-WP07";
const CUTOVER_ISO = PROVIDER_FINANCE_CUTOVER.toISOString();
const PASSWORD = `${SYNTHETIC_TAG}-Password!`;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
/** 锚点距月首的天数上限：月首 + 6 天必须已经过去，否则回退上一个月。 */
const ANCHOR_HORIZON_DAYS = 6;

/** 把一个瞬时按上海时区折算成 `YYYY-MM-DD` 自然日。 */
function shanghaiDay(instant: Date): string {
  return new Date(instant.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 证据行输出。用 `process.stdout.write` 而非 `console.log`：仓库 lint 门禁是
 * `eslint src --max-warnings=0`，且 `no-console` 只放过 warn/error，测试文件也不例外；
 * 这里的输出是**取证用**的（归档到 `V4/Evidence/.../wp07-*`），不是调试遗留。
 */
function emitEvidence(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 选定合成事实所属的上海自然月（保证全部锚点早于 `now`）。 */
function pickAnchorMonth(): { month: string; start: Date; next: Date } {
  const nowShanghai = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  const rollBack = nowShanghai.getUTCDate() <= ANCHOR_HORIZON_DAYS ? 1 : 0;
  const y = nowShanghai.getUTCFullYear();
  const m = nowShanghai.getUTCMonth() - rollBack;
  const start = new Date(Date.UTC(y, m, 1) - SHANGHAI_OFFSET_MS);
  const next = new Date(Date.UTC(y, m + 1, 1) - SHANGHAI_OFFSET_MS);
  return {
    month: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7),
    start, next,
  };
}

const anchor = pickAnchorMonth();
/** 合成事实的全部时间锚点（上海自然月内，且严格早于 now）。 */
const AT = {
  /** 智谱套餐扣费/服务开始：月首上海 10:00。 */
  planPurchase: new Date(anchor.start.getTime() + 10 * 3_600_000),
  /** DeepSeek 切换后历史充值：月首 +2 天 02:00（上海）。 */
  apiRecharge: new Date(anchor.start.getTime() + 2 * DAY_MS + 2 * 3_600_000),
  /** 套餐用量结算：月首 +2 天 06:00（上海），落在套餐周期内。 */
  planUsage: new Date(anchor.start.getTime() + 2 * DAY_MS + 6 * 3_600_000),
  /** 已定价 API 用量结算：月首 +3 天 04:00（上海）。 */
  apiUsage: new Date(anchor.start.getTime() + 3 * DAY_MS + 4 * 3_600_000),
  /** 激活后后续充值：月首 +5 天 03:00（上海），走严格写 HTTP 接口。 */
  postRecharge: new Date(anchor.start.getTime() + 5 * DAY_MS + 3 * 3_600_000),
} as const;
const FIRST_DAY = shanghaiDay(anchor.start);
const LAST_DAY = shanghaiDay(new Date(anchor.next.getTime() - DAY_MS));
/** 周期右端点（上海次月首日）——读模型按 `shanghaiDate(periodEndExclusive)` 呈现。 */
const NEXT_DAY = shanghaiDay(anchor.next);

/** 合成金额（元，均为小额合成数，非真实数据）。 */
const MONEY = {
  apiOpening: "88.55",
  apiRecharge: "20.00",
  apiUsageCost: "1.25",
  planAmount: "199.00",
  postRecharge: "30.00",
} as const;
/** 账户金额按 8 位小数呈现（DB 数值读出后统一经 `money()` 归一）。 */
const BALANCE_OPENING = "88.55000000";
/** 账户余额（8 位小数）算式：期初 + 充值 − 已定价 API 成本。 */
const BALANCE_AFTER_ACTIVATION = "107.30000000";
const BALANCE_AFTER_POST_RECHARGE = "137.30000000";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let app: FastifyInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("provider_finance_wp07_acceptance");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  const { buildControlApi } = await import("../server.js");
  app = buildControlApi(db);
  await app.ready();
}, 240_000);

afterAll(async () => { await app?.close(); await db?.destroy(); await pg?.stop(); }, 60_000);

interface Synthetic {
  enterpriseId: string;
  adminId: string;
  cookie: string;
  deepseekProviderId: string;
  zhipuProviderId: string;
  apiResourceId: string;
  planResourceId: string;
  principalId: string;
  principalKeyId: string;
  legacyRecordId: string;
  planUsageLineId: string;
}

/** 直接落库一个会话并返回 Cookie（登录路由是单企业口径，本套件用多个隔离企业）。 */
async function sessionFor(adminId: string): Promise<string> {
  const token = generateSessionToken();
  await db.insertInto("admin_session").values({ admin_user_id: adminId,
    token_hash: digestSessionToken(token), expires_at: new Date(Date.now() + 8 * 3_600_000) }).execute();
  return `qianliu_admin_session=${token}`;
}

/**
 * 建立一个完全合成的隔离企业：DeepSeek（API 模式）+ 智谱（Coding Plan 模式）两个资源。
 * 与业务无关的门禁事实（模型路由、计费规则等）不在此登记——本套件不发起模型调用。
 */
async function seedSyntheticEnterprise(name: string): Promise<Synthetic> {
  const enterpriseId = randomUUID(); const adminId = randomUUID();
  const deepseekProviderId = randomUUID(); const zhipuProviderId = randomUUID();
  const apiResourceId = randomUUID(); const planResourceId = randomUUID();
  const principalId = randomUUID(); const principalKeyId = randomUUID();
  const passwordHash = await hashPassword(PASSWORD);
  await db.insertInto("enterprise")
    .values({ id: enterpriseId, name: `${SYNTHETIC_TAG} ${name}` }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId,
    username: `${SYNTHETIC_TAG}-${name}-admin`, password_hash: passwordHash, status: "ACTIVE" }).execute();
  await db.insertInto("provider").values([
    { id: deepseekProviderId, enterprise_id: enterpriseId, code: "deepseek",
      name: `${SYNTHETIC_TAG} DeepSeek`, adapter_type: "OPENAI_COMPATIBLE" },
    { id: zhipuProviderId, enterprise_id: enterpriseId, code: "zhipu",
      name: `${SYNTHETIC_TAG} 智谱`, adapter_type: "OPENAI_COMPATIBLE" },
  ]).execute();
  await db.insertInto("provider_resource").values([
    { id: apiResourceId, enterprise_id: enterpriseId, provider_id: deepseekProviderId,
      name: `${SYNTHETIC_TAG} DeepSeek API`, mode: "API", credential_type: "API_KEY" },
    { id: planResourceId, enterprise_id: enterpriseId, provider_id: zhipuProviderId,
      name: `${SYNTHETIC_TAG} 智谱 Coding Plan`, mode: "CODING_PLAN",
      credential_type: "SUBSCRIPTION_SESSION" },
  ]).execute();
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId,
    type: "EMPLOYEE", name: `${SYNTHETIC_TAG} 合成员工`, department_label: null,
    person_id: null, owner_person_id: null }).execute();
  await db.insertInto("principal_key").values({ id: principalKeyId, enterprise_id: enterpriseId,
    principal_id: principalId, key_prefix: `ql-syn-${name.slice(0, 6)}`, key_digest: `syn-${name}`,
    allowed_model_ids: [], ip_allowlist: [], expires_at: null, quota_limit: null,
    concurrency_limit: null, last_used_at: null, revoked_at: null }).execute();
  // 切换时点前采集的厂商余额快照 → 为 DeepSeek API 资源登记 CNY 必要币种账户（PFA-01）。
  await sql`
    INSERT INTO provider_resource_operating_snapshot
      (id, enterprise_id, provider_resource_id, version, source, collected_at,
       currency, current_balance, usage_calculation)
    VALUES (${randomUUID()}::uuid, ${enterpriseId}::uuid, ${apiResourceId}::uuid, 1, 'ADMIN',
            ${CUTOVER_ISO}::timestamptz, 'CNY', 50, 'MANUAL_SNAPSHOT')
  `.execute(db);
  // 切换时点后的旧购买记录（尚无资金事件）→ 必须在候选里被唯一关闭（PFH-02）。
  const legacyRecordId = await sql<{ id: string }>`
    INSERT INTO resource_purchase_record
      (enterprise_id, provider_resource_id, purchase_type, amount, currency, purchased_at,
       service_period_start, service_period_end, source, created_by, description, evidence_ref)
    VALUES (${enterpriseId}::uuid, ${planResourceId}::uuid, 'PACKAGE_PURCHASE',
            ${MONEY.planAmount}, 'CNY', ${AT.planPurchase.toISOString()}::timestamptz,
            ${FIRST_DAY}::date, ${LAST_DAY}::date, 'ADMIN',
            ${adminId}::uuid, '合成套餐首购', 'synthetic://legacy-plan')
    RETURNING id`.execute(db).then((result) => result.rows[0]!.id);
  return { enterpriseId, adminId, cookie: await sessionFor(adminId),
    deepseekProviderId, zhipuProviderId, apiResourceId, planResourceId,
    principalId, principalKeyId, legacyRecordId, planUsageLineId: "" };
}

/**
 * 落库一条合成用量行（含 `ai_request` / `upstream_attempt` / `usage_event` 依赖链），
 * 依赖链必须终结，否则 PFA-09 排空门禁会以"在途请求/未完成 Attempt"拒绝激活。
 */
async function insertSyntheticUsageLine(
  synthetic: Synthetic,
  options: {
    mode: "API" | "CODING_PLAN"; resourceId: string; settledAt: Date;
    inputTokens: number; outputTokens: number;
    apiCost?: string | null; apiCostStatus?: string | null; snapshotCurrency?: string | null;
  },
): Promise<string> {
  const requestId = randomUUID();
  const ledger = new GatewayLedgerRepository(db);
  await ledger.createRequest({ id: requestId, enterprise_id: synthetic.enterpriseId,
    principal_id: synthetic.principalId, principal_key_id: synthetic.principalKeyId,
    protocol: "OPENAI_CHAT", unified_model: "synthetic-model", unified_model_id: null });
  const attempt = await ledger.createAttempt({ ai_request_id: requestId,
    enterprise_id: synthetic.enterpriseId, attempt_no: 1,
    provider_resource_id: options.resourceId, upstream_model: "synthetic-upstream" });
  const usage = await ledger.createUsageEventIfAbsent({ ai_request_id: requestId,
    enterprise_id: synthetic.enterpriseId, upstream_attempt_id: attempt.id,
    provider_resource_id: options.resourceId, input_tokens: BigInt(options.inputTokens),
    output_tokens: BigInt(options.outputTokens), cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `${requestId}:attempt1` });
  const lineId = randomUUID();
  const snapshot = options.snapshotCurrency === undefined ? null
    : JSON.stringify({ currency: options.snapshotCurrency });
  await sql`
    INSERT INTO ledger_line
      (id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
       provider_resource_id, principal_id, resource_mode, raw_input_tokens,
       raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens, deducted_quota,
       api_cost, api_cost_currency, api_cost_status, subscription_period_id,
       settled_at, usage_quality, billing_rule_snapshot, billing_rule_id, created_at)
    VALUES (${lineId}::uuid, ${requestId}::uuid, ${synthetic.enterpriseId}::uuid,
            ${usage!.id}::uuid, ${attempt.id}::uuid, ${options.resourceId}::uuid,
            ${synthetic.principalId}::uuid, ${options.mode},
            ${options.inputTokens}, ${options.outputTokens}, 0, 0, NULL,
            ${options.apiCost ?? null}, ${options.apiCost === null || options.apiCost === undefined
              ? null : "CNY"}, ${options.apiCostStatus ?? null}, NULL, ${options.settledAt},
            'PROVIDER_REPORTED', ${snapshot}::jsonb, NULL, ${options.settledAt})
  `.execute(db);
  await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=${options.settledAt}
             WHERE id=${requestId}::uuid`.execute(db);
  await sql`UPDATE upstream_attempt SET finished_at=${options.settledAt}, http_status=200
             WHERE id=${attempt.id}::uuid`.execute(db);
  return lineId;
}

/** 资金/控制表按企业的行数快照，用于证明"零重复事实"。 */
const FINANCE_COUNT_TABLES = ["provider_finance_event", "provider_subscription_period", "ledger_line",
  "provider_finance_activation_attempt", "operation_log"] as const;

/** 键集固定，避免 `Record<string, number>` 在 `noUncheckedIndexedAccess` 下取值退化为 `number | undefined`。 */
type FinanceCounts = Record<(typeof FINANCE_COUNT_TABLES)[number], number>;

async function financeCounts(enterpriseId: string): Promise<FinanceCounts> {
  const counts = {} as FinanceCounts;
  for (const table of FINANCE_COUNT_TABLES) {
    const row = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM ${sql.table(table)}
       WHERE enterprise_id=${enterpriseId}::uuid`.execute(db);
    counts[table] = Number(row.rows[0]!.count);
  }
  return counts;
}

const startLease = (cookie: string, durationSeconds?: number) => app.inject({
  method: "POST", url: "/provider-finance/activation-quiescence", headers: { cookie },
  payload: durationSeconds === undefined ? {} : { duration_seconds: durationSeconds },
});
const preview = (cookie: string, draft: Record<string, unknown>) => app.inject({
  method: "POST", url: "/provider-finance/activation-preview", headers: { cookie }, payload: draft });
const activate = (cookie: string, payload: Record<string, unknown>) => app.inject({
  method: "POST", url: "/provider-finance/activate", headers: { cookie }, payload });
const activationState = (cookie: string) => app.inject({
  method: "GET", url: "/provider-finance/activation-state", headers: { cookie } });

type GapView = { code: string; category: string; message: string; resourceId: string | null;
  accountCurrency: string | null; legacyRecordId: string | null;
  ledgerLineId: string | null; month: string | null; detail: string | null };

/**
 * 完整合成草稿：DeepSeek 期初 + 切换后历史充值，智谱套餐购买（金额/实付/周期）+ 旧记录 MIGRATED 关闭。
 * 与 WP03 的"最小草稿"不同，这里刻意带上套餐与旧记录，以覆盖 6.3 的业务面。
 */
function completeDraft(synthetic: Synthetic) {
  return {
    schema_version: "1",
    api_opening_balances: [{
      resource_id: synthetic.apiResourceId, account_currency: "CNY",
      account_amount: MONEY.apiOpening, occurred_at: CUTOVER_ISO,
      description: `${SYNTHETIC_TAG} 切换时点厂商余额（合成）`,
      evidence_ref: "synthetic://deepseek-opening", source_record_id: null,
    }],
    historical_api_recharges: [{
      resource_id: synthetic.apiResourceId, account_currency: "CNY",
      account_amount: MONEY.apiRecharge, cash_paid_cny: MONEY.apiRecharge,
      occurred_at: AT.apiRecharge.toISOString(), external_reference: "SYN-API-PAY-1",
      description: `${SYNTHETIC_TAG} 切换后历史充值（合成）`,
      evidence_ref: "synthetic://deepseek-recharge-1",
      source_record_id: randomUUID(), record_idempotency_key: "syn-api-recharge-1",
    }],
    coding_plan_purchases: [{
      resource_id: synthetic.planResourceId, kind: "PURCHASE",
      product_name: `${SYNTHETIC_TAG} 智谱 Coding Plan`,
      account_amount: MONEY.planAmount, account_currency: "CNY",
      cash_paid_cny: MONEY.planAmount,
      service_period_start: FIRST_DAY, service_period_end: LAST_DAY,
      occurred_at: AT.planPurchase.toISOString(), external_reference: "SYNTH-ZHIPU-ORD-1",
      auto_renew: false, description: `${SYNTHETIC_TAG} 套餐购买（合成）`,
      evidence_ref: "synthetic://zhipu-purchase", source_record_id: synthetic.legacyRecordId,
      carryover_snapshot_id: null, record_idempotency_key: "syn-plan-purchase-1",
    }],
    coding_plan_carryovers: [],
    legacy_purchase_resolutions: [{
      legacy_record_id: synthetic.legacyRecordId, resource_id: synthetic.planResourceId,
      resolution: "MIGRATED", finance_event_id: null,
      migrated_external_reference: "SYNTH-ZHIPU-ORD-1", reason: null, evidence_ref: null,
    }],
  };
}

/** 刻意不完整的草稿：只保留一条金额为 0 的充值行，其余全缺 → 用于证明 NO_GO 缺口定位精确。 */
function incompleteDraft(synthetic: Synthetic) {
  return {
    schema_version: "1",
    api_opening_balances: [],
    historical_api_recharges: [{
      resource_id: synthetic.apiResourceId, account_currency: "CNY",
      account_amount: "0", cash_paid_cny: MONEY.apiRecharge,
      occurred_at: AT.apiRecharge.toISOString(), external_reference: "SYN-API-PAY-0",
      description: `${SYNTHETIC_TAG} 故意缺金额的充值（合成）`,
      evidence_ref: "synthetic://deepseek-recharge-0",
      source_record_id: randomUUID(), record_idempotency_key: "syn-api-recharge-0",
    }],
    coding_plan_purchases: [],
    coding_plan_carryovers: [],
    legacy_purchase_resolutions: [],
  };
}

describe.sequential("PF-INIT WP07：合成企业本地业务验收（NO_GO → GO_CANDIDATE → ACTIVATED）", () => {
  let synthetic: Synthetic;
  let phase = "NO_GO";
  let candidate: { candidate_id: string; candidate_hash: string;
    fact_watermark_hash: string; expires_at: string };
  let receipt: { conservationPassed: boolean; conservationFailures: unknown[];
    factCounts: Record<string, number>; monthsChecked: string[] };

  it("1. 合成事实落库：DeepSeek 已定价 API 用量、智谱套餐用量、切换后旧购买记录", async () => {
    synthetic = await seedSyntheticEnterprise("main");
    await insertSyntheticUsageLine(synthetic, { mode: "API", resourceId: synthetic.apiResourceId,
      settledAt: AT.apiUsage, inputTokens: 120, outputTokens: 30,
      apiCost: MONEY.apiUsageCost, apiCostStatus: "PRICED_USAGE", snapshotCurrency: "CNY" });
    synthetic.planUsageLineId = await insertSyntheticUsageLine(synthetic, {
      mode: "CODING_PLAN", resourceId: synthetic.planResourceId,
      settledAt: AT.planUsage, inputTokens: 40, outputTokens: 10,
      apiCost: null, apiCostStatus: null, snapshotCurrency: "CNY" });
    // 落库即事实：未激活前企业既无严格写、也无任何资金事件。
    const state = await activationState(synthetic.cookie);
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json()).toMatchObject({ mode: "ACTIVE", strict_writes_enabled: false,
      latest_candidate: null, activation_receipt: null });
    expect(await financeCounts(synthetic.enterpriseId)).toMatchObject({
      provider_finance_event: 0, provider_subscription_period: 0,
      provider_finance_activation_attempt: 0 });
    // 「激活前」基线：账单只能走旧口径，因而**无法算出动态 API 成本**（缺期末余额桥）。
    // 同时记录主体维度行（用于判别观察项 O-1 是否为资金路径引入）。
    const preBill = await app.operatingBillRepo.getBill(synthetic.enterpriseId, anchor.month);
    emitEvidence(`[WP07-OBS] 激活前账单：${JSON.stringify({
      apiCost: preBill.summary.apiCost, totalCost: preBill.summary.totalCost,
      apiSpendStatus: preBill.summary.apiSpendStatus,
      openingBalance: preBill.summary.openingBalance,
      subjects: preBill.subjects.map((row) => ({ principalId: row.principalId,
        principalType: row.principalType, totalTokens: row.totalTokens })) })}`);
    expect(preBill.summary.apiCost).toBeNull();
    expect(preBill.summary.totalCost).toBeNull();
  }, 120_000);

  it("2. 静默租约 + 不完整草稿 → NO_GO，缺口精确定位到资源/账户、旧记录与用量行", async () => {
    expect((await startLease(synthetic.cookie)).statusCode).toBe(201);
    const response = await preview(synthetic.cookie, incompleteDraft(synthetic));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.decision).toBe("NO_GO");
    const gaps = body.gaps as GapView[];
    expect(gaps.length).toBeGreaterThan(0);
    // 资源 + 账户维度：DeepSeek API 的 CNY 必要账户缺期初。
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_OPENING_BALANCE",
        resourceId: synthetic.apiResourceId, accountCurrency: "CNY" })]));
    // 资源 + 账户维度：充值行金额为 0。
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_RECHARGE_AMOUNT",
        resourceId: synthetic.apiResourceId, accountCurrency: "CNY" })]));
    // 用量行维度：智谱套餐用量没有覆盖周期，无法唯一归属。
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNATTRIBUTED_PLAN_USAGE",
        ledgerLineId: synthetic.planUsageLineId })]));
    // 旧记录维度：切换后旧购买记录没有唯一关闭结果。
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LEGACY_RECORD_UNCLOSED",
        legacyRecordId: synthetic.legacyRecordId })]));
    // 经营账单维度：同月账单缺口必须带 month 且精确到原因码。
    expect(gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "OPERATING_BILL", month: anchor.month,
        detail: "OPENING_BALANCE_MISSING" })]));
    // 修复基准里只有那一条套餐用量行；它只带来「费用分类 = NOT_APPLICABLE」这一项可修复字段，
    // **不含** `subscription_period_id` —— 缺覆盖周期时不存在确定性归属，修复计划不得凭空指定。
    expect(body.usage_repairs.eligibleRows).toBe(1);
    expect(body.usage_repairs.eligibleByField).toMatchObject({
      subscription_period_id: 0, api_cost_status: 1, api_cost_currency: 0, settled_at: 0,
    });
    // 未激活前严格资金写入口必须被停写门禁拒绝（PFA-08）；激活前不得出现任何资金事实。
    const blockedWrite = await app.inject({ method: "POST",
      url: `/provider-resources/${synthetic.apiResourceId}/finance/recharges`,
      headers: { cookie: synthetic.cookie },
      payload: { account_currency: "CNY", account_amount: "1", cash_paid_cny: "1",
        occurred_at: AT.postRecharge.toISOString(), description: "激活前不应成功",
        evidence_ref: "synthetic://should-not-happen", idempotency_key: "syn-blocked-1" } });
    expect(blockedWrite.statusCode, blockedWrite.body).toBe(503);
    expect(blockedWrite.json()).toMatchObject({ error: "finance_write_contract_inactive" });
    // NO_GO 结论同样被归档为候选行（预检结论留痕），但企业侧**零资金事实**：
    // 没有任何资金事件、没有订阅周期；`previewActivation` 只记录结论元数据。
    expect(await financeCounts(synthetic.enterpriseId)).toMatchObject({
      provider_finance_event: 0, provider_subscription_period: 0,
      provider_finance_activation_attempt: 1 });
    // 且 NO_GO 候选**不可激活**（决策门禁在协调器第 4 步，先于租约门禁）。
    const noGoCandidate = (await activationState(synthetic.cookie)).json().latest_candidate as {
      candidate_id: string; candidate_hash: string; decision: string; status: string;
      gap_summary: unknown[] };
    expect(noGoCandidate).toMatchObject({ decision: "NO_GO", status: "PREVIEWED" });
    expect(noGoCandidate.gap_summary.length).toBeGreaterThan(0);
    const noGoActivation = await activate(synthetic.cookie, {
      candidate_id: noGoCandidate.candidate_id, candidate_hash: noGoCandidate.candidate_hash,
      idempotency_key: "syn-no-go-candidate", confirm_enterprise_id: synthetic.enterpriseId });
    expect(noGoActivation.statusCode, noGoActivation.body).toBe(409);
    expect(noGoActivation.json()).toMatchObject({ error: "candidate_not_ready", retryable: false });
    expect(await financeCounts(synthetic.enterpriseId)).toMatchObject({
      provider_finance_event: 0, provider_subscription_period: 0 });
    phase = "NO_GO";
  }, 120_000);

  it("3. 在途请求/未结束 Attempt 阻断预检，排空后生成 GO_CANDIDATE 并冻结候选四要素", async () => {
    // 在途请求（未终结）：PFA-09 要求"排空未完成不得生成候选"，连投影都不算。
    const ledger = new GatewayLedgerRepository(db);
    const inFlight = randomUUID();
    await ledger.createRequest({ id: inFlight, enterprise_id: synthetic.enterpriseId,
      principal_id: synthetic.principalId, principal_key_id: synthetic.principalKeyId,
      protocol: "OPENAI_CHAT", unified_model: "synthetic-model", unified_model_id: null });
    const blocked = await preview(synthetic.cookie, completeDraft(synthetic));
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "activation_not_quiescent" });
    expect(blocked.json().detail).toMatchObject({ in_progress_requests: 1 });

    // 未结束 Attempt（请求已终结但 attempt 未终结）：同样阻断，且理由指向 open_attempts。
    await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=now()
               WHERE id=${inFlight}::uuid`.execute(db);
    const openAttemptId = randomUUID();
    await sql`
      INSERT INTO upstream_attempt
        (id, ai_request_id, enterprise_id, attempt_no, provider_resource_id, upstream_model,
         started_at, finished_at, http_status)
      VALUES (${openAttemptId}::uuid, ${inFlight}::uuid, ${synthetic.enterpriseId}::uuid, 2,
              ${synthetic.apiResourceId}::uuid, 'synthetic-upstream', now(), NULL, NULL)
    `.execute(db);
    const stillBlocked = await preview(synthetic.cookie, completeDraft(synthetic));
    expect(stillBlocked.statusCode, stillBlocked.body).toBe(409);
    expect(stillBlocked.json().detail).toMatchObject({ open_attempts: 1 });

    // 排空（终结 Attempt）后生成 GO_CANDIDATE。
    await sql`UPDATE upstream_attempt SET finished_at=now(), http_status=200
               WHERE id=${openAttemptId}::uuid`.execute(db);
    const drained = await app.inject({ method: "GET",
      url: "/provider-finance/activation-quiescence", headers: { cookie: synthetic.cookie } });
    expect(drained.statusCode, drained.body).toBe(200);
    expect(drained.json().quiescence).toMatchObject({ active: true,
      drain: { in_progress_requests: 0, open_attempts: 0, drained: true } });

    const response = await preview(synthetic.cookie, completeDraft(synthetic));
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    // 先断言缺口清零，失败时直接暴露残留缺口（诊断可读性）。
    expect(body.gaps, `残留缺口：${JSON.stringify(body.gaps)}`).toEqual([]);
    expect(body.decision).toBe("GO_CANDIDATE");
    expect(body.candidate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.fact_watermark_hash).toMatch(/^[0-9a-f]{64}$/);
    // 候选四要素：候选哈希、事实水位哈希、TTL（30 分钟，取瞬时允许 <1s 取值漂移）、快照时点。
    const ttlMs = new Date(body.expires_at).getTime() - new Date(body.snapshot_at).getTime();
    expect(Math.abs(ttlMs - 30 * 60_000)).toBeLessThan(1_000);
    // 投影摘要（预检响应用领域字段名；`scope_summary` 只给范围计数，业务结论在 `projected`）。
    expect(body.projected).toMatchObject({
      tokenConserved: true, codingPlanUsageAttributed: true, operatingBillsComplete: true,
      monthsChecked: [anchor.month] });
    expect(body.scope_summary).toMatchObject({
      apiResources: 1, codingPlanResources: 1, requiredAccounts: 1, legacyRecords: 1,
      months: [anchor.month] });
    expect(body.usage_repairs.eligibleRows).toBe(1);
    candidate = { candidate_id: body.candidate_id, candidate_hash: body.candidate_hash,
      fact_watermark_hash: body.fact_watermark_hash, expires_at: body.expires_at };

    // 候选元数据可经状态接口复核，且草稿载荷不外泄。
    const state = await activationState(synthetic.cookie);
    expect(state.json()).toMatchObject({
      latest_candidate: { candidate_id: candidate.candidate_id,
        candidate_hash: candidate.candidate_hash,
        fact_watermark_hash: candidate.fact_watermark_hash,
        decision: "GO_CANDIDATE", status: "PREVIEWED", gap_summary: [], expired: false },
      scope_summary: { required_accounts: expect.arrayContaining([
        { resource_id: synthetic.apiResourceId, currency: "CNY" }]),
        usage_repair_rows: 1 },
    });
    expect(state.body).not.toContain("candidate_draft");
    expect(state.body).not.toContain("synthetic://");
    phase = "GO_CANDIDATE";
  }, 180_000);

  it("4. 企业二次确认后激活：严格写开启、不可变回执与审计、范围资源 READY、同键重放零重复事实", async () => {
    // 二次确认企业与会话不一致 → 失败关闭，零写入。
    const mismatch = await activate(synthetic.cookie, {
      candidate_id: candidate.candidate_id, candidate_hash: candidate.candidate_hash,
      idempotency_key: "syn-accept-mismatch", confirm_enterprise_id: randomUUID() });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: "session_enterprise_mismatch", retryable: false });
    expect(await financeCounts(synthetic.enterpriseId))
      .toMatchObject({ provider_finance_event: 0 });

    // 按企业复核（确认 ID 与会话企业逐字一致）后激活。
    const payload = { candidate_id: candidate.candidate_id, candidate_hash: candidate.candidate_hash,
      idempotency_key: "syn-accept-key-1", confirm_enterprise_id: synthetic.enterpriseId };
    const activated = await activate(synthetic.cookie, payload);
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json()).toMatchObject({ replayed: false,
      candidate_id: candidate.candidate_id, receipt: {
        conservationPassed: true, conservationFailures: [],
        factCounts: { openings: 1, recharges: 1, purchases: 1, carryovers: 0,
          legacyResolutions: 1, usageRepairs: 1 },
      } });
    receipt = activated.json().receipt;
    expect(receipt.monthsChecked).toContain(anchor.month);
    const countsAfter = await financeCounts(synthetic.enterpriseId);

    // 同幂等键重放：回执逐字一致，且不产生第二组事实。
    const replay = await activate(synthetic.cookie, payload);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, candidate_id: candidate.candidate_id });
    expect(replay.json().receipt).toEqual(receipt);
    expect(await financeCounts(synthetic.enterpriseId)).toEqual(countsAfter);

    // 范围资源资金就绪（PFH-07）：**只有 API 资源**建立资金就绪行（它才持有必要币种账户），
    // 且必备币种必须等于候选投影出的账户集合。套餐资源无币种账户，不纳入资金门禁。
    const states = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", synthetic.enterpriseId).execute();
    expect(states.map((row) => [row.provider_resource_id, row.state, row.required_currencies]))
      .toEqual([[synthetic.apiResourceId, "READY", ["CNY"]]]);
    expect(states[0]!.ready_by_admin_user_id).toBe(synthetic.adminId);
    expect(states[0]!.ready_at).not.toBeNull();

    // 回执不可变且可见；激活者与激活时点已落库。
    const state = await activationState(synthetic.cookie);
    expect(state.json()).toMatchObject({
      strict_writes_enabled: true,
      latest_candidate: { status: "ACTIVATED" },
      activation_receipt: { conservationPassed: true },
      activated_by_admin_user_id: synthetic.adminId,
    });
    expect(state.json().activated_at).not.toBeNull();

    // 审计：激活成功有不可变回执，失败尝试（企业不匹配）只记非敏感字段。
    const audits = await db.selectFrom("operation_log").select(["action", "result", "failure_reason"])
      .where("enterprise_id", "=", synthetic.enterpriseId).execute();
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "provider_finance.activation_activate.failure",
        result: "FAILURE", failure_reason: "SESSION_ENTERPRISE_MISMATCH" })]));
    phase = "ACTIVATED";
  }, 180_000);

  it("5. 激活后后续充值走严格写接口；DeepSeek 余额/本月充值/API 成本可解释", async () => {
    // 激活后、后续充值前：余额 = 期初 88.55 + 历史充值 20.00 − 已定价 API 成本 1.25。
    const beforeRecharge = await app.inject({ method: "GET",
      url: `/provider-resources/${synthetic.apiResourceId}/finance/balance?currency=CNY`,
      headers: { cookie: synthetic.cookie } });
    expect(beforeRecharge.statusCode, beforeRecharge.body).toBe(200);
    expect(beforeRecharge.json()).toMatchObject({ state: "NORMAL",
      balance: BALANCE_AFTER_ACTIVATION });

    const recharge = await app.inject({ method: "POST",
      url: `/provider-resources/${synthetic.apiResourceId}/finance/recharges`,
      headers: { cookie: synthetic.cookie },
      payload: { account_currency: "CNY", account_amount: MONEY.postRecharge,
        cash_paid_cny: MONEY.postRecharge, occurred_at: AT.postRecharge.toISOString(),
        external_reference: "SYN-API-PAY-2",
        description: `${SYNTHETIC_TAG} 激活后后续充值（合成）`,
        evidence_ref: "synthetic://deepseek-recharge-2",
        idempotency_key: "syn-api-recharge-2" } });
    expect(recharge.statusCode, recharge.body).toBe(201);

    // 余额 = 期初 88.55 + 历史充值 20.00 + 后续充值 30.00 − 已定价 API 成本 1.25。
    const balance = await app.inject({ method: "GET",
      url: `/provider-resources/${synthetic.apiResourceId}/finance/balance?currency=CNY`,
      headers: { cookie: synthetic.cookie } });
    expect(balance.statusCode, balance.body).toBe(200);
    expect(balance.json()).toMatchObject({ state: "NORMAL", balance: BALANCE_AFTER_POST_RECHARGE });

    // 本月账务摘要：动态 API 成本与固定套餐成本分开列示；余额口径完整且无缺口。
    // 套餐侧金额自 v2（D-1 修复）起为**正向断言**：199.00 只计一次，
    // `operatingCostCny = 199.00 + 1.25`，`cashOutflowCny = 199.00 + 50.00`。
    const summary = await app.inject({ method: "GET",
      url: `/provider-finance/summary?month=${anchor.month}`, headers: { cookie: synthetic.cookie } });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({
      month: anchor.month, timezone: "Asia/Shanghai",
      apiRecharges: [{ currency: "CNY", amount: "50.00000000" }],
      apiOperatingCosts: [{ currency: "CNY", amount: "1.25000000" }],
      codingPlanOrders: [{ currency: "CNY", amount: "199.00000000" }],
      codingPlanFixedCostCny: "199.00000000",
      operatingCostCny: "200.25000000",
      cashOutflowCny: "249.00000000",
      operatingCostByCurrency: [],
      currentApiBalances: [{ currency: "CNY", amount: BALANCE_AFTER_POST_RECHARGE }],
      currentApiBalancesComplete: true,
      complete: true,
    });
    expect(summary.json().gaps).toEqual([]);
  }, 120_000);

  it("6. 智谱购买/实付/周期与套餐成本、用量唯一归属可解释", async () => {
    const periods = await app.inject({ method: "GET",
      url: `/provider-resources/${synthetic.planResourceId}/subscription-periods`,
      headers: { cookie: synthetic.cookie } });
    expect(periods.statusCode, periods.body).toBe(200);
    expect(periods.json().periods).toHaveLength(1);
    const period = periods.json().periods[0] as { id: string; current_status: string };
    expect(period).toMatchObject({
      product_name: `${SYNTHETIC_TAG} 智谱 Coding Plan`,
      period_start: anchor.start.toISOString(),
      period_end_exclusive: anchor.next.toISOString(),
      current_status: "ACTIVE",
      fixed_fee_amount: "199.00000000", fixed_fee_currency: "CNY",
      fixed_cash_paid_cny: "199.00000000",
      token_usage: expect.objectContaining({ input_tokens: "40", output_tokens: "10",
        true_tokens: "50" }),
    });

    // 套餐用量唯一归属：该周期下的用量与账本行一致（无第二周期，不产生歧义）。
    const usage = await app.inject({ method: "GET",
      url: `/provider-subscription-periods/${period.id}/usage`, headers: { cookie: synthetic.cookie } });
    expect(usage.statusCode, usage.body).toBe(200);
    expect(usage.json()).toMatchObject({ period: { id: period.id },
      tokenUsage: { request_count: "1", true_tokens: "50" } });

    // 账本行确实绑定到该周期（周期唯一归属的库内证据）。
    const bound = await db.selectFrom("ledger_line").select(["subscription_period_id", "api_cost_status"])
      .where("id", "=", synthetic.planUsageLineId).executeTakeFirstOrThrow();
    expect(bound).toMatchObject({ subscription_period_id: period.id,
      api_cost_status: "NOT_APPLICABLE" });

    // 旧购买记录已被唯一关闭（PFH-02）：关闭决定落在**不可变关闭审计**里
    // （`closeLegacyPurchaseTx` 只写 `operation_log`，不另建状态表）。
    const closure = await db.selectFrom("operation_log")
      .select(["action", "target_type", "target_id", "result", "change_summary"])
      .where("enterprise_id", "=", synthetic.enterpriseId)
      .where("action", "=", "provider_finance.legacy_purchase.close").execute();
    expect(closure).toHaveLength(1);
    expect(closure[0]).toMatchObject({ target_type: "resource_purchase_record",
      target_id: synthetic.legacyRecordId, result: "SUCCESS" });
    expect(closure[0]!.change_summary).toMatchObject({ resolution: "MIGRATED",
      resource_id: synthetic.planResourceId, external_reference: "SYNTH-ZHIPU-ORD-1" });

    // 资源读模型：API 与套餐两侧都可解释（套餐侧 `monthlyPlanCashCny` 自 v2 起正向断言 199.00）。
    const resources = await app.inject({ method: "GET",
      url: `/provider-finance/resources?month=${anchor.month}`, headers: { cookie: synthetic.cookie } });
    expect(resources.statusCode, resources.body).toBe(200);
    expect(resources.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: synthetic.planResourceId, mode: "CODING_PLAN",
        monthlyPlanCashCny: "199.00000000",
        currentPeriod: expect.objectContaining({ id: period.id }) }),
      expect.objectContaining({ resourceId: synthetic.apiResourceId, mode: "API",
        accounts: [expect.objectContaining({ currency: "CNY", monthlyRecharge: "50.00000000",
          monthlyApiCost: "1.25000000", balance: BALANCE_AFTER_POST_RECHARGE })] }),
    ]));
  }, 120_000);

  it("7. 经营账单区分动态 API 成本与固定套餐成本，且金额/Token 守恒（静默期内跳过月账任务）", async () => {
    // 租约仍有效（激活不消耗租约）：`isEnterpriseQuiescent` 正是 Worker 月账/续订任务与
    // Gateway 上游门禁共用的同一判据（PFA-09）。端到端"整企业跳过"由既有两套件证明：
    // worker `provider-finance-quiescence-worker.integration.test.ts`（SKIPPED_QUIESCENT）
    // 与 gateway `provider-finance-quiescence-gate.test.ts`（不触达上游），日志随本套件归档。
    expect(await isEnterpriseQuiescent(db, synthetic.enterpriseId, new Date())).toBe(true);
    const skipped = await app.inject({ method: "GET", url: "/dashboard/home",
      headers: { cookie: synthetic.cookie } });
    expect(skipped.statusCode, skipped.body).toBe(200);

    // 解除静默 → 本地任务与流量恢复（判据翻转为 false；到期解除同语义）。
    const released = await app.inject({ method: "POST",
      url: "/provider-finance/activation-quiescence/release", headers: { cookie: synthetic.cookie },
      payload: { reason: "合成验收结束，恢复本地流量" } });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().lease).toMatchObject({ status: "RELEASED" });
    expect(await isEnterpriseQuiescent(db, synthetic.enterpriseId, new Date())).toBe(false);

    // 经 Control API 自身的账单仓储（`/dashboard/home` 同源实例）取当月快照。
    // 套餐侧金额自 v2（D-1 修复）起为正向断言：固定套餐成本 199.00 只计一次，
    // 账单总额 = 动态 API 1.25 + 固定套餐 199.00 = 200.25。
    const bill = await app.operatingBillRepo.getBill(synthetic.enterpriseId, anchor.month);
    expect(bill.month).toBe(anchor.month);
    expect(bill.summary).toMatchObject({
      apiCost: "1.25000000", ledgerApiCost: "1.25000000",
      packageCost: "199.00000000", totalCost: "200.25000000",
      monthlyRecharge: "50.00000000",
      openingBalance: BALANCE_OPENING,
      endingBalance: BALANCE_AFTER_POST_RECHARGE,
      apiSpendStatus: "CALCULABLE", apiSpendReason: null,
    });
    // 动态 API 成本与固定套餐成本分别列示，互不混算。
    expect(bill.summary.apiSpends).toEqual([{ currency: "CNY", amount: "1.25000000" }]);
    expect(bill.summary.packageCosts).toEqual([{ currency: "CNY", amount: "199.00000000" }]);
    // 账单缺口必须清零：激活后经营账单不得再报任何缺口。
    expect(bill.gaps).toEqual([]);
    // 账单内的按人分摊：合成员工的两类用量（API 120/30 + 套餐 40/10）归集到同一主体，
    // 分摊口径与账本行逐行一致（Token 守恒在主体维度也成立）。
    const subject = bill.subjects.find((row) => row.principalId === synthetic.principalId);
    expect(subject, `subjects=${JSON.stringify(bill.subjects)}`).toBeDefined();
    expect(subject).toMatchObject({ principalName: `${SYNTHETIC_TAG} 合成员工`,
      inputTokens: "160", outputTokens: "40", totalTokens: "200", requestCount: 2,
      providers: expect.arrayContaining([`${SYNTHETIC_TAG} DeepSeek`, `${SYNTHETIC_TAG} 智谱`]) });

    // 供应商级分列：DeepSeek 行只体现动态 API 成本；智谱行体现固定套餐成本与服务周期。
    const rowOf = (resourceId: string) => bill.providers
      .find((provider) => provider.providerResourceId === resourceId)!;
    expect(rowOf(synthetic.apiResourceId)).toMatchObject({ mode: "API",
      apiCost: "1.25000000", rechargeAmount: "50.00000000",
      openingBalance: BALANCE_OPENING, endingBalance: BALANCE_AFTER_POST_RECHARGE,
      apiSpendStatus: "CALCULABLE" });
    expect(rowOf(synthetic.planResourceId)).toMatchObject({ mode: "CODING_PLAN",
      packageCost: "199.00000000", totalCost: "199.00000000",
      servicePeriodStart: FIRST_DAY, servicePeriodEnd: NEXT_DAY });

    // Token 守恒：候选投影的 Token 守恒结论与账本行逐行一致
    // （驱动把 `raw_*_tokens` 以字符串回传，必须显式转换后再求和）。
    const lines = await db.selectFrom("ledger_line")
      .select(["resource_mode", "raw_input_tokens", "raw_output_tokens"])
      .where("enterprise_id", "=", synthetic.enterpriseId).execute();
    expect(lines.reduce((sum, line) => sum + BigInt(line.raw_input_tokens), 0n)).toBe(160n);
    expect(lines.reduce((sum, line) => sum + BigInt(line.raw_output_tokens), 0n)).toBe(40n);
    phase = "WORKER_RESUMED";
  }, 180_000);

  it("8. 全窗口守恒与候选/激活链路的最终一致性", async () => {
    expect(phase).toBe("WORKER_RESUMED");
    // 回执守恒结论 + 缺口清零（金额/Token/周期三类缺口都在激活后被关闭）。
    expect(receipt.conservationPassed).toBe(true);
    expect(receipt.conservationFailures).toEqual([]);
    const state = await activationState(synthetic.cookie);
    expect(state.json()).toMatchObject({
      strict_writes_enabled: true,
      latest_candidate: { status: "ACTIVATED",
        candidate_hash: candidate.candidate_hash,
        fact_watermark_hash: candidate.fact_watermark_hash },
      scope_summary: { token_conserved: true, coding_plan_usage_attributed: true,
        operating_bills_complete: true },
    });
    // 已激活企业不得再建候选。路由的静默门禁在候选门禁之前，因此先重建租约再预检。
    expect((await startLease(synthetic.cookie)).statusCode).toBe(201);
    const countsAfterLease = await financeCounts(synthetic.enterpriseId);
    const relPreview = await preview(synthetic.cookie, completeDraft(synthetic));
    expect(relPreview.statusCode, relPreview.body).toBe(409);
    expect(relPreview.json()).toMatchObject({ error: "already_activated", retryable: false });
    // 被拒的预检不得产生任何副作用：候选仍 ACTIVATED、严格写仍开启、**事实行数不变**；
    // 唯一允许的增量是这次失败留痕本身（审计一行）。
    const afterRefusal = await activationState(synthetic.cookie);
    expect(afterRefusal.json()).toMatchObject({ strict_writes_enabled: true,
      latest_candidate: { status: "ACTIVATED" } });
    const countsAfterRefusal = await financeCounts(synthetic.enterpriseId);
    const { operation_log: logAfter, ...factsAfter } = countsAfterRefusal;
    const { operation_log: logBefore, ...factsBefore } = countsAfterLease;
    expect(factsAfter).toEqual(factsBefore);
    expect(logAfter - logBefore).toBe(1);
  }, 120_000);

  /**
   * §9 证据快照（只读）：把 6.3 验收所需的「API 回执 + 关键 SQL 核验 + 读模型结论」
   * 一次性打进 stdout，由归档的 vitest 日志承载（任务 6）。
   *
   * 只输出业务事实与合成标识：**不含** Cookie、会话令牌、密码、摘要原像或任何真实凭证。
   */
  it("9. 证据快照（只读）：API 回执与关键 SQL 核验", async () => {
    const [state, summary, balances, resources, candidateRow, events, periods, ledger, legacy,
      runtime, financeState, lease, audits, orphan] = await Promise.all([
      activationState(synthetic.cookie),
      app.inject({ method: "GET", url: `/provider-finance/summary?month=${anchor.month}`,
        headers: { cookie: synthetic.cookie } }),
      app.inject({ method: "GET",
        url: `/provider-resources/${synthetic.apiResourceId}/finance/balance?currency=CNY`,
        headers: { cookie: synthetic.cookie } }),
      app.inject({ method: "GET", url: `/provider-finance/resources?month=${anchor.month}`,
        headers: { cookie: synthetic.cookie } }),
      db.selectFrom("provider_finance_activation_attempt")
        .select(["id", "decision", "status", "candidate_hash", "fact_watermark_hash",
          "created_at", "expires_at", "activated_at", "activated_by_admin_user_id",
          "usage_repair_baseline"])
        .where("id", "=", candidate.candidate_id).executeTakeFirstOrThrow(),
      db.selectFrom("provider_finance_event")
        .select(["id", "provider_resource_id", "event_type", "account_amount", "account_currency",
          "cash_paid_cny", "occurred_at", "external_reference", "source"])
        .where("enterprise_id", "=", synthetic.enterpriseId).orderBy("event_type").execute(),
      db.selectFrom("provider_subscription_period")
        .select(["id", "provider_resource_id", "product_name", "period_start",
          "period_end_exclusive", "finance_event_id", "migration_source_record_id", "source"])
        .where("enterprise_id", "=", synthetic.enterpriseId).execute(),
      db.selectFrom("ledger_line")
        .select(["id", "resource_mode", "raw_input_tokens", "raw_output_tokens", "api_cost",
          "api_cost_currency", "api_cost_status", "subscription_period_id", "settled_at"])
        .where("enterprise_id", "=", synthetic.enterpriseId).orderBy("resource_mode").execute(),
      db.selectFrom("resource_purchase_record")
        .select(["id", "provider_resource_id", "purchase_type", "amount", "currency", "purchased_at",
          "service_period_start", "service_period_end", "source"])
        .where("id", "=", synthetic.legacyRecordId).executeTakeFirstOrThrow(),
      db.selectFrom("provider_finance_runtime_state")
        .select(["strict_writes_enabled", "activated_at", "activated_by_admin_user_id"])
        .where("enterprise_id", "=", synthetic.enterpriseId).executeTakeFirstOrThrow(),
      db.selectFrom("provider_resource_finance_state")
        .select(["provider_resource_id", "state", "required_currencies", "ready_at"])
        .where("enterprise_id", "=", synthetic.enterpriseId).execute(),
      db.selectFrom("provider_finance_activation_quiescence")
        .select(["status", "started_at", "expires_at", "released_at", "release_reason"])
        .where("enterprise_id", "=", synthetic.enterpriseId).executeTakeFirstOrThrow(),
      db.selectFrom("operation_log").select(["action", "target_type", "target_id", "result"])
        .where("enterprise_id", "=", synthetic.enterpriseId).orderBy("action").execute(),
      sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM resource_purchase_record purchase
         WHERE purchase.enterprise_id=${synthetic.enterpriseId}::uuid
           AND NOT EXISTS (SELECT 1 FROM provider_finance_event event
             WHERE event.enterprise_id=purchase.enterprise_id
               AND event.provider_resource_id=purchase.provider_resource_id
               AND event.external_reference=('legacy-purchase:'||purchase.id::text))`.execute(db),
    ]);
    const bill = await app.operatingBillRepo.getBill(synthetic.enterpriseId, anchor.month);
    emitEvidence(`[WP07-EVIDENCE] ${JSON.stringify({
      synthetic: { enterpriseId: synthetic.enterpriseId, adminId: synthetic.adminId,
        apiResourceId: synthetic.apiResourceId, planResourceId: synthetic.planResourceId,
        legacyRecordId: synthetic.legacyRecordId },
      declaredSyntheticAmounts: MONEY,
      candidateFourElements: candidate,
      candidateRow: { ...candidateRow, usage_repair_baseline: undefined,
        usage_repair_row_ids: candidateRow.usage_repair_baseline
          .map((row: { ledgerLineId: string }) => row.ledgerLineId) },
      activationReceipt: receipt,
      activationState: { strict_writes_enabled: state.json().strict_writes_enabled,
        mode: state.json().mode, latest_candidate: state.json().latest_candidate,
        scope_summary: state.json().scope_summary },
      apiReceipts: { balance: balances.json(), summary: summary.json(),
        resources: resources.json().resources.map((row: { resourceId: string; mode: string;
          monthlyPlanCashCny: string; currentPeriod: { id: string } | null }) =>
          ({ resourceId: row.resourceId, mode: row.mode,
            monthlyPlanCashCny: row.monthlyPlanCashCny, currentPeriodId: row.currentPeriod?.id ?? null })) },
      sql: { providerFinanceEvents: events, subscriptionPeriods: periods, ledgerLines: ledger,
        legacyPurchaseRecord: legacy, runtimeState: runtime, resourceFinanceStates: financeState,
        quiescenceLease: lease, auditActions: audits,
        legacyRecordsNotExcludedByLedger: Number(orphan.rows[0]!.count) },
      operatingBill: { month: bill.month, summary: bill.summary, gaps: bill.gaps,
        providers: bill.providers.map((row) => ({ resourceId: row.providerResourceId, mode: row.mode,
          apiCost: row.apiCost, packageCost: row.packageCost, totalCost: row.totalCost,
          rechargeAmount: row.rechargeAmount, openingBalance: row.openingBalance,
          endingBalance: row.endingBalance, apiSpendStatus: row.apiSpendStatus,
          servicePeriodStart: row.servicePeriodStart, servicePeriodEnd: row.servicePeriodEnd })),
        subjects: bill.subjects },
    })}`);
    expect(receipt.conservationPassed).toBe(true);
  }, 120_000);

  /**
   * §10 D-1 修复回归（原为两个 `it.fails` 缺陷钉；修复后转为**正向门禁**）。
   *
   * ## 原缺陷（WP07 首次验收发现，已 NO-GO 上报）
   *
   * `MIGRATED` 关闭的旧购买记录，其金额事实以 `provider_finance_event`（`CODING_PLAN_PURCHASE`，
   * 金额 199.00）落库；但**同一笔付款仍被旧账本 `resource_purchase_record` 重复计入**，
   * 使月度摘要与经营账单的套餐金额、`operatingCost/totalCost`、`cashOutflowCny` 全部 +199.00
   * （实测 398.00 / 399.25 / 448.00，应为 199.00 / 200.25 / 249.00）。
   *
   * ## 根因与修复（写入侧最小修复：未改四处聚合读模型、未新增迁移）
   *
   * 排除旧记录的唯一机制是 `provider_finance_event.external_reference =
   * 'legacy-purchase:' || resource_purchase_record.id`（见 `registeredSubscriptionHistory`、
   * `operating-analysis-purchases`、`provider-finance-activation-facts`、
   * `provider-finance-cutover-repository` 四处读侧）。
   * 原 `writePurchases` / `writeRecharges` 却把 `external_reference` 写成草稿的业务订单引用，
   * 标记永不出现 ⇒ 排除永不命中。修复：两条写入路径统一改用纯 helper
   * `legacySourceMarker(sourceRecordId, businessExternalReference)`——有源记录即写
   * `legacy-purchase:<sourceRecordId>`，无源记录保留原业务引用。
   *
   * ## 本节断言（正向，不再使用 expected-failure）
   *
   * 金额各只计一次；排除标记可被读侧命中（孤儿计数 0）；**业务订单引用不丢失**——
   * 仍保留在关闭审计 `change_summary.external_reference`。
   */
  describe("10. D-1 修复回归：MIGRATED 旧记录只计一次，标记与业务引用各归其位", () => {
    it("10.1 金额：月度摘要与经营账单的套餐金额各只计一次（不再翻倍）", async () => {
      const summary = await app.inject({ method: "GET",
        url: `/provider-finance/summary?month=${anchor.month}`, headers: { cookie: synthetic.cookie } });
      const bill = await app.operatingBillRepo.getBill(synthetic.enterpriseId, anchor.month);
      const planRow = bill.providers
        .find((provider) => provider.providerResourceId === synthetic.planResourceId)!;
      const resources = await app.inject({ method: "GET",
        url: `/provider-finance/resources?month=${anchor.month}`, headers: { cookie: synthetic.cookie } });
      const planResource = resources.json().resources
        .find((row: { resourceId: string }) => row.resourceId === synthetic.planResourceId);
      // 观测量留档：修复后应与期望值逐项一致。
      emitEvidence(`[D-1-FIXED] 金额口径：${JSON.stringify({
        summary: { codingPlanOrders: summary.json().codingPlanOrders,
          codingPlanFixedCostCny: summary.json().codingPlanFixedCostCny,
          operatingCostCny: summary.json().operatingCostCny,
          cashOutflowCny: summary.json().cashOutflowCny },
        billSummary: { packageCost: bill.summary.packageCost, totalCost: bill.summary.totalCost,
          packageCosts: bill.summary.packageCosts, totalSpends: bill.summary.totalSpends },
        planProviderRow: { packageCost: planRow.packageCost, totalCost: planRow.totalCost },
        monthlyPlanCashCny: planResource?.monthlyPlanCashCny })}`);
      expect(summary.json()).toMatchObject({
        codingPlanOrders: [{ currency: "CNY", amount: "199.00000000" }],
        codingPlanFixedCostCny: "199.00000000",
        operatingCostCny: "200.25000000",
        cashOutflowCny: "249.00000000",
      });
      expect(bill.summary).toMatchObject({
        packageCost: "199.00000000", totalCost: "200.25000000",
        packageCosts: [{ currency: "CNY", amount: "199.00000000" }],
        totalSpends: [{ currency: "CNY", amount: "200.25000000" }],
      });
      expect(planRow).toMatchObject({ packageCost: "199.00000000", totalCost: "199.00000000" });
      expect(planResource).toMatchObject({ monthlyPlanCashCny: "199.00000000" });
    }, 120_000);

    it("10.2 标记：排除链接命中、孤儿计数为 0，且关闭审计仍保存业务订单引用", async () => {
      // 旧账本的实质：旧记录是否仍被旧账本认领（未被任何 finance event 以约定标记认领）。
      const orphaned = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count FROM resource_purchase_record purchase
         WHERE purchase.enterprise_id=${synthetic.enterpriseId}::uuid
           AND purchase.id=${synthetic.legacyRecordId}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM provider_finance_event event
              WHERE event.enterprise_id=purchase.enterprise_id
                AND event.provider_resource_id=purchase.provider_resource_id
                AND event.external_reference=('legacy-purchase:'||purchase.id::text))`
        .execute(db);
      const event = await db.selectFrom("provider_finance_event")
        .select(["external_reference", "account_amount"])
        .where("enterprise_id", "=", synthetic.enterpriseId)
        .where("event_type", "=", "CODING_PLAN_PURCHASE").executeTakeFirstOrThrow();
      // 业务订单引用不得丢失：它保留在关闭审计的不可变映射里。
      const closure = await db.selectFrom("operation_log").select("change_summary")
        .where("enterprise_id", "=", synthetic.enterpriseId)
        .where("action", "=", "provider_finance.legacy_purchase.close").executeTakeFirstOrThrow();
      const closureSummary = closure.change_summary as Record<string, unknown>;
      emitEvidence(`[D-1-FIXED] 标记与引用：${JSON.stringify({
        orphanedLegacyRecords: Number(orphaned.rows[0]!.count),
        financeEventExternalReference: event.external_reference,
        expectedMarker: `legacy-purchase:${synthetic.legacyRecordId}`,
        closureExternalReference: closureSummary.external_reference })}`);
      expect(Number(orphaned.rows[0]!.count)).toBe(0);
      expect(event).toMatchObject({ account_amount: "199.00000000",
        external_reference: `legacy-purchase:${synthetic.legacyRecordId}` });
      expect(closureSummary).toMatchObject({ resolution: "MIGRATED",
        external_reference: "SYNTH-ZHIPU-ORD-1" });
    }, 120_000);
  });
});
