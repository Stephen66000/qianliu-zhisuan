/**
 * 标准版首页概览指标卡（HOME-STANDARD-20260910 WP03；R01-F04 修订）。
 *
 * 规范依据：仟流 Web 产品视觉规范 1.0 §10.4 —— 整卡可点击时提供统一 Hover/Focus/指针；
 * 仟流青只用于本视窗唯一焦点（本月 Token 大数字，浅色主题用 accent-text 保证对比度）；
 * 变化量保持中性色（text-secondary），不按涨跌染色。
 * R01-F04：多币种金额分行展示（主币种大字 + 其余币种独立行），大金额按长度自适应字号，
 * 任何币种都不截断、不越出卡片。
 */
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface OverviewMetricCardProps {
  label: string;
  /** 跳转目标（五个入口之一；由调用方按计划第 3 节生成）。 */
  to: string;
  /** 主数值（首币种/唯一数值），大字展示。 */
  value: string;
  /** 其余币种金额（如多币种费用），每条独立一行、较小字号，不与主数值拼行。 */
  additionalValues?: string[];
  unit?: string;
  /** 唯一青色焦点（仅 Token 卡启用）。 */
  accent?: boolean;
  /** 不可比/缺口时替代主数值的说明文本。 */
  emptyText?: string;
  delta?: ReactNode;
  footnote?: ReactNode;
  testId?: string;
}

/** 主数值按字符长度自适应字号（tabular-nums 数字宽约 0.6em，按 259px 最窄卡片反推）。 */
function valueSizeClass(value: string): string {
  if (value.length <= 9) return "text-[24px] md:text-[28px] xl:text-[32px]";
  if (value.length <= 13) return "text-[22px] md:text-[24px] xl:text-[26px]";
  return "text-[18px] md:text-[20px] xl:text-[22px]";
}

export function OverviewMetricCard({
  label, to, value, additionalValues = [], unit, accent = false, emptyText, delta, footnote,
  testId,
}: OverviewMetricCardProps) {
  return (
    <Link
      aria-label={`${label}，点击查看详情`}
      className={[
        "block rounded-xl border border-ql-border bg-ql-surface p-4 text-left",
        "transition-colors duration-150 hover:border-ql-border-strong hover:bg-ql-surface-subtle",
        "focus-visible:outline-2 focus-visible:outline-ql-action",
      ].join(" ")}
      data-testid={testId}
      to={to}
    >
      <span className="flex items-center justify-between gap-2 text-[12px] text-ql-fg-tertiary">
        <span>{label}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </span>
      <span className="mt-3 block">
        <span className="flex items-baseline gap-1.5">
          <strong
            className={[
              "block whitespace-nowrap font-bold leading-[1.15] tracking-tight tabular-nums",
              valueSizeClass(value),
              accent ? "text-ql-accent-text" : "text-ql-fg",
            ].join(" ")}
          >
            {value}
          </strong>
          {unit ? <span className="shrink-0 text-[12px] text-ql-fg-tertiary">{unit}</span> : null}
        </span>
        {additionalValues.map((amount) => (
          <span
            className="mt-1 block whitespace-nowrap text-[16px] font-semibold leading-6 tabular-nums text-ql-fg"
            data-testid={`${testId ?? "home-card"}-additional-value`}
            key={amount}
          >
            {amount}
          </span>
        ))}
      </span>
      {emptyText ? <span className="mt-2 block text-[12px] text-ql-fg-tertiary">{emptyText}</span> : null}
      {delta ? (
        <span className="mt-3 block text-[13px] leading-5 text-ql-fg-secondary">{delta}</span>
      ) : null}
      {footnote ? (
        <span className="mt-1 block text-[12px] leading-[18px] text-ql-fg-tertiary">{footnote}</span>
      ) : null}
    </Link>
  );
}
