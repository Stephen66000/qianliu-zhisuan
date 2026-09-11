import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, patch, post, put, upload } from "./client";
import type { Principal } from "./types";
import type {
  DepartmentBill, DirectoryActivationResult, DirectoryImportItem, DirectoryImportRun,
  DirectoryMember, DirectorySource, DirectorySourceType, EnterpriseSettings, OrganizationUnit,
  ProcurementReview, ResourceMonthlyBudgetHistory, ResourceUtilization, UsageOverview,
  ProjectDepartmentAssignment,
} from "./v2-types";

export const V2_KEYS = {
  enterpriseSettings: ["enterprise-settings"] as const,
  directory: ["directory-members"] as const,
  organizationUnits: ["organization-units"] as const,
  directorySource: (type: DirectorySourceType) => ["directory-source", type] as const,
  importRun: (id: string) => ["directory-import-run", id] as const,
  usageOverview: (query: string) => ["usage-overview", query] as const,
  principalOptions: (type: "EMPLOYEE" | "PROJECT", search: string, offset: number, limit: number) => ["principal-options", type, search, offset, limit] as const,
  principalOption: (id: string) => ["principal-option", id] as const,
  utilization: (month: string) => ["resource-utilization", month] as const,
  procurement: (month: string) => ["procurement-review", month] as const,
  departmentBill: (month: string) => ["department-bill", month] as const,
};

