import { createContext, useContext } from "react";
import { canAccess, type AdminModule, type AdminPermissions, type AdminRoleCode } from "@qianliu/contracts";
export interface Access { roleCode?: AdminRoleCode; permissions?: AdminPermissions }
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
