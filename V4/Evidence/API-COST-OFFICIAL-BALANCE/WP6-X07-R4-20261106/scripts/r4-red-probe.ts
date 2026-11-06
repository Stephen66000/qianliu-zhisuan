/**
 * X07 R4 红证据探针——在【R3 现状脚本】上运行新用例（R4 合同断言），产出红证据。
 *
 * 四条验收缺口的红化：
 *   缺口①（增量漏已有行更新）：in-flight 请求备份时未结算、切换后完成结算——
 *     R3 主键反连接只导新增行，ai_request/upstream_attempt 的 UPDATE 丢失，
 *     grant/enterprise 的更新同样丢失（额度域配置回退）。
 *   缺口②（失败发生在 dropdb 之后）：消费引用备份后新建订阅周期（白名单外表）→
 *     R3 restore 先毁原库、replay FK 失败时 live 已被覆盖（0091＋消费消失）。
 *   缺口③（额度控制未走真实路径）：R3 回退库上 reserveEmployeeQuota 因
 *     enterprise.employee_quota_monthly_from / grant 池字段丢失而退化为 LEGACY 拒绝——
 *     真实准入/结算路径失效。
 *   缺口④（门槛退役不保持）：R3 无 retire 步骤——本探针以「回退后新建资源仍被
 *     种入 PENDING」为合同断言，在 R3 流程下为红（由演练套件承担，见 r4 probe 注）。
 *
 * 用法（R4 根目录）：
 *   RED_PHASE=1 → 驱动 R3 现状脚本（--db-target 语义），产出红证据，exit 1
 *   RED_PHASE=0 → 驱动 R4 脚本（影子库语义），应为绿证据，exit 0
 * 环境：DOCKER_HOST、TESTCONTAINERS_RYUK_DISABLED。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pgRaw from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/pg/lib/index.js";
import { startPostgresContainer } from "/Users/mac/Projects/仟流智算-api-decouple/packages/testing/src/index.ts";
import { createKysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/index.ts";
import { PostgresDialect } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";
import { Kysely } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";
import type { Database } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/kysely.ts";
import { createMigrator } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/src/migrator.ts";
import { sql } from "/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/kysely/dist/esm/index.js";

const pg = pgRaw as typeof import("pg");
const RED_PHASE = process.env.RED_PHASE === "1";
const ROOT = "/Users/mac/Projects/仟流智算-api-decouple";
const SCRIPT = resolve(ROOT, "deploy/scripts/rollback-delta-20261106.sh");
const HEAD_0091 = "0091_recorded_cost_accounting_policy";
const HEAD_0092 = "0092_employee_monthly_quota";
const CONTAINER = "wp6-r4-red-pg";
const RED_LOG = process.env.R4_RED_LOG ?? resolve(ROOT, "V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-X07-R4-20261106/logs/r4-red-probe.log");
const GREEN_LOG = process.env.R4_GREEN_LOG ?? resolve(ROOT, "V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-X07-R4-20261106/logs/r4-green-probe.log");

type Db = Kysely<Database>;

/** 自管 Pool：可挂 error 监听（定位管理员命令终止来源）＋及时销毁。 */
function makeDb(uri: string, label: string): Db {
  const pool = new pg.Pool({ connectionString: uri, max: 4 });
  pool.on("error", (err: Error) => console.log(`[pool-error:${label}] ${err.message}`));
  void createKysely; // 合同基点仍引 createKysely（类型同构），运行期用自管池。
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
const checks: Array<{ id: string; desc: string; contract: string; actual: string; pass: boolean }> = [];
const commands: Array<{ cmd: string; exit: number | null }> = [];

function record(id: string, desc: string, contract: string, actual: string, pass: boolean): void {
  checks.push({ id, desc, contract, actual, pass });
  console.log(`${pass ? "PASS" : "RED"} [${id}] ${desc}\n  contract=${contract}\n  actual  =${actual}`);
}

function runScript(args: string[]): number {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ROLLBACK_DELTA_CONFIRM: "YES" } });
  commands.push({ cmd: `bash ${SCRIPT} ${args.join(" ")}`, exit: r.status });
  if (process.env.R4_CAPTURE) {
    writeFileSync(`/tmp/r4-script-capture-${args[0] ?? "x"}.log`, `exit=${r.status}\n== stdout ==\n${r.stdout ?? ""}\n== stderr ==\n${r.stderr ?? ""}`);
  }
  if (r.status !== 0) {
    console.log(`  script exit=${r.status} stderr=${(r.stderr ?? "").slice(0, 500)}`);
  }
  return r.status ?? -1;
}

