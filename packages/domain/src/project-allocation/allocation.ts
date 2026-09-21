import {
  allocateByBps, formatScaled, parseDecimal, tokenShareUnits, UNALLOCATED_TARGET_KEY,
} from "./money.js";
import { intervalCovers, type TemporalInterval } from "./timeline.js";
import type { MembershipContext } from "./policy.js";

/**
 * 优先级分派与逐行分配（合同 §1/§2/§4；计划 v1.2 §4.2/§4.3/§4.4）。
 * 纯逻辑：优先级路径互斥；待分配池内一行可产生多项目份额+未分配份额；
 * 直接调用/人工指定 100% 记入单一目标；0% 段产生显式零份额行。
 */

export type AllocationSource = "PROJECT_DIRECT" | "MANUAL_ASSIGNMENT" | "MEMBERSHIP_RULE" | "UNALLOCATED";

export type UnallocatedReason =
  | "HISTORICAL_UNKNOWN"
  | "NO_MEMBERSHIP"
  | "NO_EFFECTIVE_RULE"
  | "WEIGHT_REMAINDER"
  | "RULE_PENDING_REPAIR";

/** 源行（来自共享成本 CTE 的行级证据；token 为 BigInt，金额为源精度字符串）。 */
export interface AllocationSourceLine {
  ledgerLineId: string;
  aiRequestId: string;
  upstreamAttemptId: string;
  providerResourceId: string | null;
  unifiedModelId: string | null;
  requestStartedAt: Date;
  accountedAt: Date;
  sourcePrincipalId: string;
  sourcePrincipalType: "EMPLOYEE" | "PROJECT";
  manualProjectId: string | null;
  inputTokens: bigint;
  outputTokens: bigint;
  cacheTokens: bigint | null;
  reasoningTokens: bigint | null;
  apiCost: string | null;
  apiCostCurrency: string | null;
  packageCost: string | null;
  usageQuality: string;
  resourceMode: string;
}

/** 已发布规则段（带版本证据）。 */
export interface EmployeeRuleSegment {
  policyId: string;
  membershipId: string;
  membershipRevisionId: string;
  projectPrincipalId: string;
  weightBps: number;
  validFrom: Date;
  validUntil: Date | null;
}

export interface EmployeeAllocationContext {
  employeePrincipalId: string;
  segments: EmployeeRuleSegment[];
  memberships: MembershipContext[];
  /** project → 核算窗口；未配置 = 不设限。 */
  accountingByProject: Map<string, { startedAt: Date; endedAt: Date | null }>;
}

export interface LineShare {
  ledgerLineId: string;
  aiRequestId: string;
  requestStartedAt: Date;
  accountedAt: Date;
  sourcePrincipalId: string;
  source: AllocationSource;
  targetProjectPrincipalId: string | null;
  weightBps: number | null;
  policyId: string | null;
  membershipId: string | null;
  membershipRevisionId: string | null;
  segmentFrom: Date | null;
  segmentUntil: Date | null;
  unallocatedReason: UnallocatedReason | null;
  shareInputTokens: string;
  shareOutputTokens: string;
  shareCacheTokens: string | null;
  shareReasoningTokens: string | null;
  shareApiCost: string | null;
  sharePackageCost: string | null;
}

export interface MonthAllocationInput {
  lines: AllocationSourceLine[];
  contextsByEmployee: Map<string, EmployeeAllocationContext>;
  /** 启用起始账期（含）之前的请求开始时间且无参与证据 → HISTORICAL_UNKNOWN。 */
  historicalCutoff: Date | null;
}

export interface MonthAllocationResult {
  shares: LineShare[];
  conservation: ConservationReport;
}

export function classifyLine(
  line: AllocationSourceLine,
): "PROJECT_DIRECT" | "MANUAL_ASSIGNMENT" | "POOL" {
  if (line.sourcePrincipalType === "PROJECT") return "PROJECT_DIRECT";
  if (line.manualProjectId !== null) return "MANUAL_ASSIGNMENT";
  return "POOL";
}

/**
 * 请求开始时点的有效权重：参与 ∩ 权重 ∩ 核算窗口（均半开）。
 * 规则存在但参与/核算不再覆盖时按待修复处理，不静默适用。
 */
