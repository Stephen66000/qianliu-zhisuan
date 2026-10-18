/**
 * W18 页面壳模板 —— 页面主标题（page-title token）+ 说明 + 内容区。
 *
 * 非仪表盘页用 Web 规范字号 token（page-title 28/36 700）；
 * 首页看板另行遵循仪表盘补充的三级收敛。
 */
import type { ReactNode } from "react";

interface PageShellProps {
  title: string;
  /** 标题右侧的附加信息（如当前项目名），与标题基线对齐。 */
  meta?: ReactNode;
  description?: string;
  children: ReactNode;
}

export function PageShell({ title, meta, description, children }: PageShellProps) {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[28px] font-bold leading-9 text-ql-fg">{title}</h1>
          {meta ? <span className="text-[15px] text-ql-fg-secondary">{meta}</span> : null}
        </div>
        {description ? (
          <p className="mt-1 text-[13px] leading-5 text-ql-fg-secondary">{description}</p>
        ) : null}
      </header>
      <section className="rounded-2xl border border-ql-border-zone bg-ql-surface p-4">
        {children}
      </section>
    </div>
  );
}
