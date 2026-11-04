/**
 * X07 任务 B 实证段：旧代码（ae506fe）读回退后库（0092 水位）。
 *
 * 依据：WP6 plan.md 总指挥裁定 2——X07 旧代码实证对象＝ae506fe 的资源候选查询
 * （ResourcePoolRepository.listServableResources）与结算/费用读取路径对回退后库的
 * 真实行为；结果如实记录（若旧代码 PENDING 过滤排除无期初资源，记为已知边界）。
 *
 * 本脚本从【旧基线只读 worktree】运行（tsx 由旧 worktree node_modules 提供），
 * 全部业务代码经绝对路径直引旧 worktree 源文件（禁止任何 bare "@qianliu/*"
 * 导入——那会解析回候选树）；对库只做「读＋旧结算写路径各一次」（写路径为
 * 实证「旧服务可结算新消费」的必要动作，写的是回退后新建消费事实，非修复数据）。
 *
 * 运行（旧 worktree 根）：
 *   DOCKER_HOST=unix:///Users/mac/.colima/default/docker.sock \
 *   DATABASE_URL=postgres://postgres:qianliu@127.0.0.1:55433/wp6_x07_drill \
 *   X07_FIXTURE_JSON=/Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.fixture.json \
 *   corepack pnpm@11.11.0 exec tsx \
 *   /Users/mac/Projects/仟流智算-api-decouple/V4/Evidence/API-COST-OFFICIAL-BALANCE/WP6-20261104/scripts/legacy-ae506fe-read-check.legacy-read.ts
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ── 旧基线（ae506fe）源码绝对路径直引 ──────────────────────────────────
const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
import { createKysely } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/kysely.ts";
import { ResourcePoolRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/resource-pool-repository.ts";
import { GatewayLedgerRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/gateway-ledger-repository.ts";
import { loadWindowOperatingFinance } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/dashboard-home-costs.ts";
import { readQuotaPeriodsInTransaction } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/employee-quota-read-repository.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FIXTURE_JSON = process.env.X07_FIXTURE_JSON ?? "";

/** 安全门：只允许本机＋演练专用库名。 */
function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_x07_drill") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

interface Fixture {
  enterpriseId: string;
  principalId: string;
  keyId: string;
  periodId: string;
  freshResourceId: string;
  pendingResourceId: string;
  freshRequest: string;
  pendingRequest: string;
  freshCost: string;
  pendingCost: string;
}