export function effectiveWeightsAt(
  context: EmployeeAllocationContext,
  at: Date,
): { weights: Array<EmployeeRuleSegment>; rulePendingRepair: boolean } {
  const membershipById = new Map(context.memberships.map((m) => [m.membershipId, m]));
  const weights: Array<EmployeeRuleSegment> = [];
  let rulePendingRepair = false;
  for (const segment of context.segments) {
    if (!intervalCovers({ from: segment.validFrom, until: segment.validUntil }, at)) continue;
    const membership = membershipById.get(segment.membershipId);
    const membershipCovers = membership !== undefined
      && intervalCovers({ from: membership.joinedAt, until: membership.leftAt }, at);
    const accounting = context.accountingByProject.get(segment.projectPrincipalId);
    const accountingCovers = accounting === undefined
      || intervalCovers({ from: accounting.startedAt, until: accounting.endedAt }, at);
    if (membershipCovers && accountingCovers) {
      weights.push(segment);
    } else {
      rulePendingRepair = true;
    }
  }
  return { weights, rulePendingRepair };
}

function fullTokenShare(tokens: bigint | null): string | null {
  return tokens === null ? null : tokenShareUnits(tokens, 10000);
}

/** 优先级 1/2：100% 记入单一目标，不进入员工待分配池。 */
function allocateFullLine(
  line: AllocationSourceLine,
  source: "PROJECT_DIRECT" | "MANUAL_ASSIGNMENT",
): LineShare {
  return {
    ledgerLineId: line.ledgerLineId,
    aiRequestId: line.aiRequestId,
    requestStartedAt: line.requestStartedAt,
    accountedAt: line.accountedAt,
    sourcePrincipalId: line.sourcePrincipalId,
    source,
    targetProjectPrincipalId: source === "PROJECT_DIRECT" ? line.sourcePrincipalId : line.manualProjectId,
    weightBps: null,
    policyId: null,
    membershipId: null,
    membershipRevisionId: null,
    segmentFrom: null,
    segmentUntil: null,
    unallocatedReason: null,
    shareInputTokens: tokenShareUnits(line.inputTokens, 10000),
    shareOutputTokens: tokenShareUnits(line.outputTokens, 10000),
    shareCacheTokens: fullTokenShare(line.cacheTokens),
    shareReasoningTokens: fullTokenShare(line.reasoningTokens),
    shareApiCost: line.apiCost,
    sharePackageCost: line.packageCost,
  };
}

function unallocatedShare(
  line: AllocationSourceLine,
  reason: UnallocatedReason,
  bps: number,
): LineShare {
  return {
    ledgerLineId: line.ledgerLineId,
    aiRequestId: line.aiRequestId,
    requestStartedAt: line.requestStartedAt,
    accountedAt: line.accountedAt,
    sourcePrincipalId: line.sourcePrincipalId,
    source: "UNALLOCATED",
    targetProjectPrincipalId: null,
    weightBps: null,
    policyId: null,
    membershipId: null,
    membershipRevisionId: null,
    segmentFrom: null,
    segmentUntil: null,
    unallocatedReason: reason,
    shareInputTokens: tokenShareUnits(line.inputTokens, bps),
    shareOutputTokens: tokenShareUnits(line.outputTokens, bps),
    shareCacheTokens: line.cacheTokens === null ? null : tokenShareUnits(line.cacheTokens, bps),
    shareReasoningTokens: line.reasoningTokens === null ? null : tokenShareUnits(line.reasoningTokens, bps),
    shareApiCost: null,
    sharePackageCost: null,
  };
}

/** 费用分配在同一源行、同种类、同币种内做最大余数，保证逐行守恒。 */
function attachCostShares(
  line: AllocationSourceLine,
  shares: LineShare[],
  targets: Array<{ key: string; bps: number }>,
): void {
  const allocateColumn = (value: string | null): Map<string, string> | null => {
    if (value === null) return null;
    const parsed = parseDecimal(value);
    const units = allocateByBps(parsed.units, targets);
    const out = new Map<string, string>();
    for (const target of targets) {
      out.set(target.key, formatScaled({ units: units.get(target.key) ?? 0n, scale: parsed.scale }));
    }
    return out;
  };
  const apiShares = allocateColumn(line.apiCost);
  const packageShares = allocateColumn(line.packageCost);
  for (const share of shares) {
    const key = share.source === "UNALLOCATED" ? UNALLOCATED_TARGET_KEY : share.targetProjectPrincipalId ?? "";
    share.shareApiCost = apiShares === null ? null : apiShares.get(key) ?? null;
    share.sharePackageCost = packageShares === null ? null : packageShares.get(key) ?? null;
  }
}

