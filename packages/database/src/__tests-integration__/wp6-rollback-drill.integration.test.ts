/**
 * AT-X07 回退半段演练（acceptance-plan §6 X07 / WP6 task 6.3；范围登记见 WP6 plan.md §3）。
 *
 * 通过标准（acceptance-plan §6 X07）：
 *   「在切换候选版本创建无期初 API 并模拟消费，再按发布候选的回退方案演练——
 *    新消费仍可读/结算且受原额度约束，不要求补虚构期初、不丢数据；
 *    不能仅恢复不兼容旧服务」。
 *
 * 本文件＝回退方案的 down 迁移链演练路线（整库备份恢复为主路线，见 WP6 plan.md
 * 总指挥裁定 1）；旧代码（ae506fe）读回退库行为由证据脚本另行实证
 * （V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/）。
 *
 * 断言集（合同固定，逐条对应）：
 *   1. 候选行为重现：migrateToLatest（0096 水位）→ 无期初 API 资源＋模拟消费结算
 *      → 金额可读（复现 WP5 已 PASS 半段：无 finance 事实下估算非空，estimation :160 同源）。
 *   2. 回退前快照：结算事实（ai_request/upstream_attempt/usage_event/ledger_line/
 *      ledger_transaction）＋员工月度额度行（principal_quota_period/principal_quota_usage）
 *      ＋存量 finance_state 行集的确定性摘要（sha256，手法同 wp5-upgrade-immutability）。
 *   3. down 链演练：rollbackTo 0092（rollbackTo 语义：执行 0096→0095→0094→0093→0092
 *      五段 down，链末必为目标迁移本身）→ a. 0092 down 为数据保留空操作（0092:38），
 *      水位暂落 0091，按回退操作单幂等重放 0092（up 全 IF NOT EXISTS，无数据变更）
 *      后水位＝0092；b. 结算事实行逐字保留；c. 员工额度约束行保留（limit_value 不变
 *      ＋约束仍生效）；d. 零新增 finance 期初/充值行（不补虚构期初、不补造资金）；
 *      e. 结算幂等约束仍在（重复 dedup/重复 (request, attempt_no) 拒绝复验）。
 *   4. 0095 守卫两态：a. 多行态 down 抛「回滚被拒绝」，daily_uq 保持不存在、
 *      多行数据原样（0096 down 已执行，被拒的 0095 应用标记保留）；b. 单行态 down
 *      成功、daily_uq 重建且唯一性恢复（本演练链语境重新断言，手法同
 *      wp3-operating-sync-decouple）。
 *   5. 0094 down 边界：down 后种入触发器恢复——a. 已存在资源不被追溯种入；
 *      b. 新建资源被种入 PENDING（＝回退方案「回退后新建资源将重新获得 PENDING 标记」实证）。
 *   6. 回退后重升：migrateToLatest 恢复 0096 → 金额仍可读；种入/准入行为随 up 逆转
 *      （AFR-02）；断言 5 预期种入的 PENDING 行之外受保护行集摘要不变。
 *
 * 白名单差异：无（0093 加列仅影响 billing_rule，不在受保护行集；0092 down 为
 * 数据保留空操作；0094/0095/0096 down 分别为恢复触发器/重建索引/删瞬态表，
 * 均不触碰受保护行——见各迁移文件头与 WP5 X05 白名单注释）。
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, loadApiCostEstimation, migrateToLatest } from "../index.js";
import { createMigrator } from "../migrator.js";
import { rollbackTo } from "./migration-rollback.js";

const HEAD_0096 = "0096_official_balance_refresh_request";
const HEAD_0095 = "0095_official_balance_sync_decouple";
const HEAD_0094 = "0094_retire_api_finance_pending_admission";
const HEAD_0093 = "0093_billing_rule_source_status";
const HEAD_0092 = "0092_employee_monthly_quota";
const DAILY_UQ_INDEX = "provider_resource_operating_sync_attempt_daily_uq";

/** 消费金额字面值（X01 金额链同源：估算恒 0.00104000）。 */
const SETTLED_CNY = "0.00104000";
/** 员工月度额度字面值（RAW_TOKEN；月度周期记账语义同 GW employee-monthly-quota）。 */
const QUOTA_LIMIT = 1_000_000n;
const QUOTA_USED = 1_200n;

