/**
 * AT-X07 R4 演练——主路线 v3：增量导出（全行比对）→影子恢复→重放 0092→增量回放
 * （DO UPDATE 幂等）→retire-threshold（门槛退役保持）→verify（影子校验）→swap
 * （单事务改名，keep＝切换后状态留档）。验收二次退回四缺口逐条对齐：
 *
 *   缺口①（增量漏已有行更新）：白名单 17 表全行比对（R5 补入 quota_counter——累计额度计数行，0004:41，grant_id 唯一约束 quota_counter_grant_idx；累计额度准入 quota-gate-repository reserveQuota 直接读其 used_value）（PK 全连接，任一列变更或新增
 *      行均入增量；清单区分 inserted/updated）；回放 ON CONFLICT (id) DO UPDATE SET
 *      列交集全列。红用例（已留证 R3 现状，WP6-X07-R4-20261106/red-evidence/）：
 *      T0 建 in-flight 请求（未结算）→备份→切换后完成结算（ai_request/upstream_attempt
 *      行 UPDATE＋usage/ledger/transaction 新行）→R3 回退到未结算态；修复后结算态
 *      逐字保全。另一红用例：principal_grant 切换后收紧（quota_value/allow_overage/
 *      pool 字段）→R3 丢更新；修复后保全。enterprise.employee_quota_monthly_from
 *      （0092 域按迁移定义加列）同批保全。
 *   缺口②（失败发生在 dropdb 之后）：restore/replay/retire/verify 全部只作用于影子
 *      库；任一步失败＝删影子、live 未动、exit 非 0；verify 全过才 swap。红用例
 *      （已留证）：消费引用备份后新建订阅周期（白名单外表）→R3 先 restore 后回放
 *      失败时 live 已被覆盖；修复后影子内失败→删影子、live 完好。
 *   缺口③（额度控制真实路径）：旧栈（ae506fe）子进程在回放后的库上走真实准入与
 *      结算入口——reserveEmployeeQuota（evaluateQuotaGate：超额拒绝且原因含额度语义
 *      REJECT_EXHAUSTED、MONTHLY 模式生效）＋settleEmployeeQuota（允许请求经旧栈
 *      结算路径落库、period used_value 正确累计）。红证：R3 丢 enterprise/grant
 *      更新使 MONTHLY 路径退化为 LEGACY 拒绝（真实路径失效）。
 *   缺口④（门槛退役保持）：retire-threshold 在影子内 DROP 0081 种入触发器与函数
 *      ＋删除 API 模式 PENDING 控制行（行数留档）。断言：回退后新建资源无 PENDING；
 *      无 finance 行资源经旧栈准入可服务；原 PENDING 资源（控制行删除后）同样可
 *      服务。依据＝AFR-02，操作单 §6.1/§6.4 v3 声明为回退包对旧代码行为的有意覆盖。
 *
 * 纪律：红用例先在 R3 现状跑出红（logs/r4-red-probe-run.log＋r4-red-probe.log，
 * RED=6），修复后转绿（logs/r4-green-probe-run.log 10/10＋本套件全绿）。
 *
 * 与 R3 版（7 用例）的衔接：原 A/B/C/D/E/F/G 用例全部保留并按 R4 语义扩展——
 *   A 导出组（+inserted/updated 与全行比对）；B 负向组（+live 不动强化）；C 恢复组
 *   （restore 改影子语义：live 物理未动）；D 回放组（applied 计数＋影子摘要＝live
 *   摘要，含 in-flight 更新逐字）；E 幂等组（DO UPDATE 语义：二次回放 applied=清单
 *   行数且摘要不变——重放结果不变）；F 组 3＋组 5（+retire-threshold；原「恢复后
 *   新建资源被种入 PENDING」按缺口④裁定改断言为「无 PENDING」——有意覆盖非削弱，
 *   触发器 ENABLED 校验保留在 E 段）；G 组 2 旧栈（+真实额度路径 C①/C②；原 PENDING
 *   留档资源按缺口④改断言为可服务）。新增 G/verify+swap、H 门槛保持、J 缺口②
 *   绿证场景三组。
 * 红线不变：finance 事件零补造（verify 以 ref 快照全表摘要证明＋各段断言）；迁移
 * 文件零触碰；rollback.sh 零触碰；不 commit。
 */
import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { createKysely, loadApiCostEstimation, migrateToLatest } from "../index.js";
import { createMigrator } from "../migrator.js";

const HEAD_0096 = "0096_official_balance_refresh_request";
const HEAD_0092 = "0092_employee_monthly_quota";
const HEAD_0091 = "0091_recorded_cost_accounting_policy";
const SEED_TRIGGER = "provider_resource_finance_state_seed_trigger";
const SEED_FUNCTION = "provider_resource_finance_state_seed";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DELTA_SCRIPT = resolve(REPO_ROOT, "deploy/scripts/rollback-delta-20261106.sh");
const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
const LEGACY_TSX = resolve(LEGACY_ROOT, "node_modules/.bin/tsx");
const LEGACY_CHECK_SCRIPT = resolve(
  REPO_ROOT,
  "V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-X07-R5-20261106/scripts/wp6-r5-legacy-read-check.ts",
);

const CONTAINER_NAME = "wp6-r4-drill-pg";
const LIVE_DB = "wp6_r4_live";
const REF_DB = "wp6_r4_ref";
const SHADOW_DB = "wp6_r4_shadow";
const KEEP_DB = "wp6_r4_live_pre_rollback_keep";
const DUMP_IN_CONTAINER = "/tmp/wp6-r4-backup.dump";

const AMOUNT_PRE = "0.00104000";
const AMOUNT_CUT1 = "0.00060000";
const AMOUNT_CUT2 = "0.00040000";
const AMOUNT_INFLIGHT = "0.00025000";
const AMOUNT_LEGACY_SETTLE = "0.00052000";
const WINDOW_ESTIMATED_CNY = "0.00259000"; // 0.00104000＋0.00060000＋0.00040000＋0.00025000＋0.00010000＋0.00020000
const QUOTA_LIMIT = 1_000_000n;
const QUOTA_USED_RESTORED = 1_900n; // 两笔切换后 SETTLED usage（1200＋700）
const QUOTA_C1_ESTIMATE = "5000000"; // 超额请求（REJECT_EXHAUSTED）
const QUOTA_C2_ESTIMATE = "50000"; // 允许请求（ALLOW→结算累计）
const QUOTA_USED_AFTER_SETTLE = "51900"; // 1900＋50000
const QUOTA_R5A_LIMIT = 1000n; // R5-A：备份时上限 1000
const QUOTA_R5A_USED_BACKUP = 900n; // 备份时已用 900
const QUOTA_R5A_USED_LIVE = 1000n; // 切换后消费 100 → 停写时已用 1000（缺口本体）
const QUOTA_R5B_LIMIT = 500n; // R5-B：新增累计授权上限
const QUOTA_R5B_USED = 200n; // R5-B：非零消费结算后计数
const QUOTA_R5B_RESERVE = 100n; // 额度内预占
const QUOTA_R5B_ACTUAL = 80n; // 结算实际（多退少补→280）
const QUOTA_R5B_USED_AFTER = 280n; // 200＋100−100＋80＝280
const AMOUNT_R5A = "0.00010000";
const AMOUNT_R5B = "0.00020000";
const WINDOW = { start: "2026-11-04T00:00:00.000Z", end: "2026-11-05T00:00:00.000Z" };

/** 白名单（＝交付脚本 REPLAY_ORDER v3；enterprise 为 0092 域按迁移定义补入）。 */
const WHITELIST = [
  "enterprise", "provider", "unified_model", "principal", "principal_key",
  "provider_resource", "billing_rule", "model_route", "ai_request",
  "upstream_attempt", "usage_event", "ledger_line", "ledger_transaction",
  "principal_grant", "quota_counter", "principal_quota_period", "principal_quota_usage",
] as const;
const ONLY_0092_TABLES = ["principal_quota_period", "principal_quota_usage"] as const;

