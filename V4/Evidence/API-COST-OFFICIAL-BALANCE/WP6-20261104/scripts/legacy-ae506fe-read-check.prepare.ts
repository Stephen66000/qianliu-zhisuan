/**
 * X07 任务 B 准备段（WP6 S3，一次性演练脚本，非测试套件成员）。
 *
 * 依据：WP6 plan.md §3 范围表（X07 旧代码读行为证据脚本）、总指挥裁定 2
 * （X07 旧代码实证对象＝ae506fe 的资源候选查询与结算读取路径对回退后库
 * （0092 水位）的真实行为）。
 *
 * 本脚本职责：在与任务 A 同型的临时库上重现演练数据（无期初资源〔无
 * finance_state 行〕＋存量 PENDING 资源＋各一条已结算消费＋员工月度额度行），
 * 并执行 down 链到 0092（候选 migrator 驱动，语义与
 * wp6-rollback-drill.integration.test.ts 断言 3 相同：rollbackTo 0092 后幂等重放
 * 0092 恢复水位）。随后由 legacy-read 脚本以 ae506fe 旧代码连接同一库读取。
 *
 * 只写本演练专用库（安全门：仅 127.0.0.1 ＋库名 wp6_x07_drill）。
 *
 * 运行（候选 worktree 根）：
 *   DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
 *   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55433/wp6_x07_drill \
 *   corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.prepare.ts
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
// 证据目录不在 @qianliu/database 的解析链上，按相对路径直引包内源文件
// （X06 先例 x06-amount-reconciliation.ts 同法）。
import { createKysely, migrateDown, migrateToLatest } from "../../../../../packages/database/src/index.ts";
import { createMigrator } from "../../../../../packages/database/src/migrator.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const OUTPUT = process.env.X07_FIXTURE_OUTPUT
  ?? "/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.fixture.json";
const HEAD_0092 = "0092_employee_monthly_quota";

/** 安全门：只允许本机＋演练专用库名（同 X06 脚本先例）。 */
function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_x07_drill") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

// kysely_migration 为框架簿记表（不在 Database 类型内）；tsx 无类型检查，
// 查询构建器运行时按表名直查（避免证据目录 bare "kysely" 导入——解析链缺失）。
async function migrationHead(db: ReturnType<typeof createKysely>): Promise<string | null> {
  const rows = await (db.selectFrom("kysely_migration" as never) as ReturnType<
    ReturnType<typeof createKysely>["selectFrom"]
  >).select("name").orderBy("name", "desc").limit(1).execute();
  return (rows[0] as { name?: string } | undefined)?.name ?? null;
}

const db = createKysely(DATABASE_URL);