/** 当前迁移水位（kysely_migration 已应用最大名）。 */
async function migrationHead(db: ReturnType<typeof createKysely>): Promise<string | null> {
  const result = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1
  `.execute(db);
  return result.rows[0]?.name ?? null;
}

async function dailyUqIndexExists(db: ReturnType<typeof createKysely>): Promise<boolean> {
  const result = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes WHERE indexname = ${DAILY_UQ_INDEX}
  `.execute(db);
  return result.rows.length > 0;
}

/** 结算幂等硬保证之一：ledger_transaction 每请求唯一（0009:71 约束）。 */
async function ledgerTransactionUniqueRequestExists(db: ReturnType<typeof createKysely>): Promise<boolean> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM pg_constraint WHERE conname = 'ledger_transaction_unique_request'
  `.execute(db);
  return result.rows[0]!.count === "1";
}

/** 规范化 JSON（键序无关/Date→ISO/bigint→字符串；同 wp5-upgrade-immutability 手法）。 */
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

const EMPTY_SET_DIGEST = createHash("sha256").update(canonicalJson([])).digest("hex");

/** 受保护行集（企业内全行、SELECT * 全列——本演练无列白名单，见文件头）。 */
const PROTECTED_SETS = [
  { name: "requests", table: "ai_request", orderBy: "id" },
  { name: "attempts", table: "upstream_attempt", orderBy: "id" },
  { name: "usage_events", table: "usage_event", orderBy: "id" },
  { name: "ledger_lines", table: "ledger_line", orderBy: "id" },
  { name: "ledger_transactions", table: "ledger_transaction", orderBy: "id" },
  { name: "quota_periods", table: "principal_quota_period", orderBy: "id" },
  { name: "quota_usages", table: "principal_quota_usage", orderBy: "id" },
  { name: "finance_states", table: "provider_resource_finance_state", orderBy: "provider_resource_id" },
] as const;

async function rowsDigest(
  database: ReturnType<typeof createKysely>,
  enterpriseId: string,
  spec: { table: string; orderBy: string },
): Promise<string> {
  const result = await sql<{ row: Record<string, unknown> }>`
    SELECT row_to_json(t) AS row FROM (
      SELECT * FROM ${sql.raw(spec.table)}
       WHERE enterprise_id = ${enterpriseId}::uuid
      ORDER BY ${sql.raw(spec.orderBy)}
    ) t`.execute(database);
  return createHash("sha256")
    .update(canonicalJson(result.rows.map((row) => row.row)))
    .digest("hex");
}

async function protectedDigests(
  database: ReturnType<typeof createKysely>,
  enterpriseId: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(PROTECTED_SETS.map(async (spec) =>
    [spec.name, await rowsDigest(database, enterpriseId, spec)] as const)));
}

/** 期初/充值类 finance 事件行数（0083 触发器管治的写入口；断言 3d）。 */
async function openingOrRechargeEventCount(db: ReturnType<typeof createKysely>, enterpriseId: string) {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM provider_finance_event
     WHERE enterprise_id = ${enterpriseId}::uuid
       AND event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE')
  `.execute(db);
  return result.rows[0]!.count;
}

interface DrillFixture {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  grantId: string;
  periodId: string;
  providerId: string;
  freshApiResourceId: string;
  legacyPendingResourceId: string;
  requestId: string;
  attemptId: string;
}