/** 优先级 3/4：员工待分配池按有效权重归集；余量进入未分配（0% 段产生显式零份额行）。 */
function allocatePoolLine(
  line: AllocationSourceLine,
  context: EmployeeAllocationContext | undefined,
  historicalCutoff: Date | null,
): LineShare[] {
  const { weights, rulePendingRepair } = context === undefined
    ? { weights: [], rulePendingRepair: false }
    : effectiveWeightsAt(context, line.requestStartedAt);

  if (weights.length === 0) {
    const hasMembership = context?.memberships.some((membership) =>
      intervalCovers({ from: membership.joinedAt, until: membership.leftAt }, line.requestStartedAt)) ?? false;
    const reason: UnallocatedReason = rulePendingRepair
      ? "RULE_PENDING_REPAIR"
      : historicalCutoff !== null && line.requestStartedAt.getTime() < historicalCutoff.getTime()
        ? "HISTORICAL_UNKNOWN"
        : hasMembership ? "NO_EFFECTIVE_RULE" : "NO_MEMBERSHIP";
    const shares = [unallocatedShare(line, reason, 10000)];
    attachCostShares(line, shares, [{ key: UNALLOCATED_TARGET_KEY, bps: 10000 }]);
    return shares;
  }

  const totalBps = weights.reduce((sum, weight) => sum + weight.weightBps, 0);
  if (totalBps > 10000) {
    throw new Error(`weight bps exceeded at runtime: ${totalBps} (line ${line.ledgerLineId})`);
  }
  const targets = weights.map((weight) => ({ key: weight.projectPrincipalId, bps: weight.weightBps }));
  const shares: LineShare[] = weights.map((weight) => ({
    ledgerLineId: line.ledgerLineId,
    aiRequestId: line.aiRequestId,
    requestStartedAt: line.requestStartedAt,
    accountedAt: line.accountedAt,
    sourcePrincipalId: line.sourcePrincipalId,
    source: "MEMBERSHIP_RULE",
    targetProjectPrincipalId: weight.projectPrincipalId,
    weightBps: weight.weightBps,
    policyId: weight.policyId,
    membershipId: weight.membershipId,
    membershipRevisionId: weight.membershipRevisionId,
    segmentFrom: weight.validFrom,
    segmentUntil: weight.validUntil,
    unallocatedReason: null,
    shareInputTokens: tokenShareUnits(line.inputTokens, weight.weightBps),
    shareOutputTokens: tokenShareUnits(line.outputTokens, weight.weightBps),
    shareCacheTokens: line.cacheTokens === null ? null : tokenShareUnits(line.cacheTokens, weight.weightBps),
    shareReasoningTokens: line.reasoningTokens === null ? null : tokenShareUnits(line.reasoningTokens, weight.weightBps),
    shareApiCost: null,
    sharePackageCost: null,
  }));
  if (totalBps < 10000) {
    shares.push(unallocatedShare(line, "WEIGHT_REMAINDER", 10000 - totalBps));
    targets.push({ key: UNALLOCATED_TARGET_KEY, bps: 10000 - totalBps });
  }
  attachCostShares(line, shares, targets);
  return shares;
}

/** 单账期归集：优先级互斥分池 → 逐行分配 → 三级守恒报告。 */
export function allocateMonth(input: MonthAllocationInput): MonthAllocationResult {
  const shares: LineShare[] = [];
  const coverageViolations: string[] = [];
  const unknownApiCostLines: string[] = [];
  const unknownPackageCostLines: string[] = [];

  for (const line of input.lines) {
    const kind = classifyLine(line);
    const lineShares = kind === "PROJECT_DIRECT" || kind === "MANUAL_ASSIGNMENT"
      ? [allocateFullLine(line, kind)]
      : allocatePoolLine(line, input.contextsByEmployee.get(line.sourcePrincipalId), input.historicalCutoff);

    let coveredInput = 0n;
    let coveredOutput = 0n;
    for (const share of lineShares) {
      shares.push(share);
      coveredInput += parseDecimal(share.shareInputTokens).units;
      coveredOutput += parseDecimal(share.shareOutputTokens).units;
    }
    const expectedInput = line.inputTokens * 10000n;
    const expectedOutput = line.outputTokens * 10000n;
    if (coveredInput !== expectedInput || coveredOutput !== expectedOutput) {
      coverageViolations.push(
        `line ${line.ledgerLineId} covered ${coveredInput + coveredOutput} expected ${expectedInput + expectedOutput}`,
      );
    }
    if (line.apiCost === null || line.apiCostCurrency === null) unknownApiCostLines.push(line.ledgerLineId);
    if (line.packageCost === null) unknownPackageCostLines.push(line.ledgerLineId);
  }

  return { shares, conservation: buildConservation(input, shares, coverageViolations, unknownApiCostLines, unknownPackageCostLines) };
}