/** 期望增量（rows/inserted/updated）——与 seedT0＋seedCutover 一一对应。 */
const EXPECTED_DELTA: Record<(typeof WHITELIST)[number], { rows: number; inserted: number; updated: number }> = {
  enterprise: { rows: 1, inserted: 0, updated: 1 }, // employee_quota_monthly_from
  provider: { rows: 0, inserted: 0, updated: 0 },
  unified_model: { rows: 0, inserted: 0, updated: 0 },
  principal: { rows: 0, inserted: 0, updated: 0 },
  principal_key: { rows: 0, inserted: 0, updated: 0 },
  provider_resource: { rows: 1, inserted: 1, updated: 0 }, // resourceC
  billing_rule: { rows: 1, inserted: 1, updated: 0 }, // drift 探针行
  model_route: { rows: 0, inserted: 0, updated: 0 },
  ai_request: { rows: 5, inserted: 4, updated: 1 }, // r2/r3/r5a/r5b 新增；in-flight 更新
  upstream_attempt: { rows: 5, inserted: 4, updated: 1 },
  usage_event: { rows: 5, inserted: 5, updated: 0 },
  ledger_line: { rows: 5, inserted: 5, updated: 0 },
  ledger_transaction: { rows: 5, inserted: 5, updated: 0 },
  principal_grant: { rows: 2, inserted: 1, updated: 1 }, // 收紧更新＋R5-B 新增累计授权
  quota_counter: { rows: 2, inserted: 1, updated: 1 }, // R5：已有计数行更新（900→1000）＋新增授权计数行
  principal_quota_period: { rows: 1, inserted: 1, updated: 0 },
  principal_quota_usage: { rows: 2, inserted: 2, updated: 0 },
};

/** 逐字摘要剔除列：0093 为 billing_rule 加的 source_status（新栈元数据列）随 schema
 * 回退不保留（§6.1 v3 已知边界）；两侧同步剔除后逐字比对。 */
const DIGEST_EXCLUDED_COLUMNS: Partial<Record<(typeof WHITELIST)[number], string[]>> = {
  billing_rule: ["source_status"],
};

