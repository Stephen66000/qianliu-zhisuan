/**
 * AT-X07 R3 重开返修演练——主路线 v2：整库备份恢复＋增量回放（acceptance-plan §6 X07
 * 语义不变：「新消费仍可读/结算且受原额度约束，不要求补虚构期初、不丢数据；
 * 不能仅恢复不兼容旧服务」；验收人退回 WP6 的修复＝主路线不再丢失切换后新消费）。
 *
 * 全程通过交付脚本 deploy/scripts/rollback-delta-20261106.sh 执行 export/restore/replay
 * （容器内 pg 工具；脚本子命令与生产操作单同款），演练断言其行为与清单闭环。
 *
 * 时序（镜像生产操作单 §6.1 v2）：
 *   0. 0091 水位（生产现状，§8.1 回执）＋T0 播种（激活企业/READY 资源/存量 PENDING
 *      留档/员工授权/统一模型/路由/计价/一笔切换前消费——零资金事实）→ 发布前备份
 *      （pg_dump -Fc，§4.1 同款）。
 *   1. 切换：migrateToLatest（0092→0096 五个，T2 同型）。
 *   2. 切换后新数据：两笔新消费（0.00060000/0.00040000，X08 T4 量级）＋员工月度
 *      额度域（period＋两笔 SETTLED usage）＋新建 API 资源（0094 后无 finance 行）
 *      ＋切换后 billing_rule（含 0093 source_status 列——列交集回放的 drift 探针）。
 *   3. 导出：脚本 export（备份点快照载入 ref 草稿库→逐白名单表主键反连接→增量
 *      COPY 文本＋行数＋sha256 清单；live 零写入）。白名单 15 表与 FK 闭包依据见
 *      V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-X07-R3-20261106/logs/fk-closure-dump.log
 *      （0096 水位 343 条 FK 边实测）与 deploy 脚本头注释。
 *   4. 负向：导出失败（制品缺失）中止——exit 非 0、live 库不动、既有清单不受污染；
 *      restore 确认门（缺 ROLLBACK_DELTA_CONFIRM 拒绝）。
 *   5. 恢复：脚本 restore（dropdb --force＋createdb＋pg_restore 到备份点 0091）；
 *      断言备份点摘要与 T0 逐字一致、0092 域表不存在。
 *   6. 重放 0092 up（幂等，§6.2 步骤 3 先例；rollback.sh「禁止叠加 down」不受影响
 *      ——0092 是 up 重放）。
 *   7. 回放：脚本 replay（FK 依赖序；staging temp 表＋ON CONFLICT (id) DO NOTHING；
 *      回放期禁用 0081 种入触发器——恢复点 0091＋0092 重放下触发器在位，不禁用会
 *      给回放资源种入 PENDING、旧代码将拒绝服务；事务内禁用、提交后校验恢复
 *      ENABLED）。断言「备份点摘要＋增量摘要＝回放后摘要」（X07 8 组机制扩展为
 *      白名单 15 表）：live 导出时摘要＝回放后摘要＝逐字在库。
 *   8. 幂等重放：二次回放 inserted 全 0、摘要不变。
 *   9. 断言组 3/5：员工额度行在位且受约束（limit/used/唯一键拒绝）；种入触发器
 *      边界——回放资源无 PENDING 行、恢复后新建资源才有 PENDING。
 *  10. 断言组 2：旧栈（ae506fe）读/结算（子进程跑 ae506fe worktree 源码，口径同
 *      WP6-20261104 legacy-ae506fe-read-check 三行式）：准入（无 finance 行资源
 *      可服务）/逐行读（切换前＋切换后金额逐字）/窗口聚合/旧结算写路径落库/额度读。
 *
 * 红线自证（§6.5）：全程零 DELETE/UPDATE 消费事实；provider_finance_event 不在
 * 白名单（增量面恒空）——零期初/充值/更正类 finance 事件；迁移文件零触碰；
 * rollback.sh 既有段零触碰。
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DELTA_SCRIPT = resolve(REPO_ROOT, "deploy/scripts/rollback-delta-20261106.sh");
const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
const LEGACY_TSX = resolve(LEGACY_ROOT, "node_modules/.bin/tsx");
const LEGACY_CHECK_SCRIPT = resolve(
  REPO_ROOT,
  "V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-X07-R3-20261106/scripts/wp6-r3-legacy-read-check.ts",
);

const CONTAINER_NAME = "wp6-r3-drill-pg";
const LIVE_DB = "wp6_r3_live";
const REF_DB = "wp6_r3_ref";
const REPLAY_DB = "wp6_r3_replay";
const DUMP_IN_CONTAINER = "/tmp/wp6-r3-backup.dump";

/** 消费金额字面值（切换前＝X01 金额链同源 0.00104000；切换后＝X08 T4 量级）。 */
const AMOUNT_PRE = "0.00104000";
const AMOUNT_CUT1 = "0.00060000";
const AMOUNT_CUT2 = "0.00040000";
const AMOUNT_LEGACY_SETTLE = "0.00052000";
// 窗口合计＝切换前＋切换后消费事实（settled_at 均在演练窗口内）；旧结算写路径行的
// settled_at＝回放后时钟（窗口外），不计入——口径同 WP6-20261104 legacy-read-check
// （窗口聚合为可读性实证，OPENING_BALANCE_MISSING:* 为仪表盘桥接口径差异不阻断）。
const WINDOW_TOTAL_CNY = "0.00204000";
const WINDOW_ESTIMATED_CNY = "0.00204000"; // 0.00104000＋0.00060000＋0.00040000（旧结算落库前）
const QUOTA_LIMIT = 1_000_000n;
const QUOTA_USED_FINAL = 1_900n; // 1200＋700（两笔切换后 SETTLED usage 的期末值）
const WINDOW = { start: "2026-11-04T00:00:00.000Z", end: "2026-11-05T00:00:00.000Z" };

