/**
 * 规则集合发布校验金标（合同 12-WP01-goldstandards.md GS-5b/W01/W03/GS-10）。
 * 期望值由计划条款独立推导。
 */
import { describe, expect, it } from "vitest";
import {
  previewCapacity, validatePolicyRules, weightLimitConflicts,
  type MembershipContext, type PolicyRuleInput,
} from "../project-allocation/policy.js";

const T = (iso: string) => new Date(iso);

function membership(id: string, project: string, joined: string, left: string | null): MembershipContext {
  return {
    membershipId: id, projectPrincipalId: project,
    joinedAt: T(joined), leftAt: left === null ? null : T(left),
  };
}

function rule(project: string, mem: string, bps: number, from: string, until: string | null): PolicyRuleInput {
  return {
    projectPrincipalId: project, membershipId: mem, weightBps: bps,
    validFrom: T(from), validUntil: until === null ? null : T(until),
  };
}

describe("W01 权重合计 0%/90%/100%/100.01%", () => {
  const memberships = [membership("m1", "pA", "2026-09-01T00:00:00Z", null)];

  it("0%、90%、100% 合法（0% 为显式段，余量保留不归一化）", () => {
    for (const bps of [0, 9000, 10000]) {
      expect(validatePolicyRules(
        [rule("pA", "m1", bps, "2026-09-01T00:00:00Z", null)],
        memberships, new Map(),
      )).toEqual([]);
    }
  });

  it("100.01% 拒绝并返回冲突时段与合计", () => {
    const conflicts = validatePolicyRules(
      [rule("pA", "m1", 10001, "2026-09-01T00:00:00Z", null)],
      memberships, new Map(),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("WEIGHT_EXCEEDS_LIMIT");
    expect(conflicts[0]?.totalBps).toBe(10001);
    expect(conflicts[0]?.interval.until).toBeNull();
  });
});

describe("跨项目时段合计与半开边界", () => {
  const memberships = [
    membership("mA", "pA", "2026-09-01T00:00:00Z", null),
    membership("mB", "pB", "2026-09-01T00:00:00Z", null),
  ];

  it("6000+5000 超限；冲突段列出涉事项目", () => {
    const conflicts = validatePolicyRules(
      [
        rule("pA", "mA", 6000, "2026-09-10T00:00:00Z", null),
        rule("pB", "mB", 5000, "2026-09-10T00:00:00Z", null),
      ],
      memberships, new Map(),
    );
    const exceed = conflicts.filter((conflict) => conflict.kind === "WEIGHT_EXCEEDS_LIMIT");
    expect(exceed).toHaveLength(1);
    expect(exceed[0]?.totalBps).toBe(11000);
    expect(exceed[0]?.conflictingProjects).toEqual(["pA", "pB"]);
  });

  it("错时生效不超限：边界时刻半开切换无误报", () => {
    expect(validatePolicyRules(
      [
        rule("pA", "mA", 10000, "2026-09-10T00:00:00Z", "2026-09-11T00:00:00Z"),
        rule("pB", "mB", 10000, "2026-09-11T00:00:00Z", null),
      ],
      memberships, new Map(),
    )).toEqual([]);
  });
});

describe("相邻同值超限段合并", () => {
  it("项目集合与合计相同的相邻超限段合并为一个冲突区间", () => {
    const conflicts = weightLimitConflicts([
      rule("pA", "mA", 6000, "2026-09-01T00:00:00Z", null),
      rule("pB", "mB", 5000, "2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z"),
      rule("pB", "mB2", 5000, "2026-09-05T00:00:00Z", null),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.interval.from).toEqual(T("2026-09-01T00:00:00Z"));
    expect(conflicts[0]?.interval.until).toBeNull();
    expect(conflicts[0]?.totalBps).toBe(11000);
  });

  it("合计或集合不同的相邻超限段不合并", () => {
    const conflicts = weightLimitConflicts([
      rule("pA", "mA", 6000, "2026-09-01T00:00:00Z", null),
      rule("pB", "mB", 5000, "2026-09-01T00:00:00Z", "2026-09-05T00:00:00Z"),
      rule("pC", "mC", 5000, "2026-09-05T00:00:00Z", null),
    ]);
    expect(conflicts).toHaveLength(2);
  });
});

describe("W03 规则覆盖与悬空", () => {
  const memberships = [membership("m1", "pA", "2026-09-01T00:00:00Z", "2026-09-20T00:00:00Z")];
  const accounting = new Map([
    ["pA", { projectPrincipalId: "pA", startedAt: T("2026-09-01T00:00:00Z"), endedAt: T("2026-09-30T00:00:00Z") }],
  ]);

  it("权重超出参与区间返回 RULE_OUTSIDE_MEMBERSHIP", () => {
    expect(validatePolicyRules(
      [rule("pA", "m1", 5000, "2026-09-19T00:00:00Z", "2026-09-25T00:00:00Z")],
      memberships, accounting,
    ).some((conflict) => conflict.kind === "RULE_OUTSIDE_MEMBERSHIP")).toBe(true);
  });

  it("权重超出核算区间返回 RULE_OUTSIDE_ACCOUNTING（参与开放但核算已结束）", () => {
    const openMemberships = [membership("m2", "pA", "2026-09-01T00:00:00Z", null)];
    const endedEarly = new Map([
      ["pA", { projectPrincipalId: "pA", startedAt: T("2026-09-01T00:00:00Z"), endedAt: T("2026-09-10T00:00:00Z") }],
    ]);
    expect(validatePolicyRules(
      [rule("pA", "m2", 5000, "2026-09-01T00:00:00Z", "2026-09-20T00:00:00Z")],
      openMemberships, endedEarly,
    ).some((conflict) => conflict.kind === "RULE_OUTSIDE_ACCOUNTING")).toBe(true);
  });

  it("权重区间恰好在参与边界内闭合合法", () => {
    expect(validatePolicyRules(
      [rule("pA", "m1", 5000, "2026-09-01T00:00:00Z", "2026-09-20T00:00:00Z")],
      memberships, accounting,
    )).toEqual([]);
  });

  it("引用不存在或项目不一致的参与关系返回 UNKNOWN_MEMBERSHIP", () => {
    expect(validatePolicyRules(
      [rule("pA", "missing", 5000, "2026-09-01T00:00:00Z", null)],
      memberships, new Map(),
    ).map((conflict) => conflict.kind)).toContain("UNKNOWN_MEMBERSHIP");
    expect(validatePolicyRules(
      [rule("pB", "m1", 5000, "2026-09-01T00:00:00Z", null)],
      memberships, new Map(),
    ).map((conflict) => conflict.kind)).toContain("UNKNOWN_MEMBERSHIP");
  });
});

describe("同项目权重区间重叠", () => {
  it("同项目两段重叠返回 RULE_OVERLAP_SAME_PROJECT", () => {
    const memberships = [membership("m1", "pA", "2026-09-01T00:00:00Z", null)];
    expect(validatePolicyRules(
      [
        rule("pA", "m1", 3000, "2026-09-01T00:00:00Z", "2026-09-10T00:00:00Z"),
        rule("pA", "m1", 4000, "2026-09-05T00:00:00Z", null),
      ],
      memberships, new Map(),
    ).some((conflict) => conflict.kind === "RULE_OVERLAP_SAME_PROJECT")).toBe(true);
  });
});

describe("GS-10 预览容量（P2-1 冻结口径）", () => {
  const hidden = [
    rule("pH1", "mH1", 2000, "2026-09-01T00:00:00Z", null),
    rule("pH2", "mH2", 1000, "2026-09-10T00:00:00Z", null),
  ];

  it("隐藏 3000、当前意图 2500 → available=7000、remaining=4500", () => {
    const capacity = previewCapacity(hidden, 2500, T("2026-09-15T00:00:00Z"));
    expect(capacity.hiddenWeightBps).toBe(3000);
    expect(capacity.availableBps).toBe(7000);
    expect(capacity.remainingBps).toBe(4500);
  });

  it("区间外隐藏规则不计入；无隐藏时 available=10000", () => {
    const beforeEffect = previewCapacity(hidden, 0, T("2026-09-05T00:00:00Z"));
    expect(beforeEffect.hiddenWeightBps).toBe(2000);
    expect(previewCapacity(hidden, 10000, T("2026-08-01T00:00:00Z")).availableBps).toBe(10000);
  });
});
