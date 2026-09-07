import { useQuery } from "@tanstack/react-query";

import { get } from "./client";

export type OperatingBillUsageQuality =
  | "EXACT"
  | "ESTIMATED"
  | "ACCOUNT_AGGREGATED"
  | "MIXED"
  | "UNKNOWN";

export interface OperatingBillMetricTotals {
  inputTokens: string | null;
  outputTokens: string | null;
  cacheTokens: string | null;
  reasoningTokens: string | null;
  totalTokens: string | null;
  deductedQuota: string | null;
  apiCost: string | null;
  packageAllocatedCost: string | null;
  totalAllocatedCost: string | null;
  activeDays: number | null;
  requestCount: number;
  lastUsedAt: string | null;
  usageQuality: OperatingBillUsageQuality;
}

export interface OperatingBillProviderRef {
  providerCode: string;
  providerName: string;
  totals?: OperatingBillMetricTotals;
}

export interface OperatingBillProjectDepartmentRef {
  departmentId: string;
  departmentName: string;
}

export interface OperatingBillProjectOwnerRef {
  personId: string | null;
  personName: string;
}

export interface OperatingBillEmployeeRow {
  subjectId: string | null;
  subjectName: string;
  isUnassigned: boolean;
  projectOwner: OperatingBillProjectOwnerRef | null;
  projectDepartments: OperatingBillProjectDepartmentRef[];
  providers: OperatingBillProviderRef[];
  totals: OperatingBillMetricTotals;
}

export type OperatingBillProjectRow = OperatingBillEmployeeRow;

interface OperatingBillAccountList<Row> {
  status: "DRAFT" | "CLOSED";
  month: string;
  totals: OperatingBillMetricTotals;
  rows: Row[];
  total: number;
  limit: number;
  offset: number;
}

export type OperatingBillEmployees = OperatingBillAccountList<OperatingBillEmployeeRow>;
export type OperatingBillProjects = OperatingBillAccountList<OperatingBillProjectRow>;

export interface OperatingBillModelRow {
  unifiedModelId: string | null;
  identityStatus: "RESOLVED" | "UNRESOLVED";
  currentAlias: string | null;
  historicalAliases: string[];
  totals: OperatingBillMetricTotals;
  usageShare: string | null;
}

export interface OperatingBillProviderGroup {
  providerCode: string;
  providerName: string;
  totals: OperatingBillMetricTotals;
  models: OperatingBillModelRow[];
}

export interface OperatingBillEmployeeDetail {
  status: "DRAFT" | "CLOSED";
  month: string;
  employee: { principalId: string; principalName: string };
  totals: OperatingBillMetricTotals;
  providers: OperatingBillProviderGroup[];
  gaps: Array<{ code: "MODEL_ID_UNRESOLVED"; historicalAlias: string }>;
}

export interface OperatingBillRequestItem {
  requestId: string;
  modelAliasAtRequest: string;
  currentAlias: string | null;
  tokens: Pick<
    OperatingBillMetricTotals,
    "inputTokens" | "outputTokens" | "cacheTokens" | "reasoningTokens" | "totalTokens"
  >;
  costs: Pick<
    OperatingBillMetricTotals,
    "deductedQuota" | "apiCost" | "packageAllocatedCost" | "totalAllocatedCost"
  >;
  status: string;
  usedAt: string;
  usageQuality: OperatingBillUsageQuality;
}

export interface OperatingBillEmployeeRequests {
  status: "DRAFT" | "CLOSED";
  month: string;
  employee: { principalId: string; principalName: string };
  model: { unifiedModelId: string; currentAlias: string | null };
  items: OperatingBillRequestItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface OperatingBillAccountFilters {
  providerCode?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

function accountSearch(filters: OperatingBillAccountFilters): string {
  const search = new URLSearchParams();
  if (filters.providerCode) search.set("provider_code", filters.providerCode);
  if (filters.search) search.set("search", filters.search);
  if (filters.limit !== undefined) search.set("limit", String(filters.limit));
  if (filters.offset !== undefined) search.set("offset", String(filters.offset));
  const value = search.toString();
  return value ? `?${value}` : "";
}

export function useOperatingBillEmployees(
  month: string,
  filters: OperatingBillAccountFilters,
) {
  return useQuery({
    queryKey: ["operating-bill-employees", month, filters] as const,
    queryFn: ({ signal }) =>
      get<OperatingBillEmployees>(
        `/operating-bills/${month}/employees${accountSearch(filters)}`,
        signal,
      ),
    retry: 1,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useOperatingBillProjects(
  month: string,
  filters: OperatingBillAccountFilters,
) {
  return useQuery({
    queryKey: ["operating-bill-projects", month, filters] as const,
    queryFn: ({ signal }) =>
      get<OperatingBillProjects>(
        `/operating-bills/${month}/projects${accountSearch(filters)}`,
        signal,
      ),
    retry: 1,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useOperatingBillEmployee(
  month: string,
  principalId: string,
  providerCode?: string,
) {
  const search = providerCode
    ? `?${new URLSearchParams({ provider_code: providerCode })}`
    : "";
  return useQuery({
    queryKey: ["operating-bill-employee", month, principalId, providerCode] as const,
    queryFn: ({ signal }) =>
      get<OperatingBillEmployeeDetail>(
        `/operating-bills/${month}/employees/${encodeURIComponent(principalId)}${search}`,
        signal,
      ),
    enabled: Boolean(principalId),
    retry: 1,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useOperatingBillEmployeeRequests(input: {
  month: string;
  principalId: string;
  unifiedModelId: string;
  providerCode: string;
  limit: number;
  offset: number;
}) {
  return useQuery({
    queryKey: ["operating-bill-employee-requests", input] as const,
    queryFn: ({ signal }) => {
      const search = new URLSearchParams({
        provider_code: input.providerCode,
        limit: String(input.limit),
        offset: String(input.offset),
      });
      return get<OperatingBillEmployeeRequests>(
        `/operating-bills/${input.month}/employees/${encodeURIComponent(input.principalId)}` +
          `/models/${encodeURIComponent(input.unifiedModelId)}/requests?${search}`,
        signal,
      );
    },
    retry: 1,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
