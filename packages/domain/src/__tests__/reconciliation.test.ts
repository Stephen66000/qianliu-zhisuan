/**
 * W17 单元测试：对账判定（evaluateReconciliation）。
 *
 * 覆盖：
 *   - PASS：重复 0 + 丢失 0 + 无汇总不一致
 *   - FAIL：重复 >0（重复率必须 0，行 870）
 *   - FAIL：丢失率 ≥0.1%（行 871）
 *   - REVIEW：仅汇总不一致（MISMATCH）
 *   - severity 分级（重复/丢失=HIGH，汇总=MEDIUM）
 *   - 比率计算（decimal 字符串）
 *
 * 依据：TRD 行 870-871、857。
 */
import { describe, it, expect } from "vitest";
import {
  evaluateReconciliation,
  DISCREPANCY_TYPE,
  RECONCILIATION_RESULT,
  DISCREPANCY_SEVERITY,
  type ReconciliationScan,
} from "../index.js";

function scan(overrides: Partial<ReconciliationScan> = {}): ReconciliationScan {
  return {
    rangeFrom: 1_800_000_000_000,
    rangeTo: 1_800_086_400_000,
    requestsScanned: 100,
    usageEventsScanned: 100,
    ledgerLinesScanned: 100,
    transactionsScanned: 100,
    discrepancies: [],
    ...overrides,
  };
}

function discrepancy(type: keyof typeof DISCREPANCY_TYPE, extra: Partial<{ aiRequestId: string; usageEventId: string }> = {}) {
  return {
    type: DISCREPANCY_TYPE[type],
    aiRequestId: extra.aiRequestId ?? null,
    usageEventId: extra.usageEventId ?? null,
    ledgerLineId: null,
    ledgerTransactionId: null,
    detail: {},
  };
}

describe("evaluateReconciliation 对账判定", () => {
  it("PASS：无任何差异（重复 0 + 丢失 0 + 无汇总不一致）", () => {
    const v = evaluateReconciliation(scan());
    expect(v.result).toBe(RECONCILIATION_RESULT.PASS);
    expect(v.duplicateCount).toBe(0);
    expect(v.missingCount).toBe(0);
    expect(v.mismatchCount).toBe(0);
    expect(v.duplicateRate).toBe("0.00000000");
    expect(v.missingRate).toBe("0.00000000");
  });

  it("FAIL：重复 >0（重复率必须 0，TRD 行 870）", () => {
    const v = evaluateReconciliation(
      scan({ discrepancies: [discrepancy("DUPLICATE_USAGE", { usageEventId: "u1" })] }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.FAIL);
    expect(v.duplicateCount).toBe(1);
    expect(v.duplicateRate).toBe("0.01000000"); // 1/100
  });

  it("FAIL：丢失率 ≥0.1%（TRD 行 871，阈值 0.001）", () => {
    // 100 个 usage，1 个丢失 = 0.01 ≥ 0.001 → FAIL
    const v = evaluateReconciliation(
      scan({ discrepancies: [discrepancy("MISSING_LEDGER_LINE", { usageEventId: "u1" })] }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.FAIL);
    expect(v.missingCount).toBe(1);
    expect(v.missingRate).toBe("0.01000000");
  });

  it("边界：丢失率恰好 0.1% → 仍 FAIL（阈值是 <，非 ≤）", () => {
    // 1000 个 usage，1 个丢失 = 0.001 = 阈值 → FAIL（行 871 是"低于 0.1%"，即严格 <）
    const v = evaluateReconciliation(
      scan({
        usageEventsScanned: 1000,
        discrepancies: [discrepancy("MISSING_LEDGER_LINE", { usageEventId: "u1" })],
      }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.FAIL);
    expect(v.missingRate).toBe("0.00100000");
  });

  it("PASS 边界：丢失率 <0.1%（如 9999 个 usage，1 个丢失 ≈ 0.0001）", () => {
    const v = evaluateReconciliation(
      scan({
        usageEventsScanned: 9999,
        discrepancies: [discrepancy("MISSING_LEDGER_LINE", { usageEventId: "u1" })],
      }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.PASS);
    expect(v.missingCount).toBe(1); // 有丢失但未超阈值
  });

  it("REVIEW：仅汇总不一致（无重复/丢失）", () => {
    const v = evaluateReconciliation(
      scan({ discrepancies: [discrepancy("SETTLEMENT_MISMATCH" as keyof typeof DISCREPANCY_TYPE)] }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.REVIEW);
    expect(v.mismatchCount).toBe(1);
    expect(v.duplicateCount).toBe(0);
    expect(v.missingCount).toBe(0);
  });

  it("severity 分级：重复/丢失 = HIGH，汇总不一致 = MEDIUM", () => {
    const v = evaluateReconciliation(
      scan({
        discrepancies: [
          discrepancy("DUPLICATE_USAGE", { usageEventId: "u1" }),
          discrepancy("MISSING_LEDGER_LINE", { usageEventId: "u2" }),
          discrepancy("ORPHAN_LEDGER_LINE"),
          discrepancy("SETTLEMENT_MISMATCH" as keyof typeof DISCREPANCY_TYPE),
        ],
      }),
    );
    const sev = v.discrepancies.map((d) => d.severity);
    expect(sev).toContain(DISCREPANCY_SEVERITY.HIGH);
    expect(sev).toContain(DISCREPANCY_SEVERITY.MEDIUM);
    // 重复/丢失类都是 HIGH
    expect(v.discrepancies.filter((d) => d.type === DISCREPANCY_TYPE.SETTLEMENT_MISMATCH)[0]!.severity).toBe(
      DISCREPANCY_SEVERITY.MEDIUM,
    );
    expect(v.discrepancies.filter((d) => d.type === DISCREPANCY_TYPE.DUPLICATE_USAGE)[0]!.severity).toBe(
      DISCREPANCY_SEVERITY.HIGH,
    );
  });

  it("重复 + 丢失同时存在 → FAIL（重复优先触发）", () => {
    const v = evaluateReconciliation(
      scan({
        discrepancies: [
          discrepancy("DUPLICATE_USAGE", { usageEventId: "u1" }),
          discrepancy("MISSING_LEDGER_LINE", { usageEventId: "u2" }),
        ],
      }),
    );
    expect(v.result).toBe(RECONCILIATION_RESULT.FAIL);
    expect(v.duplicateCount).toBe(1);
    expect(v.missingCount).toBe(1);
  });

  it("usageEventsScanned=0 时不除零（比率 0，PASS）", () => {
    const v = evaluateReconciliation(scan({ usageEventsScanned: 0, discrepancies: [] }));
    expect(v.result).toBe(RECONCILIATION_RESULT.PASS);
    expect(v.duplicateRate).toBe("0.00000000");
    expect(v.missingRate).toBe("0.00000000");
  });

  it("totalDiscrepancies 统计全部差异类型", () => {
    const v = evaluateReconciliation(
      scan({
        discrepancies: [
          discrepancy("DUPLICATE_USAGE", { usageEventId: "u1" }),
          discrepancy("SETTLEMENT_MISMATCH" as keyof typeof DISCREPANCY_TYPE),
        ],
      }),
    );
    expect(v.totalDiscrepancies).toBe(2);
  });
});
