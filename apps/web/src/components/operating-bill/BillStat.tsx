import { useLayoutEffect, useRef } from "react";
import { formatTokenMagnitude } from "../../lib/format";
import { TokenAmount } from "../ui/TokenAmount";

export function compactBillTokens(value: string): {
  text: string;
  unit: string;
} {
  const display = formatTokenMagnitude(value);
  return { text: display.value, unit: display.unit };
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
        className={`block whitespace-nowrap text-[13px] ${
          highlight ? "font-semibold text-ql-action" : "text-ql-fg-secondary"
        }`}
      >
        {label}
      </span>
      <strong
        data-fit="value"
        aria-label={
          value === null ? "数据缺失" : tokens && formatTokenMagnitude(value).unit ? `${value} Token` : value
        }
        className={`mt-2 block whitespace-nowrap text-[24px] font-semibold tabular-nums ${
          highlight ? "text-ql-action" : "text-ql-fg"
        }`}
      >
        {tokens ? <TokenAmount value={value} missing={missing} /> : value ?? missing}
      </strong>
    </article>
  );
}
