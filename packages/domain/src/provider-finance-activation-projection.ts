/**
 * 资金账本初始化：激活范围、候选假设投影与完整窗口守恒（纯函数，主编排）。
 *
 * 对应 OpenSpec：PFA-01、PFA-02、PFH-01～PFH-05。
 * 计划 v1.2 §3.2/§4.5/§5.1/§5.2 与 design §5/§6。
 *
 * 工程约束：
 * - 本模块无数据库访问、无时钟读取、无随机数。数据库层只负责把事实与水位读进来、
 *   把结论写出去；预检与激活必须调用同一套投影与守恒函数。
 * - 余额公式的唯一实现在 provider-finance-balance-components.ts。本模块不得自行书写
 *   `.plus/.minus` 链或冲销正负号。
 * - 经营账单缺口的权威口径是数据库层 `countFinanceGaps`（SQL 单一来源）。
 *   本模块只对草稿与用量修复带来的**增量**做确定性抵消，不重新定义缺口规则。
 * - 缺口必须结构化且可定位到资源、账户、旧记录、用量行或月份；不得只返回一条错误字符串。
 *
 * 分段说明（质量门禁单文件上限）：本文件按 输入契约 / 草稿规范化 / 守恒检查 / 余额投影
 * 四段下沉到同名子模块，本文件保留主编排与缺口收集器，并**显式再导出**原有公开符号，
 * 保证包对外导出面与历史调用点零变化。
 */
import {
  PROVIDER_FINANCE_CUTOVER_ISO,
  USAGE_REPAIR_FIELDS,
  sortActivationGaps,
  type ActivationGap,
  type NormalizedActivationCandidate,
  type UsageRepairField,
  type UsageRepairSummary,
} from "./provider-finance-activation.js";
import { money } from "./provider-finance-balance-components.js";
import {
  compareStrings,
  gap,
  instantOf,
  isSameShanghaiDay,
  type ActivationProjectionInput,
  type ActivationProjectionResult,
} from "./provider-finance-activation-inputs.js";
import { planUsageRepairs, virtualPeriodsOf, type PeriodCandidate } from "./provider-finance-activation-draft.js";
import {
  collectPlanAttributionGaps,
  collectUsageClassificationGaps,
  computeMonthlyGapDeltas,
  conservationMonths,
  mapMonthlyGapCode,
} from "./provider-finance-activation-conservation.js";
import { collectScopeAndModeGaps, resolveOpeningAccounts } from "./provider-finance-activation-scope-openings.js";
import { projectAccountBalances } from "./provider-finance-activation-balances.js";

// ===== 迁移兼容：保持本模块原有公开导出面 =====

export {
  shanghaiMonthOf,
  shanghaiMonthBounds,
  conservationMonths,
  type ConservationMonth,
} from "./provider-finance-activation-conservation.js";

export {
  coveringPeriods,
  virtualPeriodsOf,
  planUsageRepairs,
  usageRepairFieldDigests,
  type PeriodCandidate,
  type UsageRepairPlan,
} from "./provider-finance-activation-draft.js";

export type {
  RequiredCurrencySource,
  ActivationScopeResourceInput,
  ActivationScopeAccountInput,
  FinanceFactRow,
  PeriodFactRow,
  LegacyPurchaseFactRow,
  LedgerLineFactRow,
  UsageEventFactRow,
  AccountComponentsFactRow,
  MonthlyGapFactRow,
  VirtualPeriod,
  UsageRepairTarget,
  ActivationProjectionInput,
  ActivationProjectionResult,
} from "./provider-finance-activation-inputs.js";

// ===== 主投影的子步骤（缺口收集器） =====