const COMMAND_LOG: Array<{ cmd: string; exit: number | null; note?: string }> = [];
function logCommand(cmd: string, exit: number | null, ...notes: Array<string | undefined>): void {
  COMMAND_LOG.push({ cmd, exit, note: notes.filter((n) => n !== undefined).join(" | ") });
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runDeltaScript(args: string[], env?: Record<string, string>): ScriptResult {
  const result = spawnSync("bash", [DELTA_SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  logCommand(`bash ${DELTA_SCRIPT} ${args.join(" ")}`, result.status,
    env ? `env=${JSON.stringify(env)}` : undefined,
    `stdout=${(result.stdout ?? "").slice(0, 4000)}`, `stderr=${(result.stderr ?? "").slice(0, 4000)}`);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function expectScriptOk(result: ScriptResult): void {
  expect({ status: result.status, stderr: result.stderr.slice(0, 3000) }).toMatchObject({ status: 0 });
}

async function containerExec(container: StartedPostgreSqlContainer, command: string[]): Promise<string> {
  const result = await container.exec(command);
  logCommand(`container.exec ${command.join(" ")}`, result.exitCode);
  if (result.exitCode !== 0) {
    throw new Error(`container exec 失败 (${result.exitCode}): ${command.join(" ")}\n${result.output}\n${result.stderr ?? ""}`);
  }
  return result.output;
}

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

type Db = ReturnType<typeof createKysely>;

async function whitelistDigests(database: Db, enterpriseId: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const table of WHITELIST) {
    if (!(await tableExists(database, table))) {
      digests[table] = `ABSENT:${table}`;
      continue;
    }
    // enterprise 为租户根表（无 enterprise_id 列），按自身 id 过滤；
    // quota_counter（无 enterprise_id 列）按 grant 归属（FK 父 principal_grant 已在白名单）。
    const whereClause = table === "enterprise"
      ? sql`WHERE id = ${enterpriseId}::uuid`
      : table === "quota_counter"
        ? sql`WHERE grant_id IN (SELECT id FROM principal_grant WHERE enterprise_id = ${enterpriseId}::uuid)`
        : sql`WHERE enterprise_id = ${enterpriseId}::uuid`;
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT row_to_json(t) AS row FROM (
        SELECT * FROM ${sql.raw(table)} ${whereClause} ORDER BY id
      ) t`.execute(database);
    const excluded = DIGEST_EXCLUDED_COLUMNS[table] ?? [];
    const rows = result.rows.map((row) => {
      const record = { ...(row.row as Record<string, unknown>) };
      for (const column of excluded) delete record[column];
      return record;
    });
    digests[table] = createHash("sha256").update(canonicalJson(rows)).digest("hex");
  }
  return digests;
}

async function migrationHead(database: Db): Promise<string | null> {
  const result = await sql<{ name: string }>`
    SELECT name FROM kysely_migration ORDER BY timestamp DESC, name DESC LIMIT 1
  `.execute(database);
  return result.rows[0]?.name ?? null;
}

async function tableExists(database: Db, table: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS exists
  `.execute(database);
  return result.rows[0]!.exists;
}

async function openingOrRechargeEventCount(database: Db, enterpriseId: string): Promise<string> {
  const result = await sql<{ count: string }>`
    SELECT count(*)::text AS count FROM provider_finance_event
     WHERE enterprise_id = ${enterpriseId}::uuid
       AND event_type IN ('API_OPENING_BALANCE','API_OPENING_BALANCE_CORRECTION','API_RECHARGE')
  `.execute(database);
  return result.rows[0]!.count;
}

function swapDbName(connectionUri: string, database: string): string {
  const url = new URL(connectionUri);
  url.pathname = `/${database}`;
  return url.toString();
}

interface Fixture {
  enterpriseId: string;
  adminId: string;
  principalId: string;
  keyId: string;
  grantId: string;
  providerId: string;
  resourceReadyId: string;
  resourcePendingId: string;
  resourceCutoverId: string;
  postRollbackResourceId: string;
  unifiedModelId: string;
  preRequestId: string;
  cutRequest1Id: string;
  cutRequest2Id: string;
  cutAttempt1Id: string;
  cutAttempt2Id: string;
  periodId: string;
  inflightRequestId: string;
  inflightAttemptId: string;
  principal2Id: string;
  key2Id: string;
  grant2Id: string;
  grant3Id: string;
  r5aRequestId: string;
  r5bRequestId: string;
}

/** 一笔已计价结算消费（gateway 结算产物数据层同型）。 */
async function seedConsumption(
  db: Db,
  spec: {
    enterpriseId: string; principalId: string; keyId: string; resourceId: string;
    requestId: string; startedAt: string; amount: string;
  },
): Promise<{ attemptId: string; usageId: string }> {
  await db.insertInto("ai_request").values({
    id: spec.requestId, enterprise_id: spec.enterpriseId, principal_id: spec.principalId,
    principal_key_id: spec.keyId, protocol: "chat", unified_model: "deepseek-chat",
    status: "SUCCEEDED", started_at: new Date(spec.startedAt),
    finished_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  const attemptId = await db.insertInto("upstream_attempt").values({
    enterprise_id: spec.enterpriseId, ai_request_id: spec.requestId, attempt_no: 1,
    provider_resource_id: spec.resourceId, upstream_model: "deepseek-chat",
    http_status: 200, response_committed: true,
    finished_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const usageId = await db.insertInto("usage_event").values({
    enterprise_id: spec.enterpriseId, ai_request_id: spec.requestId, upstream_attempt_id: attemptId,
    provider_resource_id: spec.resourceId, input_tokens: 1000n, output_tokens: 200n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
    dedup_key: spec.requestId, created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({
    enterprise_id: spec.enterpriseId, ai_request_id: spec.requestId, upstream_attempt_id: attemptId,
    usage_event_id: usageId, provider_resource_id: spec.resourceId, principal_id: spec.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: spec.amount, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    billing_rule_snapshot: { sourceStatus: "VERIFIED" },
    usage_quality: "PROVIDER_REPORTED", settled_at: new Date(new Date(spec.startedAt).getTime() + 1000),
    created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    enterprise_id: spec.enterpriseId, ai_request_id: spec.requestId, principal_id: spec.principalId,
    total_input_tokens: 1000n, total_output_tokens: 200n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: spec.amount,
    api_cost_status: "PRICED_USAGE", overage: false, usage_quality: "PROVIDER_REPORTED",
    attempt_count: 1, status: "SETTLED", created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  return { attemptId, usageId };
}

/** T0 播种（0091 水位）：含 in-flight 请求（缺口①红/绿用例的数据前提）。 */
async function seedT0(db: Db): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP6 R4 回放演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "wp6-r4-admin",
    display_name: "WP6 R4 管理员", password_hash: "test",
  }).execute();
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();
  const providerId = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const resourceReadyId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R4 主 API 资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await sql`
    UPDATE provider_resource_finance_state
       SET state = 'READY', ready_at = ${new Date("2026-11-04T00:05:00.000Z")},
           ready_by_admin_user_id = ${adminId}::uuid
     WHERE provider_resource_id = ${resourceReadyId}::uuid
  `.execute(db);
  const resourcePendingId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R4 存量 PENDING 留档资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);

  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "R4 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_r4", key_digest: randomUUID(), allowed_model_ids: [] as never,
  }).execute();
  const unifiedModelId = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias: "qianliu-r4-deepseek",
    display_name: "R4 DeepSeek", status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: unifiedModelId,
    provider_resource_id: resourceReadyId, upstream_model: "deepseek-chat",
  }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, provider_resource_id: resourceReadyId,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "r4-api-price-v1", effective_from: new Date(0),
    cache_miss_price: "0.000001", multiplier: null, priority: 1000,
  }).execute();
  // 0091 水位：grant 尚无 quota_basis/pool 语义；allow_overage 初始 TRUE
  // （切换后收紧为 false——缺口①丢失更新的合同场景）。
  const grantRows = await sql<{ id: string }>`
    INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value, allow_overage)
    VALUES (${enterpriseId}::uuid, ${principalId}::uuid, 'deepseek', 'qianliu-r4-deepseek', ${QUOTA_LIMIT}, true)
    RETURNING id
  `.execute(db);
  const grantId = grantRows.rows[0]!.id;

  await seedConsumption(db, {
    enterpriseId, principalId, keyId, resourceId: resourceReadyId,
    requestId: randomUUID(), startedAt: "2026-11-04T06:00:00.000Z", amount: AMOUNT_PRE,
  });
  // in-flight 请求：IN_PROGRESS＋attempt 未完成＋无计量/账本行（备份点状态）。
  const inflightRequestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: inflightRequestId, enterprise_id: enterpriseId, principal_id: principalId,
    principal_key_id: keyId, protocol: "chat", unified_model: "deepseek-chat",
    status: "IN_PROGRESS", started_at: new Date("2026-11-04T07:00:00.000Z"),
  }).execute();
  const inflightAttemptId = await db.insertInto("upstream_attempt").values({
    enterprise_id: enterpriseId, ai_request_id: inflightRequestId, attempt_no: 1,
    provider_resource_id: resourceReadyId, upstream_model: "deepseek-chat",
    started_at: new Date("2026-11-04T07:00:00.500Z"), response_committed: false,
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);

  // R5 累计额度域（员工 2＋精确型号累计授权 grant2＋计数行 used=900——缺口本体的备份点状态）。
  const principal2Id = randomUUID();
  const key2Id = randomUUID();
  await db.insertInto("principal").values({
    id: principal2Id, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "R4 累计额度员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: key2Id, enterprise_id: enterpriseId, principal_id: principal2Id,
    key_prefix: "ql_r4c", key_digest: randomUUID(), allowed_model_ids: [] as never,
  }).execute();
  const grant2Rows = await sql<{ id: string }>`
    INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value, allow_overage)
    VALUES (${enterpriseId}::uuid, ${principal2Id}::uuid, 'deepseek', 'qianliu-r4-deepseek', ${QUOTA_R5A_LIMIT}, false)
    RETURNING id
  `.execute(db);
  const grant2Id = grant2Rows.rows[0]!.id;
  await db.insertInto("quota_counter").values({
    grant_id: grant2Id, used_value: QUOTA_R5A_USED_BACKUP, overage_value: 0n,
    period_anchor: new Date("2026-11-01T00:00:00.000Z"),
    updated_at: new Date("2026-11-04T07:30:00.000Z"),
  }).execute();

  const preRows = await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T06:00:00.000Z")} LIMIT 1`.execute(db);
  return {
    enterpriseId, adminId, principalId, keyId, grantId, providerId,
    resourceReadyId, resourcePendingId, resourceCutoverId: "", postRollbackResourceId: "",
    unifiedModelId, preRequestId: preRows.rows[0]!.id,
    cutRequest1Id: "", cutRequest2Id: "", cutAttempt1Id: "", cutAttempt2Id: "",
    periodId: "", inflightRequestId, inflightAttemptId,
    principal2Id, key2Id, grant2Id, grant3Id: "", r5aRequestId: "", r5bRequestId: "",
  };
}

/** 切换后新数据：两笔消费＋额度域＋in-flight 结算（更新已有行）＋收紧更新＋drift 探针。 */
async function seedCutover(db: Db, fixture: Fixture): Promise<void> {
  // 额度域启用（0092 按迁移定义为 enterprise 加列；全行比对随增量保全）。
  await sql`UPDATE enterprise SET employee_quota_monthly_from = ${new Date("2026-11-01T00:00:00.000Z")} WHERE id = ${fixture.enterpriseId}::uuid`.execute(db);
  // grant 收紧（缺口①丢失更新的合同场景）＋池语义（缺口③真实路径前提）。
  await sql`UPDATE principal_grant SET allow_overage = false, quota_value = 100000, pool_model_alias = '*', quota_basis = 'RAW_TOKEN', updated_at = ${new Date("2026-11-04T10:00:00.000Z")} WHERE id = ${fixture.grantId}::uuid`.execute(db);

  const cut1 = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId, keyId: fixture.keyId,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:00:00.000Z", amount: AMOUNT_CUT1,
  });
  fixture.cutRequest1Id = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:00:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  fixture.cutAttempt1Id = cut1.attemptId;
  const cut2 = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId, keyId: fixture.keyId,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:30:00.000Z", amount: AMOUNT_CUT2,
  });
  fixture.cutRequest2Id = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:30:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  fixture.cutAttempt2Id = cut2.attemptId;

  const periodId = await db.insertInto("principal_quota_period").values({
    enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId, provider: "deepseek",
    period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
    period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
    quota_basis: "RAW_TOKEN", limit_value: QUOTA_LIMIT, allow_overage: true,
    used_value: QUOTA_USED_RESTORED, reserved_value: 0n, open_grant_version: 1,
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  fixture.periodId = periodId;
  await db.insertInto("principal_quota_usage").values({
    enterprise_id: fixture.enterpriseId, request_id: fixture.cutRequest1Id, attempt_no: 1,
    upstream_attempt_id: fixture.cutAttempt1Id, period_id: periodId, grant_id: fixture.grantId,
    grant_version: 1, quota_basis: "RAW_TOKEN", estimate: 1_200n, actual: 1_200n,
    status: "SETTLED", usage_quality: "PROVIDER_REPORTED",
    created_at: new Date("2026-11-04T09:00:01.000Z"), settled_at: new Date("2026-11-04T09:00:01.000Z"),
  }).execute();
  await db.insertInto("principal_quota_usage").values({
    enterprise_id: fixture.enterpriseId, request_id: fixture.cutRequest2Id, attempt_no: 1,
    upstream_attempt_id: fixture.cutAttempt2Id, period_id: periodId, grant_id: fixture.grantId,
    grant_version: 1, quota_basis: "RAW_TOKEN", estimate: 700n, actual: 700n,
    status: "SETTLED", usage_quality: "PROVIDER_REPORTED",
    created_at: new Date("2026-11-04T09:30:01.000Z"), settled_at: new Date("2026-11-04T09:30:01.000Z"),
  }).execute();

  // in-flight 完成结算：已有行 UPDATE（缺口①对象）＋计量/账本新行。
  await sql`UPDATE ai_request SET status = 'SUCCEEDED', finished_at = ${new Date("2026-11-04T09:45:00.000Z")} WHERE id = ${fixture.inflightRequestId}::uuid`.execute(db);
  await sql`UPDATE upstream_attempt SET finished_at = ${new Date("2026-11-04T09:45:00.500Z")}, http_status = 200, response_committed = true WHERE id = ${fixture.inflightAttemptId}::uuid`.execute(db);
  const inflightUsageId = await db.insertInto("usage_event").values({
    enterprise_id: fixture.enterpriseId, ai_request_id: fixture.inflightRequestId,
    upstream_attempt_id: fixture.inflightAttemptId, provider_resource_id: fixture.resourceReadyId,
    input_tokens: 500n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n,
    usage_quality: "PROVIDER_REPORTED", dedup_key: `${fixture.inflightRequestId}:settle`,
    created_at: new Date("2026-11-04T09:45:00.500Z"),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({
    enterprise_id: fixture.enterpriseId, ai_request_id: fixture.inflightRequestId,
    upstream_attempt_id: fixture.inflightAttemptId, usage_event_id: inflightUsageId,
    provider_resource_id: fixture.resourceReadyId, principal_id: fixture.principalId,
    resource_mode: "API", raw_input_tokens: 500n, raw_output_tokens: 100n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: AMOUNT_INFLIGHT, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    billing_rule_snapshot: { sourceStatus: "VERIFIED" }, usage_quality: "PROVIDER_REPORTED",
    settled_at: new Date("2026-11-04T09:45:00.500Z"), created_at: new Date("2026-11-04T09:45:00.500Z"),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    enterprise_id: fixture.enterpriseId, ai_request_id: fixture.inflightRequestId,
    principal_id: fixture.principalId, total_input_tokens: 500n, total_output_tokens: 100n,
    total_cache_tokens: 0n, total_reasoning_tokens: 0n, total_deducted_quota: 0n,
    total_api_cost: AMOUNT_INFLIGHT, api_cost_status: "PRICED_USAGE", overage: false,
    usage_quality: "PROVIDER_REPORTED", attempt_count: 1, status: "SETTLED",
    created_at: new Date("2026-11-04T09:45:00.500Z"),
  }).execute();

  // 切换后新建 API 资源（0096：种入已退役 → 无 finance 行）。
  fixture.resourceCutoverId = await db.insertInto("provider_resource").values({
    enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
    name: "R4 切换后新建 API 资源", mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);

  // 切换后 billing_rule（含 0093 source_status——列交集回放 drift 探针）。
  await db.insertInto("billing_rule").values({
    enterprise_id: fixture.enterpriseId, provider_resource_id: fixture.resourceReadyId,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "r4-cutover-drift-v1", effective_from: new Date(0),
    cache_miss_price: "0.000002", multiplier: null, priority: 1000,
    source_status: "VERIFIED",
  }).execute();

  // R5-A：切换后消费 100 结算 → 累计计数行更新 900→1000（缺口①同型：已有行 UPDATE）。
  const r5a = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principal2Id, keyId: fixture.key2Id,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:50:00.000Z", amount: AMOUNT_R5A,
  });
  fixture.r5aRequestId = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:50:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  await sql`UPDATE quota_counter SET used_value = ${QUOTA_R5A_USED_LIVE}, updated_at = ${new Date("2026-11-04T09:50:01.000Z")} WHERE grant_id = ${fixture.grant2Id}::uuid`.execute(db);
  void r5a;

  // R5-B：备份后经既有授权流程新建累计授权＋计数行＋非零消费（结算后计数 200）。
  const grant3Rows = await sql<{ id: string }>`
    INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value, allow_overage)
    VALUES (${fixture.enterpriseId}::uuid, ${fixture.principal2Id}::uuid, 'deepseek', 'qianliu-r4-new', ${QUOTA_R5B_LIMIT}, false)
    RETURNING id
  `.execute(db);
  fixture.grant3Id = grant3Rows.rows[0]!.id;
  await db.insertInto("quota_counter").values({
    grant_id: fixture.grant3Id, used_value: QUOTA_R5B_USED, overage_value: 0n,
    period_anchor: new Date("2026-11-01T00:00:00.000Z"),
    updated_at: new Date("2026-11-04T09:55:01.000Z"),
  }).execute();
  const r5b = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principal2Id, keyId: fixture.key2Id,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:55:00.000Z", amount: AMOUNT_R5B,
  });
  fixture.r5bRequestId = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:55:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  void r5b;
}

