/**
 * X08 切换演练检查脚本（WP6 S4，证据脚本，非测试套件成员）。
 *
 * 子命令：
 *   counts   —— 输出演练企业全量计数快照（资金四表口径＝WP5 pf 测试
 *               FINANCE_COUNT_TABLES 事实四表：provider_finance_event /
 *               provider_subscription_period / ledger_line /
 *               provider_finance_activation_attempt；operation_log 审计单列）。
 *   migrate  —— 候选 migrator migrateToLatest（T2 段：0092→0096），
 *               输出迁移清单＋耗时＋幂等重放核验。
 *   final    —— 断言 A-E 的库层/证据层终判（对照 fixture＋T0 基线＋C1/C4
 *               计数快照＋mock 计数＋fetch 守卫日志）。
 *
 * 运行（候选 worktree 根）：
 *   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55434/wp6_x08_drill \
 *   corepack pnpm@11.11.0 exec tsx \
 *   V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/x08-checks.ts <subcommand>
 */
import { readFileSync } from "node:fs";
import { createKysely, migrateToLatest } from "../../../../../packages/database/src/index.ts";
import { createMigrator } from "../../../../../packages/database/src/migrator.ts";
// 裸 "kysely"/"pg" 在证据目录解析链外：按包内 node_modules 绝对路径直引（X06 脚本先例）。
import pgClient from "../../../../../packages/database/node_modules/pg/lib/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const EVIDENCE_DIR = "/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104";
const FIXTURE_PATH = `${EVIDENCE_DIR}/scripts/x08-fixture.json`;
const BASELINE_PATH = `${EVIDENCE_DIR}/logs/x08-baseline-t0.json`;
const C1_PATH = `${EVIDENCE_DIR}/logs/x08-counts-c1.json`;
const C4_PATH = `${EVIDENCE_DIR}/logs/x08-counts-c4.json`;
const MOCK_T4_PATH = `${EVIDENCE_DIR}/logs/x08-mock-stats-t4.json`;
const MOCK_FINAL_PATH = `${EVIDENCE_DIR}/logs/x08-mock-stats.json`;
const FETCH_LOG_PATH = `${EVIDENCE_DIR}/logs/x08-fetch-guard.jsonl`;

interface Fixture {
  enterpriseId: string; resourceA: string; resourceB: string; resourceP: string;
  expectedCosts: Record<string, string>;
}
interface CountsShape {
  head: string | null;
  provider_finance_event: number; provider_subscription_period: number;
  ledger_line: number; provider_finance_activation_attempt: number;
  operation_log: number; ai_request: number; ai_request_succeeded: number;
  ai_request_in_progress: number; upstream_attempt_open: number;
  ledger_transaction_pending: number; ledger_transaction_settled: number;
  operating_snapshot: number; operating_sync_attempt: number; balance_refresh: number;
  quiescence: { status: string | null; releasedAt: string | null; expiresAt: string | null };
  autoRenewEnabled: boolean | null;
  subscriptionPeriods: Array<{ periodStart: string; periodEndExclusive: string }>;
  perRequest: Array<{ requestId: string; status: string; apiCost: string | null;
    costStatus: string | null; txStatus: string | null; txTotal: string | null;
    inputTokens: string | null; outputTokens: string | null; cacheTokens: string | null }>;
}

function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_x08_drill") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

interface Row { [column: string]: unknown }

async function queryAll(sqlText: string, params: unknown[] = []): Promise<Row[]> {
  const client = new pgClient.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sqlText, params);
    return result.rows as Row[];
  } finally {
    await client.end();
  }
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