/** 旧购买记录唯一关闭（PFH-02）。 */
function collectLegacyResolutionGaps(input: ActivationProjectionInput, gaps: ActivationGap[]): void {
  const resolutionByRecord = new Map<string, NormalizedActivationCandidate["legacyPurchaseResolutions"][number]>();
  for (const resolution of input.draft.legacyPurchaseResolutions) {
    if (resolutionByRecord.has(resolution.legacyRecordId)) {
      gaps.push(gap("LEGACY_RECORD_UNCLOSED", "LEGACY_RECORD", "同一条旧购买记录出现了多个关闭决定",
        { legacyRecordId: resolution.legacyRecordId }));
      continue;
    }
    resolutionByRecord.set(resolution.legacyRecordId, resolution);
  }
  const legacyById = new Set(input.legacyPurchases.map((record) => record.id));
  for (const resolution of input.draft.legacyPurchaseResolutions) {
    if (!legacyById.has(resolution.legacyRecordId)) {
      gaps.push(gap("LEGACY_RECORD_UNKNOWN", "LEGACY_RECORD",
        "关闭决定引用的旧购买记录不在本企业激活窗口内",
        { legacyRecordId: resolution.legacyRecordId, resourceId: resolution.resourceId }));
    }
  }
  for (const record of [...input.legacyPurchases].sort((left, right) => compareStrings(left.id, right.id))) {
    if (record.alreadyMigratedEventId !== null) continue;
    const resolution = resolutionByRecord.get(record.id);
    if (!resolution) {
      gaps.push(gap("LEGACY_RECORD_UNCLOSED", "LEGACY_RECORD",
        "切换时点后的旧购买记录没有唯一关闭结果",
        { resourceId: record.resourceId, legacyRecordId: record.id }));
      continue;
    }
    if (resolution.resolution === "MIGRATED") {
      if (!resolution.migratedExternalReference) {
        gaps.push(gap("LEGACY_MIGRATION_REFERENCE_MISSING", "LEGACY_RECORD",
          "MIGRATED 必须提供外部订单引用", { legacyRecordId: record.id }));
      } else {
        // MIGRATED 必须同时把金额事实登记为草稿明细行并绑定源记录；
        // 只写「已迁移」而不登记金额，会静默丢掉一笔真实资金事实。
        const bound = [
          ...input.draft.historicalApiRecharges,
          ...input.draft.codingPlanPurchases,
        ].some((row) => row.sourceRecordId === record.id
          && row.externalReference === resolution.migratedExternalReference);
        if (!bound) {
          gaps.push(gap("LEGACY_MIGRATION_REFERENCE_MISSING", "LEGACY_RECORD",
            "MIGRATED 的外部订单引用必须与草稿明细行一致并绑定该源记录",
            { legacyRecordId: record.id, resourceId: record.resourceId,
              detail: resolution.migratedExternalReference }));
        }
      }
    }
    if (resolution.resolution === "REJECTED_WITH_EVIDENCE"
      && (!resolution.reason || !resolution.evidenceRef)) {
      gaps.push(gap("LEGACY_REJECTION_EVIDENCE_MISSING", "LEGACY_RECORD",
        "拒绝旧记录必须填写原因与证据", { legacyRecordId: record.id }));
    }
    if (resolution.resolution === "ALREADY_REPRESENTED") {
      const referenced = resolution.financeEventId
        ? input.financeEvents.find((event) => event.id === resolution.financeEventId)
        : undefined;
      const matches = referenced !== undefined
        && referenced.resourceId === record.resourceId
        && money(referenced.accountAmount) === money(record.amount)
        && referenced.currency === record.currency
        && instantOf(referenced.occurredAt) === instantOf(record.purchasedAt);
      if (!matches) {
        gaps.push(gap("LEGACY_REPRESENTATION_MISMATCH", "LEGACY_RECORD",
          "ALREADY_REPRESENTED 必须引用同企业、同资源且金额/币种/发生时间一致的资金事件",
          { legacyRecordId: record.id, resourceId: record.resourceId }));
      }
    }
  }
}

