/**
 * AT-X05 升级与历史不变（acceptance-plan §6 X05 / WP5 task 6.2；做法按 inv-wp5 §3-T3 X05）。
 *
 * 通过标准（acceptance-plan §6 AT-X05）：
 *   「原始用量/规则/资金事件与 V1 快照内容不变；迁移仅在预先列明的合同/新增数据范围变更」。
 *
 * 步骤（本文件）：
 *   a) 全新 PG 容器迁移至水位 0091_recorded_cost_accounting_policy（水位迁移先例：
 *      wp3-operating-sync-decouple.integration.test.ts、migration-pre-monthly-fixture.ts）；
 *   b) 在 0091 水位插入 F08/F09 旧数据（相关表 0026/0033/0053/0059/0086/0091 均已存在）：
 *      - operating_bill_period/version：已关账冻结快照 V1（期初 100＋充值 50−期末 120
 *        ＝旧费用 30 的旧口径语义，apiCost=桥接值）；
 *      - provider_finance_event：API 期初（MIGRATION，切换时点）/API 充值各一条＋
 *        F09 CP 购买一条；
 *      - billing_rule 规则（快照）＋原始 ledger 消费行（含计价 10.15 历史请求与
 *        billing_rule_snapshot 冻结快照）；
 *      - provider_finance_usage_cost_disposition：历史处置投影行（0086，冻结
 *        original_ledger_fact=to_jsonb(line)）；
 *      - provider_subscription_period：F09 CP 周期一条（0059）。
 *   c) 对受保护行集生成摘要（有序行 → 规范化 JSON → sha256，文件内自写 helper）；
 *   d) migrateToLatest()（跨 0092-0096）→ 重读同一行集：F08/F09 事实行摘要逐字节不变；
 *   e) 退役写入口在升级后库上仍拒绝（DB 层可断言部分，等价 410/409：0083 触发器拒绝
 *      未激活企业的 ADMIN API 期初直插、拒绝无同币种期初的 API 充值、拒绝非切换时点的
 *      MIGRATION 期初——activ-migration 先例 provider-finance-activation-migration
 *      .integration.test.ts 的触发器正反控制写法）；
 *   f) 「新库」对照：另起一个全新库 migrateToLatest 后同组查询可执行（证明新库路径
 *      可用，不断言旧数据）。
 *
 * 允许差异白名单（0092-0096 逐条列明，依据各迁移 up/down 与 acceptance-plan §6
 * 「预先列明的合同/新增数据范围」）：
 *   - 0092_employee_monthly_quota：新增员工额度域对象——enterprise.employee_quota_monthly_from、
 *     principal_grant.quota_basis 两列＋principal_quota_period/principal_quota_usage 两新表＋
 *     principal_grant/upstream_attempt 两唯一索引。均为新增对象，不 UPDATE 任何既有行；
 *     受保护行集不含 enterprise/principal_grant 行 → 无白名单列。
 *   - 0093_billing_rule_source_status：billing_rule ADD COLUMN source_status varchar(16)
 *     NOT NULL DEFAULT 'UNVERIFIED'——这是唯一会“填充既有行新列”的迁移，属 WP1 合同 §2
 *     /ACE-02 场景 3 预先列明的合同变更（存量规则不得宣称为已核实官方价）。因此
 *     F08_billing_rule 摘要按显式列白名单对比（BILLING_RULE_DIGEST_COLUMNS 排除
 *     source_status）；其余全部受保护表仍 SELECT * 全列对比（若未来迁移向这些表加列，
 *     摘要列集变化会使本用例失败，从而强制把新列列入 consciously 审核的白名单）。
 *   - 0094_retire_api_finance_pending_admission：仅 DROP 0081 种入触发器/函数，
 *     provider_resource_finance_state 表与行原样保留 → 无白名单项。
 *   - 0095_official_balance_sync_decouple：仅 DROP provider_resource_operating_sync_attempt
 *     的 daily_uq 唯一索引 → 无行变更、无白名单项。
 *   - 0096_official_balance_refresh_request：新建 provider_resource_balance_refresh 表
 *     → 无既有行变更、无白名单项。
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, migrateToLatest } from "../index.js";
import { createMigrator } from "../migrator.js";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;

beforeAll(async () => {
  pg = await startPostgresContainer("wp5_upgrade");
  db = createKysely(pg.connectionString);
  // 步骤 a)：停在 0091 水位（F08/F09 旧数据必须在升级前落库）。
  expect((await createMigrator(db)
    .migrateTo("0091_recorded_cost_accounting_policy")).error).toBeUndefined();
}, 180_000);
afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

/**
 * billing_rule 摘要列白名单（0091 水位即存在的全部列，排除 0093 新列 source_status）。
 * 依据：0093 up 为 `ADD COLUMN source_status varchar(16) NOT NULL DEFAULT 'UNVERIFIED'`
 * （WP1 合同 §2 / acceptance-plan §6「预先列明的合同变更」）；其余 0092/0094/0095/0096
 * 不触碰 billing_rule。
 */