/** 金额桶：按币种分别累计，统一到桶内最大标度后输出字符串。 */
class MoneyBucket {
  private readonly byCurrency = new Map<string, { units: bigint; scale: number }>();

  add(currency: string, value: string): void {
    const parsed = parseDecimal(value);
    const existing = this.byCurrency.get(currency);
    if (!existing) {
      this.byCurrency.set(currency, parsed);
      return;
    }
    const scale = Math.max(existing.scale, parsed.scale);
    const factor = 10n ** BigInt(scale);
    this.byCurrency.set(currency, {
      units: existing.units * factor / 10n ** BigInt(existing.scale)
        + parsed.units * factor / 10n ** BigInt(parsed.scale),
      scale,
    });
  }

  format(): Record<string, string> {
    const output: Record<string, string> = {};
    for (const [currency, value] of this.byCurrency) output[currency] = formatScaled(value);
    return output;
  }
}

interface ShareAccumulator {
  shareCount: number;
  inputUnits: bigint;
  outputUnits: bigint;
  apiCost: MoneyBucket;
  packageCost: MoneyBucket;
  requests: Set<string>;
}

function newAccumulator(): ShareAccumulator {
  return { shareCount: 0, inputUnits: 0n, outputUnits: 0n, apiCost: new MoneyBucket(), packageCost: new MoneyBucket(), requests: new Set<string>() };
}

function accumulateShare(accumulator: ShareAccumulator, line: AllocationSourceLine, share: LineShare): void {
  accumulator.shareCount += 1;
  accumulator.requests.add(line.aiRequestId);
  accumulator.inputUnits += parseDecimal(share.shareInputTokens).units;
  accumulator.outputUnits += parseDecimal(share.shareOutputTokens).units;
  if (share.shareApiCost !== null && line.apiCostCurrency !== null) {
    accumulator.apiCost.add(line.apiCostCurrency, share.shareApiCost);
  }
  if (share.sharePackageCost !== null) accumulator.packageCost.add("CNY", share.sharePackageCost);
}

