import type { AlertDomain, AlertItem } from "../../api/types";

export const DOMAIN_LABEL: Record<AlertDomain, string> = {
  RESOURCE_UNAVAILABLE: "厂商/模型不可用",
  USAGE_SPIKE: "用量/费用异常",
  QUOTA_ANOMALY: "额度/账本异常",
  CREDENTIAL_INVALID: "凭证失效",
};

const SHANGHAI_MONTH = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
});

export function monthKey(value: string | Date): string {
  const parts = SHANGHAI_MONTH.formatToParts(new Date(value));
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = (
    parts.find((part) => part.type === "month")?.value ?? ""
  ).padStart(2, "0");
  return `${year}-${month}`;
}

export function occursInMonth(alert: AlertItem, month: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return true;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1) - 8 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, monthIndex + 1, 1) - 8 * 60 * 60 * 1000);
  return (
    new Date(alert.firstSeenAt) < end && new Date(alert.lastSeenAt) >= start
  );
}

export function formatTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function isHandled(alert: AlertItem): boolean {
  return alert.status === "RESOLVED" || alert.status === "IGNORED";
}

export function isActionable(alert: AlertItem): boolean {
  return alert.status === "OPEN" || alert.status === "INVESTIGATING";
}

export function recoveryText(alert: AlertItem): string {
  if (alert.status === "AUTO_RESOLVED" || alert.sourceClearedAt)
    return "已自动恢复";
  return isHandled(alert) ? "等待后台恢复" : "尚未恢复";
}

export function relationLabels(input: {
  principalId: string | null;
  principalName?: string;
  resourceId: string | null;
  resourceName?: string;
  providerName?: string;
  hasResource: boolean;
  principalLookupFailed: boolean;
  resourceLookupFailed: boolean;
  providerLookupFailed: boolean;
}): { principalName: string; resourceName: string; providerName: string } {
  const principalName =
    input.principalName ??
    (input.principalId
      ? input.principalLookupFailed
        ? "主体信息加载失败"
        : `未知主体 ${input.principalId.slice(0, 8)}`
      : "系统级");
  const resourceName =
    input.resourceName ??
    (input.resourceId
      ? input.resourceLookupFailed
        ? "资源信息加载失败"
        : `未知资源 ${input.resourceId.slice(0, 8)}`
      : "未关联资源");
  const providerName =
    input.providerName ??
    (input.hasResource
      ? input.providerLookupFailed
        ? "厂商信息加载失败"
        : "未知厂商"
      : input.resourceLookupFailed && input.resourceId
        ? "厂商信息待资源加载"
        : "—");
  return { principalName, resourceName, providerName };
}
