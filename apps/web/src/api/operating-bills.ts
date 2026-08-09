import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { get, post } from "./client";

export interface OperatingBillProvider {
  providerResourceId: string;
  providerCode: string;
  providerName: string;
  resourceName: string;
  mode: "API" | "CODING_PLAN";
  currency: string | null;
  apiCost: string | null;
  packageCost: string;
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
    packageCost: string;
    endingBalance: string | null;
    endingBalanceCurrency: string | null;
    planUtilization: string | null;
    activePrincipalCount: number;
    confirmedValueAmount: string;
    confirmedNonMonetaryCount: number;
    unallocatedCost: string;
  };
  providers: OperatingBillProvider[];
  subjects: OperatingBillSubject[];
  values: OperatingBillValue[];
  gaps: Array<{ code: string; message: string; providerResourceId?: string }>;
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