export function useEnterpriseSettings() {
  return useQuery({ queryKey: V2_KEYS.enterpriseSettings, queryFn: ({ signal }) => get<{ settings: EnterpriseSettings }>("/enterprise-settings", signal), retry: 1 });
}
export function useUpdateEnterpriseSettings() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: { expected_version: number; name?: string; management_contact?: string | null; contact_email?: string | null; timezone?: string; default_currency?: string }) => patch<{ settings: EnterpriseSettings }>("/enterprise-settings", body), onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.enterpriseSettings }) });
}
export function useDirectoryMembers(search = "") {
  const query = new URLSearchParams({ limit: "100" }); if (search) query.set("search", search);
  return useQuery({ queryKey: [...V2_KEYS.directory, search], queryFn: ({ signal }) => get<{ items: DirectoryMember[]; total: number }>(`/directory-members?${query}`, signal), retry: 1 });
}
/** A 方式：通讯录列表勾选批量开通 AI 员工主体。 */
export function useActivateDirectoryMembers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (personIds: string[]) =>
      post<DirectoryActivationResult>("/directory-members/activate", { person_ids: personIds }),
    onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.directory }),
  });
}
/** C 方式：按姓名/工号/企微账号名单匹配批量开通。 */
export function useActivateDirectoryMembersByList() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (identifiers: string[]) =>
      post<DirectoryActivationResult>("/directory-members/activate-by-list", { identifiers }),
    onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.directory }),
  });
}
/** C 方式：上传 .xlsx 名单，后台解析首列标识供确认。 */
export function useActivateDirectoryListPreview() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.set("file", file);
      return upload<{ identifiers: string[] }>("/directory-members/activate-list-preview", form);
    },
  });
}
export function useOrganizationUnits() {
  return useQuery({ queryKey: V2_KEYS.organizationUnits, queryFn: ({ signal }) => get<{ units: OrganizationUnit[] }>("/organization-units?status=ACTIVE", signal), retry: 1 });
}
export function useProjectDepartmentAssignment(projectId: string | null) {
  return useQuery({
    queryKey: ["project-department-assignment", projectId ?? ""],
    queryFn: ({ signal }) => get<{ assignment: ProjectDepartmentAssignment | null }>(`/principals/${projectId}/department-assignment`, signal),
    enabled: Boolean(projectId), retry: 1,
  });
}
export function useSaveProjectDepartmentAssignment(projectId: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { organization_unit_id: string; expected_version: number; reason?: string | null }) =>
      put<{ assignment: ProjectDepartmentAssignment; replayed: boolean }>(`/principals/${projectId}/department-assignment`, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["project-department-assignment", projectId ?? ""] });
      void client.invalidateQueries({ queryKey: ["principals"] });
    },
  });
}
export function useDirectorySource(type: DirectorySourceType) {
  return useQuery({ queryKey: V2_KEYS.directorySource(type), queryFn: ({ signal }) => get<{ source: DirectorySource | null }>(`/directory-sources/${type}`, signal), retry: 1 });
}
export function useSaveDirectorySource(type: DirectorySourceType) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => put<{ source: DirectorySource }>(`/directory-sources/${type}`, body), onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.directorySource(type) }) });
}
export function useStartDirectorySync() {
  return useMutation({ mutationFn: (sourceId: string) => post<{ runId: string; status: string }>("/directory-sync-runs", { source_id: sourceId, idempotency_key: crypto.randomUUID() }) });
}
export function useUploadDirectoryExcel() {
  return useMutation({ mutationFn: (file: File) => { const form = new FormData(); form.set("file", file); form.set("idempotency_key", crypto.randomUUID()); return upload<{ runId: string; status: string }>("/directory-excel-imports", form); } });
}
export function useDirectoryImportRun(id: string | null) {
  return useQuery({ queryKey: V2_KEYS.importRun(id ?? ""), queryFn: ({ signal }) => get<{ run: DirectoryImportRun }>(`/directory-import-runs/${id}`, signal), enabled: Boolean(id), refetchInterval: (query) => ["QUEUED", "RUNNING"].includes(query.state.data?.run.status ?? "") ? 1500 : false, retry: 1 });
}
export function useDirectoryImportItems(id: string | null) {
  return useQuery({ queryKey: [...V2_KEYS.importRun(id ?? ""), "items"], queryFn: ({ signal }) => get<{ items: DirectoryImportItem[]; total: number }>(`/directory-import-runs/${id}/items?limit=100`, signal), enabled: Boolean(id), retry: 1 });
}
export function useUsageOverview(query: string, staleTime = 15_000) {
  return useQuery({ queryKey: V2_KEYS.usageOverview(query), queryFn: ({ signal }) => get<UsageOverview>(`/usage/overview?${query}`, signal), retry: 1, staleTime });
}
export function usePrincipalOptions(type: "EMPLOYEE" | "PROJECT", search: string, offset: number, limit = 20) {
  const query = new URLSearchParams({ archived: "exclude", type, limit: String(limit), offset: String(offset) });
  if (search) query.set("search", search);
  return useQuery({
    queryKey: V2_KEYS.principalOptions(type, search, offset, limit),
    queryFn: ({ signal }) => get<{ principals: Principal[]; total: number; limit: number; offset: number }>(`/principals?${query}`, signal),
    retry: 1,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}
export function resolvePrincipalExactMatch(type: "EMPLOYEE" | "PROJECT", name: string) {
  const query = new URLSearchParams({ type, name });
  return get<{ principal: Principal | null; match_count: number }>(`/principals/resolve-exact?${query}`);
}
export function usePrincipalOption(id: string | null) {
  return useQuery({
    queryKey: V2_KEYS.principalOption(id ?? ""),
    queryFn: ({ signal }) => get<{ principal: Principal }>(`/principals/${id}`, signal),
    enabled: Boolean(id),
    retry: 1,
    staleTime: 30_000,
  });
}
export function useResourceUtilization(month: string) {
  return useQuery({ queryKey: V2_KEYS.utilization(month), queryFn: ({ signal }) => get<{ month: string; resources: ResourceUtilization[]; generatedAt: string }>(`/provider-resources/utilization?month=${month}`, signal), retry: 1 });
}
export function useResourceMonthlyBudget(resourceId: string | null, month: string) {
  return useQuery({
    queryKey: ["resource-monthly-budget", resourceId, month],
    queryFn: ({ signal }) => get<ResourceMonthlyBudgetHistory>(
      `/provider-resources/${resourceId}/monthly-budgets?month=${month}`,
      signal,
    ),
    enabled: Boolean(resourceId),
    retry: 1,
  });
}
export function useSaveResourceMonthlyBudget(resourceId: string | null, month: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      amount: string | null;
      currency: string | null;
      expected_version: number;
    }) => put(`/provider-resources/${resourceId}/monthly-budgets/${month}`, {
      ...body,
      idempotency_key: crypto.randomUUID(),
    }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: V2_KEYS.utilization(month) });
      await client.invalidateQueries({ queryKey: ["resource-monthly-budget", resourceId, month] });
    },
  });
}
export function useProcurementReview(month: string) {
  return useQuery({ queryKey: V2_KEYS.procurement(month), queryFn: ({ signal }) => get<ProcurementReview>(`/procurement-reviews/${month}`, signal), retry: 1 });
}
export function useSaveProcurementNote(month: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: { note: string; expected_version: number }) => put(`/procurement-reviews/${month}/note`, { ...body, idempotency_key: crypto.randomUUID() }), onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.procurement(month) }) });
}
export function useDepartmentBill(month: string) {
  return useQuery({ queryKey: V2_KEYS.departmentBill(month), queryFn: ({ signal }) => get<DepartmentBill>(`/operating-bills/${month}/departments`, signal), retry: 1 });
}
export function useSaveDepartmentBudget(month: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (body: { departmentId: string; amount: string; currency: string; warning_threshold: string; expected_version: number }) => put(`/department-budgets/${body.departmentId}/${month}`, { amount: body.amount, currency: body.currency, warning_threshold: body.warning_threshold, expected_version: body.expected_version, idempotency_key: crypto.randomUUID() }), onSuccess: () => void client.invalidateQueries({ queryKey: V2_KEYS.departmentBill(month) }) });
}
export function useCheckDepartmentBill(month: string) {
  return useMutation({ mutationFn: () => post<{ month: string; ok: boolean; gaps: Array<{ code: string; severity: string }>; conservation: DepartmentBill["conservation"]; checkedAt: string }>(`/operating-bills/${month}/check`) });
}
export function useAllPurchases(month: string, resourceIds: string[], enabled = true) {
  const stable = [...resourceIds].sort();
  return useQuery({ queryKey: ["resource-purchases", month, stable], queryFn: async ({ signal }) => {
    const results = await Promise.all(stable.map((id) => get<{ items: Array<{ id: string; providerResourceId: string; purchaseType: string; description: string | null; amount: string; currency: string; purchasedAt: string; evidenceRef: string | null; createdBy: string }>; cashTotals: Array<{ currency: string; amount: string }> }>(`/provider-resources/${id}/purchases?month=${month}&limit=100`, signal)));
    return { items: results.flatMap((result) => result.items), cashTotals: results.flatMap((result) => result.cashTotals) };
  }, enabled: enabled && stable.length > 0, retry: 1 });
}