/** 白名单（＝交付脚本 REPLAY_ORDER；FK 依赖序）。 */
const WHITELIST = [
  "provider", "unified_model", "principal", "principal_key", "provider_resource",
  "billing_rule", "model_route", "ai_request", "upstream_attempt", "usage_event",
  "ledger_line", "ledger_transaction", "principal_grant",
  "principal_quota_period", "principal_quota_usage",
] as const;
/** 0091 备份点必然无此二表（0092 未应用）——导出按「快照空集」全量。 */
const ONLY_0092_TABLES = ["principal_quota_period", "principal_quota_usage"] as const;

/** 导出期期望增量行数（与 seedCutover 一一对应；脚本清单逐表核对）。 */
const EXPECTED_DELTA_ROWS: Record<(typeof WHITELIST)[number], number> = {
  provider: 0, unified_model: 0, principal: 0, principal_key: 0,
  provider_resource: 1, billing_rule: 1, model_route: 0,
  ai_request: 2, upstream_attempt: 2, usage_event: 2,
  ledger_line: 2, ledger_transaction: 2, principal_grant: 0,
  principal_quota_period: 1, principal_quota_usage: 2,
};

/** 命令与断言结果留痕（afterAll 写入 WP6_R3_EVIDENCE_DIR，供证据日志归档）。 */
const COMMAND_LOG: Array<{ cmd: string; exit: number | null; note?: string }> = [];