/** 草稿行自身必填项（防御性：合同已强制，这里保证投影不依赖校验层）。 */
function collectDraftRowGaps(
  input: ActivationProjectionInput, cutoverAt: string, gaps: ActivationGap[],
): void {
  for (const cost of input.draft.historicalApiCosts) {
    // 金额：规范化后仍必须大于 0（落账负向金额由共享实现统一取负）。
    if (Number(cost.costAmount) <= 0) {
      gaps.push(gap("HISTORICAL_COST_AMOUNT_INVALID", "USAGE",
        "历史 API 消耗的金额必须大于 0", {
          resourceId: cost.resourceId, accountCurrency: cost.accountCurrency,
          detail: cost.costAmount,
        }));
    }
    // 时间边界：期间开始固定为切换时点，截止不得早于切换时点、不得晚于候选水位。
    if (cost.occurredAt < cutoverAt) {
      gaps.push(gap("HISTORICAL_COST_TIME_INVALID", "USAGE",
        "成本截止时间不得早于资金切换时点", {
          resourceId: cost.resourceId, accountCurrency: cost.accountCurrency,
          detail: cost.occurredAt,
        }));
    }
    if (cost.occurredAt > input.snapshotAt) {
      gaps.push(gap("HISTORICAL_COST_TIME_INVALID", "USAGE",
        "成本截止时间不得晚于当前时间", {
          resourceId: cost.resourceId, accountCurrency: cost.accountCurrency,
          detail: cost.occurredAt,
        }));
    }
  }
  for (const recharge of input.draft.historicalApiRecharges) {
    if (!recharge.accountAmount || Number(recharge.accountAmount) <= 0) {
      gaps.push(gap("MISSING_RECHARGE_AMOUNT", "RECHARGE", "历史充值缺少到账金额",
        { resourceId: recharge.resourceId, accountCurrency: recharge.accountCurrency }));
    }
    if (!recharge.cashPaidCny || Number(recharge.cashPaidCny) <= 0) {
      gaps.push(gap("MISSING_RECHARGE_CASH_PAID", "RECHARGE", "历史充值缺少人民币实付",
        { resourceId: recharge.resourceId, accountCurrency: recharge.accountCurrency }));
    }
    if (!recharge.evidenceRef.trim()) {
      gaps.push(gap("MISSING_EVIDENCE", "RECHARGE", "历史充值缺少证据引用",
        { resourceId: recharge.resourceId }));
    }
  }
  for (const purchase of input.draft.codingPlanPurchases) {
    if (!purchase.accountAmount || Number(purchase.accountAmount) <= 0) {
      gaps.push(gap("MISSING_PURCHASE_AMOUNT", "PURCHASE", "购买缺少原币金额",
        { resourceId: purchase.resourceId }));
    }
    if (!purchase.cashPaidCny || Number(purchase.cashPaidCny) <= 0) {
      gaps.push(gap("MISSING_PURCHASE_CASH_PAID", "PURCHASE", "购买缺少人民币实付",
        { resourceId: purchase.resourceId }));
    }
    if (!purchase.evidenceRef.trim()) {
      gaps.push(gap("MISSING_EVIDENCE", "PURCHASE", "购买缺少证据引用",
        { resourceId: purchase.resourceId }));
    }
    if (!isSameShanghaiDay(purchase.occurredAt, purchase.servicePeriodStart)) {
      gaps.push(gap("INVALID_SERVICE_PERIOD", "PURCHASE", "扣费日期必须等于服务开始日", {
        resourceId: purchase.resourceId,
        detail: `${purchase.occurredAt} vs ${purchase.servicePeriodStart}`,
      }));
    }
  }
}

// ===== 主投影 =====

