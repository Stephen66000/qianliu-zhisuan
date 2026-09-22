/**
 * 分配金标（合同 12-WP01-goldstandards.md GS-1..GS-5b；期望值由计划 §5 独立推导）。
 */
import { describe, expect, it } from "vitest";
import {
  allocateByBps, tokenShareUnits, UNALLOCATED_TARGET_KEY,
} from "../project-allocation/money.js";
import {
  allocateMonth, classifyLine,
  type AllocationSourceLine, type EmployeeAllocationContext, type EmployeeRuleSegment,
} from "../project-allocation/allocation.js";

const T = (iso: string) => new Date(iso);

function poolLine(overrides: Partial<AllocationSourceLine>): AllocationSourceLine {
  return {
    ledgerLineId: overrides.ledgerLineId ?? "l-1",
    aiRequestId: "r-1",
    upstreamAttemptId: "att-1",
    providerResourceId: "res-1",
    unifiedModelId: null,
    requestStartedAt: T("2026-09-05T00:00:00Z"),
    accountedAt: T("2026-09-05T00:00:00Z"),
    sourcePrincipalId: "emp-1",
    sourcePrincipalType: "EMPLOYEE",
    manualProjectId: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheTokens: null,
    reasoningTokens: null,
    apiCost: null,
    apiCostCurrency: null,
    packageCost: null,
    usageQuality: "PROVIDER_REPORTED",
    resourceMode: "API",
    ...overrides,
  };
}

function context(segments: Array<Partial<EmployeeRuleSegment>>): EmployeeAllocationContext {
  return {
    employeePrincipalId: "emp-1",
    segments: segments.map((segment) => ({
      policyId: "pol-1",
      membershipId: "m-1",
      membershipRevisionId: "rev-1",
      projectPrincipalId: "pA",
      weightBps: 10000,
      validFrom: T("2026-09-01T00:00:00Z"),
      validUntil: null,
      ...segment,
    })),
    memberships: segments.map((segment) => ({
      membershipId: segment.membershipId ?? "m-1",
      projectPrincipalId: segment.projectPrincipalId ?? "pA",
      joinedAt: segment.validFrom ?? T("2026-09-01T00:00:00Z"),
      leftAt: segment.validUntil ?? null,
    })),
    accountingByProject: new Map(),
  };
}