const BILLING_RULE_DIGEST_COLUMNS = [
  "id", "enterprise_id", "provider_resource_id", "upstream_model", "rule_type", "rule_version",
  "effective_from", "effective_to", "timezone", "days_of_week", "start_time", "end_time",
  "time_windows", "multiplier", "cache_hit_price", "cache_miss_price", "output_price",
  "currency", "priority", "enabled", "source", "pricing_mode", "version",
  "archived_at", "archived_by_admin_id", "created_at", "updated_at",
];

/** 受保护行集（F08/F09 事实行；SELECT * 全列，billing_rule 按白名单列）。 */
const PROTECTED_SETS = [
  { name: "F08_bill_period", table: "operating_bill_period", orderBy: "id" },
  { name: "F08_bill_version", table: "operating_bill_version", orderBy: "period_id, version" },
  { name: "F08_F09_finance_events", table: "provider_finance_event", orderBy: "id" },
  { name: "F09_subscription_period", table: "provider_subscription_period", orderBy: "id" },
  { name: "raw_requests", table: "ai_request", orderBy: "id" },
  { name: "raw_attempts", table: "upstream_attempt", orderBy: "id" },
  { name: "raw_usage_events", table: "usage_event", orderBy: "id" },
  { name: "raw_ledger_lines", table: "ledger_line", orderBy: "id" },
  { name: "F08_cost_disposition", table: "provider_finance_usage_cost_disposition", orderBy: "ledger_line_id" },
  { name: "F08_billing_rule", table: "billing_rule", orderBy: "id", columns: BILLING_RULE_DIGEST_COLUMNS },
] as const;

/**
 * 规范化 JSON：递归排序对象键、Date → ISO 字符串、bigint → 十进制字符串，
 * 使摘要只依赖行内容本身（与驱动返回的键序/时间对象表示无关）。
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 单个受保护行集摘要：有序行 → row_to_json → 规范化 JSON → sha256。 */
async function rowsDigest(
  database: ReturnType<typeof createKysely>,
  enterpriseId: string,
  spec: { table: string; orderBy: string; columns?: readonly string[] },
): Promise<string> {
  const columnList = spec.columns ? spec.columns.join(", ") : "*";
  const result = await sql<{ row: Record<string, unknown> }>`
    SELECT row_to_json(t) AS row FROM (
      SELECT ${sql.raw(columnList)} FROM ${sql.raw(spec.table)}
       WHERE enterprise_id = ${enterpriseId}::uuid
      ORDER BY ${sql.raw(spec.orderBy)}
    ) t`.execute(database);
  return createHash("sha256")
    .update(canonicalJson(result.rows.map((row) => row.row)))
    .digest("hex");
}

