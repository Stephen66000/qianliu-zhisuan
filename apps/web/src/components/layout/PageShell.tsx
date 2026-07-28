/**
 * W18 页面壳模板 —— 页面主标题（page-title token）+ 说明 + 内容区。
 *
 * 非仪表盘页用 Web 规范字号 token（page-title 28/36 700）；
 * 首页看板另行遵循仪表盘补充的三级收敛。
 */
import type { ReactNode } from "react";

interface PageShellProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function PageShell({ title, description, children }: PageShellProps) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[28px] font-bold leading-9 text-ql-fg">{title}</h1>
        {description ? (
          <p className="mt-1 text-[13px] leading-5 text-ql-fg-tertiary">{description}</p>
        ) : null}
      </header>
      <section className="rounded-2xl border border-ql-border-zone bg-ql-surface p-4">
        {children}
      </section>
    </div>
  );
}
