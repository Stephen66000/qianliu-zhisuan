import type { Selectable } from "kysely";
import type {
  OperatingBillEventTable,
  OperatingBillPeriodTable,
  OperatingBillValueItemTable,
  OperatingBillVersionTable,
} from "../kysely.js";
import type { OperatingBillAccountFact } from "./operating-bill-account-aggregate.js";
import type {
  DepartmentBillView,
} from "./department-cost-types.js";
import type {
  FrozenDepartmentAttributionFact,
  FrozenDepartmentBudgetFact,
  FrozenResourcePurchaseFact,
} from "./department-cost-evidence.js";
import type { ResourceFinanceView } from "./provider-finance-types.js";

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
  openingBalanceCurrency: string | null;
  rechargeAmounts: Array<{ currency: string; amount: string }>;
  endingBalanceCurrency: string | null;
  apiSpendCurrency: string | null;
  packageCostCurrency: string | null;
  apiCost: string | null;
  /** 请求账本计价，仅作为月度余额桥接的核对证据。 */
  ledgerApiCost: string | null;
  openingBalance: string | null;
  rechargeAmount: string | null;
  apiSpendStatus: string;
  apiSpendReason: string | null;
  packageCost: string | null;
  monthlyBudgetId?: string | null;
  monthlyBudgetVersion?: number;
  monthlyBudgetStatus?: "ACTIVE" | "CLEARED" | "NOT_CONFIGURED";
  monthlyBudgetAmount?: string | null;
  monthlyBudgetCurrency?: string | null;
  monthlyBudgetAt?: string | null;
  totalCost: string | null;
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
  /** 最新经营快照的充值提示；仅用于管理员预填，不是月度充值流水。 */
  snapshotRechargeAmount: string | null;
  status: string;
  planAssessment: "FULL" | "UNDERUSED" | "EXHAUSTED_EARLY" | "UNUSED" | null;
  idleEntitlementCost: string | null;
  assessmentBasis: string | null;
  purchases: Array<{
    id: string; type: "API_RECHARGE" | "PACKAGE_PURCHASE"; amount: string;
    currency: string; purchasedAt: string; servicePeriodStart: string | null;
    servicePeriodEnd: string | null; source: string;
  }>;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  operatingSnapshotSource: string | null;
  requestRange: { from: string | null; to: string | null; count: number };
  factFingerprint: string;
  confirmation: {
    status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
    note: string | null; confirmedBy: string | null; confirmedAt: string | null;
    version: number; matchesCurrentFacts: boolean;
  };
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
  apiCost: string | null;
  packageAllocatedCost: string;
  totalAllocatedCost: string | null;
  activeDays: number;
  requestCount: number;
}

export interface OperatingBillGap {
  code: string;
  message: string;
  providerResourceId?: string;
  field?: string;
  snapshotId?: string | null;
  snapshotVersion?: number | null;
  requestRangeFrom?: string | null;
  requestRangeTo?: string | null;
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
    totalCost: string | null;
    apiCost: string | null;
    /** 请求账本计价，仅作为经营 API 花费的核对证据。 */
    ledgerApiCost: string | null;
    openingBalance: string | null;
    monthlyRecharge: string | null;
    apiSpendStatus: string;
    apiSpendReason: string | null;
    packageCost: string | null;
    endingBalance: string | null;
    endingBalanceCurrency: string | null;
    openingBalances: Array<{ currency: string; amount: string }>;
    rechargeAmounts: Array<{ currency: string; amount: string }>;
    endingBalances: Array<{ currency: string; amount: string }>;
    apiSpends: Array<{ currency: string; amount: string }>;
    packageCosts: Array<{ currency: string; amount: string }>;
    totalSpends: Array<{ currency: string; amount: string }>;
    planUtilization: string | null;
    activePrincipalCount: number;
    confirmedValueAmount: string;
    confirmedNonMonetaryCount: number;
    unallocatedCost: string;
    totalAllocatedQuota?: string | null;
  };
  providers: OperatingBillProviderRow[];
  subjects: OperatingBillSubjectRow[];
  values: OperatingBillValueItemView[];
  gaps: OperatingBillGap[];
  sourceFacts: {
    ledgerLineCount: number;
    operatingSnapshotIds: string[];
    balanceBridgeFacts?: Array<{
      providerResourceId: string;
      currency: string | null;
      openingSnapshotId: string | null;
      openingSnapshotVersion: number | null;
      openingSnapshotAt: string | null;
      openingBalanceFactId?: string | null;
      openingBalanceFactVersion?: number | null;
      openingBalanceSource?: "MANUAL" | "PREVIOUS_PERIOD_CLOSING" | "OPERATING_SNAPSHOT" | null;
      endingSnapshotId: string | null;
      endingSnapshotVersion: number | null;
      endingSnapshotAt: string | null;
      openingBalance: string | null;
      rechargeAmount: string | null;
      endingBalance: string | null;
      apiSpend: string | null;
      apiSpendStatus: string;
    }>;
    resourceMonthlyBudgetFacts?: Array<{
      providerResourceId: string;
      budgetId: string;
      version: number;
      status: "ACTIVE" | "CLEARED";
      amount: string | null;
      currency: string | null;
      createdAt: string;
    }>;
    ledgerLines: Array<{
      id: string;
      billingRuleId: string | null;
      ruleVersion: string | null;
      billingRuleSnapshot: Record<string, unknown> | null;
    }>;
    /** POOL-043：结账时冻结到请求/provider/model 粒度，供独立账户页稳定下钻。 */
    accountFacts?: Array<Omit<OperatingBillAccountFact, "usedAt"> & { usedAt: string }>;
    /** W20-06/07：部门分摊及其输入事实随结账版本一起冻结。 */
    departmentBill?: DepartmentBillView;
    departmentAttributionFacts?: FrozenDepartmentAttributionFact[];
    departmentBudgetFacts?: FrozenDepartmentBudgetFact[];
    resourcePurchaseFacts?: FrozenResourcePurchaseFact[];
    providerFinance?: { resourceViews: ResourceFinanceView[] };
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