async function collectCounts(enterpriseId: string): Promise<CountsShape> {
  const refreshTable = await queryAll(
    "SELECT to_regclass('provider_resource_balance_refresh') AS reg",
  );
  const refreshExists = refreshTable[0]?.reg !== null;
  const refreshSql = refreshExists
    ? "(SELECT count(*) FROM provider_resource_balance_refresh WHERE enterprise_id=$1::uuid)"
    : "0";
  const [agg] = await queryAll(`
    SELECT
      (SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1) AS head,
      (SELECT count(*) FROM provider_finance_event WHERE enterprise_id=$1::uuid) AS pfe,
      (SELECT count(*) FROM provider_subscription_period WHERE enterprise_id=$1::uuid) AS psp,
      (SELECT count(*) FROM ledger_line WHERE enterprise_id=$1::uuid) AS ll,
      (SELECT count(*) FROM provider_finance_activation_attempt WHERE enterprise_id=$1::uuid) AS pfaa,
      (SELECT count(*) FROM operation_log WHERE enterprise_id=$1::uuid) AS oplog,
      (SELECT count(*) FROM ai_request WHERE enterprise_id=$1::uuid) AS ar,
      (SELECT count(*) FROM ai_request WHERE enterprise_id=$1::uuid AND status='SUCCEEDED') AS ar_ok,
      (SELECT count(*) FROM ai_request WHERE enterprise_id=$1::uuid AND status='IN_PROGRESS') AS ar_prog,
      (SELECT count(*) FROM upstream_attempt WHERE enterprise_id=$1::uuid AND finished_at IS NULL) AS ua_open,
      (SELECT count(*) FROM ledger_transaction WHERE enterprise_id=$1::uuid AND status='PENDING') AS lt_pending,
      (SELECT count(*) FROM ledger_transaction WHERE enterprise_id=$1::uuid AND status='SETTLED') AS lt_settled,
      (SELECT count(*) FROM provider_resource_operating_snapshot WHERE enterprise_id=$1::uuid) AS snap,
      (SELECT count(*) FROM provider_resource_operating_sync_attempt WHERE enterprise_id=$1::uuid) AS attempt,
      ${refreshSql} AS refresh,
      (SELECT status FROM provider_finance_activation_quiescence WHERE enterprise_id=$1::uuid) AS q_status,
      (SELECT released_at::text FROM provider_finance_activation_quiescence WHERE enterprise_id=$1::uuid) AS q_released,
      (SELECT expires_at::text FROM provider_finance_activation_quiescence WHERE enterprise_id=$1::uuid) AS q_expires,
      (SELECT subscription_auto_renew_enabled FROM provider_resource
        WHERE enterprise_id=$1::uuid AND mode='CODING_PLAN' AND status<>'DELETED' LIMIT 1) AS auto_renew
  `, [enterpriseId]);
  const periods = await queryAll(`
    SELECT period_start::text, period_end_exclusive::text
    FROM provider_subscription_period WHERE enterprise_id=$1::uuid ORDER BY period_start
  `, [enterpriseId]);
  const perRequest = await queryAll(`
    SELECT ar.id::text AS request_id, ar.status,
      ll.api_cost::text AS api_cost, ll.api_cost_status,
      ll.raw_input_tokens::text AS in_tok, ll.raw_output_tokens::text AS out_tok,
      ll.raw_cache_tokens::text AS cache_tok,
      lt.status AS tx_status, lt.total_api_cost::text AS total_api_cost
    FROM ai_request ar
    LEFT JOIN ledger_line ll ON ll.ai_request_id=ar.id AND ll.enterprise_id=ar.enterprise_id
    LEFT JOIN ledger_transaction lt ON lt.ai_request_id=ar.id AND lt.enterprise_id=ar.enterprise_id
    WHERE ar.enterprise_id=$1::uuid
    ORDER BY ar.started_at
  `, [enterpriseId]);
  return {
    head: (agg?.head as string | null) ?? null,
    provider_finance_event: num(agg?.pfe),
    provider_subscription_period: num(agg?.psp),
    ledger_line: num(agg?.ll),
    provider_finance_activation_attempt: num(agg?.pfaa),
    operation_log: num(agg?.oplog),
    ai_request: num(agg?.ar),
    ai_request_succeeded: num(agg?.ar_ok),
    ai_request_in_progress: num(agg?.ar_prog),
    upstream_attempt_open: num(agg?.ua_open),
    ledger_transaction_pending: num(agg?.lt_pending),
    ledger_transaction_settled: num(agg?.lt_settled),
    operating_snapshot: num(agg?.snap),
    operating_sync_attempt: num(agg?.attempt),
    balance_refresh: num(agg?.refresh),
    quiescence: {
      status: (agg?.q_status as string | null) ?? null,
      releasedAt: (agg?.q_released as string | null) ?? null,
      expiresAt: (agg?.q_expires as string | null) ?? null,
    },
    autoRenewEnabled: (agg?.auto_renew as boolean | null) ?? null,
    subscriptionPeriods: periods.map((row) => ({
      periodStart: String(row.period_start), periodEndExclusive: String(row.period_end_exclusive),
    })),
    perRequest: perRequest.map((row) => ({
      requestId: String(row.request_id), status: String(row.status),
      apiCost: (row.api_cost as string | null) ?? null,
      costStatus: (row.api_cost_status as string | null) ?? null,
      txStatus: (row.tx_status as string | null) ?? null,
      txTotal: (row.total_api_cost as string | null) ?? null,
      inputTokens: (row.in_tok as string | null) ?? null,
      outputTokens: (row.out_tok as string | null) ?? null,
      cacheTokens: (row.cache_tok as string | null) ?? null,
    })),
  };
}

