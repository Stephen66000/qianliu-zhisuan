export type ResourceMode = "API" | "CODING_PLAN";

const LABELS: Record<string, string> = {
  HEALTHY: "正常",
  ACTIVE: "正常",
  DEGRADED: "可用（降权）",
  RATE_LIMITED: "限流冷却",
  UNAVAILABLE: "不可用",
  EXPIRED: "已过期",
  CREDENTIAL_INVALID: "凭证失效",
};

export function resourceStatusLabel(status: string, mode: ResourceMode): string {
  if (status === "EXHAUSTED") return mode === "API" ? "余额不足" : "套餐额度耗尽";
  return LABELS[status] ?? status;
}
