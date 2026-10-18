import type { ReactNode } from "react";

import { StatusTag } from "../dashboard/StatusTag";
import { buttonClassName } from "../ui/Button";

/** 用于 <Link> 等非 button 元素；按钮本身请用 <Button>。 */
export const buttonPrimary = buttonClassName("primary");

export const buttonSecondary = buttonClassName("secondary");

export const inputClass =
  "h-9 rounded-lg border border-ql-border bg-ql-surface px-3 text-[13px] text-ql-fg outline-none focus:border-ql-action focus:ring-1 focus:ring-ql-action";

export function BillCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-ql-border-zone bg-ql-surface ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4">
      <div>
        <h2 className="text-[16px] font-semibold leading-6 text-ql-fg">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-[13px] text-ql-fg-tertiary">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function PrototypeMark() {
  return <StatusTag tone="neutral">原型演示数据</StatusTag>;
}

export function Meter({
  value,
  danger = false,
}: {
  value: number;
  danger?: boolean;
}) {
  const color = danger
    ? "bg-ql-danger"
    : value >= 80
      ? "bg-ql-success"
      : "bg-ql-action";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-ql-surface-muted">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${Math.max(2, value)}%` }}
      />
    </div>
  );
}
