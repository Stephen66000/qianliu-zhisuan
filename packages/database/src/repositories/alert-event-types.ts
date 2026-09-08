export type AlertDomain =
  | "RESOURCE_UNAVAILABLE"
  | "USAGE_SPIKE"
  | "QUOTA_ANOMALY"
  | "CREDENTIAL_INVALID";

export interface AlertEvent {
  id: string;
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string | null;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
  status: "OPEN" | "INVESTIGATING" | "RESOLVED" | "IGNORED" | "AUTO_RESOLVED";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  sourceClearedAt: string | null;
  resolvedBy: string | null;
}

export interface DerivedAlert {
  alertKey: string;
  domain: AlertDomain;
  signal: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  title: string;
  detail: string;
  resourceId: string | null;
  principalId: string | null;
  aiRequestId: string | null;
}

export interface AlertThresholds {
  exhaustCoverageHours: number;
  usageSpikeCost: number;
  principalQuotaRatio: number;
  resourceFailureCount: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  exhaustCoverageHours: 24,
  usageSpikeCost: 100,
  principalQuotaRatio: 0.9,
  resourceFailureCount: 3,
};
