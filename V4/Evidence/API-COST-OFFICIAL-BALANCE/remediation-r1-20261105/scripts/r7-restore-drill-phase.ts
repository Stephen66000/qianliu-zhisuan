/**
 * R7（F7）整库备份恢复实际演练 —— Node 辅助阶段脚本。
 *
 * 由 scripts/r7-restore-drill.sh 以 tsx 调用，子命令：
 *   prepare            migrateToLatest（候选代码，水位 0096）＋ seedDrill 同型造数
 *   digest             备份点/恢复点摘要：八组受保护行集 sha256＋迁移头（双口径）
 *                      ＋kysely_migration 全表规范化 JSON 摘要
 *   mutate             破坏性模拟：写入「备份后新增」数据（一个新 provider_resource
 *                      ＋一笔新 ai_request），返回其标识供恢复后核对消失
 *   verify             核对：迁移头=0096、八行集摘要与备份点逐字一致、备份后新增
 *                      数据不存在、kysely_migration 全表逐字一致（无 down 需要）
 *
 * 行集与摘要口径与 packages/database/src/__tests-integration__/
 * wp6-rollback-drill.integration.test.ts 的 PROTECTED_SETS/canonicalJson/rowsDigest
 * 同源（企业域全行 SELECT * 规范化 JSON → sha256）。
 *
 * 只写演练隔离容器（wp6-r7-restore:55436/wp6_r7_drill），不触碰任何真实库。
 *
 * 运行（本 worktree 根，DATABASE_URL 指向演练库）：
 *   DATABASE_URL=postgres://wp6_r7:...@127.0.0.1:55436/wp6_r7_drill \
 *   <worktree>/node_modules/.bin/tsx <本文件> <子命令> [参数]
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
// kysely 经 database 包内依赖的绝对路径引入（证据目录不在 workspace 包内，bare import 不可解析）。
import { sql } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";
import { createKysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";
import { migrateToLatest } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/migrator.ts";
import type { Kysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.d.ts";
import type { Database } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";

const HEAD_0096 = "0096_official_balance_refresh_request";

/** 消费金额字面值（X01 金额链同源：估算恒 0.00104000；同 wp6-rollback-drill seedDrill）。 */
const SETTLED_CNY = "0.00104000";
/** 员工月度额度字面值（RAW_TOKEN；同 wp6-rollback-drill seedDrill）。 */
const QUOTA_LIMIT = 1_000_000n;
const QUOTA_USED = 1_200n;

/** 当前迁移水位（rollback.sh 口径 timestamp desc ＋ 测试口径 name desc 双取）。 */
async function migrationHeads(db: Kysely<Database>) {
  const byTimestamp = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY timestamp DESC LIMIT 1`.execute(db);
  const byName = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1`.execute(db);
  return { byTimestamp: byTimestamp.rows[0]?.name ?? null, byName: byName.rows[0]?.name ?? null };
}

/** kysely_migration 全表规范化 JSON 摘要（恢复后逐字一致 ⇒ 迁移账本自洽、无需任何 down）。 */
async function migrationLogDigest(db: Kysely<Database>): Promise<string> {
  const result = await sql<{ row: Record<string, unknown> }>`
    SELECT row_to_json(t) AS row FROM (
      SELECT * FROM kysely_migration ORDER BY name
    ) t`.execute(db);
  return createHash("sha256").update(canonicalJson(result.rows.map((row) => row.row))).digest("hex");
}

/** 规范化 JSON（键序无关/Date→ISO/bigint→字符串；同 wp6-rollback-drill.integration.test.ts:83-95）。 */
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

/** 受保护行集（企业内全行、SELECT * 全列；同 wp6-rollback-drill.integration.test.ts:100-109）。 */
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
  database: Kysely<Database>,
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
  database: Kysely<Database>,
  enterpriseId: string,
): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(PROTECTED_SETS.map(async (spec) =>
    [spec.name, await rowsDigest(database, enterpriseId, spec)] as const)));
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
 * 演练造数（seedDrill 同型，手法同 wp6-rollback-drill.integration.test.ts:163-268）：
 * 已激活企业＋无期初 API 资源（无 finance_state 行）＋存量 PENDING 留档资源＋
 * 一笔已计价结算消费（0.00104000）＋员工月度额度（period limit/used＋usage SETTLED）。
 */
async function seedDrill(db: Kysely<Database>): Promise<DrillFixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "R7 备份恢复演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "r7-restore-admin",
    display_name: "R7 恢复演练管理员", password_hash: "test",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "R7 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_r7", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  // 已激活企业（strict_writes_enabled）：0096 水位新建 API 资源不再种入（0094 已退役）。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();
  const providerId = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const freshApiResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R7 无期初 API 资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const legacyPendingResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R7 存量 PENDING 留档资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  // 存量 PENDING 留档行（0094 后种入退役，只能直插构造；D4 留档语义）。
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: enterpriseId, provider_resource_id: legacyPendingResourceId,
    required_currencies: JSON.stringify([]) as never,
  }).execute();

  // ── 模拟消费结算（数据层复现 gateway 结算产物；同 wp6-rollback-drill seedDrill）──
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

