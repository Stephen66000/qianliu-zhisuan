/**
 * W18 布局壳 —— Sidebar + Topbar + Outlet。
 *
 * 会话：useAdminSession 探测 /auth/me；未认证由 RequireAuth 拦截跳 /login。
 */
import { Outlet } from "react-router-dom";

import type { AdminSession } from "../../api/types";
import { useTheme } from "../../theme/useTheme";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface AppLayoutProps {
  admin: AdminSession;
}

export function AppLayout({ admin }: AppLayoutProps) {
  const theme = useTheme();

  return (
    <div className="flex min-h-screen bg-ql-canvas text-ql-fg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar admin={admin} theme={theme} />
        <main className="flex-1 px-8 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
