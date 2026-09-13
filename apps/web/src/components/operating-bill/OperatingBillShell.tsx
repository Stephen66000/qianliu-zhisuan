import {
  BadgeCheck,
  BriefcaseBusiness,
  CalendarDays,
  FileLock2,
  Gauge,
  LayoutDashboard,
  Receipt,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useFeatureFlags } from "../../feature-flags";

export type OperatingBillSection =
  | "value"
  | "finance"
  | "departments"
  | "employees"
  | "projects"
  | "plans"
  | "overview"
  | "procurement"
  | "reconciliation";

const sections = [
  { id: "value", label: "价值体现", icon: Sparkles },
  { id: "finance", label: "财务账", icon: Receipt },
  { id: "departments", label: "部门账", icon: UsersRound },
  { id: "employees", label: "员工账", icon: UsersRound },
  { id: "projects", label: "项目账", icon: BriefcaseBusiness },
  { id: "plans", label: "套餐利用率", icon: Gauge },
  { id: "overview", label: "月度总览", icon: LayoutDashboard },
  { id: "procurement", label: "采购复盘", icon: Gauge },
  { id: "reconciliation", label: "对账与导出", icon: FileLock2 },
] as const;

export function sectionUrl(
  section: OperatingBillSection,
  month: string,
  providerCode: string | null,
): string {
  const search = new URLSearchParams({ month });
  if (section === "employees" || section === "projects" || section === "departments") {
    if (providerCode) search.set("provider_code", providerCode);
    return `/operating-bill/${section}?${search}`;
  }
  if (section !== "overview") search.set("tab", section);
  return `/operating-bill?${search}`;
}

export function currentOperatingBillMonth(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .slice(0, 7);
}

export function operatingBillMonth(value: string | null): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (!match) return currentOperatingBillMonth();
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 2000 && year <= 2200 && month >= 1 && month <= 12
    ? value!
    : currentOperatingBillMonth();
}

export function OperatingBillShell({
  active,
  month,
  children,
}: {
  active: OperatingBillSection;
  month: string;
  status?: "DRAFT" | "CLOSED";
  version?: number;
  children: ReactNode;
}) {
  const featureFlags = useFeatureFlags();
  const [params, setParams] = useSearchParams();
  const changeMonth = (nextMonth: string) => {
    const next = new URLSearchParams(params);
    next.set("month", nextMonth);
    next.delete("page");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[28px] font-bold leading-9 text-ql-fg">
              经营账单
            </h1>
          </div>
        </div>
        <label className="flex h-9 items-center gap-2 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px]">
          <CalendarDays className="h-4 w-4 text-ql-action" />
          <input
            aria-label="账单月份"
            className="bg-transparent outline-none"
            max="2200-12"
            min="2000-01"
            onChange={(event) => changeMonth(event.target.value)}
            type="month"
            value={month}
          />
          <span className="text-[11px] text-ql-fg-tertiary">北京时间自然月</span>
        </label>
      </header>
      <nav
        aria-label="经营账单页签"
        className="overflow-x-auto rounded-xl border border-ql-border-zone bg-ql-surface p-1.5"
      >
        <div className="flex min-w-max gap-1">
          {sections.filter(({ id }) =>
            (id !== "procurement" || featureFlags.FEATURE_PROCUREMENT_REVIEW)
            && (id !== "departments" || featureFlags.FEATURE_DEPARTMENT_COST)
          ).map(({ id, label, icon: Icon }) => (
            <Link
              aria-current={active === id ? "page" : undefined}
              className={`flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13px] font-medium ${
                active === id
                  ? "bg-ql-surface-brand-soft text-ql-action"
                  : "text-ql-fg-secondary hover:bg-ql-surface-subtle"
              }`}
              key={id}
              to={sectionUrl(id, month, params.get("provider_code"))}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
        </div>
      </nav>
      {children}
    </div>
  );
}
