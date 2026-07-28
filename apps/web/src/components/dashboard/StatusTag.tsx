/**
 * W18 中性/语义状态标签 —— 仪表盘补充 §3 颜色纪律：
 * 常态状态（进行中/已完成/待命）一律中性灰；需要人处理才 warning/danger。
 * 形态统一"浅色底+深色字"（Web 规范 §10 状态标签）。
 */
import type { ReactNode } from "react";

type TagTone = "neutral" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<TagTone, string> = {
  neutral: "bg-ql-surface-muted text-ql-fg-secondary",
  success: "bg-ql-success-soft text-ql-success",
  warning: "bg-ql-warning-soft text-ql-warning",
  danger: "bg-ql-danger-soft text-ql-danger",
};

interface StatusTagProps {
  tone?: TagTone;
  children: ReactNode;
}

export function StatusTag({ tone = "neutral", children }: StatusTagProps) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] font-medium leading-[18px] ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
