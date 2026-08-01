import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_ACTION,
  AVAILABILITY_DECISION,
  AVAILABILITY_RULE_TYPE,
  RUNTIME_ASSURANCE_MODE,
  UNIFIED_AVAILABILITY_SIGNAL,
  UNIFIED_AVAILABILITY_SIGNAL_LABEL,
  availabilitySignalSummary,
  findAvailabilityRuleConflicts,
  matchAvailabilityRule,
  planLegacyResourceMigration,
  scheduleMatches,
  type AvailabilityRuleSnapshot,
} from "../index.js";

describe("RA-W01 运行保障冻结口径", () => {
  it("运行模式只有 OFF / OBSERVE / ENFORCE", () => {
    expect(Object.values(RUNTIME_ASSURANCE_MODE)).toEqual(["OFF", "OBSERVE", "ENFORCE"]);
  });

  it("企微与 Gateway 共用冻结的 7 项信号摘要", () => {
    expect(Object.keys(UNIFIED_AVAILABILITY_SIGNAL_LABEL).sort()).toEqual(
      Object.values(UNIFIED_AVAILABILITY_SIGNAL).sort(),
    );
    expect(availabilitySignalSummary("RATE_LIMIT_RETRY_AFTER")).toBe("上游明确要求稍后重试");
  });

  it("ACTIVE / DEGRADED 继续允许请求", () => {
    expect(
      planLegacyResourceMigration({
        status: "ACTIVE",
        latestReason: null,
        confirmedAvailabilitySource: null,
      }),
    ).toMatchObject({ availabilityDecision: AVAILABILITY_DECISION.ALLOW, requiresManualReview: false });
    expect(
      planLegacyResourceMigration({
        status: "DEGRADED",
        latestReason: "PASSIVE_FAILURE",
        confirmedAvailabilitySource: null,
      }),
    ).toMatchObject({ availabilityDecision: AVAILABILITY_DECISION.ALLOW, requiresManualReview: false });
  });

  it("技术性 UNAVAILABLE 迁为 DEGRADED + ALLOW，不形成硬熔断", () => {
    for (const latestReason of ["PASSIVE_FAILURE", "FAILURE_THRESHOLD", "RATE_LIMITED", "TRANSPORT_ERROR"]) {
      expect(
        planLegacyResourceMigration({
          status: "UNAVAILABLE",
          latestReason,
          confirmedAvailabilitySource: null,
        }),
      ).toEqual({
        targetHealthStatus: "DEGRADED",
        availabilityDecision: AVAILABILITY_DECISION.ALLOW,
        disposition: "DOWNGRADE_TECHNICAL_UNAVAILABLE",
        requiresManualReview: false,
      });
    }
  });

  it("旧隔离态没有明确证据时必须人工复核", () => {
    for (const status of ["EXHAUSTED", "EXPIRED", "CREDENTIAL_INVALID", "UNAVAILABLE"] as const) {
      expect(
        planLegacyResourceMigration({ status, latestReason: null, confirmedAvailabilitySource: null }),
      ).toMatchObject({
        availabilityDecision: null,
        disposition: "REVIEW_REQUIRED",
        requiresManualReview: true,
      });
    }
  });

  it("只有已确认上游／计划来源才生成 Shadow 阻断候选", () => {
    expect(
      planLegacyResourceMigration({
        status: "EXHAUSTED",
        latestReason: "BILLING_BLOCKED",
        confirmedAvailabilitySource: "UPSTREAM",
      }),
    ).toMatchObject({ availabilityDecision: AVAILABILITY_DECISION.BLOCKED_UPSTREAM });
    expect(
      planLegacyResourceMigration({
        status: "UNAVAILABLE",
        latestReason: null,
        confirmedAvailabilitySource: "SCHEDULE",
      }),
    ).toMatchObject({ availabilityDecision: AVAILABILITY_DECISION.BLOCKED_SCHEDULE });
  });
});

const baseRule = (overrides: Partial<AvailabilityRuleSnapshot> = {}): AvailabilityRuleSnapshot => ({
  id: "version-1",
  ruleId: "rule-1",
  ruleVersion: 1,
  ruleType: AVAILABILITY_RULE_TYPE.UPSTREAM_SIGNAL,
  providerId: null,
  providerResourceId: null,
  unifiedModelId: null,
  upstreamModel: null,
  unifiedSignal: "QUOTA_EXHAUSTED",
  action: AVAILABILITY_ACTION.BLOCK,
  recoveryMethod: "UPSTREAM_RESET_TIME",
  fallbackDurationSeconds: null,
  scheduleTimezone: null,
  scheduleDaysOfWeek: null,
  scheduleStartTime: null,
  scheduleEndTime: null,
  priority: 100,
  effectiveFrom: null,
  effectiveTo: null,
  ...overrides,
});

describe("运行保障规则确定性匹配", () => {
  it("更具体资源规则优先于系统默认规则", () => {
    const matched = matchAvailabilityRule([
      baseRule(),
      baseRule({ id: "specific", ruleId: "rule-2", providerResourceId: "resource-1" }),
    ], {
      now: new Date("2026-08-01T00:00:00Z"),
      providerId: "provider-1",
      providerResourceId: "resource-1",
      unifiedModelId: null,
      upstreamModel: "glm-5",
      unifiedSignal: "QUOTA_EXHAUSTED",
    });
    expect(matched?.id).toBe("specific");
  });

  it("跨午夜计划时段把凌晨归属前一配置日", () => {
    const rule = baseRule({
      ruleType: AVAILABILITY_RULE_TYPE.SCHEDULE_BLOCK,
      unifiedSignal: null,
      scheduleTimezone: "Asia/Shanghai",
      scheduleDaysOfWeek: [5],
      scheduleStartTime: "23:00",
      scheduleEndTime: "02:00",
      recoveryMethod: "SCHEDULE_END",
    });
    expect(scheduleMatches(rule, new Date("2026-07-31T16:30:00Z"))).toBe(true);
    expect(scheduleMatches(rule, new Date("2026-07-31T19:00:00Z"))).toBe(false);
  });

  it("相同作用域、信号和有效期的不同规则发布冲突", () => {
    const candidate = baseRule({ ruleId: "candidate", effectiveFrom: new Date("2026-08-01T00:00:00Z") });
    const existing = baseRule({ ruleId: "existing", effectiveTo: new Date("2026-08-02T00:00:00Z") });
    expect(findAvailabilityRuleConflicts(candidate, [existing])).toHaveLength(1);
  });
});
