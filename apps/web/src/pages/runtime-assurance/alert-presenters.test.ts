import { describe, expect, it } from "vitest";

import type { AlertItem } from "../../api/types";
import {
  isActionable,
  isHandled,
  monthKey,
  occursInMonth,
  recoveryText,
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

  it("跨月异常在相交月份展示，并排除边界之外月份", () => {
    const item = alert();
    expect(occursInMonth(item, "2026-08")).toBe(true);
    expect(occursInMonth(item, "2026-09")).toBe(true);
    expect(occursInMonth(item, "2026-10")).toBe(true);
    expect(occursInMonth(item, "2026-11")).toBe(false);
    expect(occursInMonth(item, "invalid")).toBe(true);
  });

  it("人工处理和后台恢复保持两个独立事实", () => {
    expect(isActionable(alert())).toBe(true);
    expect(isActionable(alert({ status: "INVESTIGATING" }))).toBe(true);
    expect(isHandled(alert({ status: "RESOLVED" }))).toBe(true);
    expect(isHandled(alert({ status: "IGNORED" }))).toBe(true);
    expect(isHandled(alert({ status: "AUTO_RESOLVED" }))).toBe(false);
    expect(recoveryText(alert())).toBe("尚未恢复");
    expect(recoveryText(alert({ status: "RESOLVED" }))).toBe("等待后台恢复");
    expect(recoveryText(alert({ status: "AUTO_RESOLVED" }))).toBe("已自动恢复");
    expect(
      recoveryText(alert({ sourceClearedAt: "2026-09-01T00:00:00Z" })),
    ).toBe("已自动恢复");
  });
});