async function subcommandCounts(): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  process.stdout.write(`${JSON.stringify(await collectCounts(fixture.enterpriseId), null, 2)}\n`);
}

async function subcommandMigrate(): Promise<void> {
  const started = Date.now();
  const executed = await migrateToLatest(db);
  const durationMs = Date.now() - started;
  const headRows = await queryAll("SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1");
  const head = (headRows[0]?.name as string | undefined) ?? null;
  const replay = await createMigrator(db).migrateTo(head ?? "");
  process.stdout.write(`${JSON.stringify({
    executed, durationMs, head,
    idempotentReplayError: replay.error ? String(replay.error) : null,
  }, null, 2)}\n`);
}

interface Assertion { id: string; pass: boolean; detail: string }

async function subcommandFinal(): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<string, unknown>;
  const c1 = JSON.parse(readFileSync(C1_PATH, "utf8")) as CountsShape;
  const c4 = JSON.parse(readFileSync(C4_PATH, "utf8")) as CountsShape;
  const mockT4 = JSON.parse(readFileSync(MOCK_T4_PATH, "utf8")) as {
    chat: number; balance: number; models: number; other: number; total: number;
  };
  // mock 关停（SIGTERM）时落盘的权威终值计数
  const mockFinal = JSON.parse(readFileSync(MOCK_FINAL_PATH, "utf8")) as {
    chat: number; balance: number; models: number; other: number; total: number;
  };
  const fetchLog = readFileSync(FETCH_LOG_PATH, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { action: string; originalUrl: string; finalUrl?: string; service: string });
  const live = await collectCounts(fixture.enterpriseId);
  const assertions: Assertion[] = [];
  const add = (id: string, pass: boolean, detail: string) => assertions.push({ id, pass, detail });

  // ── 断言 A：资金四表零增量（pf 测试 FINANCE_COUNT_TABLES 四事实表口径）──
  add("A1_finance_event_zero_after_switch",
    live.provider_finance_event === c1.provider_finance_event
    && live.provider_finance_event === c4.provider_finance_event,
    `切换窗口起点 C1=${c1.provider_finance_event} 终点 live=${live.provider_finance_event} C4=${c4.provider_finance_event}（资金事件全程仅 T0 旧栈订阅登记 ${String(baseline.providerFinanceEventAtC0)} 行，切换窗口内零新增）`);
  add("A2_subscription_period_zero_after_switch",
    live.provider_subscription_period === c1.provider_subscription_period
    && live.provider_subscription_period === c4.provider_subscription_period,
    `C1=${c1.provider_subscription_period} live=${live.provider_subscription_period}（周期行全程仅 T0 订阅登记，切换窗口内零新增）`);
  add("A3_activation_attempt_zero_all_drill",
    live.provider_finance_activation_attempt === 0 && c1.provider_finance_activation_attempt === 0
    && c4.provider_finance_activation_attempt === 0,
    `C1=${c1.provider_finance_activation_attempt} C4=${c4.provider_finance_activation_attempt} live=${live.provider_finance_activation_attempt}（全程零激活尝试行）`);
  add("A4_ledger_only_planned_consumption",
    live.ledger_line === c1.ledger_line + 1 && live.ledger_line === c4.ledger_line
    && live.perRequest.length === 3,
    `C1=${c1.ledger_line} live=${live.ledger_line}；切换窗口内仅 +1＝T1 在途消费收尾；请求总数=${live.perRequest.length}（3 笔计划消费，无旁路账本行）`);
  add("A5_retired_endpoints_410", baseline.retired410 === true,
    `七退役端点在候选栈全部 410＋固定错误码（HTTP 层证据：${JSON.stringify(baseline.retired410Detail ?? "")}）`);

  // ── 断言 B：在途消费收尾（真实时序）──
  const inflightId = String(baseline.inflightRequestId ?? "");
  const inflight = live.perRequest.find((row) => row.requestId === inflightId);
  add("B1_inflight_admitted_under_lease", baseline.inflightAdmitted === true,
    `静默租约启动时在途请求已 admitted=${baseline.inflightAdmitted}（租约 ${JSON.stringify(baseline.leaseStart)}）`);
  add("B2_gate_blocked_new_requests", baseline.gate503 === true,
    `租约内新请求被门禁拒绝（${JSON.stringify(baseline.gate503Detail ?? "")}）`);
  add("B3_drain_report_reached_zero",
    baseline.drained === true && live.ai_request_in_progress === 0 && live.upstream_attempt_open === 0
    && live.ledger_transaction_pending === 0,
    `收尾报告 drained=${baseline.drained}；live IN_PROGRESS=${live.ai_request_in_progress} openAttempts=${live.upstream_attempt_open} pendingTx=${live.ledger_transaction_pending}`);
  add("B4_inflight_settled_amount_readable",
    inflight !== undefined && inflight.status === "SUCCEEDED"
    && inflight.apiCost === fixture.expectedCosts["X08-T1-INFLIGHT"]
    && inflight.txStatus === "SETTLED" && inflight.txTotal === fixture.expectedCosts["X08-T1-INFLIGHT"],
    `在途请求 ${inflightId}：status=${inflight?.status} api_cost=${inflight?.apiCost} tx=${inflight?.txStatus}/${inflight?.txTotal}`);
  add("B5_quiescence_released",
    live.quiescence.status === "RELEASED" && live.quiescence.releasedAt !== null,
    `租约终态=${live.quiescence.status} released_at=${live.quiescence.releasedAt}`);

  // ── 断言 C：Worker 切换＋官方刷新＋套餐 tick 共存 ──
  const newTick = baseline.newWorkerOperatingTick as { snapshotsCreated?: number } | null | undefined;
  add("C1_old_worker_stopped_new_started",
    baseline.oldWorkerStopped === true && baseline.newWorkerStarted === true,
    `旧 worker PID ${JSON.stringify(baseline.oldWorkerPid)} 已停；新 worker PID ${JSON.stringify(baseline.newWorkerPid)} 运行`);
  add("C2_official_refresh_runner_snapshot",
    live.operating_snapshot > c1.operating_snapshot && typeof newTick?.snapshotsCreated === "number"
    && newTick.snapshotsCreated >= 1,
    `快照 C1=${c1.operating_snapshot} → live=${live.operating_snapshot}（T4 新 worker runner 路径新快照落库）；tick 输出 ${JSON.stringify(newTick)}`);
  add("C3_official_refresh_manual_success",
    live.balance_refresh >= 1 && baseline.manualRefresh === true,
    `provider_resource_balance_refresh 行数=${live.balance_refresh}；HTTP 结果 ${JSON.stringify(baseline.manualRefreshDetail)}`);
  add("C4_renewal_tick_runs_both_workers",
    baseline.renewalTickOld !== null && baseline.renewalTickNew !== null,
    `旧 worker tick ${JSON.stringify(baseline.renewalTickOld)}；新 worker tick ${JSON.stringify(baseline.renewalTickNew)}`);

  // ── 断言 D：套餐自动续订开关/周期前后不变 ──
  add("D1_auto_renew_enabled_unchanged",
    live.autoRenewEnabled === true && baseline.autoRenewalOld !== null
    && JSON.stringify(baseline.autoRenewalNew) === JSON.stringify(baseline.autoRenewalOld),
    `DB enabled=${live.autoRenewEnabled}；HTTP 新旧栈视图一致=${JSON.stringify(baseline.autoRenewalNew) === JSON.stringify(baseline.autoRenewalOld)}`);
  add("D2_subscription_period_unchanged",
    live.subscriptionPeriods.length === 1
    && JSON.stringify(live.subscriptionPeriods) === JSON.stringify(baseline.periodsDbT0),
    `live 周期行=${JSON.stringify(live.subscriptionPeriods)}；T0 基线=${JSON.stringify(baseline.periodsDbT0)}`);
  add("D3_http_views_unchanged",
    JSON.stringify(baseline.periodsNew) === JSON.stringify(baseline.periodsOld),
    `GET subscription-periods 新旧栈响应一致=${JSON.stringify(baseline.periodsNew) === JSON.stringify(baseline.periodsOld)}`);

  // ── 断言 E：全程零真实付款（全部上游＝本地 mock；fail-closed 守卫）──
  const blocked = fetchLog.filter((line) => line.action === "BLOCKED");
  const nonLocalFinal = fetchLog.filter((line) => {
    if (line.action === "BLOCKED" || !line.finalUrl) return false;
    const host = new URL(line.finalUrl).hostname;
    return host !== "127.0.0.1" && host !== "localhost" && host !== "::1";
  });
  add("E1_no_blocked_or_nonlocal_outbound",
    blocked.length === 0 && nonLocalFinal.length === 0,
    `fetch 守卫日志共 ${fetchLog.length} 行：BLOCKED=${blocked.length}，非本地 finalUrl=${nonLocalFinal.length}（守卫 fail-closed：非本地主机的调用不会发出）`);
  add("E2_mock_upstream_counts_match_plan",
    mockFinal.chat === 3 && mockFinal.balance === 4 && mockFinal.other === 0,
    `mock 权威终值（SIGTERM 落盘 x08-mock-stats.json）：chat=${mockFinal.chat}（T0 正常＋T1 在途＋T4 新消费；503 被拒请求未触达上游） balance=${mockFinal.balance}（T0 旧 worker 同步 A/B 共 2 次＋T4 新 worker runner 同步资源C 1 次＋T4 手动刷新资源A 1 次） other=${mockFinal.other}（无未知端点）；T4 时点快照 balance=${mockT4.balance}`);
  add("E3_no_unplanned_requests",
    live.ai_request === 3 && live.ai_request_succeeded === 3 && live.ledger_transaction_settled === 3,
    `ai_request=${live.ai_request}（全部 SUCCEEDED）；SETTLED 事务=${live.ledger_transaction_settled}`);
  add("E4_zero_real_payment_proxy",
    blocked.length === 0 && nonLocalFinal.length === 0 && mockFinal.other === 0
    && live.provider_finance_event === 1,
    `无任何外部主机外呼；资金事件全程仅 T0 订阅登记（充值/付款凭证写路径零触达）；方法局限：进程网络层以 fetch 守卫日志＋mock 计数＋配置审查（capability_set.base_url 指向本地）为证`);

  // ── 附加核对：T0 消费在新栈可读金额一致；无期初资源新消费可结算 ──
  const t0Id = String(baseline.t0RequestId ?? "");
  const t0Row = live.perRequest.find((row) => row.requestId === t0Id);
  const t0Old = baseline.t0UsageRowOld as { total_api_cost?: string } | null;
  const t0New = baseline.t0UsageRowNew as { total_api_cost?: string } | null;
  add("X1_t0_consumption_readable_same_amount",
    t0Row !== undefined && t0Row.apiCost === fixture.expectedCosts["X08-T0-NORMAL"]
    && t0Old?.total_api_cost === t0Row.apiCost && t0New?.total_api_cost === t0Row.apiCost,
    `T0 请求 ${t0Id} 旧栈 /usage=${t0Old?.total_api_cost} 新栈 /usage=${t0New?.total_api_cost} DB=${t0Row?.apiCost}`);
  const t4Id = String(baseline.t4RequestId ?? "");
  const t4Row = live.perRequest.find((row) => row.requestId === t4Id);
  add("X2_new_consumption_no_opening_settleable",
    t4Row !== undefined && t4Row.status === "SUCCEEDED"
    && t4Row.apiCost === fixture.expectedCosts["X08-T4-NEW"] && t4Row.txStatus === "SETTLED",
    `T4 新消费 ${t4Id}（无期初资源A）：${t4Row?.status} ${t4Row?.apiCost} tx=${t4Row?.txStatus}`);

  const allPass = assertions.every((item) => item.pass);
  process.stdout.write(`${JSON.stringify({ allPass, assertions }, null, 2)}\n`);
  if (!allPass) process.exitCode = 2;
}

const db = createKysely(DATABASE_URL);

async function main(): Promise<void> {
  assertDedicatedDatabase(DATABASE_URL);
  const sub = process.argv[2] ?? "";
  if (sub === "counts") await subcommandCounts();
  else if (sub === "migrate") await subcommandMigrate();
  else if (sub === "final") await subcommandFinal();
  else throw new Error(`未知子命令：${sub}（counts|migrate|final）`);
  await db.destroy();
}

main().catch((error) => {
  console.error("X08_CHECKS_FAILED", error);
  process.exitCode = 1;
});