/** 全部受保护行集摘要（迁移前后同组查询，逐名对比）。 */
async function protectedDigests(
  database: ReturnType<typeof createKysely>,
  enterpriseId: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(PROTECTED_SETS.map(async (spec) =>
    [spec.name, await rowsDigest(database, enterpriseId, spec)] as const)));
}

/** 空行集的摘要常量（新库对照：同组查询可执行且为空集）。 */
const EMPTY_SET_DIGEST = createHash("sha256").update(canonicalJson([])).digest("hex");

/** F08/F09 旧数据落库（0091 水位 schema；全部直插均满足当期触发器/约束）。 */
async function seedLegacyFacts(): Promise<{ enterpriseId: string; apiResourceId: string }> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  const created = new Date("2026-08-01T00:00:00+08:00");
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP5 X05 旧数据企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: adminId,
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "旧数据员工",
    person_id: null, owner_person_id: null, department_label: null, created_at: created,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "wp5x05", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow();
  const apiResource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "旧 API 资源", mode: "API",
    credential_type: "API_KEY", created_at: created,
  }).returning("id").executeTakeFirstOrThrow();
  const planResource = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: provider.id, name: "旧 CP 资源",
    mode: "CODING_PLAN", credential_type: "API_KEY", created_at: created,
  }).returning("id").executeTakeFirstOrThrow();

  // ── 规则快照（0011/0018/0021/0050/0064 列集；无 0093 source_status——尚未迁移）──
  const rule = await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, rule_type: "API_PRICE", rule_version: "legacy-v1",
    effective_from: new Date("2026-09-01T00:00:00+08:00"),
    cache_hit_price: "0.0000005", cache_miss_price: "0.000001", output_price: "0.000002",
    currency: "CNY", priority: 10, source: "legacy official pricing page",
    pricing_mode: "ABSOLUTE",
  }).returning("id").executeTakeFirstOrThrow();

  // ── 原始 ledger 消费行（历史可信请求估算 10.15 语义）＋冻结节点的规则快照 ──
  const seedConsumption = async (input: { cost: string | null; requestId: string }) => {
    const at = new Date("2026-09-05T10:00:00+08:00");
    const attempt = await db.insertInto("upstream_attempt").values({
      enterprise_id: enterpriseId, ai_request_id: input.requestId, attempt_no: 1,
      provider_resource_id: apiResource.id, upstream_model: "legacy-model",
      http_status: 200, response_committed: true, finished_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      enterprise_id: enterpriseId, ai_request_id: input.requestId, upstream_attempt_id: attempt.id,
      provider_resource_id: apiResource.id, input_tokens: 1000n, output_tokens: 100n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: input.requestId, created_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    return db.insertInto("ledger_line").values({
      enterprise_id: enterpriseId, ai_request_id: input.requestId, upstream_attempt_id: attempt.id,
      usage_event_id: usage.id, provider_resource_id: apiResource.id, principal_id: principalId,
      resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 100n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: input.cost,
      api_cost_currency: input.cost === null ? null : "CNY",
      api_cost_status: input.cost === null ? "UNKNOWN_COST" : "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", settled_at: at, created_at: at,
      billing_rule_id: input.cost === null ? null : rule.id,
      rule_version: input.cost === null ? null : "legacy-v1",
      billing_rule_snapshot: input.cost === null ? null : {
        ruleVersion: "legacy-v1", currency: "CNY",
        cacheHitPrice: "0.0000005", cacheMissPrice: "0.000001", outputPrice: "0.000002",
      },
    }).returning("id").executeTakeFirstOrThrow();
  };
  const pricedRequestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: pricedRequestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "legacy-model",
    status: "SUCCEEDED", started_at: new Date("2026-09-05T10:00:00+08:00"),
    finished_at: new Date("2026-09-05T10:00:01+08:00"),
  }).execute();
  await seedConsumption({ cost: "10.15000000", requestId: pricedRequestId });
  const unknownRequestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: unknownRequestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "legacy-model",
    status: "SUCCEEDED", started_at: new Date("2026-09-06T10:00:00+08:00"),
    finished_at: new Date("2026-09-06T10:00:01+08:00"),
  }).execute();
  const unknownLine = await seedConsumption({ cost: null, requestId: unknownRequestId });

  // ── 历史处置投影行（0086；original_ledger_fact 冻结 to_jsonb(line)）──
  const fact = await sql<{ fact: Record<string, unknown> }>`
    SELECT to_jsonb(line) AS fact FROM ledger_line line
    WHERE line.enterprise_id=${enterpriseId}::uuid AND line.id=${unknownLine.id}::uuid`.execute(db);
  await db.insertInto("provider_finance_usage_cost_disposition").values({
    enterprise_id: enterpriseId, provider_resource_id: apiResource.id,
    ledger_line_id: unknownLine.id, ai_request_id: unknownRequestId,
    decision: "EXCLUDE_NO_SERVER_COST",
    original_ledger_fact: fact.rows[0]!.fact,
    server_cost_evidence: { request: unknownRequestId, policy: "server-recorded-cost-only", recordedCost: null },
    reason: "Legacy exclusion imported before the upgrade (historical disposition projection)",
    evidence_ref: `wp5-x05-legacy:${unknownLine.id}`,
    decided_by_admin_user_id: adminId,
    idempotency_key: randomUUID(),
    request_hash: createHash("sha256").update(unknownLine.id).digest("hex"),
  }).execute();

  // ── F08 资金事实：API 期初（MIGRATION，切换时点）＋ API 充值（均满足 0083 触发器）──
  const cutover = new Date("2026-08-31T16:00:00Z");
  await db.insertInto("provider_finance_event").values([
    { enterprise_id: enterpriseId, provider_resource_id: apiResource.id,
      event_type: "API_OPENING_BALANCE", account_amount: "100", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: cutover, source: "MIGRATION",
      description: "legacy opening balance 100", evidence_ref: "wp5-x05:opening",
      idempotency_key: randomUUID(), created_by_admin_user_id: null },
    { enterprise_id: enterpriseId, provider_resource_id: apiResource.id,
      event_type: "API_RECHARGE", account_amount: "50", account_currency: "CNY",
      cash_paid_cny: "50", occurred_at: new Date("2026-09-02T00:00:00+08:00"),
      source: "MIGRATION", description: "legacy recharge 50", evidence_ref: "wp5-x05:recharge",
      idempotency_key: randomUUID(), created_by_admin_user_id: null },
  ]).execute();

  // ── F09：CP 购买事件＋订阅周期一条（0059 形状/时点约束：上海零点对齐）。
  //    0059 的 provider_subscription_period_closure 为 DEFERRABLE INITIALLY DEFERRED
  //    约束触发器——事件与周期必须同一事务提交（事务提交时事件才“拥有”周期）。──
  await db.transaction().execute(async (trx) => {
    const planEvent = await trx.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: planResource.id,
      event_type: "CODING_PLAN_PURCHASE", account_amount: "100", account_currency: "CNY",
      cash_paid_cny: "100", occurred_at: new Date("2026-09-01T00:00:00+08:00"),
      source: "ADMIN", description: "legacy coding plan purchase",
      evidence_ref: "wp5-x05:cp-purchase", idempotency_key: randomUUID(),
      created_by_admin_user_id: adminId,
    }).returning("id").executeTakeFirstOrThrow();
    await trx.insertInto("provider_subscription_period").values({
      enterprise_id: enterpriseId, provider_resource_id: planResource.id,
      finance_event_id: planEvent.id, product_name: "Coding Plan（旧周期）",
      period_start: new Date("2026-09-01T00:00:00+08:00"),
      period_end_exclusive: new Date("2026-10-01T00:00:00+08:00"),
      source: "PURCHASE", created_by_admin_user_id: adminId,
    }).execute();
    return planEvent.id;
  });

  // ── F08 已关账冻结快照 V1（0033）：期初 100＋充值 50−期末 120＝旧费用 30 的旧口径
  //    （V1 时代 apiCost 即桥接值；快照 JSONB 一经落库不可改写）──
  const period = await db.insertInto("operating_bill_period").values({
    enterprise_id: enterpriseId, period_month: "2026-09-01", status: "CLOSED",
    current_version: 1, created_by: adminId,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("operating_bill_version").values({
    enterprise_id: enterpriseId, period_id: period.id, version: 1,
    snapshot: {
      month: "2026-09", timezone: "Asia/Shanghai", status: "CLOSED", version: 1,
      summary: {
        totalCost: "30.00000000", apiCost: "30.00000000", ledgerApiCost: "10.15000000",
        openingBalance: "100.00000000", monthlyRecharge: "50.00000000",
        endingBalance: "120.00000000", apiSpendStatus: "CALCULABLE", apiSpendReason: null,
        apiSpends: [{ currency: "CNY", amount: "30.00000000" }],
      },
      providers: [],
      sourceFacts: {
        ledgerLineCount: 2,
        balanceBridgeFacts: [{
          providerResourceId: apiResource.id, currency: "CNY",
          openingBalance: "100.00000000", rechargeAmount: "50.00000000",
          endingBalance: "120.00000000", apiSpend: "30.00000000", apiSpendStatus: "CALCULABLE",
        }],
      },
    },
    close_note: "WP5 X05 旧口径关账（升级前水位 0091）",
    closed_by: adminId,
  }).execute();

  return { enterpriseId, apiResourceId: apiResource.id };
}

describe.sequential("AT-X05 升级与历史不变（acceptance-plan §6 X05 / task 6.2）", () => {
  it("AT-X05/task 6.2a：0091 水位 F08/F09 旧数据跨 0092-0096 升级，受保护行摘要逐字节不变", async () => {
    const { enterpriseId } = await seedLegacyFacts();

    // 步骤 c)：升级前基线摘要。
    const before = await protectedDigests(db, enterpriseId);
    expect(Object.values(before)).not.toContain(EMPTY_SET_DIGEST); // 夹具自证：每个行集非空

    // 步骤 d)：migrateToLatest 跨 0092-0096（白名单见文件头注释）。
    const executed = await migrateToLatest(db);
    for (const name of [
      "0092_employee_monthly_quota",
      "0093_billing_rule_source_status",
      "0094_retire_api_finance_pending_admission",
      "0095_official_balance_sync_decouple",
      "0096_official_balance_refresh_request",
    ]) {
      expect(executed, `missing migration ${name}`).toContain(name);
    }

    // 通过标准：原始用量/规则/资金事件与 V1 快照内容不变——除白名单（billing_rule 的
    // 0093 新列）外，逐个行集摘要逐字节相等。
    const after = await protectedDigests(db, enterpriseId);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
    // 白名单正向证据：0093 落库后 billing_rule 存量行 source_status 填充为默认 UNVERIFIED
    //（合同变更本身发生，但不触碰白名单内任何列）。
    const sourceStatus = await sql<{ source_status: string }>`
      SELECT source_status FROM billing_rule WHERE enterprise_id=${enterpriseId}::uuid`.execute(db);
    expect(sourceStatus.rows.map((row) => row.source_status)).toEqual(["UNVERIFIED"]);
  }, 180_000);

  it("AT-X05/task 6.2b：升级后库退役写入口仍拒绝（0083 触发器＝DB 层 410/409 等价物）", async () => {
    const { enterpriseId, apiResourceId } = await protectedEnterprise();
    // 1) ADMIN 资源级 API 期初直插：企业未激活（strict_writes 关）→ 0083 触发器拒绝
    //    （退役后不恢复任何期初写入口；HTTP 层 410 的 DB 层等价断言）。
    await expect(db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "10", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: new Date("2026-09-05T00:00:00+08:00"),
      source: "ADMIN", idempotency_key: randomUUID(),
    }).execute()).rejects.toThrow(/resource-level opening balance requires an activated enterprise/);
    // 2) ADMIN API 充值（无同币种期初可挂）：0059/0083 合同仍拒绝。
    await expect(db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_RECHARGE", account_amount: "5", account_currency: "USD",
      cash_paid_cny: "5", occurred_at: new Date("2026-09-05T00:00:00+08:00"),
      source: "ADMIN", idempotency_key: randomUUID(),
    }).execute()).rejects.toThrow(/API recharge requires an opening balance in the same currency/);
    // 3) MIGRATION 期初但非切换时点：0083 时点合同在升级后库上仍生效（迁移未弱化触发器）。
    await expect(db.insertInto("provider_finance_event").values({
      enterprise_id: enterpriseId, provider_resource_id: apiResourceId,
      event_type: "API_OPENING_BALANCE", account_amount: "1", account_currency: "CNY",
      cash_paid_cny: null, occurred_at: new Date("2026-09-06T00:00:00+08:00"),
      source: "MIGRATION", idempotency_key: randomUUID(),
    }).execute()).rejects.toThrow(/migration opening balance facts must use the cutover instant/);
    // 零写入证据：三次拒绝后资金事件仍只有 F08/F09 夹具的 3 条。
    const eventCount = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM provider_finance_event
      WHERE enterprise_id=${enterpriseId}::uuid`.execute(db);
    expect(eventCount.rows[0]!.count).toBe("3");
  }, 120_000);

  it("AT-X05/task 6.2c：全新库 migrateToLatest 后同组查询可执行（新库路径可用，不断言旧数据）", async () => {
    const freshPg = await startPostgresContainer("wp5_fresh");
    const freshDb = createKysely(freshPg.connectionString);
    try {
      expect((await createMigrator(freshDb).migrateToLatest()).error).toBeUndefined();
      const head = await sql<{ name: string }>`
        SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1`.execute(freshDb);
      expect(head.rows[0]!.name).toBe("0096_official_balance_refresh_request");
      // 同组受保护行集查询在新库上全部可执行（空库 → 全部为空集摘要）。
      const digests = await protectedDigests(freshDb, randomUUID());
      expect(Object.values(digests)).toEqual(PROTECTED_SETS.map(() => EMPTY_SET_DIGEST));
    } finally {
      await freshDb.destroy();
      // teardown 加固（仅测试文件内，不涉断言）：pool.end() 的 socket 关闭是异步的，
      // 高并发并集下紧随的 container.stop() 可能在 FIN 完成前终止 Postgres，
      // 使半开连接收到 57P01 并以 unhandled error 冒泡（并集实测 2 例；
      // operating-bill-resource-scope 等标准模式文件同轮亦出现同类，见回执）。
      await new Promise((resolve) => setTimeout(resolve, 200));
      await freshPg.stop();
    }
  }, 240_000);
});

/** 6.2b 复用 6.2a 已种子化并升级的企业（describe.sequential 保证先后）。 */
async function protectedEnterprise(): Promise<{ enterpriseId: string; apiResourceId: string }> {
  const row = await sql<{ enterprise_id: string }>`
    SELECT enterprise_id FROM operating_bill_period
    WHERE period_month = '2026-09-01' AND status = 'CLOSED' LIMIT 1`.execute(db);
  const enterpriseId = row.rows[0]!.enterprise_id;
  const resource = await sql<{ id: string }>`
    SELECT id FROM provider_resource
    WHERE enterprise_id=${enterpriseId}::uuid AND mode = 'API' LIMIT 1`.execute(db);
  return { enterpriseId, apiResourceId: resource.rows[0]!.id };
}
