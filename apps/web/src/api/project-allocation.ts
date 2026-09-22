/** 项目归集 hooks（候选 C3 WP04/WP05；合同 11-WP01-api-schema.md）。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post } from "./client";

export interface ProjectMembershipRow {
  membershipId: string;
  employeePrincipalId: string;
  employeeName: string;
  stintIndex: number;
  revision: number;
  status: "ACTIVE" | "FUTURE" | "ENDED";
  joinedAt: string;
  leftAt: string | null;
  currentWeightBps: number | null;
  weightInterval: { from: string; until: string | null } | null;
  otherProjectsCount: number;
  otherProjectsWeightBps: number;
}

export interface ProjectMembershipsView {
  rows: ProjectMembershipRow[];
  counts: { currentMembers: number; atMembers: number | null; periodMembers: number | null };
  total: number;
  limit: number;
  offset: number;
  /** 当前核算窗口（无配置为 null）：生命周期修订的 expectedVersion 来源。 */
  accountingProfile: { version: number; startedAt: string; endedAt: string | null } | null;
}

export function useProjectMemberships(projectId: string, at?: string) {
  return useQuery({
    queryKey: ["project-memberships", projectId, at ?? null],
    queryFn: () => get<ProjectMembershipsView>(
      `/principals/${projectId}/project-memberships?limit=100${at ? `&at=${at}` : ""}`,
    ),
    enabled: projectId !== "",
    retry: 1,
  });
}

export function useCreateProjectMembership(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      employeePrincipalId: string; joinedAt: string; leftAt?: string | null;
      weightBps?: number; reason: string; idempotencyKey: string;
    }) => post(`/principals/${projectId}/project-memberships`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-memberships"] });
    },
  });
}

export function useReviseProjectMembership(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      membershipId: string; expectedRevision: number; leftAt?: string | null; reason: string; idempotencyKey: string;
    }) => post(`/principals/${projectId}/project-memberships/${payload.membershipId}/revisions`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-memberships"] });
    },
  });
}

export interface PolicyPreviewView {
  currentVersion: number;
  conflicts: Array<{ kind: string; message: string; totalBps?: number | null }>;
  hidden: { hiddenProjectCount: number; hiddenWeightBps: number; availableBps: number; remainingBps: number };
  segments: Array<{ weightBps: number; availableBps: number; remainingBps: number }>;
  visibleRules: Array<{ projectPrincipalId: string; weightBps: number; validFrom: string; validUntil: string | null }>;
}

export function usePreviewPolicyIntent(projectId: string) {
  return useMutation({
    mutationFn: (payload: {
      employeePrincipalId: string; expectedPolicyVersion: number | null;
      segments: Array<{ validFrom: string; validUntil: string | null; weightBps: number }>;
    }) => post<PolicyPreviewView>(`/principals/${projectId}/project-allocation-intents/preview`, payload),
  });
}

export function usePublishPolicyIntent(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      employeePrincipalId: string; expectedPolicyVersion: number; reason: string; idempotencyKey: string;
      segments: Array<{ validFrom: string; validUntil: string | null; weightBps: number }>;
    }) => post(`/principals/${projectId}/project-allocation-intents/versions`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-memberships"] });
    },
  });
}

export function useReviseAccountingLifecycle(projectId: string) {
  return useMutation({
    mutationFn: (payload: { effectiveAt: string; reason: string; expectedVersion: number }) =>
      post(`/principals/${projectId}/accounting-lifecycle-revisions`, payload),
  });
}

export interface AllocationStatusView {
  month: string;
  enabled: boolean;
  currentRun: {
    id: string; status: string; computedAt: string | null; stale: boolean;
  } | null;
  lastError: string | null;
}

export function useAllocationStatus(month: string) {
  return useQuery({
    queryKey: ["project-allocation-status", month],
    queryFn: () => get<AllocationStatusView>(`/operating-bills/${month}/project-allocation-status`),
    enabled: /^\d{4}-\d{2}$/.test(month),
    retry: 1,
  });
}

export function useEnableAllocation(month: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { startMonth: string; reason: string }) =>
      post(`/operating-bills/${month}/project-allocation-enablement`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-allocation-status"] });
    },
  });
}

export function useCreateAllocationRun(month: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { reason: string }) =>
      post(`/operating-bills/${month}/project-allocation-runs`, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-allocation-status"] });
    },
  });
}

export interface AllocationLinesView {
  runId: string | null;
  lines: Array<{
    ledgerLineId: string;
    requestId: string;
    employeeName: string | null;
    allocationSource: string;
    weightBps: number | null;
    requestStartedAt: string;
    shareInputTokens: string;
    shareOutputTokens: string;
    shareApiCost: string | null;
    apiCostCurrency: string | null;
    sharePackageCost: string | null;
    usageQuality: string;
  }>;
  total: number;
  limit: number;
  offset: number;
}

export function useAllocationLines(month: string, projectId: string, offset: number) {
  return useQuery({
    queryKey: ["project-allocation-lines", month, projectId, offset],
    queryFn: () => get<AllocationLinesView>(
      `/operating-bills/${month}/projects/${projectId}/allocation-lines?limit=25&offset=${offset}`,
    ),
    enabled: /^\d{4}-\d{2}$/.test(month) && projectId !== "",
    retry: 1,
  });
}

export interface UnallocatedDetailLine {
  ledgerLineId: string;
  requestId: string;
  employeeName: string | null;
  unallocatedReason: string | null;
  shareInputTokens: string;
  shareOutputTokens: string;
  providerResourceId: string | null;
}

export interface UnallocatedView {
  runId: string | null;
  tokens: string;
  byReason: Record<string, string>;
  apiCostByCurrency: Record<string, string>;
  packageCostCny: string;
  lineCount: number;
  /** 未分配明细（合同 §3.3：汇总及明细）；项目明细本身只含该项目份额。 */
  detail: {
    runId: string | null;
    lines: UnallocatedDetailLine[];
    total: number;
    limit: number;
    offset: number;
  };
}

export function useUnallocated(month: string, detailLimit = 10) {
  return useQuery({
    queryKey: ["project-unallocated", month, detailLimit],
    queryFn: () => get<UnallocatedView>(
      `/operating-bills/${month}/project-unallocated?limit=${detailLimit}`,
    ),
    enabled: /^\d{4}-\d{2}$/.test(month),
    retry: 1,
  });
}

export function useEmployeesForMembership() {
  return useQuery({
    queryKey: ["allocation-employees"],
    queryFn: () => get<{ principals: Array<{ id: string; name: string }> }>(
      "/principals?type=EMPLOYEE&limit=100",
    ),
    staleTime: 60_000,
    retry: 1,
  });
}