/**
 * 演练造数（0096 水位直插，手法同 wp2-pending-admission / wp5-upgrade-immutability）：
 * 已激活企业＋无期初 API 资源（无 finance_state 行）＋存量 PENDING 留档资源＋
 * 一笔已计价结算消费＋员工月度额度（period limit/used＋usage SETTLED）。
 */
async function seedDrill(db: ReturnType<typeof createKysely>): Promise<DrillFixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP6 X07 回退演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "wp6-x07-admin",
    display_name: "WP6 X07 管理员", password_hash: "test",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "X07 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_x07", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  // 已激活企业（strict_writes_enabled）：0096 水位新建 API 资源不再种入（0094 已退役）；
  // down 后触发器恢复（0094 down），新建资源重新种入 PENDING（断言 5b）。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();
  const providerId = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const freshApiResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "X07 无期初 API 资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const legacyPendingResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "X07 存量 PENDING 留档资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  // 存量 PENDING 留档行（0094 后种入退役，只能直插构造；D4 留档语义）。
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: enterpriseId, provider_resource_id: legacyPendingResourceId,
    required_currencies: JSON.stringify([]) as never,
  }).execute();

  // ── 模拟消费结算（数据层复现 gateway 结算产物；GW attempt-usage-settlement 同型）──
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "deepseek-chat",
    status: "SUCCEEDED", started_at: new Date("2026-11-04T08:00:00.000Z"),
    finished_at: new Date("2026-11-04T08:00:01.000Z"),
  }).execute();
  const attemptId = await db.insertInto("upstream_attempt").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: freshApiResourceId, upstream_model: "deepseek-chat",
    http_status: 200, response_committed: true, finished_at: new Date("2026-11-04T08:00:01.000Z"),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const usageId = await db.insertInto("usage_event").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
    provider_resource_id: freshApiResourceId, input_tokens: 1000n, output_tokens: 200n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: requestId, created_at: new Date("2026-11-04T08:00:01.000Z"),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
    usage_event_id: usageId, provider_resource_id: freshApiResourceId, principal_id: principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: SETTLED_CNY, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    // F3：生产已计价行自 9bf1560 起冻结快照（含 sourceStatus）；夹具补齐生产形态。
    billing_rule_snapshot: { sourceStatus: "VERIFIED" },
    usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T08:00:01.000Z"),
    created_at: new Date("2026-11-04T08:00:01.000Z"),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    enterprise_id: enterpriseId, ai_request_id: requestId, principal_id: principalId,
    total_input_tokens: 1000n, total_output_tokens: 200n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: SETTLED_CNY,
    api_cost_status: "PRICED_USAGE", overage: false, usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T08:00:01.000Z"),
  }).execute();

  // ── 员工月度额度（0092 域对象）：period（limit/used）＋usage（SETTLED）──
  const grantId = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    model_alias: "deepseek-chat", quota_value: QUOTA_LIMIT, quota_basis: "RAW_TOKEN",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const periodId = await db.insertInto("principal_quota_period").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
    period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
    quota_basis: "RAW_TOKEN", limit_value: QUOTA_LIMIT, allow_overage: true,
    used_value: QUOTA_USED, reserved_value: 0n, open_grant_version: 1,
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("principal_quota_usage").values({
    enterprise_id: enterpriseId, request_id: requestId, attempt_no: 1,
    upstream_attempt_id: attemptId, period_id: periodId, grant_id: grantId,
    grant_version: 1, quota_basis: "RAW_TOKEN", estimate: QUOTA_USED,
    actual: QUOTA_USED, status: "SETTLED", usage_quality: "PROVIDER_REPORTED",
    created_at: new Date("2026-11-04T08:00:01.000Z"),
    settled_at: new Date("2026-11-04T08:00:01.000Z"),
  }).execute();

  return {
    enterpriseId, principalId, keyId, grantId, periodId, providerId,
    freshApiResourceId, legacyPendingResourceId, requestId, attemptId,
  };
}

