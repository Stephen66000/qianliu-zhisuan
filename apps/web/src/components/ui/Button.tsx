/**
 * 按钮 —— Web 规范 1.0 按钮 + 视觉系统 1.1 Button 条目。
 *
 * - variant：secondary 为默认；primary 每个操作区最多一个；ghost 用于工具栏和低频操作；
 *   danger 只在确认语境出现。
 * - 实色按钮文字用 on-action 令牌：浅色白字、深色深字，不写死白字。
 * - 样式定义在 src/styles/index.css 的 .ql-btn-*；<Link>、<label> 等非 button 元素用
 *   buttonClassName() 取同一套类名，不要另写按钮样式（eslint 会拦手写实色按钮）。
 * - .ql-btn-* 在 @layer components 里，Tailwind 只保留源码中以完整字面量出现的类名，
 *   所以变体和尺寸必须用下面的完整类名映射，不能写成 `ql-btn-${variant}` 拼接，
 *   否则这些规则会被裁掉（src/styles/visual-spec.test.ts 会用真实 Tailwind 构建检查）。
 * - 仅图标的按钮必须传 aria-label。
 * - React 19 函数组件直接接收 ref，焦点管理（如确认框默认聚焦取消）照常传 ref。
 */
import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm" | "form";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingText?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "ql-btn-primary",
  secondary: "ql-btn-secondary",
  ghost: "ql-btn-ghost",
  danger: "ql-btn-danger",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  md: "ql-btn-md",
  sm: "ql-btn-sm",
  form: "ql-btn-form",
};

export function buttonClassName(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return ["ql-btn", SIZE_CLASS[size], VARIANT_CLASS[variant], className].filter(Boolean).join(" ");
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  loading,
  loadingText = "处理中…",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return <button className={buttonClassName(variant, size, className)} type={type}
    {...rest} disabled={disabled || loading} aria-busy={loading || rest["aria-busy"]}
    aria-label={rest["aria-label"] ?? (loading ? loadingText : undefined)}>
    <span className="inline-grid items-center justify-items-center">
      <span className="col-start-1 row-start-1 inline-flex items-center gap-2" style={loading ? { visibility: "hidden" } : undefined}>{children}</span>
      {loading !== undefined ? <span className="col-start-1 row-start-1" aria-hidden style={loading ? undefined : { visibility: "hidden" }}>{loadingText}</span> : null}
    </span>
  </button>;
}
