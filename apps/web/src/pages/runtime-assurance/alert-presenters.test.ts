import { describe, expect, it } from "vitest";

import type { AlertItem } from "../../api/types";
import {
  isActionable,
  isHandled,
  monthKey,
  occursInMonth,
  recoveryText,
  isFault,
  hasVerifiedRecovery,
  relationLabels,
  formatTime,
} from "./alert-presenters";

function alert(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: "alert",
    alertKey: "alert:key",
    domain: "RESOURCE_UNAVAILABLE",
    signal: "resource_unavailable",
    severity: "MEDIUM",
    title: "异常",
    detail: null,
    resourceId: null,
    principalId: null,
    aiRequestId: null,
    status: "OPEN",
    firstSeenAt: "2026-08-31T15:59:59.000Z",
    lastSeenAt: "2026-09-30T16:00:00.000Z",
    resolvedAt: null,
    resolutionNote: null,
    sourceClearedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe("异常中心展示规则", () => {
  it("月份使用上海时区和两位月份", () => {
    expect(monthKey("2026-09-07T00:00:00.000Z")).toBe("2026-09");
  });

  it("只按北京时间首次发生月份筛选，恢复和更新时间不改变归属", () => {
    const item = alert();
    expect(occursInMonth(item, "2026-08")).toBe(true);
    expect(occursInMonth(item, "2026-09")).toBe(false);
    expect(occursInMonth(item, "2026-10")).toBe(false);
    expect(
      occursInMonth(alert({ firstSeenAt: "2026-08-31T16:00:00Z" }), "2026-09"),
    ).toBe(true);
    expect(occursInMonth(item, "2026-11")).toBe(false);
    expect(occursInMonth(item, "invalid")).toBe(true);
  });

  it("人工处理和后台恢复保持两个独立事实", () => {
    expect(isActionable(alert())).toBe(true);
    expect(isActionable(alert({ status: "INVESTIGATING" }))).toBe(true);
    expect(isHandled(alert({ status: "RESOLVED" }))).toBe(true);
    expect(isHandled(alert({ status: "IGNORED" }))).toBe(true);
    expect(isHandled(alert({ status: "AUTO_RESOLVED" }))).toBe(false);
    expect(recoveryText(alert())).toBe("尚无恢复证据");
    expect(recoveryText(alert({ status: "RESOLVED" }))).toBe("等待恢复验证");
    expect(recoveryText(alert({ status: "AUTO_RESOLVED" }))).toBe("恢复待核实");
    expect(
      recoveryText(alert({ sourceClearedAt: "2026-09-01T00:00:00Z" })),
    ).toBe("恢复待核实");
    expect(
      recoveryText(
        alert({
          recoveryEvidence: {
            kind: "SUCCESSFUL_REQUEST",
            summary: "调用成功",
            verifiedAt: "2026-09-01T00:00:00Z",
          },
        }),
      ),
    ).toBe("已自动恢复");
  });
});

it("month bounds are half-open even at the first instant of the next Shanghai month", () => {
  expect(
    occursInMonth(
      alert({ firstSeenAt: "2026-09-30T15:59:59.999Z" }),
      "2026-09",
    ),
  ).toBe(true);
  expect(
    occursInMonth(
      alert({ firstSeenAt: "2026-09-30T16:00:00.000Z" }),
      "2026-09",
    ),
  ).toBe(false);
  expect(
    occursInMonth(
      alert({ firstSeenAt: "2026-08-31T15:59:59.999Z" }),
      "2026-09",
    ),
  ).toBe(false);
  expect(
    occursInMonth(
      alert({ firstSeenAt: "2026-08-31T16:00:00.000Z" }),
      "2026-09",
    ),
  ).toBe(true);
  expect(occursInMonth(alert(), "x2026-09")).toBe(true);
  expect(occursInMonth(alert(), "2026-09x")).toBe(true);
  expect(monthKey("2026-12-31T16:00:00Z")).toBe("2027-01");
  expect(formatTime(null)).toBe("—");
  expect(formatTime("2026-09-01T00:00:00Z")).toBe("09/01 08:00");
});
it.each([
  "SUCCESSFUL_REQUEST",
  "RECONCILIATION_RESOLVED",
  "TASK_SUCCEEDED",
  "SERVICE_HEALTHY",
])("accepts only complete %s proof", (kind) => {
  expect(
    hasVerifiedRecovery(
      alert({
        recoveryEvidence: {
          kind,
          summary: "验证成功",
          verifiedAt: "2026-09-01T00:00:00Z",
        },
      }),
    ),
  ).toBe(true);
});
it.each([
  undefined,
  null,
  {},
  { kind: "UNKNOWN", summary: "x", verifiedAt: "2026-09-01" },
  { kind: "TASK_SUCCEEDED", summary: 3, verifiedAt: "2026-09-01" },
  { kind: "TASK_SUCCEEDED", summary: "x", verifiedAt: 3 },
  { kind: "TASK_SUCCEEDED", summary: "x", verifiedAt: "bad" },
])("rejects incomplete or unsupported proof %#", (recoveryEvidence) => {
  expect(hasVerifiedRecovery(alert({ recoveryEvidence }))).toBe(false);
});
it("excludes all retired warning signals, locks complete manual notes and labels immutable failures", () => {
  expect(isFault(alert({ domain: "USAGE_SPIKE", signal: "unknown" }))).toBe(
    false,
  );
  for (const signal of [
    "principal_usage_anomaly",
    "supply_anomaly",
    "department_budget_warning",
  ])
    expect(isFault(alert({ signal }))).toBe(false);
  expect(isFault(alert())).toBe(true);
  for (const status of ["RESOLVED", "IGNORED"] as const) {
    expect(isActionable(alert({ status, resolutionNote: "已核对" }))).toBe(
      false,
    );
    expect(isActionable(alert({ status, resolutionNote: " " }))).toBe(true);
  }
  for (const signal of [
    "routing_anomaly",
    "streaming_anomaly",
    "request_failure",
    "directory_task_failure",
    "dispatch_anomaly",
  ])
    expect(recoveryText(alert({ signal }))).toBe("单次失败记录");
});
it("relation fallbacks distinguish missing identifiers from failed lookups", () => {
  const empty = {
    principalId: null,
    resourceId: null,
    hasResource: false,
    principalLookupFailed: false,
    resourceLookupFailed: false,
    providerLookupFailed: false,
  };
  expect(relationLabels(empty)).toEqual({
    principalName: "系统级",
    resourceName: "未关联资源",
    providerName: "—",
  });
  expect(
    relationLabels({
      ...empty,
      principalId: "123456789",
      resourceId: "abcdefghi",
      hasResource: true,
    }),
  ).toEqual({
    principalName: "未知主体 12345678",
    resourceName: "未知资源 abcdefgh",
    providerName: "未知厂商",
  });
  expect(
    relationLabels({
      ...empty,
      principalId: "p",
      resourceId: "r",
      hasResource: true,
      principalLookupFailed: true,
      resourceLookupFailed: true,
      providerLookupFailed: true,
    }),
  ).toEqual({
    principalName: "主体信息加载失败",
    resourceName: "资源信息加载失败",
    providerName: "厂商信息加载失败",
  });
  expect(
    relationLabels({ ...empty, resourceId: "r", resourceLookupFailed: true })
      .providerName,
  ).toBe("厂商信息待资源加载");
  expect(
    relationLabels({
      ...empty,
      principalName: "人员",
      resourceName: "资源",
      providerName: "厂商",
    }),
  ).toEqual({
    principalName: "人员",
    resourceName: "资源",
    providerName: "厂商",
  });
});
