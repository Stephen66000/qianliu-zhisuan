import { createContext, useContext } from "react";
import { canAccess, type AdminModule, type AdminPermissions, type AdminRoleCode } from "@qianliu/contracts";
export interface Access {
  roleCode?: AdminRoleCode;
  permissions?: AdminPermissions;
  /**
   * 当前会话企业（`RequireAuth` 直接用 `session.admin` 作为上下文值，因此这里天然可用）。
   * 只用于**展示与二次确认**（激活弹窗要求管理员逐字复核企业 ID）；
   * 权威企业始终由服务端从会话取得，前端不靠它做任何授权判定。
   */
  enterpriseId?: string;
}
export const AccessContext = createContext<Access>({});
export function useAccess() {
  const access = useContext(AccessContext);
  return { ...access, can: (module: AdminModule, action: "view" | "operate" = "view") => canAccess(access.roleCode, access.permissions, module, action) };
}
export function pageModule(path: string): AdminModule | null {
  const root = path.split("/")[1];
  return ({ dashboard: "dashboard", principals: "principals", resources: "resources", "quota-rules": "quota",
    usage: "usage", "operating-bill": "billing", "runtime-assurance": "runtime", admins: "admins" } as Record<string, AdminModule>)[root ?? ""] ?? null;
}
