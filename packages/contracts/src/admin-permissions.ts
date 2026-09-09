export const ADMIN_MODULES = [
  ["dashboard", "首页看板"], ["principals", "使用主体"], ["resources", "厂商资源"],
  ["quota", "额度规则"], ["usage", "用量账本"], ["billing", "经营账单"],
  ["runtime", "运行保障"], ["enterprise", "企业信息"], ["admins", "管理员"],
  ["security", "登录安全"], ["audit", "审计日志"], ["version", "关于版本"],
] as const;
export type AdminModule = typeof ADMIN_MODULES[number][0];
export type AdminPermissions = Partial<Record<AdminModule, { view: boolean; operate: boolean }>>;
export type AdminRoleCode = "SUPER_ADMIN" | "CUSTOM";
export function canAccess(role: AdminRoleCode | undefined, permissions: AdminPermissions | undefined,
  module: AdminModule, action: "view" | "operate" = "view"): boolean {
  return role === "SUPER_ADMIN" || (permissions?.[module]?.view === true &&
    (action === "view" || permissions[module]?.operate === true));
}

/** Unknown endpoints are denied to custom roles. No access inferred from a URL supplied by the client. */
export function adminRouteModule(route: string): AdminModule | null {
  const root = route.split("/")[1] ?? "";
  if (root === "enterprise-settings") return "enterprise";
  if (root === "admins" || root === "admin-role") return "admins";
  if (root === "security-settings" || root === "admin-sessions") return "security";
  if (root === "operation-logs") return "audit";
  if (root === "deployment-logs" || root === "system-version") return "version";
  if (root === "dashboard") return "dashboard";
  if (root === "usage" || root === "gateway-requests") return "usage";
  if (root?.startsWith("operating-bill") || root === "procurement-reviews") return "billing";
  if (["alerts", "availability-events", "availability-rules", "runtime-assurance"].includes(root)) return "runtime";
  if (["billing-rules", "dispatch-policies", "pricing-configurations", "pricing-ready-routes", "department-budgets"].includes(root)) return "quota";
  if (["principals", "grants", "employee-model-rules", "organization-units", "directory-members",
    "directory-sources", "directory-sync-runs", "directory-excel-template", "directory-excel-imports",
    "directory-import-runs"].includes(root)) return "principals";
  if (["providers", "provider-resources", "unified-models", "model-routes", "supply-forecasts",
    "provider-finance", "provider-finance-events", "provider-finance-duplicate-candidates",
    "provider-finance-reconciliation-cases", "provider-subscription-periods"].includes(root)) return "resources";
  return null;
}