describe("GS-1 三段算例", () => {
  it("A 220 万、B 60 万、未分配 320 万；员工账 600 万不变；三级守恒通过", () => {
    const ctx = context([
      { projectPrincipalId: "pA", membershipId: "mA", weightBps: 10000, validFrom: T("2026-09-01T00:00:00Z"), validUntil: T("2026-09-11T00:00:00Z") },
      { projectPrincipalId: "pA", membershipId: "mA2", weightBps: 6000, validFrom: T("2026-09-11T00:00:00Z"), validUntil: T("2026-09-21T00:00:00Z") },
      { projectPrincipalId: "pB", membershipId: "mB", weightBps: 3000, validFrom: T("2026-09-11T00:00:00Z"), validUntil: T("2026-09-21T00:00:00Z") },
    ]);
    const result = allocateMonth({
      lines: [
        poolLine({ ledgerLineId: "l-1", requestStartedAt: T("2026-09-05T00:00:00Z"), inputTokens: 1_000_000n }),
        poolLine({ ledgerLineId: "l-2", requestStartedAt: T("2026-09-15T00:00:00Z"), inputTokens: 2_000_000n }),
        poolLine({ ledgerLineId: "l-3", requestStartedAt: T("2026-09-25T00:00:00Z"), inputTokens: 3_000_000n }),
      ],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    const tokens = (project: string) => result.conservation.byProject
      .find((p) => p.projectPrincipalId === project)?.totalTokens;
    expect(tokens("pA")).toBe("2200000.0000");
    expect(tokens("pB")).toBe("600000.0000");
    expect(result.conservation.bySource.UNALLOCATED.totalTokens).toBe("3200000.0000");
    expect(result.conservation.source.totalTokens).toBe("6000000.0000");
    expect(result.conservation.poolConserved).toBe(true);
    expect(result.conservation.fullSourceConserved).toBe(true);
    expect(result.conservation.perLineCoverageOk).toBe(true);
    expect(result.conservation.violations).toEqual([]);

    // 首段 100% 专属规则来源为成员规则分摊，不标为人工指定（P1-1）。
    const firstSegmentShare = result.shares.find((share) => share.ledgerLineId === "l-1");
    expect(firstSegmentShare?.source).toBe("MEMBERSHIP_RULE");
    expect(firstSegmentShare?.weightBps).toBe(10000);
    const thirdShare = result.shares.find((share) => share.ledgerLineId === "l-3");
    expect(thirdShare?.unallocatedReason).toBe("NO_MEMBERSHIP");
  });
});

describe("GS-2 最小精度", () => {
  it("1 Token 按 3333/3333/余 3334 → 0.3333/0.3333/0.3334", () => {
    expect(tokenShareUnits(1n, 3333)).toBe("0.3333");
    expect(tokenShareUnits(1n, 3334)).toBe("0.3334");
    const ctx = context([
      { projectPrincipalId: "pA", weightBps: 3333 },
      { projectPrincipalId: "pB", membershipId: "mB", weightBps: 3333 },
    ]);
    const result = allocateMonth({
      lines: [poolLine({ inputTokens: 1n })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    expect(result.conservation.byProject.find((p) => p.projectPrincipalId === "pA")?.totalTokens).toBe("0.3333");
    expect(result.conservation.byProject.find((p) => p.projectPrincipalId === "pB")?.totalTokens).toBe("0.3333");
    expect(result.conservation.bySource.UNALLOCATED.totalTokens).toBe("0.3334");
    expect(result.conservation.violations).toEqual([]);
  });

  it("大额稳定性：10^15 × 6000bps 精确", () => {
    expect(tokenShareUnits(10n ** 15n, 6000)).toBe("600000000000000.0000");
  });
});

describe("GS-3 全来源金标", () => {
  it("源总量 630 万；A 230/B 80/未 320；10+20+280+320=630；新增事实不进池", () => {
    const ctx = context([
      { projectPrincipalId: "pA", membershipId: "mA", weightBps: 10000, validFrom: T("2026-09-01T00:00:00Z"), validUntil: T("2026-09-11T00:00:00Z") },
      { projectPrincipalId: "pA", membershipId: "mA2", weightBps: 6000, validFrom: T("2026-09-11T00:00:00Z"), validUntil: T("2026-09-21T00:00:00Z") },
      { projectPrincipalId: "pB", membershipId: "mB", weightBps: 3000, validFrom: T("2026-09-11T00:00:00Z"), validUntil: T("2026-09-21T00:00:00Z") },
    ]);
    const result = allocateMonth({
      lines: [
        poolLine({ ledgerLineId: "l-1", requestStartedAt: T("2026-09-05T00:00:00Z"), inputTokens: 1_000_000n }),
        poolLine({ ledgerLineId: "l-2", requestStartedAt: T("2026-09-15T00:00:00Z"), inputTokens: 2_000_000n }),
        poolLine({ ledgerLineId: "l-3", requestStartedAt: T("2026-09-25T00:00:00Z"), inputTokens: 3_000_000n }),
        poolLine({
          ledgerLineId: "l-direct", sourcePrincipalId: "pA", sourcePrincipalType: "PROJECT",
          inputTokens: 100_000n,
        }),
        poolLine({
          ledgerLineId: "l-manual", sourcePrincipalId: "emp-2", manualProjectId: "pB",
          inputTokens: 200_000n,
        }),
      ],
      contextsByEmployee: new Map([
        ["emp-1", ctx],
        ["emp-2", { employeePrincipalId: "emp-2", segments: [], memberships: [], accountingByProject: new Map() }],
      ]),
      historicalCutoff: null,
    });
    expect(result.conservation.source.totalTokens).toBe("6300000.0000");
    expect(result.conservation.byProject.find((p) => p.projectPrincipalId === "pA")?.totalTokens).toBe("2300000.0000");
    expect(result.conservation.byProject.find((p) => p.projectPrincipalId === "pB")?.totalTokens).toBe("800000.0000");
    expect(result.conservation.bySource.UNALLOCATED.totalTokens).toBe("3200000.0000");
    expect(result.conservation.bySource.PROJECT_DIRECT.totalTokens).toBe("100000.0000");
    expect(result.conservation.bySource.MANUAL_ASSIGNMENT.totalTokens).toBe("200000.0000");
    expect(result.conservation.bySource.MEMBERSHIP_RULE.totalTokens).toBe("2800000.0000");
    expect(result.conservation.violations).toEqual([]);
    // 涉及请求数按目标内去重；人工指定的请求不属于池内请求。
    expect(result.conservation.bySource.PROJECT_DIRECT.requestCount).toBe(1);
    expect(classifyLine(poolLine({ sourcePrincipalType: "PROJECT" }))).toBe("PROJECT_DIRECT");
  });
});

describe("GS-4 费用与币种", () => {
  it("API CNY/USD 与套餐 CNY 分别守恒；尾差确定性", () => {
    const ctx = context([
      { projectPrincipalId: "pA", weightBps: 6000 },
      { projectPrincipalId: "pB", membershipId: "mB", weightBps: 3000 },
    ]);
    const result = allocateMonth({
      lines: [
        poolLine({ ledgerLineId: "l-1", inputTokens: 100n, apiCost: "100.0000", apiCostCurrency: "CNY", packageCost: "50.00" }),
        poolLine({ ledgerLineId: "l-2", inputTokens: 100n, apiCost: "20.00", apiCostCurrency: "USD" }),
      ],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    const pA = result.conservation.byProject.find((p) => p.projectPrincipalId === "pA");
    const pB = result.conservation.byProject.find((p) => p.projectPrincipalId === "pB");
    expect(pA?.apiCostByCurrency.CNY).toBe("60.0000");
    expect(pB?.apiCostByCurrency.CNY).toBe("30.0000");
    expect(result.conservation.bySource.UNALLOCATED.apiCostByCurrency.CNY).toBe("10.0000");
    expect(pA?.apiCostByCurrency.USD).toBe("12.00");
    expect(pB?.apiCostByCurrency.USD).toBe("6.00");
    expect(result.conservation.bySource.UNALLOCATED.apiCostByCurrency.USD).toBe("2.00");
    expect(pA?.packageCostCny).toBe("30.00");
    expect(pB?.packageCostCny).toBe("15.00");
    expect(result.conservation.bySource.UNALLOCATED.packageCostCny).toBe("5.00");
    expect(result.conservation.violations).toEqual([]);
  });

  it("GS-4b 0.01 尾差确定性：最大余数归 3334 基点目标（未分配），合计守恒", () => {
    const units = allocateByBps(1n, [
      { key: "proj-z", bps: 3333 },
      { key: "proj-a", bps: 3333 },
      { key: UNALLOCATED_TARGET_KEY, bps: 3334 },
    ]);
    const total = [...units.values()].reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(1n);
    expect(units.get(UNALLOCATED_TARGET_KEY)).toBe(1n);
    expect(units.get("proj-a")).toBe(0n);
    expect(units.get("proj-z")).toBe(0n);
    // 平局场景：两目标余数相同时按键字典序取尾差。
    const tieUnits = allocateByBps(1n, [
      { key: "proj-z", bps: 5000 },
      { key: "proj-a", bps: 5000 },
    ]);
    expect([...tieUnits.values()].reduce((sum, value) => sum + value, 0n)).toBe(1n);
    expect(tieUnits.get("proj-a")).toBe(1n);
    expect(tieUnits.get("proj-z")).toBe(0n);
  });

  it("GS-4c 未知费用：份额行 NULL，计入完整性缺口", () => {
    const ctx = context([{ projectPrincipalId: "pA", weightBps: 5000 }]);
    const result = allocateMonth({
      lines: [poolLine({ apiCost: null, apiCostCurrency: null })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    expect(result.conservation.source.unknownApiCostLineCount).toBe(1);
    expect(result.shares.every((share) => share.shareApiCost === null)).toBe(true);
  });
});

describe("GS-5b 0% 显式段（P3-3）", () => {
  it("0% 段产生显式零份额行；结果全部未分配（WEIGHT_REMAINDER）", () => {
    const ctx = context([{ projectPrincipalId: "pA", weightBps: 0 }]);
    const result = allocateMonth({
      lines: [poolLine({ inputTokens: 100n })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    const zeroShare = result.shares.find((share) => share.targetProjectPrincipalId === "pA");
    expect(zeroShare).toBeDefined();
    expect(zeroShare?.source).toBe("MEMBERSHIP_RULE");
    expect(zeroShare?.weightBps).toBe(0);
    expect(zeroShare?.shareInputTokens).toBe("0.0000");
    const unallocated = result.shares.find((share) => share.source === "UNALLOCATED");
    expect(unallocated?.unallocatedReason).toBe("WEIGHT_REMAINDER");
    expect(unallocated?.shareInputTokens).toBe("100.0000");
    expect(result.conservation.violations).toEqual([]);
  });
});

describe("GS-7 无规则与边界", () => {
  it("仅参加未设权重 → NO_EFFECTIVE_RULE，不自动 100%", () => {
    const ctx: EmployeeAllocationContext = {
      employeePrincipalId: "emp-1", segments: [],
      memberships: [{ membershipId: "m-1", projectPrincipalId: "pA", joinedAt: T("2026-09-01T00:00:00Z"), leftAt: null }],
      accountingByProject: new Map(),
    };
    const result = allocateMonth({
      lines: [poolLine({ inputTokens: 100n })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: null,
    });
    expect(result.shares[0]?.unallocatedReason).toBe("NO_EFFECTIVE_RULE");
    expect(result.shares[0]?.shareInputTokens).toBe("100.0000");
  });

  it("启用前历史（cutoff 之前且无参与）→ HISTORICAL_UNKNOWN", () => {
    const result = allocateMonth({
      lines: [poolLine({ requestStartedAt: T("2026-08-01T00:00:00Z"), inputTokens: 10n })],
      contextsByEmployee: new Map(),
      historicalCutoff: T("2026-09-01T00:00:00Z"),
    });
    expect(result.shares[0]?.unallocatedReason).toBe("HISTORICAL_UNKNOWN");
  });

  it("cutoff 之前但有参与证据且无有效规则 → NO_EFFECTIVE_RULE（R02 P1 契约：历史未知须无参与证据）", () => {
    const ctx: EmployeeAllocationContext = {
      employeePrincipalId: "emp-1", segments: [],
      memberships: [{
        membershipId: "m-early", projectPrincipalId: "pA",
        joinedAt: T("2026-07-01T00:00:00Z"), leftAt: null,
      }],
      accountingByProject: new Map(),
    };
    const result = allocateMonth({
      lines: [poolLine({ requestStartedAt: T("2026-08-01T00:00:00Z"), inputTokens: 10n })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: T("2026-09-01T00:00:00Z"),
    });
    expect(result.shares[0]?.unallocatedReason).toBe("NO_EFFECTIVE_RULE");
    expect(result.shares[0]?.shareInputTokens).toBe("10.0000");
  });

  it("cutoff 之前有参与但规则待修复 → RULE_PENDING_REPAIR 优先于历史未知", () => {
    const ctx: EmployeeAllocationContext = {
      employeePrincipalId: "emp-1",
      segments: [{
        policyId: "pol-1", membershipId: "m-early", membershipRevisionId: "rev-1",
        projectPrincipalId: "pA", weightBps: 10000,
        validFrom: T("2026-08-01T00:00:00Z"), validUntil: null,
      }],
      memberships: [{
        membershipId: "m-early", projectPrincipalId: "pA",
        joinedAt: T("2026-09-15T00:00:00Z"), leftAt: null,
      }],
      accountingByProject: new Map(),
    };
    const result = allocateMonth({
      lines: [poolLine({ requestStartedAt: T("2026-08-01T00:00:00Z"), inputTokens: 10n })],
      contextsByEmployee: new Map([["emp-1", ctx]]),
      historicalCutoff: T("2026-09-01T00:00:00Z"),
    });
    expect(result.shares[0]?.unallocatedReason).toBe("RULE_PENDING_REPAIR");
  });
});