/** 演练主库（断言 1/2/3/5/6 同库串行）；0095 两态各用独立库（断言 4）。 */
describe.sequential("AT-X07 回退半段演练（WP6 task 6.3；down 链 0096→0092＋0095 守卫两态＋0094 边界）", () => {
  let pg: PostgresTestInstance;
  let db: ReturnType<typeof createKysely>;
  let fixture: DrillFixture;
  let beforeRollbackDigests: Record<string, string>;
  /** 断言 5 在回退后种入 PENDING 的新建资源（断言 6 复核其留档与不追溯范围）。 */
  let postRollbackResourceId: string;

  beforeAll(async () => {
    pg = await startPostgresContainer("wp6_x07_drill_main");
    db = createKysely(pg.connectionString);
    await migrateToLatest(db);
    fixture = await seedDrill(db);
  }, 240_000);
  afterAll(async () => { await db?.destroy(); await pg?.stop(); }, 60_000);

  it("断言 1：候选行为重现——0096 水位、无期初资源无 finance 行、结算金额可读（无 finance 事实估算非空）", async () => {
    expect(await migrationHead(db)).toBe(HEAD_0096);
    // 无期初 API 资源：已激活企业新建后无任何 finance_state 行（0094 种入已退役）。
    const financeRows = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .where("provider_resource_id", "=", fixture.freshApiResourceId).execute();
    expect(financeRows).toEqual([]);
    // 模拟消费已结算且金额可读（WP5 已 PASS 半段同源断言：估算只依赖 ledger，不依赖资金表）。
    const estimation = await loadApiCostEstimation(db, fixture.enterpriseId, {
      start: new Date("2026-11-04T00:00:00.000Z"), end: new Date("2026-11-05T00:00:00.000Z"),
      resourceIds: [fixture.freshApiResourceId],
    });
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: SETTLED_CNY }]);
    expect(estimation.gaps).toEqual([]);
    // 额度记账已落（受原额度约束的数据前提）：period used＝1 200/limit 1 000 000。
    const period = await db.selectFrom("principal_quota_period").selectAll()
      .where("id", "=", fixture.periodId).executeTakeFirstOrThrow();
    expect(period.limit_value).toBe(QUOTA_LIMIT.toString());
    expect(period.used_value).toBe(QUOTA_USED.toString());
  }, 120_000);

  it("断言 2：回退前快照——受保护行集摘要非空集、期初/充值计数为零", async () => {
    beforeRollbackDigests = await protectedDigests(db, fixture.enterpriseId);
    // 夹具自证：每个受保护行集非空（无空集摘要混入）。
    for (const [name, digest] of Object.entries(beforeRollbackDigests)) {
      expect(digest, `行集 ${name} 不应为空`).not.toBe(EMPTY_SET_DIGEST);
    }
    // 回退前无任何期初/充值行（零补造资金的前提基线）。
    expect(await openingOrRechargeEventCount(db, fixture.enterpriseId)).toBe("0");
  }, 120_000);

  it("断言 3：down 链到 0092——水位＝0092、数据逐字保留、约束与幂等仍在、零补期初", async () => {
    // 逐级回滚（rollbackTo 语义：链末必为目标迁移本身；0092 自身 down 为数据保留
    // 空操作，见 0092:38 注释——执行后水位暂落 0091）。
    const rolledBack = await rollbackTo(db, HEAD_0092);
    expect(rolledBack.at(-1)).toBe(HEAD_0092);
    expect(rolledBack).toContain(HEAD_0096);
    expect(rolledBack).toContain(HEAD_0095);
    expect(rolledBack).toContain(HEAD_0094);
    expect(rolledBack).toContain(HEAD_0093);
    expect(await migrationHead(db)).toBe("0091_recorded_cost_accounting_policy");

    // 按回退操作单幂等重放 0092（up 全 IF NOT EXISTS——对象均在、无数据变更），
    // 恢复回退目标水位＝0092（演练库状态与「迁移头 0092 的旧基线」对齐）。
    expect((await createMigrator(db).migrateTo(HEAD_0092)).error).toBeUndefined();
    // a. 水位＝0092。
    expect(await migrationHead(db)).toBe(HEAD_0092);

    // b. 结算事实行逐字保留（不丢数据；含 0092 重放前后）。
    const afterRollbackDigests = await protectedDigests(db, fixture.enterpriseId);
    expect(Object.keys(afterRollbackDigests).sort()).toEqual(Object.keys(beforeRollbackDigests).sort());
    expect(afterRollbackDigests).toEqual(beforeRollbackDigests);

    // c. 员工额度约束行保留：period 的 limit/used/唯一键原样（0092 down 为数据保留空操作）。
    const period = await db.selectFrom("principal_quota_period").selectAll()
      .where("id", "=", fixture.periodId).executeTakeFirstOrThrow();
    expect(period.limit_value).toBe(QUOTA_LIMIT.toString());
    expect(period.used_value).toBe(QUOTA_USED.toString());
    expect(period.quota_basis).toBe("RAW_TOKEN");
    const usage = await db.selectFrom("principal_quota_usage").selectAll()
      .where("upstream_attempt_id", "=", fixture.attemptId).executeTakeFirstOrThrow();
    expect(usage.status).toBe("SETTLED");
    expect(usage.actual).toBe(QUOTA_USED.toString());
    // 同键第二 period 行仍被拒（UNIQUE(enterprise,principal,provider,period_key) 约束仍在）。
    await expect(db.insertInto("principal_quota_period").values({
      enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId, provider: "deepseek",
      period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
      period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
      quota_basis: "RAW_TOKEN", limit_value: 1n, allow_overage: false,
      used_value: 0n, open_grant_version: 1,
    }).execute()).rejects.toThrow();

    // d. 零新增 finance 期初/充值行（不补虚构期初、不补造资金）。
    expect(await openingOrRechargeEventCount(db, fixture.enterpriseId)).toBe("0");
    expect(await db.selectFrom("provider_finance_event").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId).execute()).toEqual([]);

    // e. 结算幂等约束仍在（最小可行断言：重复 dedup 拒绝＋重复 (request, attempt_no) 拒绝
    //    ＋ledger_transaction 每请求唯一约束存在）。
    expect(await ledgerTransactionUniqueRequestExists(db)).toBe(true);
    await expect(db.insertInto("usage_event").values({
      enterprise_id: fixture.enterpriseId, ai_request_id: fixture.requestId,
      upstream_attempt_id: fixture.attemptId, provider_resource_id: fixture.freshApiResourceId,
      input_tokens: 1n, output_tokens: 1n, cache_tokens: 0n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: fixture.requestId,
      created_at: new Date(),
    }).execute()).rejects.toThrow();
    await expect(db.insertInto("principal_quota_usage").values({
      enterprise_id: fixture.enterpriseId, request_id: fixture.requestId, attempt_no: 1,
      upstream_attempt_id: fixture.attemptId, period_id: fixture.periodId,
      grant_id: fixture.grantId, grant_version: 1, quota_basis: "RAW_TOKEN",
      estimate: 1n, actual: 1n, status: "SETTLED", usage_quality: "PROVIDER_REPORTED",
      created_at: new Date(), settled_at: new Date(),
    }).execute()).rejects.toThrow();
  }, 240_000);

  it("断言 5：0094 down 边界——已存在资源不被追溯种入；新建资源重新获得 PENDING 标记", async () => {
    // a. 已存在资源不被追溯种入：无期初资源仍无 finance 行；存量 PENDING 行原样。
    const beforeRows = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .orderBy("provider_resource_id").execute();
    expect(beforeRows.map((r) => r.provider_resource_id)).toEqual([fixture.legacyPendingResourceId]);
    expect(beforeRows[0]!.state).toBe("PENDING");
    expect(await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", fixture.freshApiResourceId).execute()).toEqual([]);

    // b. 新建 API 资源（已激活企业）：0094 down 恢复的种入触发器生效 → PENDING 行出现。
    postRollbackResourceId = await db.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
      name: "X07 回退后新建资源", mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const seeded = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .where("provider_resource_id", "=", postRollbackResourceId).executeTakeFirstOrThrow();
    expect(seeded.state).toBe("PENDING");
    // 种入恰为一行：除存量留档行与新建资源外无其他行（不追溯、不批量）。
    const afterRows = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .orderBy("provider_resource_id").execute();
    expect(afterRows.map((r) => r.provider_resource_id).sort())
      .toEqual([fixture.legacyPendingResourceId, postRollbackResourceId].sort());
  }, 120_000);

  it("断言 6：回退后重升 migrateToLatest 恢复 0096——金额仍可读、种入随 up 再次退役、数据零丢失", async () => {
    const executed = await migrateToLatest(db);
    expect(executed).toContain(HEAD_0093);
    expect(executed).toContain(HEAD_0094);
    expect(executed).toContain(HEAD_0095);
    expect(executed).toContain(HEAD_0096);
    expect(await migrationHead(db)).toBe(HEAD_0096);

    // 金额仍可读（回退往返后 ledger 事实无损）。
    const estimation = await loadApiCostEstimation(db, fixture.enterpriseId, {
      start: new Date("2026-11-04T00:00:00.000Z"), end: new Date("2026-11-05T00:00:00.000Z"),
      resourceIds: [fixture.freshApiResourceId],
    });
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: SETTLED_CNY }]);

    // AFR-02 随 up 逆转：down 期间种入的 PENDING 行原样留档（D4 不清理），
    // 重升后新建资源不再种入。
    const statesAfter = await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .orderBy("provider_resource_id").execute();
    expect(statesAfter.map((r) => r.provider_resource_id).sort())
      .toEqual([fixture.legacyPendingResourceId, postRollbackResourceId].sort());
    expect(statesAfter.map((r) => r.state)).toEqual(["PENDING", "PENDING"]);
    const postReupResourceId = await db.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
      name: "X07 重升后新建资源", mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    expect(await db.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", postReupResourceId).execute()).toEqual([]);

    // 除断言 5 预期种入的 PENDING 行（finance_states）外，受保护行集重升后不变。
    const afterReupDigests = await protectedDigests(db, fixture.enterpriseId);
    for (const [name, digest] of Object.entries(beforeRollbackDigests)) {
      if (name === "finance_states") continue;
      expect(afterReupDigests[name], `行集 ${name} 重升后应不变`).toBe(digest);
    }
  }, 240_000);
});

