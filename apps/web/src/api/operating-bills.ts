import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post, put } from "./client";

export interface OperatingBillProvider {
  providerResourceId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  currency: string | null;
  openingBalanceCurrency?: string | null;
  rechargeAmounts?: Array<{ currency: string; amount: string }>;
  endingBalanceCurrency?: string | null;
  apiSpendCurrency?: string | null;
  packageCostCurrency?: string | null;
  apiCost: string | null;
  ledgerApiCost?: string | null;
  openingBalance?: string | null;
  rechargeAmount?: string | null;
  apiSpendStatus?: string;
  apiSpendReason?: string | null;
  packageCost: string | null;
  totalCost: string | null;
  endingBalance: string | null;
  totalQuota: string | null;
  usedQuota: string | null;
  remainingQuota: string | null;
  quotaUnit: string | null;
  utilization: string | null;
  activePrincipalCount: number;
  status: string;
  planAssessment: "FULL" | "UNDERUSED" | "EXHAUSTED_EARLY" | "UNUSED" | null;
  idleEntitlementCost: string | null;
  assessmentBasis: string | null;
  operatingSnapshotId?: string | null;
  operatingSnapshotVersion?: number | null;
  operatingSnapshotAt?: string | null;
  /** 只用于显式登记充值时预填，不参与月度汇总。 */
  snapshotRechargeAmount?: string | null;
  purchases?: Array<{
    id: string; type: "API_RECHARGE" | "PACKAGE_PURCHASE"; amount: string; currency: string;
    purchasedAt: string; servicePeriodStart: string | null; servicePeriodEnd: string | null; source: string;
  }>;
  servicePeriodStart?: string | null;
  servicePeriodEnd?: string | null;
  operatingSnapshotSource?: string | null;
  requestRange?: { from: string | null; to: string | null; count: number };
  factFingerprint?: string;
  confirmation?: {
    status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY";
    note: string | null; confirmedBy: string | null; confirmedAt: string | null;
    version: number; matchesCurrentFacts: boolean;
  };
}

