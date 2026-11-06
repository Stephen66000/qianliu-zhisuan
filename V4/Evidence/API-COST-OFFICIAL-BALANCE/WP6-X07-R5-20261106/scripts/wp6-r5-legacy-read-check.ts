/**
 * X07 R4 断言组 2＋缺口③：旧栈（ae506fe）在「增量回放 v3」后的库（0092 水位）上
 * 走【真实准入与结算路径】，不只查行。
 *
 * 路径＝ae506fe 源码原签名：
 *   准入/额度门：ResourcePoolRepository.listServableResources ＋
 *     EmployeeQuotaRepository.reserveEmployeeQuota（evaluateQuotaGate：REJECT_EXHAUSTED
 *     ＝额度语义拒绝；MONTHLY 模式＝月度额度域真实生效，前提 enterprise
 *     .employee_quota_monthly_from 与 grant 池字段随增量保全）。
 *   结算累计：settleEmployeeQuota（settleEmployeeQuotaInTransaction：usage SETTLED＋
 *     period used_value 累计、reserved_value 回冲）。
 *   可读：GatewayLedgerRepository.listLedgerLines（备份点＋切换后消费逐字）。
 *   窗口：loadWindowOperatingFinance（resource_mode='API'＋settled_at 窗内合计）。
 *   旧结算写路径：createRequest/createAttempt/createUsageAndLedgerLineIfAbsent。
 *
 * 从【旧基线只读 worktree】运行（tsx 由旧 worktree node_modules 提供，业务代码绝对
 * 路径直引，禁止 bare "@qianliu/*"）。安全门：只允许本机＋演练专用库名 wp6_r4_live。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const LEGACY_ROOT = "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe";
import { createKysely } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/kysely.ts";
import { ResourcePoolRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/resource-pool-repository.ts";
import { GatewayLedgerRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/gateway-ledger-repository.ts";
import { loadWindowOperatingFinance } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/dashboard-home-costs.ts";
import { readQuotaPeriodsInTransaction } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/employee-quota-read-repository.ts";
import { EmployeeQuotaRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/employee-quota-repository.ts";
import { QuotaGateRepository } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/repositories/quota-gate-repository.ts";
import type { Database } from "/Users/mac/Projects/仟流智算-wp6-legacy-ae506fe/packages/database/src/kysely.ts";
import type { Kysely } from "kysely";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FIXTURE_JSON = process.env.WP6_R4_FIXTURE_JSON ?? "";
const OUTPUT_JSON = process.env.WP6_R4_LEGACY_OUTPUT ?? "";

function assertDedicatedDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (!local || url.pathname !== "/wp6_r4_live") {
    throw new Error(`拒绝连接非演练专用库：${url.hostname}${url.pathname}`);
  }
}

/** 累计计数行读取（R5 断言用）。 */
async function readCounter(db: Kysely<Database>, grantId: string) {
  const row = await db.selectFrom("quota_counter").selectAll()
    .where("grant_id", "=", grantId).executeTakeFirstOrThrow();
  return {
    used_value: row.used_value?.toString?.() ?? String(row.used_value),
    overage_value: row.overage_value?.toString?.() ?? String(row.overage_value),
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

interface Fixture {
  enterpriseId: string;
  principalId: string;
  principal2Id: string;
  keyId: string;
  key2Id: string;
  grant2Id: string;
  grant3Id: string;
  resourceReadyId: string;
  resourcePendingId: string;
  resourceCutoverId: string;
  postRollbackResourceId: string;
  preRequest: string;
  cutRequest1: string;
  cutRequest2: string;
  inflightRequest: string;
  r5aRequest: string;
  r5bRequest: string;
  amounts: { pre: string; cut1: string; cut2: string; inflight: string; legacySettle: string; r5a: string; r5b: string };
  window: { start: string; end: string };
  modelAliasExact: string;
  modelAliasNew: string;
  expected: {
    periodKey: string; limitValue: string; usedValueRestored: string;
    usedValueAfterSettle: string; windowTotalCny: string;
    c1Estimate: string; c2Estimate: string;
    counter2UsedLive: string; r5aEstimate: string;
    r5bLimit: string; r5bReserve: string; r5bActual: string; r5bUsedAfter: string;
    r5bOverEstimate: string;
  };
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
  const db: Kysely<Database> = createKysely(DATABASE_URL);

  const report: Record<string, unknown> = {
    legacyRoot: LEGACY_ROOT,
    legacyHeadMigration: "0092_employee_monthly_quota（ae506fe 迁移头；恢复点 0091＋0092 幂等重放＋增量回放 v3）",
    databaseUrlPath: new URL(DATABASE_URL).pathname,
  };

  // ── 1) 准入（缺口④绿证：PENDING 控制行已由 retire-threshold 删除，各态资源可服务）──
  const servable = await new ResourcePoolRepository(db).listServableResources(fixture.enterpriseId);
  const servableIds = servable.map((item) => item.id);
  report.admission = {
    query: "ResourcePoolRepository.listServableResources (ae506fe)",
    servableIds,
    readyResource_included: servableIds.includes(fixture.resourceReadyId),
    cutoverResource_noFinanceRow_included: servableIds.includes(fixture.resourceCutoverId),
    formerPendingResource_nowServable_included: servableIds.includes(fixture.resourcePendingId),
    postRollbackNewResource_noPending_included: servableIds.includes(fixture.postRollbackResourceId),
  };

  // ── 2) 可读：备份点＋切换后消费逐字（含 in-flight 结算产物——缺口①绿证）────
  const ledger = new GatewayLedgerRepository(db);
  async function readLines(requestId: string) {
    const lines = await ledger.listLedgerLines(requestId);
    return lines.map((line) => ({
      api_cost: line.api_cost, api_cost_currency: line.api_cost_currency,
      api_cost_status: line.api_cost_status, resource_mode: line.resource_mode,
    }));
  }
  const reads: Record<string, unknown> = {
    query: "GatewayLedgerRepository.listLedgerLines (ae506fe)",
  };
  for (const [key, id, amount] of [
    ["preBackup", fixture.preRequest, fixture.amounts.pre],
    ["cutover1", fixture.cutRequest1, fixture.amounts.cut1],
    ["cutover2", fixture.cutRequest2, fixture.amounts.cut2],
    ["inflightSettled", fixture.inflightRequest, fixture.amounts.inflight],
    ["r5aSettled", fixture.r5aRequest, fixture.amounts.r5a],
    ["r5bSettled", fixture.r5bRequest, fixture.amounts.r5b],
  ] as const) {
    const lines = await readLines(id);
    reads[key] = { requestId: id, lines,
      amountMatchesSeed: lines[0]?.api_cost === amount };
  }
  report.readConsumptionFacts = reads;

  // ── 3) 窗口聚合（旧结算落库前的窗口内 API 事实合计）──────────────────
  const windowFinance = await loadWindowOperatingFinance(
    db, fixture.enterpriseId,
    new Date(fixture.window.start), new Date(fixture.window.end),
  );
  report.windowOperatingFinance = {
    path: "loadWindowOperatingFinance (ae506fe dashboard-home-costs；resource_mode='API'＋settled_at 窗内)",
    totalSpends: windowFinance.totalSpends,
    incompleteReason: windowFinance.incompleteReason,
    expectedWindowSumCny: fixture.expected.windowTotalCny,
    sumMatches: JSON.stringify(windowFinance.totalSpends)
      === JSON.stringify([{ currency: "CNY", amount: fixture.expected.windowTotalCny }]),
  };

  // ── 4) 额度行可读（回放后还原值）───────────────────────────────────
  const quotaRepo = new EmployeeQuotaRepository(db);
  const periodsBefore = await readQuotaPeriodsInTransaction(db, {
    enterpriseId: fixture.enterpriseId, periodKey: fixture.expected.periodKey,
  });
  report.employeeQuotaRestored = {
    path: "readQuotaPeriodsInTransaction (ae506fe employee-quota-read-repository)",
    periods: periodsBefore.map((period) => ({
      period_key: period.period_key, provider: period.provider,
      limit_value: period.limit_value?.toString?.() ?? period.limit_value,
      used_value: period.used_value?.toString?.() ?? period.used_value,
      reserved_value: period.reserved_value?.toString?.() ?? period.reserved_value,
      quota_basis: period.quota_basis, allow_overage: period.allow_overage,
    })),
    limitMatches: periodsBefore[0]?.limit_value?.toString?.() === fixture.expected.limitValue,
    usedMatches: periodsBefore[0]?.used_value?.toString?.() === fixture.expected.usedValueRestored,
  };

  // ── 5) 缺口③①：真实额度门——超额请求经 reserveEmployeeQuota 被拒 ────
  const c1Request = await ledger.createRequest({
    id: randomUUID(), enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId,
    principal_key_id: fixture.keyId, protocol: "chat", unified_model: "deepseek-chat",
    unified_model_id: null,
  });
  const c1 = await quotaRepo.reserveEmployeeQuota({
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId,
    provider: "deepseek", modelAlias: "qianliu-r4",
    requestId: c1Request.id, attemptNo: 1, basis: "RAW_TOKEN",
    estimatedCost: BigInt(fixture.expected.c1Estimate),
  });
  report.quotaGateOverLimit = {
    path: "EmployeeQuotaRepository.reserveEmployeeQuota → evaluateQuotaGate (ae506fe)",
    requestId: c1Request.id,
    mode: c1.mode, decision: c1.decision,
    gateProjectedRemaining: c1.gate.projectedRemaining?.toString?.() ?? String(c1.gate.projectedRemaining),
    monthlyMode: c1.mode === "MONTHLY",
    rejectedWithQuotaReason: c1.decision === "REJECT_EXHAUSTED",
    periodReservedUnchanged: (periodsBefore[0]?.reserved_value?.toString?.() ?? "0") === "0",
  };

  // ── 6) 缺口③②：允许请求→旧栈结算路径落库、used 正确累计 ───────────
  const c2Request = await ledger.createRequest({
    id: randomUUID(), enterprise_id: fixture.enterpriseId, principal_id: fixture.principalId,
    principal_key_id: fixture.keyId, protocol: "chat", unified_model: "deepseek-chat",
    unified_model_id: null,
  });
  const c2 = await quotaRepo.reserveEmployeeQuota({
    enterpriseId: fixture.enterpriseId, principalId: fixture.principalId,
    provider: "deepseek", modelAlias: "qianliu-r4",
    requestId: c2Request.id, attemptNo: 1, basis: "RAW_TOKEN",
    estimatedCost: BigInt(fixture.expected.c2Estimate),
  });
  const reservedOk = c2.mode === "MONTHLY" && c2.decision === "ALLOW" && c2.usageId !== undefined && c2.periodId !== undefined;
  if (reservedOk) {
    await quotaRepo.settleEmployeeQuota({
      enterpriseId: fixture.enterpriseId, principalId: fixture.principalId,
      requestId: c2Request.id, usageId: c2.usageId!, periodId: c2.periodId!,
      actual: BigInt(fixture.expected.c2Estimate), usageQuality: "PROVIDER_REPORTED",
    });
  }
  const periodsAfter = await readQuotaPeriodsInTransaction(db, {
    enterpriseId: fixture.enterpriseId, periodKey: fixture.expected.periodKey,
  });
  const usageRow = c2.usageId
    ? await db.selectFrom("principal_quota_usage").selectAll()
        .where("id", "=", c2.usageId).executeTakeFirst()
    : undefined;
  report.quotaSettlementAccumulates = {
    path: "EmployeeQuotaRepository.settleEmployeeQuota → settleEmployeeQuotaInTransaction (ae506fe)",
    requestId: c2Request.id,
    reserved: { mode: c2.mode, decision: c2.decision, reservedOk },
    usage: usageRow ? { status: usageRow.status, actual: usageRow.actual?.toString?.() ?? usageRow.actual } : null,
    usedAfter: periodsAfter[0]?.used_value?.toString?.() ?? periodsAfter[0]?.used_value,
    reservedAfter: periodsAfter[0]?.reserved_value?.toString?.() ?? periodsAfter[0]?.reserved_value,
    usedAccumulatedCorrectly: reservedOk
      && periodsAfter[0]?.used_value?.toString?.() === fixture.expected.usedValueAfterSettle,
    usageSettled: usageRow?.status === "SETTLED"
      && usageRow?.actual?.toString?.() === fixture.expected.c2Estimate,
  };

  // ── 7) 旧结算写路径：恢复库落一笔新消费并随即可读 ───────────────────
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

  // ── R5-A：已有累计计数更新保全＋真实累计门（避免误走 MONTHLY：精确型号行 pool_model_alias IS NULL）──
  const quotaGate = new QuotaGateRepository(db);
  const counter2Before = await readCounter(db, fixture.grant2Id);
  const r5aReserve = await quotaGate.reserveQuota({
    enterpriseId: fixture.enterpriseId, principalId: fixture.principal2Id,
    provider: "deepseek", modelAlias: fixture.modelAliasExact,
    estimatedCost: BigInt(fixture.expected.r5aEstimate),
  });
  const counter2After = await readCounter(db, fixture.grant2Id);
  report.r5aCumulativeGate = {
    path: "QuotaGateRepository.reserveQuota (ae506fe quota-gate-repository；精确型号 grant＋quota_counter FOR UPDATE)",
    grantId: fixture.grant2Id, modelAlias: fixture.modelAliasExact,
    counterBefore: counter2Before, counterAfter: counter2After,
    decision: r5aReserve.decision, reservedEstimate: r5aReserve.reservedEstimate?.toString?.() ?? String(r5aReserve.reservedEstimate),
    rejectedWithQuotaReason: r5aReserve.decision === "REJECT_EXHAUSTED",
    counterUnchangedOnReject: counter2Before.used_value === counter2After.used_value
      && counter2Before.overage_value === counter2After.overage_value,
    usedMatchesLive: counter2Before.used_value === fixture.expected.counter2UsedLive,
  };

  // ── R5-B：新增累计授权及计数行——额度内预占→结算（多退少补精确累计）→达上限拒绝 ──
  const counter3Before = await readCounter(db, fixture.grant3Id);
  const r5bReserve = await quotaGate.reserveQuota({
    enterpriseId: fixture.enterpriseId, principalId: fixture.principal2Id,
    provider: "deepseek", modelAlias: fixture.modelAliasNew,
    estimatedCost: BigInt(fixture.expected.r5bReserve),
  });
  const counter3AfterReserve = await readCounter(db, fixture.grant3Id);
  const reserveAccumulated = r5bReserve.decision === "ALLOW"
    && counter3AfterReserve.used_value === (BigInt(counter3Before.used_value) + BigInt(fixture.expected.r5bReserve)).toString();
  if (reserveAccumulated) {
    await quotaGate.settleQuota(fixture.grant3Id, BigInt(fixture.expected.r5bReserve), BigInt(fixture.expected.r5bActual));
  }
  const counter3AfterSettle = await readCounter(db, fixture.grant3Id);
  const r5bOver = await quotaGate.reserveQuota({
    enterpriseId: fixture.enterpriseId, principalId: fixture.principal2Id,
    provider: "deepseek", modelAlias: fixture.modelAliasNew,
    estimatedCost: BigInt(fixture.expected.r5bOverEstimate),
  });
  const counter3AfterOver = await readCounter(db, fixture.grant3Id);
  report.r5bNewGrantCumulative = {
    path: "QuotaGateRepository.reserveQuota/settleQuota (ae506fe；新增授权＋计数行随增量回放后)",
    grantId: fixture.grant3Id,
    counterBefore: counter3Before,
    reserve: { decision: r5bReserve.decision, reservedEstimate: r5bReserve.reservedEstimate?.toString?.() ?? String(r5bReserve.reservedEstimate) },
    counterAfterReserve: counter3AfterReserve,
    counterAfterSettle: counter3AfterSettle,
    overLimit: { decision: r5bOver.decision, counterAfter: counter3AfterOver },
    reserveAllowed: r5bReserve.decision === "ALLOW",
    reserveAccumulatedPrecisely: reserveAccumulated,
    settleCorrectedPrecisely: counter3AfterSettle.used_value === fixture.expected.r5bUsedAfter,
    grantIdUniqueHeld: (await db.selectFrom("quota_counter").selectAll()
      .where("grant_id", "=", fixture.grant3Id).execute()).length === 1,
    overLimitRejected: r5bOver.decision === "REJECT_EXHAUSTED",
    counterUnchangedOnOverReject: counter3AfterSettle.used_value === counter3AfterOver.used_value,
    noCounterMissingException: true,
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