describe.sequential("AT-X07 断言 4：0095 守卫两态（演练链语境；手法同 wp3-operating-sync-decouple）", () => {
  /** 种主体行＋直插 attempt 行（0096 水位 daily_uq 已放开，同日多行可共存）。 */
  async function seedResourceWithAttempts(
    db: ReturnType<typeof createKysely>,
    startedAtList: string[],
  ): Promise<{ enterpriseId: string; resourceId: string }> {
    const enterpriseId = randomUUID();
    const providerId = randomUUID();
    await db.insertInto("enterprise").values({ id: enterpriseId, name: "X07 0095 守卫企业" }).execute();
    await db.insertInto("provider").values({
      id: providerId, enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
      adapter_type: "OPENAI_COMPATIBLE",
    }).execute();
    const resourceId = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: providerId,
      name: "DeepSeek API", mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    for (const startedAt of startedAtList) {
      await sql`
        INSERT INTO provider_resource_operating_sync_attempt
          (enterprise_id, provider_resource_id, sync_day, balance_status, cost_status,
           started_at, completed_at, next_sync_at, adapter_version)
        VALUES (${enterpriseId}::uuid, ${resourceId}::uuid, '2026-11-04',
                'SUCCESS', 'NOT_SUPPORTED',
                ${startedAt}::timestamptz, ${startedAt}::timestamptz,
                ${startedAt}::timestamptz + interval '15 minutes', 'wp6-x07-drill')
      `.execute(db);
    }
    return { enterpriseId, resourceId };
  }

  it("断言 4a：多行态——同日两条 attempt 后 0095 down 抛「回滚被拒绝」，daily_uq 保持不存在、数据原样", async () => {
    const multiPg = await startPostgresContainer("wp6_x07_0095_multi");
    const multiDb = createKysely(multiPg.connectionString);
    try {
      await migrateToLatest(multiDb);
      expect(await migrationHead(multiDb)).toBe(HEAD_0096);
      // 0096 水位 daily_uq 已放开：同日两行可共存（P1 周期门禁产物）。
      const { enterpriseId } =
        await seedResourceWithAttempts(multiDb, ["2026-11-04T01:00:00Z", "2026-11-04T01:15:00Z"]);
      expect(await dailyUqIndexExists(multiDb)).toBe(false);
      // 演练链语境：对 0095 执行 down（0096 先行回滚）→ 守卫拒绝。
      await expect(rollbackTo(multiDb, HEAD_0095)).rejects.toThrow(/回滚被拒绝/);
      expect(await dailyUqIndexExists(multiDb)).toBe(false);
      // 0096 down 已执行；被守卫拒绝的 0095 down 未成，其应用标记保留（水位＝0095），
      // 失败的 down 不改 schema 也不丢数据（两行 attempt 原样）。
      expect(await migrationHead(multiDb)).toBe(HEAD_0095);
      const attemptCount = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM provider_resource_operating_sync_attempt
         WHERE enterprise_id = ${enterpriseId}::uuid`.execute(multiDb);
      expect(attemptCount.rows[0]!.count).toBe("2");
    } finally {
      await multiDb.destroy();
      // teardown 加固（仅测试文件内，不涉断言）：pool.end() socket 关闭异步完成前
      // container.stop() 可能截断 FIN（wp5-upgrade-immutability 同款注释，并集实测）。
      await new Promise((resolve) => setTimeout(resolve, 200));
      await multiPg.stop();
    }
  }, 240_000);

  it("断言 4b：单行态——单行库 down 到 0095 成功，daily_uq 重建且唯一性恢复", async () => {
    const singlePg = await startPostgresContainer("wp6_x07_0095_single");
    const singleDb = createKysely(singlePg.connectionString);
    try {
      await migrateToLatest(singleDb);
      expect(await migrationHead(singleDb)).toBe(HEAD_0096);
      const { enterpriseId, resourceId } =
        await seedResourceWithAttempts(singleDb, ["2026-11-04T01:00:00Z"]);
      const rolledBack = await rollbackTo(singleDb, HEAD_0095);
      expect(rolledBack.at(-1)).toBe(HEAD_0095);
      expect(rolledBack).toContain(HEAD_0096);
      expect(await dailyUqIndexExists(singleDb)).toBe(true);
      // 唯一性确实恢复：同日第二行再被拒。
      await expect(sql`
        INSERT INTO provider_resource_operating_sync_attempt
          (enterprise_id, provider_resource_id, sync_day, balance_status, cost_status,
           started_at, completed_at, next_sync_at, adapter_version)
        VALUES (${enterpriseId}::uuid, ${resourceId}::uuid, '2026-11-04',
                'SUCCESS', 'NOT_SUPPORTED',
                '2026-11-04T01:30:00Z'::timestamptz, '2026-11-04T01:30:00Z'::timestamptz,
                '2026-11-04T01:45:00Z'::timestamptz, 'wp6-x07-drill')
      `.execute(singleDb)).rejects.toThrow();
    } finally {
      await singleDb.destroy();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await singlePg.stop();
    }
  }, 240_000);
});