export function projectActivationCandidate(
  input: ActivationProjectionInput,
): ActivationProjectionResult {
  const cutoverAt = input.cutoverAt ?? PROVIDER_FINANCE_CUTOVER_ISO;
  const gaps: ActivationGap[] = [];
  const resourcesById = new Map(input.resources.map((resource) => [resource.resourceId, resource]));
  const window = conservationMonths(cutoverAt, input.snapshotAt);

  const effectivePeriods: PeriodCandidate[] = [
    ...input.periods.map((period): PeriodCandidate => ({
      id: period.id, resourceId: period.resourceId, periodStart: period.periodStart,
      periodEndExclusive: period.periodEndExclusive, reversed: period.reversedByEventId !== null,
    })),
    ...virtualPeriodsOf(input.draft),
  ];
  const plan = planUsageRepairs({ ledgerLines: input.ledgerLines, periods: effectivePeriods });

  // --- 激活范围、资源模式与期初时点（失败关闭） ---
  collectScopeAndModeGaps(input, resourcesById, cutoverAt, gaps);

  // --- 期初余额：必要账户必须且仅有一条（PFH-01） ---
  const { scopeAccounts, realOpenings, draftOpenings } = resolveOpeningAccounts(input, resourcesById, gaps);

  // --- 旧购买记录唯一关闭（PFH-02） ---
  collectLegacyResolutionGaps(input, gaps);

  // --- 草稿行自身必填项（防御性：合同已强制，这里保证投影不依赖校验层） ---
  collectDraftRowGaps(input, cutoverAt, gaps);

  // --- Coding Plan 用量唯一归属（PFH-03） ---
  collectPlanAttributionGaps(plan, gaps);

  // --- 全部月份守恒（PFH-05） ---
  const monthlyDelta = computeMonthlyGapDeltas(input, plan, new Set(
    [...draftOpenings.keys()].filter((key) => !realOpenings.has(key))), window);
  const operatingBillsComplete = monthlyDelta.every((entry) => entry.gaps.length === 0);
  for (const entry of monthlyDelta) {
    for (const code of entry.gaps) {
      gaps.push(gap(mapMonthlyGapCode(code), "OPERATING_BILL",
        `经营账单在 ${entry.month} 不完整：${code}`, { month: entry.month, detail: code }));
    }
  }

  // --- 用量费用分类与 Token 守恒（失败关闭 #4、#6） ---
  const tokenConserved = collectUsageClassificationGaps(input, plan, gaps);

  // --- 余额投影与守恒（PFH-05，复用共享聚合语义） ---
  const accounts = projectAccountBalances(input, plan, scopeAccounts, gaps);

  const eligibleByField = Object.fromEntries(USAGE_REPAIR_FIELDS.map((field) => [field,
    plan.baseline.filter((row) => row.eligibleRepairs.includes(field)).length]),
  ) as Record<UsageRepairField, number>;
  const usageRepairs: UsageRepairSummary = {
    eligibleRows: plan.baseline.length,
    eligibleByField,
    // 预检阶段尚未写入任何事实，故没有新增行；该计数只在激活复验时可能非零。
    newRowsAfterPreview: 0,
    nonTargetHashMismatches: 0,
  };

  const scopeResources = [...resourcesById.values()];
  return {
    decision: gaps.length === 0 ? "GO_CANDIDATE" : "NO_GO",
    // 缺口顺序只由缺口字段决定，不依赖查询或遍历顺序（PFU-03）。
    gaps: sortActivationGaps(gaps),
    projected: {
      accounts,
      monthsChecked: window.map((entry) => entry.month),
      tokenConserved,
      codingPlanUsageAttributed: plan.ambiguousPeriodLines.length === 0
        && plan.unattributedPlanLines.length === 0,
      operatingBillsComplete,
    },
    usageRepairs,
    usageRepairBaseline: plan.baseline,
    usageRepairTargets: plan.targets,
    scopeSummary: {
      apiResources: scopeResources.filter((resource) => resource.mode === "API").length,
      codingPlanResources: scopeResources.filter((resource) => resource.mode === "CODING_PLAN").length,
      requiredAccounts: scopeAccounts.size,
      legacyRecords: input.legacyPurchases.filter((record) => record.alreadyMigratedEventId === null).length,
      months: window.map((entry) => entry.month),
    },
  };
}