/** JSON 安全化（bigint/Date）。 */
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
  // 旧代码 createKysely（ae506fe:150）连接回退后库。
  const db = createKysely(DATABASE_URL);

  const report: Record<string, unknown> = {
    legacyRoot: LEGACY_ROOT,
    legacyHeadMigration: "0092_employee_monthly_quota（ae506fe 迁移头）",
    databaseUrlPath: new URL(DATABASE_URL).pathname,
  };

  // ── 准入：旧代码资源候选查询 ────────────────────────────────────────
  const servable = await new ResourcePoolRepository(db).listServableResources(fixture.enterpriseId);
  const servableIds = servable.map((item) => item.id);
  report.admission = {
    query: "ResourcePoolRepository.listServableResources (ae506fe:428)",
    servableIds,
    freshResource_noFinanceRow: {
      resourceId: fixture.freshResourceId,
      included: servableIds.includes(fixture.freshResourceId),
    },
    legacyResource_pendingRow: {
      resourceId: fixture.pendingResourceId,
      included: servableIds.includes(fixture.pendingResourceId),
    },
  };

  // ── 可读：旧代码结算读取路径（回退前已结算消费）─────────────────────
  const ledger = new GatewayLedgerRepository(db);
  const freshLines = await ledger.listLedgerLines(fixture.freshRequest);
  const pendingLines = await ledger.listLedgerLines(fixture.pendingRequest);
  report.readPreRollbackSettlement = {
    query: "GatewayLedgerRepository.listLedgerLines (ae506fe:261)",
    freshRequest: {
      requestId: fixture.freshRequest,
      lines: freshLines.map((line) => ({
        api_cost: line.api_cost, api_cost_currency: line.api_cost_currency,
        api_cost_status: line.api_cost_status, resource_mode: line.resource_mode,
      })),
      amountMatchesSeed: freshLines[0]?.api_cost === fixture.freshCost,
    },
    pendingRequest: {
      requestId: fixture.pendingRequest,
      lines: pendingLines.map((line) => ({
        api_cost: line.api_cost, api_cost_currency: line.api_cost_currency,
        api_cost_status: line.api_cost_status,
      })),
      amountMatchesSeed: pendingLines[0]?.api_cost === fixture.pendingCost,
    },
  };

  // ── 可结算：旧代码结算写路径对回退后库落一笔新消费 ──────────────────
  // （旧服务在回退库上继续服务新请求：createRequest → createAttempt →
  //   createUsageAndLedgerLineIfAbsent，ae506fe 原签名原路径。）
  const newRequestId = randomUUID();
  const request = await ledger.createRequest({
    id: newRequestId, enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId,
    principal_key_id: fixture.keyId, protocol: "chat", unified_model: "deepseek-chat",
    unified_model_id: null,
  });
  const newAttempt = await ledger.createAttempt({
    ai_request_id: request.id, enterprise_id: fixture.enterpriseId, attempt_no: 1,
    provider_resource_id: fixture.freshResourceId, upstream_model: "deepseek-chat",
  });
  const settled = await ledger.createUsageAndLedgerLineIfAbsent({
    usage: {
      ai_request_id: request.id, enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: newAttempt.id, provider_resource_id: fixture.freshResourceId,
      input_tokens: 500n, output_tokens: 100n, cache_tokens: 0n, reasoning_tokens: 0n,
      usage_quality: "PROVIDER_REPORTED", dedup_key: randomUUID(),
    },
    ledger_line: {
      ai_request_id: request.id, enterprise_id: fixture.enterpriseId,
      upstream_attempt_id: newAttempt.id, provider_resource_id: fixture.freshResourceId,
      principal_id: fixture.principalId, resource_mode: "API",
      raw_input_tokens: 500n, raw_output_tokens: 100n, raw_cache_tokens: 0n,
      raw_reasoning_tokens: 0n, api_cost: "0.00052000", api_cost_currency: "CNY",
      api_cost_status: "PRICED_USAGE", usage_quality: "PROVIDER_REPORTED",
      settled_at: new Date(),
    },
  });
  const newLines = await ledger.listLedgerLines(request.id);
  report.settleNewConsumption = {
    path: "GatewayLedgerRepository.createRequest/createAttempt/createUsageAndLedgerLineIfAbsent (ae506fe)",
    requestStatus: request.status,
    created: settled.created,
    newLine: {
      api_cost: settled.line.api_cost, api_cost_currency: settled.line.api_cost_currency,
      api_cost_status: settled.line.api_cost_status,
    },
    readableAfterSettle: newLines.map((line) => line.api_cost),
  };

  // ── 可读（费用读路径）：旧代码 loadWindowOperatingFinance ────────────
  const windowFinance = await loadWindowOperatingFinance(
    db, fixture.enterpriseId,
    new Date("2026-11-04T00:00:00.000Z"), new Date("2026-11-05T00:00:00.000Z"),
  );
  report.windowOperatingFinance = {
    path: "loadWindowOperatingFinance (ae506fe dashboard-home-costs:36)",
    totalSpends: windowFinance.totalSpends,
    incompleteReason: windowFinance.incompleteReason,
    expectedLedgerSumCny: "0.00208000", // 0.00104000＋0.00052000＋旧结算写路径 0.00052000
  };

  // ── 额度：旧代码员工月度额度读取 ────────────────────────────────────
  const quotaPeriods = await readQuotaPeriodsInTransaction(db, {
    enterpriseId: fixture.enterpriseId, periodKey: "2026-11",
  });
  report.employeeQuotaPeriods = {
    path: "readQuotaPeriodsInTransaction (ae506fe employee-quota-read-repository:65)",
    periods: quotaPeriods.map((period) => ({
      period_key: period.period_key, provider: period.provider,
      limit_value: period.limit_value?.toString?.() ?? period.limit_value,
      used_value: period.used_value?.toString?.() ?? period.used_value,
      quota_basis: period.quota_basis, allow_overage: period.allow_overage,
    })),
  };

  console.log(JSON.stringify(report, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  await db.destroy();
}

main().catch((error) => {
  console.error("LEGACY_READ_FAILED", safe(error));
  process.exitCode = 1;
});