function logCommand(cmd: string, exit: number | null, ...notes: Array<string | undefined>): void {
  COMMAND_LOG.push({ cmd, exit, note: notes.filter((n) => n !== undefined).join(" | ") });
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 交付脚本调用（生产操作单同款；DOCKER_HOST 继承测试进程环境）。 */
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

/** 规范化 JSON（键序无关/Date→ISO/bigint→字符串；X07 摘要机制同款）。 */
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

/** 逐字摘要剔除列：0093 为 billing_rule 加列 source_status（新栈元数据列）——恢复点
 * 0091＋0092 重放的 schema 无此列，增量回放按列交集投影天然不含它（§6.1 v2：schema
 * drift 列随回退语义回退，不属消费事实）。逐字断言对 live/回放后两侧同步剔除该列。 */
const DIGEST_EXCLUDED_COLUMNS: Partial<Record<(typeof WHITELIST)[number], string[]>> = {
  billing_rule: ["source_status"],
};

/** 白名单全表行摘要（企业域内全行、SELECT * 全列、ORDER BY id；X07 机制扩展到 15 表）。
 * 0092 域表在 0091 水位不存在（0092 未应用）——缺席记 ABSENT 哨兵，摘要等值比较天然通过；
 * live/回放后快照不得含 ABSENT（由断言显式核对）。 */
async function whitelistDigests(database: Db, enterpriseId: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const table of WHITELIST) {
    if (!(await tableExists(database, table))) {
      digests[table] = `ABSENT:${table}`;
      continue;
    }
    const result = await sql<{ row: Record<string, unknown> }>`
      SELECT row_to_json(t) AS row FROM (
        SELECT * FROM ${sql.raw(table)} WHERE enterprise_id = ${enterpriseId}::uuid ORDER BY id
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

/** 期初/充值类 finance 事件行数（红线 2；X07 断言 3d 同款）。 */
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
  unifiedModelId: string;
  preRequestId: string;
  cutRequest1Id: string;
  cutRequest2Id: string;
  cutAttempt1Id: string;
  cutAttempt2Id: string;
  cutUsageId1: string;
  cutUsageId2: string;
  periodId: string;
}

/** T0 播种（0091 水位：0092 域表尚不存在；grant 走裸 SQL 不带 quota_basis 列）。 */
async function seedT0(db: Db): Promise<Fixture> {
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP6 R3 回放演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "wp6-r3-admin",
    display_name: "WP6 R3 管理员", password_hash: "test",
  }).execute();
  // 已激活企业（先于资源插入：0091 水位种入触发器在位，新建 API 资源即刻 PENDING——
  // 与生产激活企业语义一致）。
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();
  const providerId = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  // 主资源：插库即被 0081 触发器种入 PENDING，随后激活为 READY（生产激活态写实）。
  const resourceReadyId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R3 主 API 资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await sql`
    UPDATE provider_resource_finance_state
       SET state = 'READY', ready_at = ${new Date("2026-11-04T00:05:00.000Z")},
           ready_by_admin_user_id = ${adminId}::uuid
     WHERE provider_resource_id = ${resourceReadyId}::uuid
  `.execute(db);
  // 存量 PENDING 留档资源（从未激活；备份点原样保留）。
  const resourcePendingId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "R3 存量 PENDING 留档资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);

  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "R3 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_r3", key_digest: randomUUID(), allowed_model_ids: [] as never,
  }).execute();
  const unifiedModelId = await db.insertInto("unified_model").values({
    enterprise_id: enterpriseId, alias: "qianliu-r3-deepseek",
    display_name: "R3 DeepSeek", status: "ACTIVE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("model_route").values({
    enterprise_id: enterpriseId, unified_model_id: unifiedModelId,
    provider_resource_id: resourceReadyId, upstream_model: "deepseek-chat",
  }).execute();
  await db.insertInto("billing_rule").values({
    enterprise_id: enterpriseId, provider_resource_id: resourceReadyId,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "r3-api-price-v1", effective_from: new Date(0),
    cache_miss_price: "0.000001", multiplier: null, priority: 1000,
  }).execute();
  // 0091 水位：principal_grant 无 quota_basis 列（0092:6 才加），裸 SQL 播种。
  const grantRows = await sql<{ id: string }>`
    INSERT INTO principal_grant (enterprise_id, principal_id, provider, model_alias, quota_value)
    VALUES (${enterpriseId}::uuid, ${principalId}::uuid, 'deepseek', 'qianliu-r3-deepseek', ${QUOTA_LIMIT})
    RETURNING id
  `.execute(db);
  const grantId = grantRows.rows[0]!.id;

  seedConsumption(db, {
    enterpriseId, principalId, keyId, resourceId: resourceReadyId,
    requestId: randomUUID(), startedAt: "2026-11-04T06:00:00.000Z",
    amount: AMOUNT_PRE, usageQuality: "PROVIDER_REPORTED",
  });

  return {
    enterpriseId, adminId, principalId, keyId, grantId, providerId,
    resourceReadyId, resourcePendingId, resourceCutoverId: "", unifiedModelId,
    preRequestId: "", cutRequest1Id: "", cutRequest2Id: "",
    cutAttempt1Id: "", cutAttempt2Id: "", cutUsageId1: "", cutUsageId2: "", periodId: "",
  };
}

/** 一笔已计价结算消费（数据层复现 gateway 结算产物；X07 夹具同型）。 */
async function seedConsumption(
  db: Db,
  spec: {
    enterpriseId: string; principalId: string; keyId: string; resourceId: string;
    requestId: string; startedAt: string; amount: string; usageQuality: string;
  },
): Promise<{ attemptId: string; usageId: string }> {
  const requestId = spec.requestId;
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: spec.enterpriseId, principal_id: spec.principalId,
    principal_key_id: spec.keyId, protocol: "chat", unified_model: "deepseek-chat",
    status: "SUCCEEDED", started_at: new Date(spec.startedAt),
    finished_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  const attemptId = await db.insertInto("upstream_attempt").values({
    enterprise_id: spec.enterpriseId, ai_request_id: requestId, attempt_no: 1,
    provider_resource_id: spec.resourceId, upstream_model: "deepseek-chat",
    http_status: 200, response_committed: true,
    finished_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const usageId = await db.insertInto("usage_event").values({
    enterprise_id: spec.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
    provider_resource_id: spec.resourceId, input_tokens: 1000n, output_tokens: 200n,
    cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: spec.usageQuality,
    dedup_key: requestId, created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("ledger_line").values({
    enterprise_id: spec.enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
    usage_event_id: usageId, provider_resource_id: spec.resourceId, principal_id: spec.principalId,
    resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n,
    raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
    api_cost: spec.amount, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
    billing_rule_snapshot: { sourceStatus: "VERIFIED" },
    usage_quality: spec.usageQuality, settled_at: new Date(new Date(spec.startedAt).getTime() + 1000),
    created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  await db.insertInto("ledger_transaction").values({
    enterprise_id: spec.enterpriseId, ai_request_id: requestId, principal_id: spec.principalId,
    total_input_tokens: 1000n, total_output_tokens: 200n, total_cache_tokens: 0n,
    total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: spec.amount,
    api_cost_status: "PRICED_USAGE", overage: false, usage_quality: spec.usageQuality,
    attempt_count: 1, status: "SETTLED", created_at: new Date(new Date(spec.startedAt).getTime() + 1000),
  }).execute();
  return { attemptId, usageId };
}

/** 切换后新数据（0096 水位）：两笔新消费＋员工额度域＋无期初新资源＋drift 探针计价行。 */
async function seedCutover(db: Db, fixture: Fixture): Promise<void> {
  const cut1 = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId, keyId: fixture.keyId,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:00:00.000Z", amount: AMOUNT_CUT1, usageQuality: "PROVIDER_REPORTED",
  });
  fixture.cutRequest1Id = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:00:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  fixture.cutAttempt1Id = cut1.attemptId;
  fixture.cutUsageId1 = cut1.usageId;
  const cut2 = await seedConsumption(db, {
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId, keyId: fixture.keyId,
    resourceId: fixture.resourceReadyId, requestId: randomUUID(),
    startedAt: "2026-11-04T09:30:00.000Z", amount: AMOUNT_CUT2, usageQuality: "PROVIDER_REPORTED",
  });
  fixture.cutRequest2Id = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T09:30:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
  fixture.cutAttempt2Id = cut2.attemptId;
  fixture.cutUsageId2 = cut2.usageId;

  // 员工月度额度域（0092 产物；切换前不存在→反连接全量导出）。
  const periodId = await db.insertInto("principal_quota_period").values({
    enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId, provider: "deepseek",
    period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
    period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
    quota_basis: "RAW_TOKEN", limit_value: QUOTA_LIMIT, allow_overage: true,
    used_value: QUOTA_USED_FINAL, reserved_value: 0n, open_grant_version: 1,
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

  // 切换后新建 API 资源：0094 已退役种入（0096 水位）→ 无 finance 行（AT-X07 对象）。
  fixture.resourceCutoverId = await db.insertInto("provider_resource").values({
    enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
    name: "R3 切换后新建 API 资源", mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);

  // 切换后 billing_rule（含 0093 source_status 列——回放列交集 drift 探针）。
  await db.insertInto("billing_rule").values({
    enterprise_id: fixture.enterpriseId, provider_resource_id: fixture.resourceReadyId,
    upstream_model: "deepseek-chat", rule_type: "API_PRICE",
    rule_version: "r3-cutover-drift-v1", effective_from: new Date(0),
    cache_miss_price: "0.000002", multiplier: null, priority: 1000,
    source_status: "VERIFIED",
  }).execute();

  // 补记切换前请求 id（seedT0 内生成的随机 id）。
  fixture.preRequestId = (await sql<{ id: string }>`
    SELECT id FROM ai_request WHERE enterprise_id = ${fixture.enterpriseId}::uuid
      AND started_at = ${new Date("2026-11-04T06:00:00.000Z")} LIMIT 1`.execute(db)).rows[0]!.id;
}

interface ManifestTable {
  table: string;
  rows: number;
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
        table: fields[1]!, rows: Number(get("rows")), sha256: get("sha256"),
        refPresent: get("ref_present"), columns: get("columns").split(","),
      });
    } else if (fields.length === 2) {
      headers[fields[0]!] = fields[1]!;
    }
  }
  return { headers, tables };
}

describe.sequential("AT-X07 R3：主路线 v2 演练（增量导出→恢复 0091→重放 0092→增量回放）", () => {
  let container: StartedPostgreSqlContainer;
  let live: Db;
  let replayDb: Db;
  let fixture: Fixture;
  let tmpHost: string;
  let dumpHostPath: string;
  let outDir: string;
  let manifestPath: string;
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
    tmpHost = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/wp6-r3-drill-`);
    dumpHostPath = resolve(tmpHost, "backup.dump");
    outDir = resolve(tmpHost, "delta-out");
    manifestPath = resolve(outDir, "manifest.tsv");

    // 0) 0091 水位（生产现状 §8.1）＋T0 播种＋发布前备份＋切换。
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
    const evidenceDir = process.env.WP6_R3_EVIDENCE_DIR;
    if (evidenceDir) {
      writeFileSync(resolve(evidenceDir, "wp6-rollback-replay-drill-commands.json"),
        `${JSON.stringify(COMMAND_LOG, null, 2)}\n`);
    }
    await live?.destroy();
    await replayDb?.destroy();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    await container?.stop();
  }, 90_000);

  it("断言 A：check-contract 只读实测＋主键反连接增量导出——清单行数/sha256/0092 域全量与期望逐表一致", async () => {
    // check-contract：白名单存在性/单列主键/FK 闭包/回放序拓扑（只读）。
    const contract = runDeltaScript(["check-contract", "--container", CONTAINER_NAME, "--db-live", LIVE_DB]);
    expectScriptOk(contract);
    expect(contract.stdout).toContain("check-contract: OK");
    // 导出（破坏动作之前；live 零写入）。
    const exportResult = runDeltaScript([
      "export", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-ref", REF_DB,
      "--dump-file", dumpHostPath, "--out-dir", outDir,
    ]);
    expectScriptOk(exportResult);
    expect(await migrationHead(live)).toBe(HEAD_0096);
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    expect(manifest.headers["manifest_version"]).toBe("wp6-r3-1");
    expect(manifest.headers["live_migration_head"]).toBe(HEAD_0096);
    expect(manifest.headers["ref_migration_head"]).toBe(HEAD_0091);
    for (const table of WHITELIST) {
      const row = manifest.tables.find((t) => t.table === table);
      expect(row, `清单缺表 ${table}`).toBeDefined();
      expect(row!.rows, `表 ${table} 增量行数`).toBe(EXPECTED_DELTA_ROWS[table]);
      expect(row!.refPresent,
        `表 ${table} ref 快照在位标记（0092 域表备份点必无）`)
        .toBe((ONLY_0092_TABLES as readonly string[]).includes(table) ? "no" : "yes");
      const artifact = readFileSync(resolve(outDir, `${table}.copy`));
      expect(createHash("sha256").update(artifact).digest("hex")).toBe(row!.sha256);
      expect(artifact.toString("utf8").split("\n").filter((line) => line !== "").length)
        .toBe(row!.rows);
    }
    // 增量行内容抽核：切换后新消费逐字节（id 锚定）＋ drift 探针列在导出列清单中。
    const ledgerArtifact = readFileSync(resolve(outDir, "ledger_line.copy"), "utf8");
    expect(ledgerArtifact).toContain(fixture.cutRequest1Id);
    expect(ledgerArtifact).toContain(AMOUNT_CUT1);
    expect(ledgerArtifact).toContain(AMOUNT_CUT2);
    const billingManifest = manifest.tables.find((t) => t.table === "billing_rule")!;
    expect(billingManifest.columns).toContain("source_status"); // live 0096 schema 列
    const requestArtifact = readFileSync(resolve(outDir, "ai_request.copy"), "utf8");
    expect(requestArtifact.split("\n").filter((line) => line !== "").length).toBe(2);
    logCommand("manifest-parse", 0, JSON.stringify(Object.fromEntries(manifest.tables.map((t) => [t.table, t.rows]))));
  }, 240_000);

  it("断言 B（负向）：导出失败中止——exit 非 0、live 库不动、既有清单不受污染；restore 确认门拒绝", async () => {
    const missingDump = resolve(tmpHost, "does-not-exist.dump");
    const failed = runDeltaScript([
      "export", "--container", CONTAINER_NAME, "--db-live", LIVE_DB, "--db-ref", REF_DB,
      "--dump-file", missingDump, "--out-dir", resolve(tmpHost, "delta-out-failed"),
    ]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("FAIL-CLOSED");
    // live 库不动：水位＋15 表摘要逐字不变。
    expect(await migrationHead(live)).toBe(HEAD_0096);
    expect(await whitelistDigests(live, fixture.enterpriseId)).toEqual(liveDigests);
    // 既有清单不受污染：manifest_done 自校验仍成立（脚本 sha 闭环）。
    const manifest = readFileSync(manifestPath, "utf8");
    const declared = manifest.split("\n").find((line) => line.startsWith("manifest_done"))!.split("\t")[1]!;
    const body = manifest.split("\n").filter((line) => line !== "" && !line.startsWith("manifest_done")).join("\n");
    expect(createHash("sha256").update(`${body}\n`).digest("hex")).toBe(declared);
    // restore 确认门：缺 ROLLBACK_DELTA_CONFIRM 拒绝（安全等级同 rollback.sh:5）。
    const noConfirm = runDeltaScript([
      "restore", "--container", CONTAINER_NAME, "--db-target", REPLAY_DB, "--dump-file", dumpHostPath,
    ]);
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("ROLLBACK_DELTA_CONFIRM");
  }, 240_000);

  it("断言 C：恢复段——整库恢复到备份点 0091，备份点摘要与 T0 逐字一致，0092 域表不存在", async () => {
    const restoreResult = runDeltaScript([
      "restore", "--container", CONTAINER_NAME, "--db-target", REPLAY_DB, "--dump-file", dumpHostPath,
    ], { ROLLBACK_DELTA_CONFIRM: "YES" });
    expectScriptOk(restoreResult);
    replayDb = createKysely(swapDbName(container.getConnectionUri(), REPLAY_DB));
    expect(await migrationHead(replayDb)).toBe(HEAD_0091);
    // 备份点行集摘要＝T0 摘要（恢复逐字；8 组机制的白名单 15 表版）。
    expect(await whitelistDigests(replayDb, fixture.enterpriseId)).toEqual(preCutoverDigests);
    // 0092 域表在备份点不存在（回放 0092 前提）。
    expect(await tableExists(replayDb, "principal_quota_period")).toBe(false);
    expect(await tableExists(replayDb, "principal_quota_usage")).toBe(false);
    // 红线 2 基线：备份点无期初/充值类 finance 事件。
    expect(await openingOrRechargeEventCount(replayDb, fixture.enterpriseId)).toBe("0");
    // 0091 水位种入触发器在位（回放须禁用的机制前提）。
    const trigger = await sql<{ tgenabled: string }>`
      SELECT tgenabled FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal
    `.execute(replayDb);
    expect(trigger.rows[0]?.tgenabled).toBe("O");
  }, 240_000);

  it("断言 D：重放 0092＋增量回放——15 表「live 摘要＝回放后摘要」逐字在库，inserted 数与清单一致", async () => {
    // 重放 0092 up（幂等；§6.2 步骤 3 先例；up 重放非 down，rollback.sh:113 规则不受影响）。
    const replay0092 = await createMigrator(replayDb).migrateTo(HEAD_0092);
    expect(replay0092.error).toBeUndefined();
    expect(await migrationHead(replayDb)).toBe(HEAD_0092);
    expect(await tableExists(replayDb, "principal_quota_period")).toBe(true);

    const replayResult = runDeltaScript([
      "replay", "--container", CONTAINER_NAME, "--db-target", REPLAY_DB,
      "--manifest", manifestPath, "--delta-dir", outDir,
    ]);
    expectScriptOk(replayResult);
    // inserted 行数＝清单行数（首轮回放全量落库）。
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    for (const table of WHITELIST) {
      const expected = EXPECTED_DELTA_ROWS[table];
      const pattern = new RegExp(`REPLAY_RESULT table=${table} inserted=(\\d+)`);
      const match = replayResult.stdout.match(pattern);
      if (expected === 0) {
        expect(match, `表 ${table} 不应产生回放输出`).toBeNull();
      } else {
        expect(match, `表 ${table} 回放输出缺失`).not.toBeNull();
        expect(Number(match![1]!)).toBe(expected);
      }
    }
    // 「备份点摘要＋增量摘要＝回放后摘要」：白名单 15 表 live 摘要＝回放后摘要＝逐字在库。
    const postReplayDigests = await whitelistDigests(replayDb, fixture.enterpriseId);
    expect(postReplayDigests).toEqual(liveDigests);
    // 红线 2：回放零补造资金（finance 事件增量＝0）。
    expect(await openingOrRechargeEventCount(replayDb, fixture.enterpriseId)).toBe("0");
    // 候选读侧：回放后的切换前＋切换后金额窗口聚合可读（KNOWN_COMPLETE）。
    const estimation = await loadApiCostEstimation(replayDb, fixture.enterpriseId, {
      start: new Date(WINDOW.start), end: new Date(WINDOW.end),
      resourceIds: [fixture.resourceReadyId],
    });
    expect(estimation.completeness).toBe("KNOWN_COMPLETE");
    expect(estimation.amounts).toEqual([{ currency: "CNY", amount: WINDOW_ESTIMATED_CNY }]);
  }, 240_000);

  it("断言 E：幂等重放——二次回放 inserted 全 0、15 表摘要不变", async () => {
    const second = runDeltaScript([
      "replay", "--container", CONTAINER_NAME, "--db-target", REPLAY_DB,
      "--manifest", manifestPath, "--delta-dir", outDir,
    ]);
    expectScriptOk(second);
    for (const table of WHITELIST) {
      if (EXPECTED_DELTA_ROWS[table] === 0) continue;
      const match = second.stdout.match(new RegExp(`REPLAY_RESULT table=${table} inserted=(\\d+)`));
      expect(match, `表 ${table} 二次回放输出缺失`).not.toBeNull();
      expect(Number(match![1]!)).toBe(0);
    }
    expect(await whitelistDigests(replayDb, fixture.enterpriseId)).toEqual(liveDigests);
    expect(await openingOrRechargeEventCount(replayDb, fixture.enterpriseId)).toBe("0");
  }, 240_000);

  it("断言 F（组 3＋组 5）：员工额度行在位且受约束；种入触发器边界——回放资源无 PENDING、恢复后新建才 PENDING", async () => {
    // 组 3：额度行在位且受约束（0092 域随增量回放完整回库）。
    const period = await replayDb.selectFrom("principal_quota_period").selectAll()
      .where("id", "=", fixture.periodId).executeTakeFirstOrThrow();
    expect(period.limit_value).toBe(QUOTA_LIMIT.toString());
    expect(period.used_value).toBe(QUOTA_USED_FINAL.toString());
    expect(period.quota_basis).toBe("RAW_TOKEN");
    expect(period.allow_overage).toBe(true);
    const usages = await replayDb.selectFrom("principal_quota_usage").selectAll()
      .where("period_id", "=", fixture.periodId).orderBy("created_at").execute();
    expect(usages.map((u) => [u.status, u.actual?.toString()])).toEqual([["SETTLED", "1200"], ["SETTLED", "700"]]);
    // 同键第二 period 行仍被拒（UNIQUE(enterprise,principal,provider,period_key) 约束随 0092 重放在位）。
    await expect(replayDb.insertInto("principal_quota_period").values({
      enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId, provider: "deepseek",
      period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
      period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
      quota_basis: "RAW_TOKEN", limit_value: 1n, allow_overage: false,
      used_value: 0n, open_grant_version: 1,
    }).execute()).rejects.toThrow();

    // 组 5a：回放资源（切换后新建）无 finance 行——回放期触发器禁用，未被种入污染。
    const cutoverFinanceRows = await replayDb.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", fixture.resourceCutoverId).execute();
    expect(cutoverFinanceRows).toEqual([]);
    // 备份点资源状态逐字（READY 主资源＋PENDING 留档）。
    const states = await replayDb.selectFrom("provider_resource_finance_state").selectAll()
      .where("enterprise_id", "=", fixture.enterpriseId)
      .orderBy("provider_resource_id").execute();
    // 备份点资源状态逐字（READY 主资源＋PENDING 留档；uuid 序随机，顺序无关比较）。
    expect(states.map((s) => [s.provider_resource_id === fixture.resourceReadyId ? "ready" : "pending", s.state])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)))
      .toEqual([["pending", "PENDING"], ["ready", "READY"]]);
    // 组 5b：恢复后新建资源才被种入（0091 语义；旧栈准入门槛既定行为）。
    const postReplayResourceId = await replayDb.insertInto("provider_resource").values({
      enterprise_id: fixture.enterpriseId, provider_id: fixture.providerId,
      name: "R3 恢复后新建资源", mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const seeded = await replayDb.selectFrom("provider_resource_finance_state").selectAll()
      .where("provider_resource_id", "=", postReplayResourceId).executeTakeFirstOrThrow();
    expect(seeded.state).toBe("PENDING");
    // 触发器恢复 ENABLED（提交后校验；旧栈语义回到 0091 基线）。
    const trigger = await sql<{ tgenabled: string }>`
      SELECT tgenabled FROM pg_trigger WHERE tgname = ${SEED_TRIGGER} AND NOT tgisinternal
    `.execute(replayDb);
    expect(trigger.rows[0]?.tgenabled).toBe("O");
    (fixture as { postReplayResourceId?: string }).postReplayResourceId = postReplayResourceId;
  }, 240_000);

  it("断言 G（组 2）：旧栈（ae506fe）读/结算恢复库——准入含无 finance 行资源、逐行读切换前后金额、旧结算落库、窗口聚合、额度读", async () => {
    const postReplayResourceId = (fixture as { postReplayResourceId?: string }).postReplayResourceId ?? "";
    const legacyFixture = {
      enterpriseId: fixture.enterpriseId,
      principalId: fixture.principalId,
      keyId: fixture.keyId,
      resourceReadyId: fixture.resourceReadyId,
      resourcePendingId: fixture.resourcePendingId,
      resourceCutoverId: fixture.resourceCutoverId,
      resourcePostReplayId: postReplayResourceId,
      preRequest: fixture.preRequestId,
      cutRequest1: fixture.cutRequest1Id,
      cutRequest2: fixture.cutRequest2Id,
      amounts: { pre: AMOUNT_PRE, cut1: AMOUNT_CUT1, cut2: AMOUNT_CUT2, legacySettle: AMOUNT_LEGACY_SETTLE },
      window: WINDOW,
      expected: { periodKey: "2026-11", limitValue: QUOTA_LIMIT.toString(),
        usedValue: QUOTA_USED_FINAL.toString(), windowTotalCny: WINDOW_TOTAL_CNY },
    };
    const fixturePath = resolve(tmpHost, "legacy-fixture.json");
    const legacyOutPath = resolve(tmpHost, "legacy-result.json");
    writeFileSync(fixturePath, `${JSON.stringify(legacyFixture, null, 2)}\n`);
    let stdout = "";
    try {
      stdout = execFileSync(LEGACY_TSX, [LEGACY_CHECK_SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: swapDbName(container.getConnectionUri(), REPLAY_DB),
          WP6_R3_FIXTURE_JSON: fixturePath,
          WP6_R3_LEGACY_OUTPUT: legacyOutPath,
        },
        timeout: 120_000,
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number };
      logCommand("legacy-read-check", failure.status ?? -1, failure.stderr?.slice(0, 2000));
      throw new Error(`legacy 读检查失败: ${failure.stderr ?? error}`);
    }
    logCommand("legacy-read-check", 0, stdout.slice(0, 500));
    const report = JSON.parse(readFileSync(legacyOutPath, "utf8")) as Record<string, Record<string, unknown>>;
    // 1) 准入：无 finance 行的回放资源被旧候选包含；PENDING（留档/回放后新建）被排除。
    const admission = report.admission!;
    expect(admission.readyResource_included).toBe(true);
    expect(admission.cutoverResource_noFinanceRow_included).toBe(true);
    expect(admission.pendingArchive_excluded).toBe(true);
    expect(admission.postReplayNewResource_pending_excluded).toBe(true);
    // 2) 可读：切换前＋切换后新消费金额逐字。
    const reads = report.readConsumptionFacts!;
    expect(reads.preBackupRequest).toMatchObject({ amountMatchesSeed: true });
    expect(reads.cutoverRequest1_replayed).toMatchObject({ amountMatchesSeed: true });
    expect(reads.cutoverRequest2_replayed).toMatchObject({ amountMatchesSeed: true });
    // 3) 可结算：旧结算写路径落新消费（created=true）并随即可读。
    const settle = report.settleNewConsumption!;
    expect(settle.created).toBe(true);
    expect(settle.newLine).toMatchObject({ api_cost: AMOUNT_LEGACY_SETTLE, api_cost_currency: "CNY" });
    // 4) 窗口聚合：切换前＋切换后＋旧结算落库合计。
    const windowFinance = report.windowOperatingFinance!;
    expect(windowFinance.sumMatches).toBe(true);
    // 5) 额度：员工月度额度行旧代码可读（limit 1000000/used 1900/RAW_TOKEN）。
    const quota = report.employeeQuotaPeriods!;
    expect(quota.limitMatches).toBe(true);
    expect(quota.usedMatches).toBe(true);
    // 红线 2 终核：旧结算落库后 finance 事件仍为 0（零补造资金）。
    expect(await openingOrRechargeEventCount(replayDb, fixture.enterpriseId)).toBe("0");
    // 证据归档。
    const evidenceDir = process.env.WP6_R3_EVIDENCE_DIR;
    if (evidenceDir) {
      writeFileSync(resolve(evidenceDir, "wp6-r3-legacy-read-check.result.json"),
        `${JSON.stringify(report, null, 2)}\n`);
    }
  }, 240_000);
});
