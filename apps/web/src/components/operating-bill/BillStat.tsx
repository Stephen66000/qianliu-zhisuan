import { useLayoutEffect, useRef } from "react";
import { formatDecimal } from "../../lib/format";

export function compactBillTokens(value: string): {
  text: string;
  unit: string;
} {
  return { text: formatDecimal(value, 2), unit: "" };
}

export function BillStat({
  label,
  value,
  tokens = false,
  missing = "—",
  highlight = false,
}: {
  label: string;
  value: string | null;
  tokens?: boolean;
  missing?: string;
  highlight?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const display =
    value === null
      ? { text: missing, unit: "" }
      : tokens
        ? compactBillTokens(value)
        : { text: value, unit: "" };
  useLayoutEffect(() => {
    const fit = () =>
      root.current
        ?.querySelectorAll<HTMLElement>("[data-fit]")
        .forEach((element) => {
          if (!element.clientWidth) return;
          let low = 11,
            high = element.dataset.fit === "label" ? 12 : 24;
          element.style.fontSize = `${high}px`;
          if (element.scrollWidth <= element.clientWidth) return;
          while (high - low > 0.15) {
            const middle = (low + high) / 2;
            element.style.fontSize = `${middle}px`;
            if (element.scrollWidth > element.clientWidth) high = middle;
            else low = middle;
          }
          element.style.fontSize = `${low}px`;
        });
    fit();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (root.current) observer?.observe(root.current);
    void document.fonts?.ready.then(fit);
    return () => observer?.disconnect();
  }, [label, value]);
  return (
    <article
      ref={root}
      className={`min-w-0 rounded-xl px-2 py-4 ${
        highlight
          ? "border-2 border-ql-action bg-ql-surface-brand-soft/20"
          : "border border-ql-border-zone bg-ql-surface"
      }`}
    >
      <span
        data-fit="label"
        className={`block whitespace-nowrap text-[12px] ${
          highlight ? "font-semibold text-ql-action" : "text-ql-fg-secondary"
        }`}
      >
        {label}
      </span>
      <strong
        data-fit="value"
        aria-label={
          value === null ? "数据缺失" : tokens ? `${value} Token` : value
        }
        className={`mt-2 block whitespace-nowrap text-[24px] font-semibold tabular-nums ${
          highlight ? "text-ql-action" : "text-ql-fg"
        }`}
      >
        {display.text}
        {display.unit ? (
          <span className="ml-1 text-[11px] font-normal text-ql-fg-secondary">
            {display.unit}
          </span>
        ) : null}
      </strong>
    </article>
  );
}
