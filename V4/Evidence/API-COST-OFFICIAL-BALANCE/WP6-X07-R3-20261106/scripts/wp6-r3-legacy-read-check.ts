/**
 * X07 R3 断言组 2：旧栈（ae506fe）读/结算「恢复＋增量回放」后的库（0092 水位）。
 *
 * 口径＝WP6-20261104 已采信的 legacy-ae506fe-read-check 三行式结论复用：
 *   1) 准入：ResourcePoolRepository.listServableResources——无 finance_state 行的
 *      资源（切换后新建、随增量回放回库）被旧候选包含（可服务）；
 *      带 PENDING 行的资源（存量留档／回放后新建）被旧过滤排除（行为边界非丢数据）。
 *   2) 可读：GatewayLedgerRepository.listLedgerLines——切换前＋切换后新消费金额逐字读出。
 *   3) 可结算：createRequest/createAttempt/createUsageAndLedgerLineIfAbsent 旧结算写路径
 *      在恢复库落一笔新消费并随即可读（ae506fe 原签名原路径）。
 *   4) 窗口聚合：loadWindowOperatingFinance——切换前＋切换后＋旧结算写路径金额合计。
 *   5) 额度：readQuotaPeriodsInTransaction——员工月度额度行（0092 重放＋增量回放产物）可读。
 *
 * 从【旧基线只读 worktree】运行（tsx 由旧 worktree node_modules 提供），全部业务代码
 * 经绝对路径直引旧 worktree 源文件（禁止 bare "@qianliu/*"——那会解析回候选树）。
 * 安全门：只允许本机＋演练专用库名 wp6_r3_replay。
 *
 * 运行（旧 worktree 根）：
 *   DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
 *   DATABASE_URL=postgres://qianliu_test:...@127.0.0.1:<port>/wp6_r3_replay \
 *   WP6_R3_FIXTURE_JSON=<fixture.json> \
 *   /Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/node_modules/.bin/tsx 本文件
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
import { createKysely } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/kysely.ts";
import { ResourcePoolRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/resource-pool-repository.ts";
import { GatewayLedgerRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/gateway-ledger-repository.ts";
import { loadWindowOperatingFinance } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/dashboard-home-costs.ts";
import { readQuotaPeriodsInTransaction } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/employee-quota-read-repository.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FIXTURE_JSON = process.env.WP6_R3_FIXTURE_JSON ?? "";
const OUTPUT_JSON = process.env.WP6_R3_LEGACY_OUTPUT ?? "";

function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_r3_replay") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

interface Fixture {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  resourceReadyId: string;
  resourcePendingId: string;
  resourceCutoverId: string;
  resourcePostReplayId: string;
  preRequest: string;
  cutRequest1: string;
  cutRequest2: string;
  amounts: { pre: string; cut1: string; cut2: string; legacySettle: string };
  window: { start: string; end: string };
  expected: { periodKey: string; limitValue: string; usedValue: string; windowTotalCny: string };
}

function safe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, safe(v)]));
  }
  return value;
}

async function main(): Promise<void> {
  assertDedicatedDatabase(DATABASE_URL);
  const fixture = JSON.parse(readFileSync(FIXTURE_JSON, "utf8")) as Fixture;
  const db = createKysely(DATABASE_URL);

  const report: Record<string, unknown> = {
    legacyRoot: LEGACY_ROOT,
    legacyHeadMigration: "0092_employee_monthly_quota（ae506fe 迁移头；恢复点 0091＋0092 幂等重放）",
    databaseUrlPath: new URL(DATABASE_URL).pathname,
  };

  // ── 1) 准入：旧代码资源候选查询 ────────────────────────────────────
  const servable = await new ResourcePoolRepository(db).listServableResources(fixture.enterpriseId);
  const servableIds = servable.map((item) => item.id);
  report.admission = {
    query: "ResourcePoolRepository.listServableResources (ae506fe)",
    servableIds,
    readyResource_included: servableIds.includes(fixture.resourceReadyId),
    cutoverResource_noFinanceRow_included: servableIds.includes(fixture.resourceCutoverId),
    pendingArchive_excluded: !servableIds.includes(fixture.resourcePendingId),
    postReplayNewResource_pending_excluded: !servableIds.includes(fixture.resourcePostReplayId),
  };

  // ── 2) 可读：旧代码结算读取路径（备份点消费＋增量回放的新消费）──────
  const ledger = new GatewayLedgerRepository(db);
  async function readLines(requestId: string) {
    const lines = await ledger.listLedgerLines(requestId);
    return lines.map((line) => ({
      api_cost: line.api_cost, api_cost_currency: line.api_cost_currency,
      api_cost_status: line.api_cost_status, resource_mode: line.resource_mode,
    }));
  }
  const preLines = await readLines(fixture.preRequest);
  const cut1Lines = await readLines(fixture.cutRequest1);
  const cut2Lines = await readLines(fixture.cutRequest2);
  report.readConsumptionFacts = {
    query: "GatewayLedgerRepository.listLedgerLines (ae506fe)",
    preBackupRequest: { requestId: fixture.preRequest, lines: preLines,
      amountMatchesSeed: preLines[0]?.api_cost === fixture.amounts.pre },
    cutoverRequest1_replayed: { requestId: fixture.cutRequest1, lines: cut1Lines,
      amountMatchesSeed: cut1Lines[0]?.api_cost === fixture.amounts.cut1 },
    cutoverRequest2_replayed: { requestId: fixture.cutRequest2, lines: cut2Lines,
      amountMatchesSeed: cut2Lines[0]?.api_cost === fixture.amounts.cut2 },
  };

  // ── 3) 可结算：旧代码结算写路径对恢复库落一笔新消费 ─────────────────
  const newRequestId = randomUUID();
  const request = await ledger.createRequest({
    id: newRequestId, enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId,
    principal_key_id: fixture.keyId, protocol: "chat", unified_model: "deepseek-chat",
    unified_model_id: null,
  });
  const newAttempt = await ledger.createAttempt({
    ai_request_id: request.id, enterprise_id: fixture.enterpriseId, attempt_no: 1,
    provider_resource_id: fixture.resourceReadyId, upstream_model: "deepseek-chat",
  });
  const settled = await ledger.createUsageAndLedgerLineIfAbsent({
    usage: {
      ai_request_id: request.id, enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: newAttempt.id, provider_resource_id: fixture.resourceReadyId,
      input_tokens: 500n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID(),
    },
    ledger_line: {
      ai_request_id: request.id, enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: newAttempt.id, provider_resource_id: fixture.resourceReadyId,
      principal_id: fixture.principalId, resource_mode: "API",
      raw_input_tokens: 500n, raw_output_tokens: 100n, raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n, api_cost: fixture.amounts.legacySettle,
      api_cost_currency: "CNY", api_cost_status: "PRICED_USAGE",
      usage_quality: "PROVIDER_REPORTED", settled_at: new Date(),
    },
  });
  const newLines = await ledger.listLedgerLines(request.id);
  report.settleNewConsumption = {
    path: "GatewayLedgerRepository.createRequest/createAttempt/createUsageAndLedgerLineIfAbsent (ae506fe)",
    requestStatus: request.status, created: settled.created,
    newLine: { api_cost: settled.line.api_cost, api_cost_currency: settled.line.api_cost_currency,
      api_cost_status: settled.line.api_cost_status },
    readableAfterSettle: newLines.map((line) => line.api_cost),
  };

  // ── 4) 窗口聚合：旧代码 loadWindowOperatingFinance ──────────────────
  const windowFinance = await loadWindowOperatingFinance(
    db, fixture.enterpriseId,
    new Date(fixture.window.start), new Date(fixture.window.end),
  );
  // 口径（同 WP6-20261104 legacy-read-check）：窗口聚合为可读性实证；窗口过滤按
  // ledger_line.settled_at（0054/0062 口径），旧结算写路径行的 settled_at＝回放后时钟
  // （不在演练窗口）不入合计——窗口内合计＝切换前＋切换后消费事实。
  report.windowOperatingFinance = {
    path: "loadWindowOperatingFinance (ae506fe dashboard-home-costs)",
    totalSpends: windowFinance.totalSpends,
    incompleteReason: windowFinance.incompleteReason,
    expectedWindowSumCny: fixture.expected.windowTotalCny,
    sumMatches: JSON.stringify(windowFinance.totalSpends)
      === JSON.stringify([{ currency: "CNY", amount: fixture.expected.windowTotalCny }]),
  };

  // ── 5) 额度：旧代码员工月度额度读取（0092 重放＋增量回放产物）──────
  const quotaPeriods = await readQuotaPeriodsInTransaction(db, {
    enterpriseId: fixture.enterpriseId, periodKey: fixture.expected.periodKey,
  });
  report.employeeQuotaPeriods = {
    path: "readQuotaPeriodsInTransaction (ae506fe employee-quota-read-repository)",
    periods: quotaPeriods.map((period) => ({
      period_key: period.period_key, provider: period.provider,
      limit_value: period.limit_value?.toString?.() ?? period.limit_value,
      used_value: period.used_value?.toString?.() ?? period.used_value,
      quota_basis: period.quota_basis, allow_overage: period.allow_overage,
    })),
    limitMatches: quotaPeriods[0]?.limit_value?.toString?.() === fixture.expected.limitValue,
    usedMatches: quotaPeriods[0]?.used_value?.toString?.() === fixture.expected.usedValue,
  };

  const payload = JSON.stringify(report, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
  if (OUTPUT_JSON) writeFileSync(OUTPUT_JSON, payload + "\n");
  console.log(payload);
  await db.destroy();
}

main().catch((error) => {
  console.error("LEGACY_READ_FAILED", safe(error));
  process.exitCode = 1;
});
