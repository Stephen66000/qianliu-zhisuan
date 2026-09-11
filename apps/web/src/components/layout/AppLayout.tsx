/**
 * W18 布局壳 —— Sidebar + Topbar + Outlet。
 *
 * 会话：useAdminSession 探测 /auth/me；未认证由 RequireAuth 拦截跳 /login。
 */
import { Outlet, useLocation } from "react-router-dom";
import { useAccess, pageModule, AccessContext } from "../../permissions";

import type { AdminSession } from "../../api/types";
import { useTheme } from "../../theme/useTheme";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface AppLayoutProps {
  admin: AdminSession;
}

function AppLayoutContent({ admin }: AppLayoutProps) {
  const theme = useTheme();
  const access = useAccess();
  const module = pageModule(useLocation().pathname);

  return (
    <div className="flex min-h-screen flex-col bg-ql-canvas text-ql-fg md:flex-row">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar admin={admin} theme={theme} />
        <main className={"flex-1 px-4 py-4 sm:px-6 md:px-8 md:py-6 " + (module && !access.can(module, "operate") ? "ql-readonly" : "")}>
          {module && !access.can(module) ? <p role="alert">没有此模块的查看权限，请从左侧选择已授权模块。</p> : <Outlet />}
        </main>
      </div>
    </div>
  );
}

export function AppLayout({ admin }: AppLayoutProps) {
  const contextAccess = useAccess();
  if (!contextAccess.roleCode && !contextAccess.permissions) {
    return (
      <AccessContext.Provider value={{ roleCode: admin.roleCode ?? "SUPER_ADMIN", permissions: admin.permissions }}>
        <AppLayoutContent admin={admin} />
      </AccessContext.Provider>
    );
  }
  return <AppLayoutContent admin={admin} />;
}
