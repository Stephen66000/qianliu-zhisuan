/**
 * W18 顶部栏 —— 页面标题槽 + 主题切换三态 + 用户菜单。
 *
 * 主题切换：规范 §4 三态（跟随系统/浅色/深色），不做循环切换按钮。
 */
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { useLogout } from "../../api/auth";
import type { AdminSession } from "../../api/types";
import type { ThemeState } from "../../theme/useTheme";
import type { ThemePreference } from "../../theme/theme";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

interface TopbarProps {
  admin: AdminSession;
  theme: ThemeState;
}

export function Topbar({ admin, theme }: TopbarProps) {
  const navigate = useNavigate();
  const logout = useLogout();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        navigate("/login", { replace: true });
      },
    });
  };

  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-end gap-2 border-b border-ql-border bg-ql-surface px-4 py-2 md:h-16 md:gap-4 md:px-8 md:py-0">
      {/* 仟流智算 Agent 入口槽位（PRD §10.1：一期功能开关隐藏，预留位置） */}
      <div aria-label="主题" className="flex items-center gap-1 rounded-lg border border-ql-border p-1">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme.preference === value;
          return (
            <button
              aria-pressed={active}
              className={[
                "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] leading-[18px]",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action",
                active
                  ? "bg-ql-surface-brand-soft font-medium text-ql-action"
                  : "text-ql-fg-tertiary hover:text-ql-fg",
              ].join(" ")}
              key={value}
              onClick={() => theme.setPreference(value)}
              title={`主题：${label}`}
              type="button"
            >
              <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3">
        <Link to="/change-password" className="text-[13px] text-ql-action">修改密码</Link>
        <span className="hidden text-[13px] leading-5 text-ql-fg-secondary sm:inline">{admin.displayName || admin.username}</span>
        <button
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-ql-fg-tertiary hover:bg-ql-surface-subtle hover:text-ql-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ql-action"
          disabled={logout.isPending}
          onClick={handleLogout}
          type="button"
        >
          <LogOut aria-hidden className="h-4 w-4" strokeWidth={1.75} />
          退出
        </button>
      </div>
    </header>
  );
}