function swapDb(uri: string, db: string): string {
  const u = new URL(uri);
  u.pathname = `/${db}`;
  return u.toString();
}

async function execContainer(command: string[]): Promise<string> {
  const r = await containerRef!.exec(command);
  if (r.exitCode !== 0) throw new Error(`exec fail ${r.exitCode}: ${command.join(" ")} ${r.stderr ?? ""}`);
  return r.output;
}

let containerRef: { exec(cmd: string[]): Promise<{ exitCode: number; output: string; stderr: string }> } | null = null;

async function seedBase(db: Db, tag: string): Promise<{
  enterpriseId: string; adminId: string; principalId: string; keyId: string; grantId: string;
  providerId: string; resourceAId: string; unifiedModelId: string; preRequestId: string;
  inflightRequestId: string; inflightAttemptId: string;
}> {
  const { randomUUID } = await import("node:crypto");
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: `R4 探针企业 ${tag}` }).execute();
  await db.insertInto("admin_user").values({ id: adminId, enterprise_id: enterpriseId, username: `r4-${tag}`, display_name: "R4", password_hash: "test" }).execute();
  await db.insertInto("provider_finance_runtime_state").values({ enterprise_id: enterpriseId, strict_writes_enabled: true, activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId }).execute();
  const providerId = await db.insertInto("provider").values({ enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "OPENAI_COMPATIBLE" }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const resourceAId = await db.insertInto("provider_resource").values({ enterprise_id: enterpriseId, provider_id: providerId, name: `R4 主资源 ${tag}`, mode: "API", credential_type: "API_KEY" }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await sql`UPDATE provider_resource_finance_state SET state='READY', ready_at=${new Date("2026-11-04T00:05:00.000Z")}, ready_by_admin_user_id=${adminId}::uuid WHERE provider_resource_id=${resourceAId}::uuid`.execute(db);
  await db.insertInto("principal").values({ id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "R4 员工", person_id: null, owner_person_id: null, department_label: null }).execute();
  await db.insertInto("principal_key").values({ id: keyId, enterprise_id: enterpriseId, principal_id: principalId, key_prefix: "ql_r4", key_digest: randomUUID(), allowed_model_ids: [] as never }).execute();
  const unifiedModelId = await db.insertInto("unified_model").values({ enterprise_id: enterpriseId, alias: `qianliu-r4-${tag}`, display_name: "R4", status: "ACTIVE" }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("model_route").values({ enterprise_id: enterpriseId, unified_model_id: unifiedModelId, provider_resource_id: resourceAId, upstream_model: "deepseek-chat" }).execute();
  await db.insertInto("billing_rule").values({ enterprise_id: enterpriseId, provider_resource_id: resourceAId, upstream_model: "deepseek-chat", rule_type: "API_PRICE", rule_version: `r4-${tag}-v1`, effective_from: new Date(0), cache_miss_price: "0.000001", multiplier: null, priority: 1000 }).execute();
  // 0091 水位：grant 无 quota_basis 列；allow_overage 初始 TRUE（切换后收紧为 false——缺口①的丢失更新）。
  const grantRows = await sql<{ id: string }>`
    INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value, allow_overage)
    VALUES (${enterpriseId}::uuid, ${principalId}::uuid, 'deepseek', 'qianliu-r4', 1000000, true) RETURNING id`.execute(db);
  const grantId = grantRows.rows[0]!.id;
  // 已结算基线消费（备份点事实）。
  const preRequestId = randomUUID();
  await db.insertInto("ai_request").values({ id: preRequestId, enterprise_id: enterpriseId, principal_id: principalId, principal_key_id: keyId, protocol: "chat", unified_model: "deepseek-chat", status: "SUCCEEDED", started_at: new Date("2026-11-04T06:00:00.000Z"), finished_at: new Date("2026-11-04T06:00:01.000Z") }).execute();
  const preAttempt = await db.insertInto("upstream_attempt").values({ enterprise_id: enterpriseId, ai_request_id: preRequestId, attempt_no: 1, provider_resource_id: resourceAId, upstream_model: "deepseek-chat", http_status: 200, response_committed: true, finished_at: new Date("2026-11-04T06:00:01.000Z") }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const preUsage = await db.insertInto("usage_event").values({ enterprise_id: enterpriseId, ai_request_id: preRequestId, upstream_attempt_id: preAttempt, provider_resource_id: resourceAId, input_tokens: 1000n, output_tokens: 200n, cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED", dedup_key: preRequestId, created_at: new Date("2026-11-04T06:00:01.000Z") }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({ enterprise_id: enterpriseId, ai_request_id: preRequestId, upstream_attempt_id: preAttempt, usage_event_id: preUsage, provider_resource_id: resourceAId, principal_id: principalId, resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: "0.00104000", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE", billing_rule_snapshot: { sourceStatus: "VERIFIED" }, usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T06:00:01.000Z"), created_at: new Date("2026-11-04T06:00:01.000Z") }).execute();
  await db.insertInto("ledger_transaction").values({ enterprise_id: enterpriseId, ai_request_id: preRequestId, principal_id: principalId, total_input_tokens: 1000n, total_output_tokens: 200n, total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0.00104000", api_cost_status: "PRICED_USAGE", overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T06:00:01.000Z") }).execute();
  // in-flight 请求（备份时未结算）：IN_PROGRESS＋attempt 未完成＋无计量/账本行。
  const inflightRequestId = randomUUID();
  await db.insertInto("ai_request").values({ id: inflightRequestId, enterprise_id: enterpriseId, principal_id: principalId, principal_key_id: keyId, protocol: "chat", unified_model: "deepseek-chat", status: "IN_PROGRESS", started_at: new Date("2026-11-04T07:00:00.000Z") }).execute();
  const inflightAttemptId = await db.insertInto("upstream_attempt").values({ enterprise_id: enterpriseId, ai_request_id: inflightRequestId, attempt_no: 1, provider_resource_id: resourceAId, upstream_model: "deepseek-chat", started_at: new Date("2026-11-04T07:00:00.500Z"), response_committed: false }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  return { enterpriseId, adminId, principalId, keyId, grantId, providerId, resourceAId, unifiedModelId, preRequestId, inflightRequestId, inflightAttemptId };
}

/** 切换后在 live 上完成 in-flight 结算（UPDATE 已有行——缺口①对象）＋额度域更新。 */
async function settleInflightAndQuotaUpdates(db: Db, fx: Awaited<ReturnType<typeof seedBase>>): Promise<void> {
  await sql`UPDATE enterprise SET employee_quota_monthly_from=${new Date("2026-11-01T00:00:00.000Z")} WHERE id=${fx.enterpriseId}::uuid`.execute(db);
  await sql`UPDATE principal_grant SET allow_overage=false, quota_value=100000, pool_model_alias='*', quota_basis='RAW_TOKEN', updated_at=${new Date("2026-11-04T10:00:00.000Z")} WHERE id=${fx.grantId}::uuid`.execute(db);
  await sql`UPDATE ai_request SET status='SUCCEEDED', finished_at=${new Date("2026-11-04T09:45:00.000Z")} WHERE id=${fx.inflightRequestId}::uuid`.execute(db);
  await sql`UPDATE upstream_attempt SET finished_at=${new Date("2026-11-04T09:45:00.500Z")}, http_status=200, response_committed=true WHERE id=${fx.inflightAttemptId}::uuid`.execute(db);
  const usageId = await db.insertInto("usage_event").values({ enterprise_id: fx.enterpriseId, ai_request_id: fx.inflightRequestId, upstream_attempt_id: fx.inflightAttemptId, provider_resource_id: fx.resourceAId, input_tokens: 500n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED", dedup_key: `${fx.inflightRequestId}:settle`, created_at: new Date("2026-11-04T09:45:00.500Z") }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({ enterprise_id: fx.enterpriseId, ai_request_id: fx.inflightRequestId, upstream_attempt_id: fx.inflightAttemptId, usage_event_id: usageId, provider_resource_id: fx.resourceAId, principal_id: fx.principalId, resource_mode: "API", raw_input_tokens: 500n, raw_output_tokens: 100n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: "0.00025000", api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE", billing_rule_snapshot: { sourceStatus: "VERIFIED" }, usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T09:45:00.500Z"), created_at: new Date("2026-11-04T09:45:00.500Z") }).execute();
  await db.insertInto("ledger_transaction").values({ enterprise_id: fx.enterpriseId, ai_request_id: fx.inflightRequestId, principal_id: fx.principalId, total_input_tokens: 500n, total_output_tokens: 100n, total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0.00025000", api_cost_status: "PRICED_USAGE", overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T09:45:00.500Z") }).execute();
}

async function pipelineA(instanceUri: string): Promise<void> {
  // 缺口①：增量漏已有行更新（R3 反连接＋DO NOTHING）。
  const live = makeDb(swapDb(instanceUri, "wp6_r4_red_live"), "A-live");
  await createMigrator(live).migrateTo(HEAD_0091);
  const fx = await seedBase(live, "A");
  await execContainer(["pg_dump", "-Fc", "-U", "qianliu_test", "-d", "wp6_r4_red_live", "-f", "/tmp/wp6-r4-red-a.dump"]);
  const dumpHost = resolve(tmp!, "a.dump");
  const cp = spawnSync("docker", ["cp", `${CONTAINER}:/tmp/wp6-r4-red-a.dump`, dumpHost], { encoding: "utf8" });
  if (cp.status !== 0) throw new Error(`docker cp fail: ${cp.stderr}`);
  await createMigrator(live).migrateToLatest();
  await settleInflightAndQuotaUpdates(live, fx);
  const outDir = resolve(tmp!, "a-out");
  const refDb = "wp6_r4_red_ref";
  let exit = runScript(RED_PHASE
    ? ["export", "--container", CONTAINER, "--db-live", "wp6_r4_red_live", "--db-ref", refDb, "--dump-file", dumpHost, "--out-dir", outDir]
    : ["export", "--container", CONTAINER, "--db-live", "wp6_r4_red_live", "--db-ref", refDb, "--dump-file", dumpHost, "--out-dir", outDir]);
  if (exit !== 0) { record("A-export", "增量导出", "exit=0", `exit=${exit}`, false); return; }
  const shadow = "wp6_r4_red_shadow";
  exit = runScript(RED_PHASE
    ? ["restore", "--container", CONTAINER, "--db-target", shadow, "--dump-file", dumpHost]
    : ["restore", "--container", CONTAINER, "--db-shadow", shadow, "--dump-file", dumpHost]);
  if (exit !== 0) { record("A-restore", "影子恢复", "exit=0", `exit=${exit}`, false); return; }
  const shadowDb = makeDb(swapDb(instanceUri, shadow), `A-${shadow}`);
  await createMigrator(shadowDb).migrateTo(HEAD_0092);
  exit = runScript(RED_PHASE
    ? ["replay", "--container", CONTAINER, "--db-target", shadow, "--manifest", resolve(outDir, "manifest.tsv"), "--delta-dir", outDir]
    : ["replay", "--container", CONTAINER, "--db-shadow", shadow, "--manifest", resolve(outDir, "manifest.tsv"), "--delta-dir", outDir]);
  if (exit !== 0) { record("A-replay", "增量回放", "exit=0", `exit=${exit}`, false); await shadowDb.destroy(); return; }

  const head = (await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1`.execute(shadowDb)).rows[0]?.name;
  record("A-head", "回放后水位", HEAD_0092, String(head), head === HEAD_0092);
  const req = (await sql<{ status: string; finished_at: Date | null }>`SELECT status, finished_at FROM ai_request WHERE id=${fx.inflightRequestId}::uuid`.execute(shadowDb)).rows[0]!;
  record("A1-inflight-request", "缺口①：in-flight 请求行更新保全（切换后完成结算）", "status=SUCCEEDED ∧ finished_at 非空", `status=${req.status} finished_at=${req.finished_at}`, req.status === "SUCCEEDED" && req.finished_at !== null);
  const att = (await sql<{ finished_at: Date | null; response_committed: boolean }>`SELECT finished_at, response_committed FROM upstream_attempt WHERE id=${fx.inflightAttemptId}::uuid`.execute(shadowDb)).rows[0]!;
  record("A2-inflight-attempt", "缺口①：in-flight attempt 行更新保全", "finished_at 非空 ∧ response_committed=true", `finished_at=${att.finished_at} committed=${att.response_committed}`, att.finished_at !== null && att.response_committed);
  const grant = (await sql<{ quota_value: string; allow_overage: boolean; pool_model_alias: string | null; quota_basis: string | null }>`SELECT quota_value::text AS quota_value, allow_overage, pool_model_alias, quota_basis FROM principal_grant WHERE id=${fx.grantId}::uuid`.execute(shadowDb)).rows[0]!;
  record("A3-grant-update", "缺口①：principal_grant 更新保全（额度域配置收紧）", "quota_value=100000 ∧ allow_overage=false ∧ pool_model_alias='*' ∧ quota_basis='RAW_TOKEN'", JSON.stringify(grant), grant.quota_value === "100000" && grant.allow_overage === false && grant.pool_model_alias === "*" && grant.quota_basis === "RAW_TOKEN");
  const ent = (await sql<{ monthly_from: Date | null }>`SELECT employee_quota_monthly_from AS monthly_from FROM enterprise WHERE id=${fx.enterpriseId}::uuid`.execute(shadowDb)).rows[0]!;
  record("A4-enterprise-quota-from", "缺口①：enterprise.employee_quota_monthly_from 保全（0092 域按迁移定义）", "非空（2026-11-01）", String(ent.monthly_from), ent.monthly_from !== null);
  const fin = (await sql<{ count: string }>`SELECT count(*)::text AS count FROM provider_finance_event WHERE enterprise_id=${fx.enterpriseId}::uuid AND event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE')`.execute(shadowDb)).rows[0]!;
  record("A5-finance-zero", "红线：期初/充值类 finance 事件＝0", "0", fin.count, fin.count === "0");
  await shadowDb.destroy();
  await live.destroy();
}

async function pipelineB(instanceUri: string): Promise<void> {
  // 缺口②：失败发生在 dropdb 之后——消费引用备份后新建订阅周期（provider_subscription_period 非白名单）。
  let live = makeDb(swapDb(instanceUri, "wp6_r4_red_b_live"), "B-live");
  await createMigrator(live).migrateTo(HEAD_0091);
  const fx = await seedBase(live, "B");
  await execContainer(["pg_dump", "-Fc", "-U", "qianliu_test", "-d", "wp6_r4_red_b_live", "-f", "/tmp/wp6-r4-red-b.dump"]);
  const dumpHost = resolve(tmp!, "b.dump");
  const cp = spawnSync("docker", ["cp", `${CONTAINER}:/tmp/wp6-r4-red-b.dump`, dumpHost], { encoding: "utf8" });
  if (cp.status !== 0) throw new Error(`docker cp fail: ${cp.stderr}`);
  await createMigrator(live).migrateToLatest();
  // 切换后：CODING_PLAN 资源＋订阅周期（白名单外表，不回放）＋引用它的消费。
  const planResourceId = await live.insertInto("provider_resource").values({ enterprise_id: fx.enterpriseId, provider_id: fx.providerId, name: "R4 Coding Plan 资源", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION" }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const periodId = await live.insertInto("provider_subscription_period").values({ enterprise_id: fx.enterpriseId, provider_resource_id: planResourceId, product_name: "R4 Coding Plan", period_start: new Date("2026-10-31T16:00:00.000Z"), period_end_exclusive: new Date("2026-11-30T16:00:00.000Z"), source: "MIGRATED_CARRYOVER", created_by_admin_user_id: fx.adminId }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const { randomUUID } = await import("node:crypto");
  const request4 = randomUUID();
  await live.insertInto("ai_request").values({ id: request4, enterprise_id: fx.enterpriseId, principal_id: fx.principalId, principal_key_id: fx.keyId, protocol: "chat", unified_model: "deepseek-chat", status: "SUCCEEDED", started_at: new Date("2026-11-04T10:00:00.000Z"), finished_at: new Date("2026-11-04T10:00:01.000Z") }).execute();
  const att4 = await live.insertInto("upstream_attempt").values({ enterprise_id: fx.enterpriseId, ai_request_id: request4, attempt_no: 1, provider_resource_id: planResourceId, upstream_model: "deepseek-chat", http_status: 200, response_committed: true, finished_at: new Date("2026-11-04T10:00:01.000Z") }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const usage4 = await live.insertInto("usage_event").values({ enterprise_id: fx.enterpriseId, ai_request_id: request4, upstream_attempt_id: att4, provider_resource_id: planResourceId, input_tokens: 800n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED", dedup_key: request4, created_at: new Date("2026-11-04T10:00:01.000Z") }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await live.insertInto("ledger_line").values({ enterprise_id: fx.enterpriseId, ai_request_id: request4, upstream_attempt_id: att4, usage_event_id: usage4, provider_resource_id: planResourceId, principal_id: fx.principalId, resource_mode: "CODING_PLAN", raw_input_tokens: 800n, raw_output_tokens: 100n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: null, api_cost_currency: null, api_cost_status: "NOT_APPLICABLE", subscription_period_id: periodId, usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T10:00:01.000Z"), created_at: new Date("2026-11-04T10:00:01.000Z") }).execute();
  await live.insertInto("ledger_transaction").values({ enterprise_id: fx.enterpriseId, ai_request_id: request4, principal_id: fx.principalId, total_input_tokens: 800n, total_output_tokens: 100n, total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0", api_cost_status: "NOT_APPLICABLE", overage: false, usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T10:00:01.000Z") }).execute();

  const outDir = resolve(tmp!, "b-out");
  const refDb = "wp6_r4_red_b_ref";
  let exit = runScript(["export", "--container", CONTAINER, "--db-live", "wp6_r4_red_b_live", "--db-ref", refDb, "--dump-file", dumpHost, "--out-dir", outDir]);
  if (exit !== 0) { record("B-export", "增量导出", "exit=0", `exit=${exit}`, false); return; }

  if (RED_PHASE) {
    // R3 现状：restore 直接以原库名为目标——原 live 在此被覆盖。
    exit = runScript(["restore", "--container", CONTAINER, "--db-target", "wp6_r4_red_b_live", "--dump-file", dumpHost]);
    if (exit !== 0) { record("B-restore", "R3 恢复段", "exit=0", `exit=${exit}`, false); return; }
    // R3 restore 已 dropdb --force 覆盖原库名——旧池连接随库销毁，重建池再查。
    await live.destroy();
    live = makeDb(swapDb(instanceUri, "wp6_r4_red_b_live"), "B-live-recovered");
    await createMigrator(live).migrateTo(HEAD_0092);
    exit = runScript(["replay", "--container", CONTAINER, "--db-target", "wp6_r4_red_b_live", "--manifest", resolve(outDir, "manifest.tsv"), "--delta-dir", outDir]);
    record("B1-replay-fk-fail", "缺口②：引用备份后新建订阅周期（白名单外表）的消费使回放失败（fail-closed；period 归属触发器/FK 任一拦截）", "exit≠0", `exit=${exit}`, exit !== 0);
    const head = (await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1`.execute(live)).rows[0]?.name;
    record("B2-live-destroyed", "缺口②红证：回放失败时原 live 已被覆盖（『失败中止库不动』不成立）", "水位＝0096 且切换后消费仍在（live 未动）", `水位=${head}（0091＝已被备份点覆盖）`, head === "0096_official_balance_refresh_request");
    const gone = (await sql<{ count: string }>`SELECT count(*)::text AS count FROM ai_request WHERE enterprise_id=${fx.enterpriseId}::uuid AND started_at=${new Date("2026-11-04T10:00:00.000Z")}`.execute(live)).rows[0]!;
    record("B3-consumption-lost", "缺口②红证：切换后消费随整库覆盖消失", "request4 行仍在", `count=${gone.count}`, gone.count === "1");
    await live.destroy();
    return;
  }
  // R4：全程影子——replay 失败＝删影子、live 未动、exit 非 0。
  const shadow = "wp6_r4_red_b_shadow";
  exit = runScript(["restore", "--container", CONTAINER, "--db-shadow", shadow, "--dump-file", dumpHost]);
  if (exit !== 0) { record("B-restore", "影子恢复", "exit=0", `exit=${exit}`, false); return; }
  const shadowDb = makeDb(swapDb(instanceUri, shadow), "B-shadow");
  await createMigrator(shadowDb).migrateTo(HEAD_0092);
  await shadowDb.destroy();
  exit = runScript(["replay", "--container", CONTAINER, "--db-shadow", shadow, "--manifest", resolve(outDir, "manifest.tsv"), "--delta-dir", outDir]);
  record("B1-replay-fk-fail", "缺口②：引用白名单外表的消费使影子回放失败（fail-closed）", "exit≠0（FK 失败）", `exit=${exit}`, exit !== 0);
  const head = (await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1`.execute(live)).rows[0]?.name;
  record("B2-live-intact", "缺口②绿证：回放失败时 live 未动", "水位＝0096", `水位=${head}`, head === "0096_official_balance_refresh_request");
  const kept = (await sql<{ count: string }>`SELECT count(*)::text AS count FROM ai_request WHERE enterprise_id=${fx.enterpriseId}::uuid AND started_at=${new Date("2026-11-04T10:00:00.000Z")}`.execute(live)).rows[0]!;
  record("B3-consumption-intact", "缺口②绿证：切换后消费仍在 live", "request4 行仍在", `count=${kept.count}`, kept.count === "1");
  const shadowGone = (await sql<{ exists: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=${shadow}) AS exists`.execute(live)).rows[0]!.exists;
  record("B4-shadow-dropped", "缺口②绿证：失败后影子库已删除", "影子不存在", `exists=${shadowGone}`, !shadowGone);
  await live.destroy();
}

let tmp: string | null = null;

async function main(): Promise<void> {
  tmp = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/wp6-r4-probe-`);
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
  const { PostgreSqlContainer } = await import("/Users/mac/Projects/仟流智算-api-decouple/packages/database/node_modules/@testcontainers/postgresql/build/index.js");
  const container = await new PostgreSqlContainer("postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193")
    .withUsername("qianliu_test").withPassword("qianliu_test_only").withName(CONTAINER).start();
  containerRef = container;
  const instanceUri = container.getConnectionUri();
  for (const db of ["wp6_r4_red_live", "wp6_r4_red_b_live"]) {
    const cr = spawnSync("docker", ["exec", CONTAINER, "sh", "-c", `createdb -U qianliu_test ${db}`], { encoding: "utf8" });
    if (cr.status !== 0) throw new Error(`createdb ${db} fail: ${cr.stderr}`);
  }
  try {
    await pipelineA(instanceUri);
    await pipelineB(instanceUri);
  } finally {
    const admin = createKysely(instanceUri);
    for (const db of ["wp6_r4_red_live", "wp6_r4_red_shadow", "wp6_r4_red_ref", "wp6_r4_red_b_live", "wp6_r4_red_b_shadow", "wp6_r4_red_b_ref"]) {
      await sql`DROP DATABASE IF EXISTS ${sql.raw(`"${db}"`)} WITH (FORCE)`.execute(admin).catch(() => undefined);
    }
    await admin.destroy();
    const lg = spawnSync("docker", ["logs", CONTAINER, "--tail", "80"], { encoding: "utf8" });
    console.log("== PG LOG TAIL ==");
    console.log((lg.stdout ?? "") + (lg.stderr ?? ""));
    await new Promise((r) => setTimeout(r, 300));
    await container.stop();
  }
  const reds = checks.filter((c) => !c.pass);
  const report = { phase: RED_PHASE ? "RED(R3 现状)" : "GREEN(R4 修复后)", checks, commands };
  writeFileSync(RED_PHASE ? RED_LOG : GREEN_LOG, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n== ${report.phase} == RED=${reds.length} PASS=${checks.length - reds.length}`);
  for (const r of reds) console.log(`RED [${r.id}] ${r.desc}`);
  if (RED_PHASE) {
    if (reds.length === 0) { console.error("红阶段未产生红——探针无效"); process.exit(2); }
    process.exit(1);
  }
  if (reds.length > 0) process.exit(1);
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  console.log(`[uncaught-ignored] ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  console.log(`[unhandled-ignored] ${String(err).slice(0, 200)}`);
});

try {
  await main();
} catch (error) {
  console.error("PROBE_FAILED", error);
  process.exit(3);
}