interface ManifestTable {
  table: string;
  rows: number;
  inserted: number;
  updated: number;
  sha256: string;
  refPresent: string;
  columns: string[];
}

function parseManifest(text: string): { headers: Record<string, string>; tables: ManifestTable[] } {
  const headers: Record<string, string> = {};
  const tables: ManifestTable[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields[0] === "table") {
      const kv = fields.slice(2).filter((f) => f.includes("="));
      const get = (key: string) => kv.find((f) => f.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
      tables.push({
        table: fields[1]!, rows: Number(get("rows")), inserted: Number(get("inserted")),
        updated: Number(get("updated")), sha256: get("sha256"),
        refPresent: get("ref_present"), columns: get("columns").split(","),
      });
    } else if (fields.length === 2) {
      headers[fields[0]!] = fields[1]!;
    }
  }
  return { headers, tables };
}

describe.sequential("AT-X07 R4：主路线 v3 演练（全行比对增量→影子恢复→重放 0092→DO UPDATE 回放→retire→verify→swap）", () => {
  let container: StartedPostgreSqlContainer;
  let live: Db;
  let shadowDb: Db | undefined;
  let swappedLive: Db | undefined;
  let keepDb: Db | undefined;
  let fixture: Fixture;
  let tmpHost: string;
  let dumpHostPath: string;
  let outDir: string;
  let manifestPath: string;
  let retireLogPath: string;
  let preCutoverDigests: Record<string, string>;
  let liveDigests: Record<string, string>;

  beforeAll(async () => {
    expect(existsSync(DELTA_SCRIPT), `交付脚本缺失: ${DELTA_SCRIPT}`).toBe(true);
    expect(existsSync(LEGACY_CHECK_SCRIPT), `legacy 检查脚本缺失: ${LEGACY_CHECK_SCRIPT}`).toBe(true);
    spawnSync("docker", ["rm", "-f", CONTAINER_NAME], { encoding: "utf8" });
    container = await new PostgreSqlContainer(
      "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
    ).withDatabase(LIVE_DB).withUsername("qianliu_test").withPassword("qianliu_test_only")
      .withName(CONTAINER_NAME).start();
    live = createKysely(container.getConnectionUri());
    tmpHost = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/wp6-r4-drill-`);
    dumpHostPath = resolve(tmpHost, "backup.dump");
    outDir = resolve(tmpHost, "delta-out");
    manifestPath = resolve(outDir, "manifest.tsv");
    retireLogPath = resolve(tmpHost, "threshold-retirement.log");

    const upTo0091 = await createMigrator(live).migrateTo(HEAD_0091);
    expect(upTo0091.error).toBeUndefined();
    expect(await migrationHead(live)).toBe(HEAD_0091);
    fixture = await seedT0(live);
    preCutoverDigests = await whitelistDigests(live, fixture.enterpriseId);

    await containerExec(container, [
      "pg_dump", "-Fc", "-U", "qianliu_test", "-d", LIVE_DB, "-f", DUMP_IN_CONTAINER,
    ]);
    const sizeOut = await containerExec(container, ["wc", "-c", DUMP_IN_CONTAINER]);
    expect(Number(sizeOut.trim().split(/\s+/)[0])).toBeGreaterThan(0);
    const cp = spawnSync("docker", ["cp", `${CONTAINER_NAME}:${DUMP_IN_CONTAINER}`, dumpHostPath], { encoding: "utf8" });
    expect(cp.status).toBe(0);
    logCommand(`docker cp ${CONTAINER_NAME}:${DUMP_IN_CONTAINER} ${dumpHostPath}`, cp.status);
    expect(spawnSync("wc", ["-c", dumpHostPath], { encoding: "utf8" }).stdout.trim()).toMatch(/[1-9]/);

    const executed = await migrateToLatest(live);
    for (const head of ["0092_employee_monthly_quota", "0093_billing_rule_source_status",
      "0094_retire_api_finance_pending_admission", "0095_official_balance_sync_decouple", HEAD_0096]) {
      expect(executed).toContain(head);
    }
    expect(await migrationHead(live)).toBe(HEAD_0096);
    await seedCutover(live, fixture);
    liveDigests = await whitelistDigests(live, fixture.enterpriseId);
    for (const [table, digest] of Object.entries(liveDigests)) {
      expect(digest.startsWith("ABSENT:"), `live 摘要 ${table} 不应缺席`).toBe(false);
    }
  }, 360_000);

  afterAll(async () => {
    const evidenceDir = process.env.WP6_R4_EVIDENCE_DIR;
    if (evidenceDir) {
      writeFileSync(resolve(evidenceDir, "wp6-rollback-replay-drill-commands.json"),
        `${JSON.stringify(COMMAND_LOG, null, 2)}\n`);
    }
    await live?.destroy();
    await shadowDb?.destroy();
    await swappedLive?.destroy();
    await keepDb?.destroy();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    await container?.stop();
  }, 90_000);

  it("断言 A：check-contract＋全行比对增量导出——inserted/updated/rows/sha256 与期望逐表一致（缺口①）", async () => {
    const contract = runDeltaScript(["check-contract", "--container", CONTAINER_NAME, "--db-live", LIVE_DB]);
    expectScriptOk(contract);
    expect(contract.stdout).toContain("check-contract: OK");
    const exportResult = runDeltaScript([
      "export", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-ref", REF_DB,
      "--dump-file", dumpHostPath, "--out-dir", outDir,
    ]);
    expectScriptOk(exportResult);
    expect(await migrationHead(live)).toBe(HEAD_0096);
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    expect(manifest.headers["manifest_version"]).toBe("wp6-r4-1");
    expect(manifest.headers["live_migration_head"]).toBe(HEAD_0096);
    expect(manifest.headers["ref_migration_head"]).toBe(HEAD_0091);
    for (const table of WHITELIST) {
      const row = manifest.tables.find((t) => t.table === table);
      expect(row, `清单缺表 ${table}`).toBeDefined();
      const expected = EXPECTED_DELTA[table];
      expect(row!.rows, `表 ${table} 增量行数`).toBe(expected.rows);
      expect(row!.inserted, `表 ${table} inserted（缺口①）`).toBe(expected.inserted);
      expect(row!.updated, `表 ${table} updated（缺口①：已有行更新入增量）`).toBe(expected.updated);
      expect(row!.refPresent,
        `表 ${table} ref 快照在位标记（0092 域表备份点必无）`)
        .toBe((ONLY_0092_TABLES as readonly string[]).includes(table) ? "no" : "yes");
      const artifact = readFileSync(resolve(outDir, `${table}.copy`));
      expect(createHash("sha256").update(artifact).digest("hex")).toBe(row!.sha256);
      expect(artifact.toString("utf8").split("\n").filter((line) => line !== "").length).toBe(row!.rows);
    }
    // 更新行内容抽核：in-flight 请求状态与 grant 收紧值在增量中。
    const requestArtifact = readFileSync(resolve(outDir, "ai_request.copy"), "utf8");
    expect(requestArtifact).toContain(fixture.inflightRequestId);
    expect(requestArtifact).toContain("SUCCEEDED");
    const grantArtifact = readFileSync(resolve(outDir, "principal_grant.copy"), "utf8");
    expect(grantArtifact).toContain("100000");
    expect(grantArtifact).toContain("RAW_TOKEN");
    const enterpriseArtifact = readFileSync(resolve(outDir, "enterprise.copy"), "utf8");
    expect(enterpriseArtifact).toContain(fixture.enterpriseId);
    logCommand("manifest-parse", 0,
      JSON.stringify(Object.fromEntries(manifest.tables.map((t) => [t.table, `${t.rows}/${t.inserted}/${t.updated}`]))));
  }, 240_000);

  it("断言 B（负向）：导出失败中止——exit 非 0、live 不动、既有清单不受污染；restore 确认门拒绝", async () => {
    const missingDump = resolve(tmpHost, "does-not-exist.dump");
    const failed = runDeltaScript([
      "export", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-ref", REF_DB,
      "--dump-file", missingDump, "--out-dir", resolve(tmpHost, "delta-out-failed"),
    ]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("FAIL-CLOSED");
    expect(await migrationHead(live)).toBe(HEAD_0096);
    expect(await whitelistDigests(live, fixture.enterpriseId)).toEqual(liveDigests);
    const manifest = readFileSync(manifestPath, "utf8");
    const declared = manifest.split("\n").find((line) => line.startsWith("manifest_done"))!.split("\t")[1]!;
    const body = manifest.split("\n").filter((line) => line !== "" && !line.startsWith("manifest_done")).join("\n");
    expect(createHash("sha256").update(`${body}\n`).digest("hex")).toBe(declared);
    const noConfirm = runDeltaScript([
      "restore", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--dump-file", dumpHostPath,
    ]);
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("ROLLBACK_DELTA_CONFIRM");
  }, 240_000);

  it("断言 C：影子恢复——live 物理未动（缺口②），影子＝备份点逐字，0092 域不存在", async () => {
    const restoreResult = runDeltaScript([
      "restore", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--dump-file", dumpHostPath,
    ], { ROLLBACK_DELTA_CONFIRM: "YES" });
    expectScriptOk(restoreResult);
    // live 未动（水位＋17 表摘要逐字）。
    expect(await migrationHead(live)).toBe(HEAD_0096);
    expect(await whitelistDigests(live, fixture.enterpriseId)).toEqual(liveDigests);
    shadowDb = createKysely(swapDbName(container.getConnectionUri(), SHADOW_DB));
    expect(await migrationHead(shadowDb)).toBe(HEAD_0091);
    expect(await whitelistDigests(shadowDb, fixture.enterpriseId)).toEqual(preCutoverDigests);
    expect(await tableExists(shadowDb, "principal_quota_period")).toBe(false);
    expect(await tableExists(shadowDb, "principal_quota_usage")).toBe(false);
    expect(await openingOrRechargeEventCount(shadowDb, fixture.enterpriseId)).toBe("0");
    const trigger = await sql<{ tgenabled: string }>`
      SELECT tgenabled FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal
    `.execute(shadowDb);
    expect(trigger.rows[0]?.tgenabled).toBe("O");
  }, 240_000);

  it("断言 D：重放 0092＋增量回放（DO UPDATE）——17 表影子摘要＝live 摘要（含 in-flight 更新逐字）", async () => {
    const replay0092 = await createMigrator(shadowDb!).migrateTo(HEAD_0092);
    expect(replay0092.error).toBeUndefined();
    expect(await migrationHead(shadowDb!)).toBe(HEAD_0092);
    expect(await tableExists(shadowDb!, "principal_quota_period")).toBe(true);

    const replayResult = runDeltaScript([
      "replay", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--manifest", manifestPath, "--delta-dir", outDir,
    ]);
    expectScriptOk(replayResult);
    for (const table of WHITELIST) {
      const expected = EXPECTED_DELTA[table].rows;
      if (expected === 0) {
        expect(replayResult.stdout.match(new RegExp(`REPLAY_RESULT table=${table} applied=`)), `表 ${table} 不应产生回放输出`).toBeNull();
        continue;
      }
      const match = replayResult.stdout.match(new RegExp(`REPLAY_RESULT table=${table} applied=(\\d+)`));
      expect(match, `表 ${table} 回放输出缺失`).not.toBeNull();
      expect(Number(match![1]!)).toBe(expected);
    }
    // 「备份点摘要＋增量摘要＝回放后摘要」（R4 语义：全行比对含更新；billing_rule 剔除 drift 列）。
    const postReplayDigests = await whitelistDigests(shadowDb!, fixture.enterpriseId);
    expect(postReplayDigests).toEqual(liveDigests);
    // 缺口①逐值抽核：in-flight 结算态、attempt 完成态、grant 收紧、企业额度启用。
    const req = await sql<{ status: string; finished_at: Date | null }>`
      SELECT status, finished_at FROM ai_request WHERE id = ${fixture.inflightRequestId}::uuid`.execute(shadowDb!);
    expect(req.rows[0]!.status).toBe("SUCCEEDED");
    expect(req.rows[0]!.finished_at).not.toBeNull();
    const att = await sql<{ finished_at: Date | null; response_committed: boolean }>`
      SELECT finished_at, response_committed FROM upstream_attempt WHERE id = ${fixture.inflightAttemptId}::uuid`.execute(shadowDb!);
    expect(att.rows[0]!.finished_at).not.toBeNull();
    expect(att.rows[0]!.response_committed).toBe(true);
    const grant = await sql<{ quota_value: string; allow_overage: boolean; quota_basis: string | null }>`
      SELECT quota_value::text AS quota_value, allow_overage, quota_basis FROM principal_grant WHERE id = ${fixture.grantId}::uuid`.execute(shadowDb!);
    expect(grant.rows[0]!.quota_value).toBe("100000");
    expect(grant.rows[0]!.allow_overage).toBe(false);
    expect(grant.rows[0]!.quota_basis).toBe("RAW_TOKEN");
    const ent = await sql<{ monthly_from: Date | null }>`
      SELECT employee_quota_monthly_from AS monthly_from FROM enterprise WHERE id = ${fixture.enterpriseId}::uuid`.execute(shadowDb!);
    expect(ent.rows[0]!.monthly_from).not.toBeNull();
    expect(await openingOrRechargeEventCount(shadowDb!, fixture.enterpriseId)).toBe("0");
    const estimation = await loadApiCostEstimation(shadowDb!, fixture.enterpriseId, {
      start: new Date(WINDOW.start), end: new Date(WINDOW.end),
      resourceIds: [fixture.resourceReadyId],
    });
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: WINDOW_ESTIMATED_CNY }]);
  }, 240_000);

  it("断言 E：幂等回放——二次回放 applied＝清单行数、17 表摘要不变（DO UPDATE 结果不变）", async () => {
    const second = runDeltaScript([
      "replay", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--manifest", manifestPath, "--delta-dir", outDir,
    ]);
    expectScriptOk(second);
    for (const table of WHITELIST) {
      if (EXPECTED_DELTA[table].rows === 0) continue;
      const match = second.stdout.match(new RegExp(`REPLAY_RESULT table=${table} applied=(\\d+)`));
      expect(match, `表 ${table} 二次回放输出缺失`).not.toBeNull();
      expect(Number(match![1]!)).toBe(EXPECTED_DELTA[table].rows);
    }
    expect(await whitelistDigests(shadowDb!, fixture.enterpriseId)).toEqual(liveDigests);
    // R5-C：累计计数不被重复累计（二次回放后仍＝live 值 1000，非 1900/900）。
    const counterAfterSecond = await sql<{ used_value: string }>`
      SELECT used_value::text AS used_value FROM quota_counter
       WHERE grant_id = ${fixture.grant2Id}::uuid`.execute(shadowDb!);
    expect(counterAfterSecond.rows[0]!.used_value).toBe(QUOTA_R5A_USED_LIVE.toString());
    expect(await openingOrRechargeEventCount(shadowDb!, fixture.enterpriseId)).toBe("0");
    // 回放后触发器回到 ENABLED（0091 语义；retire-threshold 随后退役保持）。
    const trigger = await sql<{ tgenabled: string }>`
      SELECT tgenabled FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal
    `.execute(shadowDb!);
    expect(trigger.rows[0]?.tgenabled).toBe("O");
  }, 240_000);

  it("断言 F：retire-threshold（缺口④）——触发器/函数退役、API PENDING 控制行清零且留档、额度域与 READY 事实原样", async () => {
    const retire = runDeltaScript([
      "retire-threshold", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--log", retireLogPath,
    ]);
    expectScriptOk(retire);
    // 留档内容（删除前计数进日志——控制行非资金事实）。
    const log = readFileSync(retireLogPath, "utf8");
    expect(log).toContain("RETIRE pending_api_before=1");
    expect(log).toContain("RETIRE pending_api_after=0");
    expect(log).toContain("RETIRE finance_state_rows_before=2");
    expect(log).toContain("RETIRE finance_state_rows_after=1");
    expect(log).toContain("RETIRE seed_trigger_present=0");
    expect(log).toContain("RETIRE seed_function_present=0");
    // 影子状态：触发器/函数已退役；PENDING 控制行清零；READY 事实保留。
    const trg = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal) AS present`.execute(shadowDb!);
    expect(trg.rows[0]!.present).toBe(false);
    const fun = await sql<{ present: boolean }>`
      SELECT to_regproc(${SEED_FUNCTION}) IS NOT NULL AS present`.execute(shadowDb!);
    expect(fun.rows[0]!.present).toBe(false);
    const pending = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM provider_resource_finance_state s
        JOIN provider_resource r ON r.enterprise_id = s.enterprise_id AND r.id = s.provider_resource_id
       WHERE s.state = 'PENDING' AND r.mode = 'API'`.execute(shadowDb!);
    expect(pending.rows[0]!.count).toBe("0");
    const states = await shadowDb!.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId).execute();
    expect(states.map((s) => [s.provider_resource_id === fixture.resourceReadyId ? "ready" : "other", s.state]))
      .toEqual([["ready", "READY"]]);
    // 组 3：额度域在位且受约束（DO UPDATE 保全的切换后事实）。
    const period = await shadowDb!.selectFrom("principal_quota_period").selectAll()
      .where("id", "=", fixture.periodId).executeTakeFirstOrThrow();
    expect(period.limit_value).toBe(QUOTA_LIMIT.toString());
    expect(period.used_value).toBe(QUOTA_USED_RESTORED.toString());
    expect(period.quota_basis).toBe("RAW_TOKEN");
    const usages = await shadowDb!.selectFrom("principal_quota_usage").selectAll()
      .where("period_id", "=", fixture.periodId).orderBy("created_at").execute();
    expect(usages.map((u) => [u.status, u.actual?.toString()])).toEqual([["SETTLED", "1200"], ["SETTLED", "700"]]);
    await expect(shadowDb!.insertInto("principal_quota_period").values({
      enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId, provider: "deepseek",
      period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
      period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
      quota_basis: "RAW_TOKEN", limit_value: 1n, allow_overage: false,
      used_value: 0n, open_grant_version: 1,
    }).execute()).rejects.toThrow();
    // 回放资源无 PENDING（回放期触发器禁用）＋enterprise 额度启用列保全。
    expect(await shadowDb!.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", fixture.resourceCutoverId).execute()).toEqual([]);
    const ent = await sql<{ monthly_from: Date | null }>`
      SELECT employee_quota_monthly_from AS monthly_from FROM enterprise WHERE id = ${fixture.enterpriseId}::uuid`.execute(shadowDb!);
    expect(ent.rows[0]!.monthly_from).not.toBeNull();
    expect(await openingOrRechargeEventCount(shadowDb!, fixture.enterpriseId)).toBe("0");
  }, 240_000);

  it("断言 G：verify 全过才 swap——单事务改名替换 live，keep＝切换后状态留档（缺口②）", async () => {
    const noConfirm = runDeltaScript([
      "swap", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--db-ref", REF_DB, "--manifest", manifestPath,
    ]);
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("ROLLBACK_DELTA_CONFIRM");
    const verify = runDeltaScript([
      "verify", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--db-ref", REF_DB, "--manifest", manifestPath,
    ]);
    expectScriptOk(verify);
    expect(verify.stdout).toContain("verify: OK");
    expect(verify.stdout.match(/table=\S+ digest=match/g)?.length).toBe(WHITELIST.length);
    // 改名前断开既有池（旧连接绑定被改名库对象，避免误读）。
    await shadowDb!.destroy();
    await live.destroy();
    const swap = runDeltaScript([
      "swap", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-shadow", SHADOW_DB,
      "--db-ref", REF_DB, "--manifest", manifestPath,
    ], { ROLLBACK_DELTA_CONFIRM: "YES" });
    expectScriptOk(swap);
    const admin = createKysely(container.getConnectionUri());
    const dbs = await sql<{ datname: string }>`
      SELECT datname FROM pg_database WHERE datname IN (${LIVE_DB}, ${KEEP_DB}, ${SHADOW_DB})`.execute(admin);
    expect(dbs.rows.map((r) => r.datname).sort()).toEqual([KEEP_DB, LIVE_DB].sort());
    await admin.destroy();
    swappedLive = createKysely(swapDbName(container.getConnectionUri(), LIVE_DB));
    keepDb = createKysely(swapDbName(container.getConnectionUri(), KEEP_DB));
    expect(await migrationHead(swappedLive)).toBe(HEAD_0092);
    expect(await whitelistDigests(swappedLive, fixture.enterpriseId)).toEqual(liveDigests);
    // keep＝切换后状态留档（水位 0096＋摘要＝live 导出时摘要）。
    expect(await migrationHead(keepDb)).toBe(HEAD_0096);
    expect(await whitelistDigests(keepDb, fixture.enterpriseId)).toEqual(liveDigests);
  }, 240_000);

  it("断言 H：门槛退役保持（缺口④）——回退后新建资源无 PENDING；触发器与函数不存在", async () => {
    const trg = await sql<{ present: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal) AS present`.execute(swappedLive!);
    expect(trg.rows[0]!.present).toBe(false);
    const fun = await sql<{ present: boolean }>`
      SELECT to_regproc(${SEED_FUNCTION}) IS NOT NULL AS present`.execute(swappedLive!);
    expect(fun.rows[0]!.present).toBe(false);
    const newResourceId = await swappedLive!.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
      name: "R4 回退后新建 API 资源", mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    fixture.postRollbackResourceId = newResourceId;
    expect(await swappedLive!.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", newResourceId).execute()).toEqual([]);
    const newPlanId = await swappedLive!.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
      name: "R4 回退后新建 CODING_PLAN 资源", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    expect(await swappedLive!.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", newPlanId).execute()).toEqual([]);
    expect(await openingOrRechargeEventCount(swappedLive!, fixture.enterpriseId)).toBe("0");
  }, 240_000);

  it("断言 I：旧栈（ae506fe）真实路径——准入可服务、消费逐字、窗口聚合、额度门 REJECT_EXHAUSTED、结算累计 used（缺口③④）", async () => {
    const legacyFixture = {
      enterpriseId: fixture.enterpriseId,
      principalId: fixture.principalId,
      principal2Id: fixture.principal2Id,
      keyId: fixture.keyId,
      key2Id: fixture.key2Id,
      grant2Id: fixture.grant2Id,
      grant3Id: fixture.grant3Id,
      resourceReadyId: fixture.resourceReadyId,
      resourcePendingId: fixture.resourcePendingId,
      resourceCutoverId: fixture.resourceCutoverId,
      postRollbackResourceId: fixture.postRollbackResourceId,
      preRequest: fixture.preRequestId,
      cutRequest1: fixture.cutRequest1Id,
      cutRequest2: fixture.cutRequest2Id,
      inflightRequest: fixture.inflightRequestId,
      r5aRequest: fixture.r5aRequestId,
      r5bRequest: fixture.r5bRequestId,
      amounts: { pre: AMOUNT_PRE, cut1: AMOUNT_CUT1, cut2: AMOUNT_CUT2, inflight: AMOUNT_INFLIGHT, legacySettle: AMOUNT_LEGACY_SETTLE, r5a: AMOUNT_R5A, r5b: AMOUNT_R5B },
      window: WINDOW,
      modelAliasExact: "qianliu-r4-deepseek",
      modelAliasNew: "qianliu-r4-new",
      expected: {
        periodKey: "2026-11", limitValue: QUOTA_LIMIT.toString(),
        usedValueRestored: QUOTA_USED_RESTORED.toString(),
        usedValueAfterSettle: QUOTA_USED_AFTER_SETTLE,
        windowTotalCny: WINDOW_ESTIMATED_CNY,
        c1Estimate: QUOTA_C1_ESTIMATE, c2Estimate: QUOTA_C2_ESTIMATE,
        counter2UsedLive: QUOTA_R5A_USED_LIVE.toString(),
        r5aEstimate: "1",
        r5bLimit: QUOTA_R5B_LIMIT.toString(),
        r5bReserve: QUOTA_R5B_RESERVE.toString(),
        r5bActual: QUOTA_R5B_ACTUAL.toString(),
        r5bUsedAfter: QUOTA_R5B_USED_AFTER.toString(),
        r5bOverEstimate: "1000",
      },
    };
    const fixturePath = resolve(tmpHost, "legacy-fixture.json");
    const legacyOutPath = resolve(tmpHost, "legacy-result.json");
    writeFileSync(fixturePath, `${JSON.stringify(legacyFixture, null, 2)}\n`);
    try {
      execFileSync(LEGACY_TSX, [LEGACY_CHECK_SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: swapDbName(container.getConnectionUri(), LIVE_DB),
          WP6_R4_FIXTURE_JSON: fixturePath,
          WP6_R4_LEGACY_OUTPUT: legacyOutPath,
        },
        timeout: 120_000,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number };
      logCommand("legacy-read-check", failure.status ?? -1, (failure.stderr ?? failure.stdout ?? "").slice(0, 3000));
      throw new Error(`legacy 读检查失败: ${failure.stderr ?? error}`);
    }
    logCommand("legacy-read-check", 0, "ok");
    const report = JSON.parse(readFileSync(legacyOutPath, "utf8")) as Record<string, Record<string, unknown>>;
    // 准入（缺口④）：READY/无 finance 行/原 PENDING（控制行删除后）/回退后新建 全部可服务。
    const admission = report.admission!;
    expect(admission.readyResource_included).toBe(true);
    expect(admission.cutoverResource_noFinanceRow_included).toBe(true);
    expect(admission.formerPendingResource_nowServable_included).toBe(true);
    expect(admission.postRollbackNewResource_noPending_included).toBe(true);
    // 可读（缺口①）：备份点＋切换后＋in-flight 结算金额逐字。
    const reads = report.readConsumptionFacts!;
    for (const key of ["preBackup", "cutover1", "cutover2", "inflightSettled"]) {
      expect((reads[key] as Record<string, unknown>).amountMatchesSeed).toBe(true);
    }
    // 窗口聚合。
    expect((report.windowOperatingFinance!).sumMatches).toBe(true);
    // 额度行还原值。
    expect((report.employeeQuotaRestored!).limitMatches).toBe(true);
    expect((report.employeeQuotaRestored!).usedMatches).toBe(true);
    // 缺口③①：超额请求经真实额度门被拒（MONTHLY 模式＋额度语义拒绝＋reserved 未变）。
    const gate = report.quotaGateOverLimit!;
    expect(gate.monthlyMode).toBe(true);
    expect(gate.rejectedWithQuotaReason).toBe(true);
    expect(gate.decision).toBe("REJECT_EXHAUSTED");
    expect(gate.periodReservedUnchanged).toBe(true);
    // 缺口③②：允许请求经旧栈结算路径落库、used 正确累计、usage SETTLED。
    const settle = report.quotaSettlementAccumulates!;
    expect((settle.reserved as Record<string, unknown>).reservedOk).toBe(true);
    expect(settle.usedAccumulatedCorrectly).toBe(true);
    expect(settle.usageSettled).toBe(true);
    expect(settle.usedAfter).toBe(QUOTA_USED_AFTER_SETTLE);
    // R5-A：已有累计计数保全（used=1000＝停写时 live 值）＋真实累计门拒绝超额且不改计数。
    const r5a = report.r5aCumulativeGate!;
    expect(r5a.usedMatchesLive).toBe(true);
    expect(r5a.rejectedWithQuotaReason).toBe(true);
    expect(r5a.decision).toBe("REJECT_EXHAUSTED");
    expect(r5a.counterUnchangedOnReject).toBe(true);
    // R5-B：新增授权与计数行随增量回放——预占/结算精确累计、grant_id 唯一、达上限拒绝、无计数缺失异常。
    const r5b = report.r5bNewGrantCumulative!;
    expect(r5b.reserveAllowed).toBe(true);
    expect(r5b.reserveAccumulatedPrecisely).toBe(true);
    expect(r5b.settleCorrectedPrecisely).toBe(true);
    expect(r5b.grantIdUniqueHeld).toBe(true);
    expect(r5b.overLimitRejected).toBe(true);
    expect(r5b.counterUnchangedOnOverReject).toBe(true);
    expect(r5b.noCounterMissingException).toBe(true);
    expect(r5b.counterAfterSettle).toMatchObject({ used_value: QUOTA_R5B_USED_AFTER.toString() });
    // 旧结算写路径仍可落库可读。
    const legacySettle = report.settleNewConsumption!;
    expect(legacySettle.created).toBe(true);
    expect(legacySettle.newLine).toMatchObject({ api_cost: AMOUNT_LEGACY_SETTLE, api_cost_currency: "CNY" });
    // 红线 2 终核：全部真实路径动作后 finance 事件仍为 0。
    expect(await openingOrRechargeEventCount(swappedLive!, fixture.enterpriseId)).toBe("0");
    const evidenceDir = process.env.WP6_R4_EVIDENCE_DIR;
    if (evidenceDir) {
      writeFileSync(resolve(evidenceDir, "wp6-r5-legacy-read-check.result.json"),
        `${JSON.stringify(report, null, 2)}\n`);
    }
  }, 240_000);

  it("断言 J（缺口②绿证场景）：消费引用备份后新建订阅周期——影子内回放失败＝删影子、live 完好", async () => {
    const J_LIVE = "wp6_r4_j_live";
    let jDb: Db | undefined;
    const J_REF = "wp6_r4_j_ref";
    const J_SHADOW = "wp6_r4_j_shadow";
    const cr = spawnSync("docker", ["exec", CONTAINER_NAME, "sh", "-c", `createdb -U qianliu_test ${J_LIVE}`], { encoding: "utf8" });
    expect(cr.status).toBe(0);
    jDb = createKysely(swapDbName(container.getConnectionUri(), J_LIVE));
    try {
    const upTo0091 = await createMigrator(jDb).migrateTo(HEAD_0091);
    expect(upTo0091.error).toBeUndefined();
    const jFx = await seedT0(jDb);
    const jDumpContainer = "/tmp/wp6-r4-j.dump";
    await containerExec(container, ["pg_dump", "-Fc", "-U", "qianliu_test", "-d", J_LIVE, "-f", jDumpContainer]);
    const jDumpHost = resolve(tmpHost, "j.dump");
    expect(spawnSync("docker", ["cp", `${CONTAINER_NAME}:${jDumpContainer}`, jDumpHost], { encoding: "utf8" }).status).toBe(0);
    await createMigrator(jDb).migrateToLatest();
    // 切换后：CODING_PLAN 资源＋订阅周期（白名单外表，不回放）＋引用它的消费。
    const planResourceId = await jDb.insertInto("provider_resource").values({
      enterprise_id: jFx.enterpriseId, provider_id: jFx.providerId,
      name: "R4 J Coding Plan 资源", mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const periodRow = await jDb.insertInto("provider_subscription_period").values({
      enterprise_id: jFx.enterpriseId, provider_resource_id: planResourceId,
      product_name: "R4 J Coding Plan", period_start: new Date("2026-10-31T16:00:00.000Z"),
      period_end_exclusive: new Date("2026-11-30T16:00:00.000Z"),
      source: "MIGRATED_CARRYOVER", created_by_admin_user_id: jFx.adminId,
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const requestJ = randomUUID();
    await jDb.insertInto("ai_request").values({
      id: requestJ, enterprise_id: jFx.enterpriseId, principal_id: jFx.principalId,
      principal_key_id: jFx.keyId, protocol: "chat", unified_model: "deepseek-chat",
      status: "SUCCEEDED", started_at: new Date("2026-11-04T10:00:00.000Z"),
      finished_at: new Date("2026-11-04T10:00:01.000Z"),
    }).execute();
    const attJ = await jDb.insertInto("upstream_attempt").values({
      enterprise_id: jFx.enterpriseId, ai_request_id: requestJ, attempt_no: 1,
      provider_resource_id: planResourceId, upstream_model: "deepseek-chat",
      http_status: 200, response_committed: true, finished_at: new Date("2026-11-04T10:00:01.000Z"),
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const usageJ = await jDb.insertInto("usage_event").values({
      enterprise_id: jFx.enterpriseId, ai_request_id: requestJ, upstream_attempt_id: attJ,
      provider_resource_id: planResourceId, input_tokens: 800n, output_tokens: 100n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: requestJ, created_at: new Date("2026-11-04T10:00:01.000Z"),
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const jLineVals = {
      enterprise_id: jFx.enterpriseId, ai_request_id: requestJ, upstream_attempt_id: attJ,
      usage_event_id: usageJ, provider_resource_id: planResourceId, principal_id: jFx.principalId,
      resource_mode: "CODING_PLAN", raw_input_tokens: 800n, raw_output_tokens: 100n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n, api_cost: null, api_cost_currency: null,
      api_cost_status: "NOT_APPLICABLE", subscription_period_id: periodRow,
      usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T10:00:01.000Z"),
      created_at: new Date("2026-11-04T10:00:01.000Z"),
    } as Record<string, unknown>;
    await jDb.insertInto("ledger_line").values(jLineVals as never).execute();
    await jDb.insertInto("ledger_transaction").values({
      enterprise_id: jFx.enterpriseId, ai_request_id: requestJ, principal_id: jFx.principalId,
      total_input_tokens: 800n, total_output_tokens: 100n, total_cache_tokens: 0n,
      total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: "0",
      api_cost_status: "NOT_APPLICABLE", overage: false, usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T10:00:01.000Z"),
    }).execute();

    const jOut = resolve(tmpHost, "j-out");
    expectScriptOk(runDeltaScript([
      "export", "--container", CONTAINER_NAME, "--db-live", J_LIVE, "--db-ref", J_REF,
      "--dump-file", jDumpHost, "--out-dir", jOut,
    ]));
    expectScriptOk(runDeltaScript([
      "restore", "--container", CONTAINER_NAME, "--db-live", J_LIVE, "--db-shadow", J_SHADOW,
      "--dump-file", jDumpHost,
    ], { ROLLBACK_DELTA_CONFIRM: "YES" }));
    const jShadow = createKysely(swapDbName(container.getConnectionUri(), J_SHADOW));
    expect((await createMigrator(jShadow).migrateTo(HEAD_0092)).error).toBeUndefined();
    await jShadow.destroy();
    const replayExit = runDeltaScript([
      "replay", "--container", CONTAINER_NAME, "--db-live", J_LIVE, "--db-shadow", J_SHADOW,
      "--manifest", resolve(jOut, "manifest.tsv"), "--delta-dir", jOut,
    ]);
    expect(replayExit.status).not.toBe(0);
    // live 完好（缺口②绿证）：水位 0096＋切换后消费与订阅周期仍在＋影子已删。
    expect(await migrationHead(jDb)).toBe(HEAD_0096);
    const kept = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM ai_request WHERE enterprise_id = ${jFx.enterpriseId}::uuid
        AND started_at = ${new Date("2026-11-04T10:00:00.000Z")}`.execute(jDb);
    expect(kept.rows[0]!.count).toBe("1");
    const periods = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM provider_subscription_period
       WHERE enterprise_id = ${jFx.enterpriseId}::uuid`.execute(jDb);
    expect(periods.rows[0]!.count).toBe("1");
    const shadowGone = await sql<{ exists: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${J_SHADOW}) AS exists`.execute(jDb!);
    expect(shadowGone.rows[0]!.exists).toBe(false);
    } finally {
      await jDb?.destroy();
    }
  }, 360_000);

  it("断言 K（R5-C）：影子计数摘要篡改→verify fail-closed＝删影子、live 水位/消费/计数不变；回放重复执行计数不重复累计", async () => {
    const K_LIVE = "wp6_r4_k_live";
    const K_REF = "wp6_r4_k_ref";
    const K_SHADOW = "wp6_r4_k_shadow";
    const cr = spawnSync("docker", ["exec", CONTAINER_NAME, "sh", "-c", `createdb -U qianliu_test ${K_LIVE}`], { encoding: "utf8" });
    expect(cr.status).toBe(0);
    let kDb: Db | undefined;
    try {
      kDb = createKysely(swapDbName(container.getConnectionUri(), K_LIVE));
      const upTo0091 = await createMigrator(kDb).migrateTo(HEAD_0091);
      expect(upTo0091.error).toBeUndefined();
      const kFx = await seedT0(kDb);
      const kDumpContainer = "/tmp/wp6-r4-k.dump";
      await containerExec(container, ["pg_dump", "-Fc", "-U", "qianliu_test", "-d", K_LIVE, "-f", kDumpContainer]);
      const kDumpHost = resolve(tmpHost, "k.dump");
      expect(spawnSync("docker", ["cp", `${CONTAINER_NAME}:${kDumpContainer}`, kDumpHost], { encoding: "utf8" }).status).toBe(0);
      await createMigrator(kDb).migrateToLatest();
      // 切换后：累计计数更新 900→1000（R5-A 同型）。
      await sql`UPDATE quota_counter SET used_value = ${QUOTA_R5A_USED_LIVE}, updated_at = ${new Date("2026-11-04T09:50:01.000Z")} WHERE grant_id = ${kFx.grant2Id}::uuid`.execute(kDb);

      const kOut = resolve(tmpHost, "k-out");
      expectScriptOk(runDeltaScript([
        "export", "--container", CONTAINER_NAME, "--db-live", K_LIVE, "--db-ref", K_REF,
        "--dump-file", kDumpHost, "--out-dir", kOut,
      ]));
      expectScriptOk(runDeltaScript([
        "restore", "--container", CONTAINER_NAME, "--db-live", K_LIVE, "--db-shadow", K_SHADOW,
        "--dump-file", kDumpHost,
      ], { ROLLBACK_DELTA_CONFIRM: "YES" }));
      const kShadow = createKysely(swapDbName(container.getConnectionUri(), K_SHADOW));
      expect((await createMigrator(kShadow).migrateTo(HEAD_0092)).error).toBeUndefined();
      expectScriptOk(runDeltaScript([
        "replay", "--container", CONTAINER_NAME, "--db-live", K_LIVE, "--db-shadow", K_SHADOW,
        "--manifest", resolve(kOut, "manifest.tsv"), "--delta-dir", kOut,
      ]));
      // 回放重复执行（R5-C 幂等）：计数不重复累计。
      expectScriptOk(runDeltaScript([
        "replay", "--container", CONTAINER_NAME, "--db-live", K_LIVE, "--db-shadow", K_SHADOW,
        "--manifest", resolve(kOut, "manifest.tsv"), "--delta-dir", kOut,
      ]));
      const counterAfterReplays = await sql<{ used_value: string }>`
        SELECT used_value::text AS used_value FROM quota_counter
         WHERE grant_id = ${kFx.grant2Id}::uuid`.execute(kShadow);
      expect(counterAfterReplays.rows[0]!.used_value).toBe(QUOTA_R5A_USED_LIVE.toString());
      await kShadow.destroy();
      // 影子中制造计数摘要不一致（通过影子连接——live 不动）。
      const kShadowTamper = createKysely(swapDbName(container.getConnectionUri(), K_SHADOW));
      await sql`UPDATE quota_counter SET used_value = 42 WHERE grant_id = ${kFx.grant2Id}::uuid`.execute(kShadowTamper);
      await kShadowTamper.destroy();
      const verifyResult = runDeltaScript([
        "verify", "--container", CONTAINER_NAME, "--db-live", K_LIVE, "--db-shadow", K_SHADOW,
        "--db-ref", K_REF, "--manifest", resolve(kOut, "manifest.tsv"),
      ]);
      expect(verifyResult.status).not.toBe(0);
      // 摘要失败＝删影子、live 原水位/消费/计数不变、不切换。
      const shadowGone = await sql<{ exists: boolean }>`
        SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${K_SHADOW}) AS exists`.execute(kDb);
      expect(shadowGone.rows[0]!.exists).toBe(false);
      expect(await migrationHead(kDb)).toBe(HEAD_0096);
      const counterLive = await sql<{ used_value: string }>`
        SELECT used_value::text AS used_value FROM quota_counter
         WHERE grant_id = ${kFx.grant2Id}::uuid`.execute(kDb);
      expect(counterLive.rows[0]!.used_value).toBe(QUOTA_R5A_USED_LIVE.toString());
      const consumption = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM ai_request WHERE enterprise_id = ${kFx.enterpriseId}::uuid`.execute(kDb);
      expect(Number(consumption.rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await kDb?.destroy();
    }
  }, 360_000);
});
