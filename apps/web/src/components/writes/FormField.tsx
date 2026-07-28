/**
 * W19 表单字段 —— 标签 + 输入 + 错误（Web 规范 §10 表单：
 * 标签不只依赖 placeholder；错误状态同时给颜色+图标+文字；focus 2px 焦点环）。
 */
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

export function FormField({ label, htmlFor, error, hint, children }: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13px] font-medium leading-5 text-ql-fg" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1 text-[12px] leading-[18px] text-ql-danger" role="alert">
          <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">{hint}</p>
      ) : null}
    </div>
  );
}

/** 统一的文本输入样式（border-strong 默认边框，focus 2px 环）。 */
export const INPUT_CLASS =
  "h-10 rounded-lg border border-ql-border-strong bg-ql-surface px-3 text-[14px] text-ql-fg focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-ql-action disabled:cursor-not-allowed disabled:bg-ql-surface-muted disabled:text-ql-fg-disabled";
