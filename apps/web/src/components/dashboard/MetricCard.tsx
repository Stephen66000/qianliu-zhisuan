/**
 * W18 指标卡片 —— 仪表盘补充 §4 字体三级收敛：
 * 统计大数字收敛到 24px（数字是参考不是主角）；标签 caption 12px；辅助说明 12px 浅灰。
 *
 * accent 焦点（仟流青大数字）每视口限 1-2 处（Web 规范 §3.5），
 * 浅色下大数字才可用 accent-visual，小字一律 accent-text。
 */
import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  /** 主数值文本（已格式化）。null → 空状态展示（数据源 gap，不伪造）。 */
  value: string | null;
  /** 单位/后缀（如 "人"、"元"），12px 浅灰随数字行。 */
  unit?: string;
  /** 辅助说明（如"当前正在使用 3 人"）。 */
  hint?: ReactNode;
  /** 空值时的展示文案（默认"暂无数据"）。 */
  emptyText?: string;
  /** 仟流青焦点（全场最重数字，每视口 1-2 处）。 */
  accent?: boolean;
}

export function MetricCard({
  label,
  value,
  unit,
  hint,
  emptyText = "暂无数据",
  accent = false,
}: MetricCardProps) {
  return (
    <div className="rounded-xl border border-ql-border bg-ql-surface p-4">
      <p className="text-[12px] leading-[18px] text-ql-fg-tertiary">{label}</p>
      {value === null ? (
        <p className="mt-1 text-[13px] leading-6 text-ql-fg-tertiary">{emptyText}</p>
      ) : (
        <p className="mt-1 whitespace-nowrap">
          <span
            className={[
              "text-[24px] font-bold leading-[1.2] [font-variant-numeric:tabular-nums]",
              accent ? "text-ql-accent-text" : "text-ql-fg",
            ].join(" ")}
          >
            {value}
          </span>
          {unit ? (
            <span className="ml-1 text-[12px] leading-[18px] text-ql-fg-tertiary">{unit}</span>
          ) : null}
        </p>
      )}
      {hint ? <div className="mt-1 text-[12px] leading-[18px] text-ql-fg-tertiary">{hint}</div> : null}
    </div>
  );
}