async function main(): Promise<void> {
  assertDedicatedDatabase(DATABASE_URL);

  // 1) 候选 migrator 到 0096 水位（候选行为重现，同任务 A 断言 1 前提）。
  const executed = await migrateToLatest(db);
  const head0096 = await migrationHead(db);
  console.log(JSON.stringify({ step: "migrateToLatest", executedCount: executed.length, head: head0096 }));

  // 2) 演练造数（同任务 A seedDrill 形状；全新 UUID）。
  const enterpriseId = randomUUID();
  const adminId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  await db.insertInto("enterprise").values({ id: enterpriseId, name: "WP6 X07 旧代码读库演练企业" }).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "wp6-x07-legacy-admin",
    display_name: "WP6 X07 Legacy", password_hash: "test",
  }).execute();
  await db.insertInto("principal").values({
    id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "X07 Legacy 员工",
    person_id: null, owner_person_id: null, department_label: null,
  }).execute();
  await db.insertInto("principal_key").values({
    id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
    key_prefix: "ql_x07l", key_digest: randomUUID(), allowed_model_ids: [],
  }).execute();
  await db.insertInto("provider_finance_runtime_state").values({
    enterprise_id: enterpriseId, strict_writes_enabled: true,
    activated_at: new Date("2026-11-04T00:00:00.000Z"), activated_by_admin_user_id: adminId,
  }).execute();
  const providerId = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek",
    adapter_type: "OPENAI_COMPATIBLE",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  // 无期初资源：候选水位新建（无 finance_state 行；候选种入已退役）。
  const freshResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "X07L 无期初 API 资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const freshFinanceRows = await db.selectFrom("provider_resource_finance_state").selectAll()
    .where("provider_resource_id", "=", freshResourceId).execute();
  if (freshFinanceRows.length !== 0) throw new Error("无期初资源出现 finance_state 行（候选行为不符）");
  // 存量 PENDING 资源：直插留档行（模拟 0094 之前种入）。
  const pendingResourceId = await db.insertInto("provider_resource").values({
    enterprise_id: enterpriseId, provider_id: providerId, name: "X07L 存量 PENDING 留档资源",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("provider_resource_finance_state").values({
    enterprise_id: enterpriseId, provider_resource_id: pendingResourceId,
    required_currencies: JSON.stringify([]) as never,
  }).execute();

  // 已结算消费：无期初资源一条（0.00104000）；存量 PENDING 资源一条（0.00052000）。
  const consumption: Array<{ requestId: string; attemptId: string; resourceId: string; cost: string }> = [];
  for (const [index, targetResourceId] of [freshResourceId, pendingResourceId].entries()) {
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: keyId, protocol: "chat", unified_model: "deepseek-chat",
      status: "SUCCEEDED", started_at: new Date("2026-11-04T09:00:00.000Z"),
      finished_at: new Date("2026-11-04T09:00:01.000Z"),
    }).execute();
    const attemptId = await db.insertInto("upstream_attempt").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, attempt_no: 1,
      provider_resource_id: targetResourceId, upstream_model: "deepseek-chat",
      http_status: 200, response_committed: true, finished_at: new Date("2026-11-04T09:00:01.000Z"),
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const usageId = await db.insertInto("usage_event").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
      provider_resource_id: targetResourceId, input_tokens: 1000n, output_tokens: 200n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: requestId, created_at: new Date("2026-11-04T09:00:01.000Z"),
    }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
    const cost = index === 0 ? "0.00104000" : "0.00052000";
    await db.insertInto("ledger_line").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, upstream_attempt_id: attemptId,
      usage_event_id: usageId, provider_resource_id: targetResourceId, principal_id: principalId,
      resource_mode: "API", raw_input_tokens: 1000n, raw_output_tokens: 200n,
      raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      api_cost: cost, api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", settled_at: new Date("2026-11-04T09:00:01.000Z"),
      created_at: new Date("2026-11-04T09:00:01.000Z"),
    }).execute();
    await db.insertInto("ledger_transaction").values({
      enterprise_id: enterpriseId, ai_request_id: requestId, principal_id: principalId,
      total_input_tokens: 1000n, total_output_tokens: 200n, total_cache_tokens: 0n,
      total_reasoning_tokens: 0n, total_deducted_quota: 0n, total_api_cost: cost,
      api_cost_status: "PRICED_USAGE", overage: false, usage_quality: "PROVIDER_REPORTED",
      attempt_count: 1, status: "SETTLED", created_at: new Date("2026-11-04T09:00:01.000Z"),
    }).execute();
    consumption.push({ requestId, attemptId, resourceId: targetResourceId, cost });
  }

  // 员工月度额度行（0092 域对象，limit 1 000 000 / used 1 200）。
  const grantId = await db.insertInto("principal_grant").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    model_alias: "deepseek-chat", quota_value: 1_000_000n, quota_basis: "RAW_TOKEN",
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  const periodId = await db.insertInto("principal_quota_period").values({
    enterprise_id: enterpriseId, principal_id: principalId, provider: "deepseek",
    period_key: "2026-11", period_start: new Date("2026-10-31T16:00:00.000Z"),
    period_end: new Date("2026-11-30T16:00:00.000Z"), timezone: "Asia/Shanghai",
    quota_basis: "RAW_TOKEN", limit_value: 1_000_000n, allow_overage: true,
    used_value: 1_200n, reserved_value: 0n, open_grant_version: 1,
  }).returning("id").executeTakeFirstOrThrow().then((r) => r.id);
  await db.insertInto("principal_quota_usage").values({
    enterprise_id: enterpriseId, request_id: consumption[0]!.requestId, attempt_no: 1,
    upstream_attempt_id: consumption[0]!.attemptId, period_id: periodId, grant_id: grantId,
    grant_version: 1, quota_basis: "RAW_TOKEN", estimate: 1_200n, actual: 1_200n,
    status: "SETTLED", usage_quality: "PROVIDER_REPORTED",
    created_at: new Date("2026-11-04T09:00:01.000Z"),
    settled_at: new Date("2026-11-04T09:00:01.000Z"),
  }).execute();
  console.log(JSON.stringify({ step: "seed", enterpriseId, freshResourceId, pendingResourceId, consumption }));

  // 3) down 链到 0092（与任务 A 断言 3 同型：rollbackTo 语义＋0092 空操作 down
  //    后幂等重放恢复水位）。
  const downChain: string[] = [];
  for (let guard = 0; guard < 500; guard += 1) {
    const name = await migrateDown(db);
    if (name === null) throw new Error("回滚链在到达 0092 之前已经清空");
    downChain.push(name);
    if (name === HEAD_0092) break;
  }
  const headAfterDown = await migrationHead(db);
  const replay = await createMigrator(db).migrateTo(HEAD_0092);
  if (replay.error) throw replay.error;
  const head0092 = await migrationHead(db);
  console.log(JSON.stringify({
    step: "downChain", downChain, headAfterDown, headAfterReplay: head0092,
  }));

  // 4) 快照摘要（回退后基线，供 legacy-read 前后一致性复核）。
  async function countRows(table: string, enterpriseId: string): Promise<string> {
    const row = await (db.selectFrom(table as never) as ReturnType<
      ReturnType<typeof createKysely>["selectFrom"]
    >).select((eb) => eb.fn.countAll().as("count"))
      .where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
    return String((row as unknown as { count: number | string }).count);
  }
  const counts = {
    ledger_lines: await countRows("ledger_line", enterpriseId),
    finance_events: await countRows("provider_finance_event", enterpriseId),
    finance_states: await countRows("provider_resource_finance_state", enterpriseId),
    quota_periods: await countRows("principal_quota_period", enterpriseId),
  };
  console.log(JSON.stringify({ step: "postRollbackCounts", counts }));

  const fixture = {
    generatedAt: new Date().toISOString(),
    databaseUrlHost: new URL(DATABASE_URL).host,
    databaseName: new URL(DATABASE_URL).pathname,
    candidateHeadMigration: head0096,
    downChain,
    headAfterDown,
    headFinal: head0092,
    enterpriseId, principalId, keyId, grantId, periodId, providerId,
    freshResourceId, pendingResourceId,
    freshRequest: consumption[0]!.requestId,
    freshAttempt: consumption[0]!.attemptId,
    pendingRequest: consumption[1]!.requestId,
    pendingAttempt: consumption[1]!.attemptId,
    freshCost: consumption[0]!.cost,
    pendingCost: consumption[1]!.cost,
  };
  writeFileSync(OUTPUT, JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify({ step: "fixtureWritten", output: OUTPUT }));
  await db.destroy();
}

main().catch((error) => {
  console.error("PREPARE_FAILED", error);
  process.exitCode = 1;
});
