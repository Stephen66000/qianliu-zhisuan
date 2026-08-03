import type { Selectable } from "kysely";
import type {
  OperatingBillEventTable,
  OperatingBillPeriodTable,
  OperatingBillValueItemTable,
  OperatingBillVersionTable,
} from "../kysely.js";

export type OperatingBillPeriod = Selectable<OperatingBillPeriodTable>;
export type OperatingBillValueItem = Selectable<OperatingBillValueItemTable>;
export type OperatingBillVersion = Selectable<OperatingBillVersionTable>;
export type OperatingBillEvent = Selectable<OperatingBillEventTable>;

export interface OperatingBillValueItemView extends OperatingBillValueItem {
  related_principal_name: string | null;
  submitted_by_name: string;
  confirmed_by_name: string | null;
}

export interface OperatingBillProviderRow {
  providerResourceId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  currency: string | null;
  apiCost: string;
  packageCost: string;
  totalCost: string;
  endingBalance: string | null;
  totalQuota: string | null;
  usedQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  utilization: string | null;
  activePrincipalCount: number;
  operatingSnapshotId: string | null;
  operatingSnapshotVersion: number | null;
  operatingSnapshotAt: string | null;
  status: string;
  planAssessment: "FULL" | "UNDERUSED" | "EXHAUSTED_EARLY" | "UNUSED" | null;
  idleEntitlementCost: string | null;
  assessmentBasis: string | null;
}

export interface OperatingBillSubjectRow {
  principalId: string;
  principalName: string;
  principalType: "EMPLOYEE" | "PROJECT";
  providers: string[];
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  reasoningTokens: string;
  totalTokens: string;
  deductedQuota: string;
  apiCost: string;
  packageAllocatedCost: string;
  totalAllocatedCost: string;
  activeDays: number;
  requestCount: number;
}

export interface OperatingBillGap {
  code: string;
  message: string;
  providerResourceId?: string;
}

export interface OperatingBillSnapshot {
  month: string;
  timezone: "Asia/Shanghai";
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "CLOSED";
  version: number;
  generatedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  summary: {
    totalCost: string;
    apiCost: string;
    packageCost: string;
    endingBalance: string | null;
    endingBalanceCurrency: string | null;
    planUtilization: string | null;
    activePrincipalCount: number;
    confirmedValueAmount: string;
    confirmedNonMonetaryCount: number;
    unallocatedCost: string;
  };
  providers: OperatingBillProviderRow[];
  subjects: OperatingBillSubjectRow[];
  values: OperatingBillValueItemView[];
  gaps: OperatingBillGap[];
  sourceFacts: {
    ledgerLineCount: number;
    operatingSnapshotIds: string[];
    ledgerLines: Array<{
      id: string;
      billingRuleId: string | null;
      ruleVersion: string | null;
      billingRuleSnapshot: Record<string, unknown> | null;
    }>;
  };
}

export interface OperatingBillView extends OperatingBillSnapshot {
  versions: Array<{
    id: string;
    version: number;
    closedAt: string;
    closedBy: string;
    closeNote: string | null;
    exceptions: Array<Record<string, unknown>>;
  }>;
  events: Array<{
    id: string;
    action: OperatingBillEvent["action"];
    version: number | null;
    reason: string | null;
    actor: string;
    createdAt: string;
  }>;
}