/** 破坏性模拟：备份后新增数据（一个新 provider_resource＋一笔新 ai_request）。 */
async function mutate(db: Kysely<Database>, fixture: DrillFixture) {
  const mutationResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
    name: "R7 备份后新增资源（恢复后必须消失）", mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const mutationRequestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: mutationRequestId, enterprise_id: fixture.enterpriseId,
    principal_id: fixture.principalId, principal_key_id: fixture.keyId,
    protocol: "chat", unified_model: "deepseek-chat", status: "SUCCEEDED",
    started_at: new Date("2026-11-04T09:00:00.000Z"),
    finished_at: new Date("2026-11-04T09:00:01.000Z"),
  }).execute();
  return {
    providerResourceId: mutationResourceId,
    providerResourceName: "R7 备份后新增资源（恢复后必须消失）",
    requestId: mutationRequestId,
  };
}

async function main() {
  const command = process.argv[2];
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const db = createKysely(process.env.DATABASE_URL);
  try {
    if (command === "prepare") {
      const executed = await migrateToLatest(db);
      const heads = await migrationHeads(db);
      const fixture = await seedDrill(db);
      console.log(JSON.stringify({
        executedMigrations: executed, migrationHeads: heads, fixture,
      }, null, 2));
    } else if (command === "digest") {
      const fixture = JSON.parse(readFileSync(process.argv[3]!, "utf8")).fixture as DrillFixture;
      const heads = await migrationHeads(db);
      const digests = await protectedDigests(db, fixture.enterpriseId);
      const logDigest = await migrationLogDigest(db);
      for (const [name, digest] of Object.entries(digests)) {
        console.log(`[r7-digest] ${name} sha256=${digest} empty=${digest === EMPTY_SET_DIGEST}`);
      }
      console.log(`[r7-digest] head(timestamp desc)=${heads.byTimestamp} head(name desc)=${heads.byName}`);
      console.log(`[r7-digest] kysely_migration sha256=${logDigest}`);
      console.log(JSON.stringify({ migrationHeads: heads, protectedDigests: digests, migrationLogDigest: logDigest }, null, 2));
    } else if (command === "mutate") {
      const fixture = JSON.parse(readFileSync(process.argv[3]!, "utf8")).fixture as DrillFixture;
      const mutation = await mutate(db, fixture);
      console.log(`[r7-mutate] inserted provider_resource id=${mutation.providerResourceId}`);
      console.log(`[r7-mutate] inserted ai_request id=${mutation.requestId}`);
      console.log(JSON.stringify(mutation, null, 2));
    } else if (command === "verify") {
      const fixture = JSON.parse(readFileSync(process.argv[3]!, "utf8")).fixture as DrillFixture;
      const baseline = JSON.parse(readFileSync(process.argv[4]!, "utf8"));
      const mutation = JSON.parse(readFileSync(process.argv[5]!, "utf8"));
      const heads = await migrationHeads(db);
      const digests = await protectedDigests(db, fixture.enterpriseId);
      const logDigest = await migrationLogDigest(db);
      const mutatedResourceRows = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM provider_resource
         WHERE id = ${mutation.providerResourceId}::uuid`.execute(db);
      const mutatedRequestRows = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM ai_request
         WHERE id = ${mutation.requestId}::uuid`.execute(db);
      const checks: Array<{ check: string; expected: unknown; actual: unknown; pass: boolean }> = [];
      const add = (check: string, expected: unknown, actual: unknown) =>
        checks.push({ check, expected, actual, pass: expected === actual });
      add("migration_head_rollback_sh_timestamp_desc", baseline.migrationHeads.byTimestamp, heads.byTimestamp);
      add("migration_head_by_name_desc", baseline.migrationHeads.byName, heads.byName);
      add("migration_head_is_0096", HEAD_0096, heads.byTimestamp);
      for (const [name, digest] of Object.entries(baseline.protectedDigests as Record<string, string>)) {
        add(`protected_set_verbatim:${name}`, digest, digests[name]);
      }
      add("post_backup_provider_resource_absent", "0", mutatedResourceRows.rows[0]!.count);
      add("post_backup_ai_request_absent", "0", mutatedRequestRows.rows[0]!.count);
      add("kysely_migration_log_verbatim", baseline.migrationLogDigest, logDigest);
      const allPass = checks.every((c) => c.pass);
      for (const c of checks) {
        console.log(`[r7-verify] ${c.pass ? "PASS" : "FAIL"} ${c.check} expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}`);
      }
      console.log(`[r7-verify] allPass=${allPass}`);
      console.log(JSON.stringify({ migrationHeads: heads, protectedDigests: digests, migrationLogDigest: logDigest, checks, allPass }, null, 2));
      if (!allPass) process.exitCode = 1;
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await db.destroy();
  }
}

await main();