export interface OperatingBillSubject {
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

export interface OperatingBillValue {
  id: string;
  title: string;
  value_type: "MONETARY" | "NON_MONETARY";
  amount: string | null;
  metric_value: string | null;
  metric_unit: string | null;
  description: string | null;
  evidence_ref: string | null;
  related_principal_name: string | null;
  status: "PENDING" | "CONFIRMED";
  submitted_by_name: string;
  confirmed_by_name: string | null;
}

export interface OperatingBill {
  month: string;
  timezone: "Asia/Shanghai";
  status: "DRAFT" | "CLOSED";
  version: number;
  generatedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  closeNote: string | null;
  summary: {
    totalCost: string | null;
    apiCost: string | null;
    ledgerApiCost?: string | null;
    openingBalance?: string | null;
    monthlyRecharge?: string | null;
    apiSpendStatus?: string;
    apiSpendReason?: string | null;
    packageCost: string | null;
    endingBalance: string | null;
    endingBalanceCurrency: string | null;
    openingBalances?: Array<{ currency: string; amount: string }>;
    rechargeAmounts?: Array<{ currency: string; amount: string }>;
    endingBalances?: Array<{ currency: string; amount: string }>;
    apiSpends?: Array<{ currency: string; amount: string }>;
    packageCosts?: Array<{ currency: string; amount: string }>;
    totalSpends?: Array<{ currency: string; amount: string }>;
    planUtilization: string | null;
    activePrincipalCount: number;
    confirmedValueAmount: string;
    confirmedNonMonetaryCount: number;
    unallocatedCost: string;
  };
  providers: OperatingBillProvider[];
  subjects: OperatingBillSubject[];
  values: OperatingBillValue[];
  gaps: Array<{ code: string; message: string; providerResourceId?: string; field?: string; snapshotId?: string | null; snapshotVersion?: number | null; requestRangeFrom?: string | null; requestRangeTo?: string | null }>;
  versions: Array<{ id: string; version: number; closedAt: string; closedBy: string; closeNote: string | null; exceptions: Array<Record<string, unknown>> }>;
  events: Array<{ id: string; action: string; version: number | null; reason: string | null; actor: string; createdAt: string }>;
}

const billKey = (month: string) => ["operating-bill", month] as const;

function invalidateOperatingBillViews(
  client: ReturnType<typeof useQueryClient>,
  month: string,
): void {
  void client.invalidateQueries({ queryKey: billKey(month) });
  void client.invalidateQueries({
    predicate: (query) => {
      const [root, scope] = query.queryKey;
      if (root === "operating-bill-employee-requests") {
        return typeof scope === "object" && scope !== null
          && "month" in scope && scope.month === month;
      }
      return (root === "operating-bill-employees"
        || root === "operating-bill-projects"
        || root === "operating-bill-employee") && scope === month;
    },
  });
}

export function useOperatingBill(month: string) {
  return useQuery({
    queryKey: billKey(month),
    queryFn: ({ signal }) => get<OperatingBill>(`/operating-bills/${month}`, signal),
    retry: 1,
    staleTime: 15_000,
  });
}

export function useCreateOperatingBillValue(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/operating-bills/${month}/value-items`, body),
    onSuccess: () => void client.invalidateQueries({ queryKey: billKey(month) }),
  });
}

export function useRecordOpeningBalance(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      provider_resource_id: string; amount: string; currency: string; reason: string | null;
    }) => post(`/operating-bills/${month}/opening-balances`, body),
    onSuccess: () => {
      invalidateOperatingBillViews(client, month);
      void client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRecordResourcePurchase(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      provider_resource_id: string;
      purchase_type: "API_RECHARGE" | "PACKAGE_PURCHASE";
      amount: string;
      currency: string;
      purchased_at: string;
      description: string | null;
      evidence_ref: string | null;
    }) => post(`/provider-resources/${body.provider_resource_id}/purchases`, {
      purchase_type: body.purchase_type,
      amount: body.amount,
      currency: body.currency,
      purchased_at: body.purchased_at,
      description: body.description,
      evidence_ref: body.evidence_ref,
      service_period_start: null,
      service_period_end: null,
      idempotency_key: crypto.randomUUID(),
    }),
    onSuccess: () => {
      invalidateOperatingBillViews(client, month);
      void client.invalidateQueries({ queryKey: ["dashboard"] });
      void client.invalidateQueries({ queryKey: ["resource-purchases"] });
      void client.invalidateQueries({ queryKey: ["resource-utilization", month] });
      void client.invalidateQueries({ queryKey: ["procurement-review", month] });
    },
  });
}

export function useConfirmOperatingBillValue(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/operating-bill-value-items/${id}/confirm`),
    onSuccess: () => void client.invalidateQueries({ queryKey: billKey(month) }),
  });
}

export function useCloseOperatingBill(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { allow_incomplete: boolean; note: string | null }) => post(`/operating-bills/${month}/close`, body),
    onSuccess: () => invalidateOperatingBillViews(client, month),
  });
}

export function useReopenOperatingBill(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => post(`/operating-bills/${month}/reopen`, { reason }),
    onSuccess: () => invalidateOperatingBillViews(client, month),
  });
}

export function useConfirmOperatingBillResource(month: string, resourceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: "CONFIRMED" | "PENDING" | "NOT_APPLICABLE" | "ANOMALY"; note: string | null }) =>
      put(`/operating-bills/${month}/resource-confirmations/${resourceId}`, body),
    onSuccess: () => invalidateOperatingBillViews(client, month),
  });
}

export function useAssignOperatingBillProject(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { ai_request_id: string; project_principal_id: string; reason: string | null }) =>
      post(`/operating-bills/${month}/project-assignments`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: billKey(month) });
      void client.invalidateQueries({ queryKey: ["operating-bill-projects", month] });
    },
  });
}

export function useImportOperatingBillSnapshots(month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rows: Array<{ provider_resource_id: string; snapshot: Record<string, unknown> }>) =>
      post("/operating-bill-snapshot-imports", { rows }),
    onSuccess: () => invalidateOperatingBillViews(client, month),
  });
}
