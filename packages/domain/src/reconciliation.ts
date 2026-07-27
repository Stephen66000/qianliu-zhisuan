/**
 * 对账判定（W17）—— 重复/丢失/汇总比对的结果评估（纯函数，确定性）。
 *
 * 依据：TRD 行 870-871（同一计量事实重复记账率为 0；已确认调用事件丢失率低于 0.1%）、
 * 行 857（账本重复/丢失 → 立即停止，执行幂等对账或数据库恢复）、
 * 行 352（同一计量事实重复到达只更新处理状态，不新增 usage_event/ledger_line）。
 *
 * 分层：
 *   - 扫描（查 DB 找差异）在 @qianliu/database 仓储；
 *   - 判定（算比率、给 PASS/FAIL/REVIEW 结论、分级 severity）在本纯函数。
 *
 * 重复为 0 的硬保证：usage_event.dedup_key UNIQUE + ledger_transaction UNIQUE(ai_request_id)。
 * 对账任务是验证层：确认约束实际生效，并检测约束覆盖不到的丢失。
 *
 * 确定性（工程规则 §7）：同输入同输出，可回放。
 */

/** 对账算法版本（W17 冻结；自然月偏差校准底座）。 */
export const RECONCILIATION_ALGORITHM_VERSION = "w17-v1" as const;

/** 差异类型（reconciliation_discrepancy.discrepancy_type 稳定枚举）。 */
export const DISCREPANCY_TYPE = {
  /** 重复计量事实：同 dedup_key 多条（约束应已阻止，对账复核）。 */
  DUPLICATE_USAGE: "DUPLICATE_USAGE",
  /** usage_event 存在但缺对应 ledger_line（丢失明细）。 */
  MISSING_LEDGER_LINE: "MISSING_LEDGER_LINE",
  /** upstream_attempt 有消耗但缺 usage_event（丢失计量事实）。 */
  MISSING_USAGE: "MISSING_USAGE",
  /** ledger_line 存在但无对应 usage_event（孤儿明细）。 */
  ORPHAN_LEDGER_LINE: "ORPHAN_LEDGER_LINE",
  /** ledger_transaction.total_* 与 ledger_line 聚合不一致（结算汇总错）。 */
  SETTLEMENT_MISMATCH: "SETTLEMENT_MISMATCH",
} as const;

export type DiscrepancyType = (typeof DISCREPANCY_TYPE)[keyof typeof DISCREPANCY_TYPE];

/** 对账结论。 */
export const RECONCILIATION_RESULT = {
  /** 重复率=0 且丢失率<0.1%（TRD 行 870-871 达标）。 */
  PASS: "PASS",
  /** 重复率>0 或丢失率≥0.1%（超标，立即停止，行 857）。 */
  FAIL: "FAIL",
  /** 无重复/丢失，但存在汇总比对不一致（需人工复核）。 */
  REVIEW: "REVIEW",
} as const;

export type ReconciliationResultVerdict =
  (typeof RECONCILIATION_RESULT)[keyof typeof RECONCILIATION_RESULT];

/** 严重度（重复/丢失=HIGH；汇总不一致=MEDIUM）。 */
export const DISCREPANCY_SEVERITY = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
} as const;

/** 单条差异（仓储扫描产出，供纯函数分级 + 落库）。 */
export interface DiscrepancyRecord {
  type: DiscrepancyType;
  aiRequestId: string | null;
  usageEventId: string | null;
  ledgerLineId: string | null;
  ledgerTransactionId: string | null;
  detail: Record<string, unknown>;
}

/** 对账扫描结果（仓储层产出，传入纯函数判定）。 */
export interface ReconciliationScan {
  rangeFrom: number; // epoch ms
  rangeTo: number;
  requestsScanned: number;
  usageEventsScanned: number;
  ledgerLinesScanned: number;
  transactionsScanned: number;
  discrepancies: DiscrepancyRecord[];
}

/** 对账判定输出（落 reconciliation_run + 驱动异常队列）。 */
export interface ReconciliationVerdict {
  result: ReconciliationResultVerdict;
  duplicateCount: number;
  missingCount: number;
  mismatchCount: number;
  totalDiscrepancies: number;
  /** 重复率（duplicate/usageEvents，须为 0）。 */
  duplicateRate: string;
  /** 丢失率（missing/usageEvents，须 <0.001）。 */
  missingRate: string;
  /** 分级后的差异（附加 severity，供落库）。 */
  discrepancies: Array<DiscrepancyRecord & { severity: "HIGH" | "MEDIUM" | "LOW" }>;
}

/** 丢失率阈值：0.1%（TRD 行 871：已确认调用事件丢失率低于 0.1%）。 */
const MISSING_RATE_THRESHOLD = 0.001;

/**
 * 对账判定（TRD 行 870-871）。
 *
 *   - 重复率 = 重复差异数 / 扫描的 usage_event 数；必须 = 0；
 *   - 丢失率 = 丢失差异数 / 扫描的 usage_event 数；必须 < 0.1%；
 *   - 结论：PASS（达标）/ FAIL（重复或丢失超标）/ REVIEW（仅汇总不一致）。
 *
 * @param scan  仓储扫描结果
 * @returns 判定 + 分级差异（重复/丢失=HIGH，汇总不一致=MEDIUM）
 */
export function evaluateReconciliation(scan: ReconciliationScan): ReconciliationVerdict {
  const duplicateCount = scan.discrepancies.filter(
    (d) => d.type === DISCREPANCY_TYPE.DUPLICATE_USAGE,
  ).length;
  const missingCount = scan.discrepancies.filter(
    (d) =>
      d.type === DISCREPANCY_TYPE.MISSING_LEDGER_LINE ||
      d.type === DISCREPANCY_TYPE.MISSING_USAGE ||
      d.type === DISCREPANCY_TYPE.ORPHAN_LEDGER_LINE,
  ).length;
  const mismatchCount = scan.discrepancies.filter(
    (d) => d.type === DISCREPANCY_TYPE.SETTLEMENT_MISMATCH,
  ).length;

  // 比率（decimal 字符串，避免 number 精度；分母为 0 时比率为 "0"）
  const denom = scan.usageEventsScanned > 0 ? scan.usageEventsScanned : 1;
  const duplicateRate = (duplicateCount / denom).toFixed(8);
  const missingRate = (missingCount / denom).toFixed(8);

  // 判定（行 870-871）
  let result: ReconciliationResultVerdict;
  if (duplicateCount > 0 || missingCount / denom >= MISSING_RATE_THRESHOLD) {
    result = RECONCILIATION_RESULT.FAIL;
  } else if (mismatchCount > 0) {
    result = RECONCILIATION_RESULT.REVIEW;
  } else {
    result = RECONCILIATION_RESULT.PASS;
  }

  // 分级 severity（重复/丢失 = HIGH；汇总不一致 = MEDIUM）
  const discrepancies = scan.discrepancies.map((d) => ({
    ...d,
    severity:
      d.type === DISCREPANCY_TYPE.SETTLEMENT_MISMATCH
        ? DISCREPANCY_SEVERITY.MEDIUM
        : DISCREPANCY_SEVERITY.HIGH,
  }));

  return {
    result,
    duplicateCount,
    missingCount,
    mismatchCount,
    totalDiscrepancies: scan.discrepancies.length,
    duplicateRate,
    missingRate,
    discrepancies,
  };
}
