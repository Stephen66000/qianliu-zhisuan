/**
 * W18 左侧导航 —— 七入口（PRD §10.1 / TRD §11.1 路由表）。
 *
 * 视觉：Web 规范 §8 壳层（展开侧栏 256px、顶栏 64px）、§10 导航
 * （选中 = 品牌软底 + 品牌功能色 + 左指示条；Hover 与 Selected 有明显差异）。
 * 图标：Lucide 单色线性 20px，颜色继承文字（§9）；不给导航图标上状态色。
 */
import {
  Bell,
  BookOpenText,
  Gauge,
  LayoutDashboard,
  ReceiptText,
  Settings,
  Server,
  Users,
} from "lucide-react";
import { Link, NavLink } from "react-router-dom";

import qianliuLogo from "../../assets/qianliu-logo-primary.png";
import { pageModule, useAccess } from "../../permissions";
import type { AdminModule } from "@qianliu/contracts";

const NAV_ITEMS = [
  { to: "/dashboard", label: "首页看板", icon: LayoutDashboard },
  { to: "/principals", label: "使用主体", icon: Users },
  { to: "/resources", label: "厂商资源", icon: Server },
  { to: "/quota-rules", label: "额度规则", icon: Gauge },
  { to: "/usage", label: "用量账本", icon: BookOpenText },
  { to: "/operating-bill", label: "经营账单", icon: ReceiptText },
  { to: "/runtime-assurance", label: "运行保障", icon: Bell },
  { to: "/settings", label: "系统设置", icon: Settings },
] as const;

export function Sidebar() {
  const access = useAccess();
  const items = NAV_ITEMS.filter(i => i.to === "/settings" ? ["enterprise", "admins", "security", "audit", "version"].some(m => access.can(m as AdminModule)) : access.can(pageModule(i.to)!));
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-ql-border bg-ql-surface md:h-screen md:w-64 md:border-b-0 md:border-r">
      <Link
        aria-label="返回首页看板"
        className="flex h-12 items-center gap-2 border-b border-ql-border px-4 hover:bg-ql-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ql-action md:h-16 md:px-5"
        to="/dashboard"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
          <img
            alt="仟流科技 Logo"
            className="h-12 w-12 max-w-none object-contain"
            src={qianliuLogo}
          />
        </span>
        <span className="text-[15px] font-semibold leading-[22px] text-ql-fg">
          仟流智算
        </span>
      </Link>
      <nav aria-label="主导航" className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-col md:overflow-y-auto md:px-3 md:py-4">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            className={({ isActive }) =>
              [
                "relative flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[14px] leading-5",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action",
                isActive
                  ? "bg-ql-surface-brand-soft font-medium text-ql-action before:hidden before:absolute before:left-[-12px] before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-ql-action md:before:block"
                  : "text-ql-fg-secondary hover:bg-ql-surface-subtle hover:text-ql-fg",
              ].join(" ")
            }
            key={to}
            to={to}
          >
            <Icon aria-hidden className="h-5 w-5" strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
