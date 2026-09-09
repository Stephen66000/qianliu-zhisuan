import type { FastifyInstance } from "fastify";
import { canAccess, adminRouteModule } from "@qianliu/contracts";
import type { AdminContext } from "../server.js";

export async function loadAdminAccess(app: FastifyInstance, adminId: string, enterpriseId: string) {
  const admin = await app.db.selectFrom("admin_user").select("role_code")
    .where("id", "=", adminId).where("enterprise_id", "=", enterpriseId).executeTakeFirstOrThrow();
  const role = await app.db.selectFrom("admin_role").select(["name", "permissions"])
    .where("enterprise_id", "=", enterpriseId).executeTakeFirst();
  return { roleCode: admin.role_code, roleName: admin.role_code === "SUPER_ADMIN" ? "超级管理员" : role?.name ?? "未配置岗位",
    permissions: admin.role_code === "CUSTOM" ? role?.permissions ?? {} : {} };
}
export function allowsRoute(admin: AdminContext, route: string, method: string) {
  if (["/auth/me", "/auth/logout", "/auth/change-password"].includes(route)) return true;
  if (admin.roleCode === "SUPER_ADMIN") return true;
  const read = method === "GET" || method === "HEAD";
  if (read && /^\/reference-data\/(providers|resources|models|principals)$/.test(route)) {
    return (["usage", "quota", "runtime", "billing", "principals", "resources"] as const).some(m => canAccess(admin.roleCode, admin.permissions, m));
  }
  if (read && route === "/unified-models/:modelId/routes" && canAccess(admin.roleCode, admin.permissions, "quota")) return true;
  // Account/role writes can grant privileges, so they are reserved to super administrators.
  if ((!read && /^\/(admins|admin-role|security-settings|admin-sessions|deployment-logs)(\/|$)/.test(route)) ||
    route === "/deployment-logs/:id") return false;
  const module = adminRouteModule(route);
  return module !== null && canAccess(admin.roleCode, admin.permissions, module, read ? "view" : "operate");
}