function buildConservation(
  input: MonthAllocationInput,
  shares: LineShare[],
  coverageViolations: string[],
  unknownApiCostLines: string[],
  unknownPackageCostLines: string[],
): ConservationReport {
  const bySource: Record<AllocationSource, ShareAccumulator> = {
    PROJECT_DIRECT: newAccumulator(),
    MANUAL_ASSIGNMENT: newAccumulator(),
    MEMBERSHIP_RULE: newAccumulator(),
    UNALLOCATED: newAccumulator(),
  };
  const byProject = new Map<string, ShareAccumulator & { requests: Set<string> }>();
  const lineById = new Map(input.lines.map((line) => [line.ledgerLineId, line]));

  const poolExpected = input.lines
    .filter((line) => classifyLine(line) === "POOL")
    .reduce((sum, line) => sum + (line.inputTokens + line.outputTokens) * 10000n, 0n);
  const sourceInput = input.lines.reduce((sum, line) => sum + line.inputTokens * 10000n, 0n);
  const sourceOutput = input.lines.reduce((sum, line) => sum + line.outputTokens * 10000n, 0n);
  const sourceApiMoney = new MoneyBucket();
  const sourcePackageMoney = new MoneyBucket();

  for (const line of input.lines) {
    if (line.apiCost !== null && line.apiCostCurrency !== null) sourceApiMoney.add(line.apiCostCurrency, line.apiCost);
    if (line.packageCost !== null) sourcePackageMoney.add("CNY", line.packageCost);
  }
  for (const share of shares) {
    const line = lineById.get(share.ledgerLineId);
    if (line === undefined) continue;
    accumulateShare(bySource[share.source], line, share);
    if (share.targetProjectPrincipalId !== null) {
      const project = byProject.get(share.targetProjectPrincipalId) ?? newAccumulator();
      accumulateShare(project, line, share);
      byProject.set(share.targetProjectPrincipalId, project);
    }
  }

  const sum = (accumulator: ShareAccumulator): bigint => accumulator.inputUnits + accumulator.outputUnits;
  const poolActual = sum(bySource.MEMBERSHIP_RULE) + sum(bySource.UNALLOCATED);
  const fullActual = poolActual + sum(bySource.PROJECT_DIRECT) + sum(bySource.MANUAL_ASSIGNMENT);
  const violations = [...coverageViolations];
  if (poolActual !== poolExpected) violations.push("employee pool conservation failed");
  if (fullActual !== sourceInput + sourceOutput) violations.push("full-source conservation failed");

  const mergedApiMoney = new MoneyBucket();
  for (const bucket of [bySource.PROJECT_DIRECT.apiCost, bySource.MANUAL_ASSIGNMENT.apiCost,
    bySource.MEMBERSHIP_RULE.apiCost, bySource.UNALLOCATED.apiCost]) {
    for (const [currency, amount] of Object.entries(bucket.format())) mergedApiMoney.add(currency, amount);
  }
  const sameMoney = (left: Record<string, string>, right: Record<string, string>): boolean => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if ((left[key] ?? "0") !== (right[key] ?? "0")) return false;
    }
    return true;
  };
  if (!sameMoney(mergedApiMoney.format(), sourceApiMoney.format())) violations.push("api cost conservation failed");
  const mergedPackageMoney = new MoneyBucket();
  for (const bucket of [bySource.PROJECT_DIRECT.packageCost, bySource.MANUAL_ASSIGNMENT.packageCost,
    bySource.MEMBERSHIP_RULE.packageCost, bySource.UNALLOCATED.packageCost]) {
    for (const amount of Object.values(bucket.format())) mergedPackageMoney.add("CNY", amount);
  }
  if (!sameMoney(mergedPackageMoney.format(), sourcePackageMoney.format())) violations.push("package cost conservation failed");

  const view = (accumulator: ShareAccumulator) => ({
    shareCount: accumulator.shareCount,
    totalTokens: formatScaled({ units: sum(accumulator), scale: 4 }),
    apiCostByCurrency: accumulator.apiCost.format(),
    packageCostCny: accumulator.packageCost.format().CNY ?? "0",
    requestCount: accumulator.requests.size,
  });

  return {
    source: {
      lineCount: input.lines.length,
      totalTokens: formatScaled({ units: sourceInput + sourceOutput, scale: 4 }),
      apiCostByCurrency: sourceApiMoney.format(),
      packageCostCny: sourcePackageMoney.format().CNY ?? "0",
      unknownApiCostLineCount: unknownApiCostLines.length,
      unknownPackageCostLineCount: unknownPackageCostLines.length,
    },
    bySource: {
      PROJECT_DIRECT: view(bySource.PROJECT_DIRECT),
      MANUAL_ASSIGNMENT: view(bySource.MANUAL_ASSIGNMENT),
      MEMBERSHIP_RULE: view(bySource.MEMBERSHIP_RULE),
      UNALLOCATED: view(bySource.UNALLOCATED),
    },
    byProject: [...byProject.entries()].map(([projectId, accumulator]) => ({
      projectPrincipalId: projectId,
      totalTokens: formatScaled({ units: sum(accumulator), scale: 4 }),
      involvedRequestCount: accumulator.requests.size,
      apiCostByCurrency: accumulator.apiCost.format(),
      packageCostCny: accumulator.packageCost.format().CNY ?? "0",
    })),
    perLineCoverageOk: coverageViolations.length === 0,
    poolConserved: poolActual === poolExpected,
    fullSourceConserved: fullActual === sourceInput + sourceOutput,
    violations,
  };
}

export interface ConservationReport {
  source: {
    lineCount: number;
    totalTokens: string;
    apiCostByCurrency: Record<string, string>;
    packageCostCny: string;
    unknownApiCostLineCount: number;
    unknownPackageCostLineCount: number;
  };
  bySource: Record<AllocationSource, {
    shareCount: number;
    totalTokens: string;
    apiCostByCurrency: Record<string, string>;
    packageCostCny: string;
    requestCount: number;
  }>;
  byProject: Array<{
    projectPrincipalId: string;
    totalTokens: string;
    involvedRequestCount: number;
    apiCostByCurrency: Record<string, string>;
    packageCostCny: string;
  }>;
  perLineCoverageOk: boolean;
  poolConserved: boolean;
  fullSourceConserved: boolean;
  violations: string[];
}

export type { TemporalInterval };
