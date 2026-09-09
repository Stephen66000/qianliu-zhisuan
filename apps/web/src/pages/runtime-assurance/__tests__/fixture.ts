import type { AlertItem } from "../../../api/types";
export function fault(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    id: "fault-1",
    alertKey: "RUNTIME_ASSURANCE:TECHNICAL_FAILURE:r:model",
    domain: "RESOURCE_UNAVAILABLE",
    signal: "TECHNICAL_FAILURE",
    severity: "HIGH",
    title: "上游调用失败",
    detail: null,
    resourceId: "r",
    principalId: "p",
    aiRequestId: null,
    status: "OPEN",
    firstSeenAt: "2026-08-31T16:00:00Z",
    lastSeenAt: "2026-09-01T01:00:00Z",
    resolvedAt: null,
    sourceClearedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}
