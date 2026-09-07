import { useLayoutEffect, useRef } from "react";
import { formatDecimal } from "../../lib/format";

export function compactBillTokens(value: string): {
  text: string;
  unit: string;
} {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { text: value, unit: "" };
  const integer = BigInt(match[1]!);
  if (integer < 100_000_000n)
    return { text: formatDecimal(value, 0), unit: "" };
  const hundredths = (integer + 50n) / 100n;
  const whole = hundredths / 100n,
    fraction = String(hundredths % 100n)
      .padStart(2, "0")
      .replace(/0+$/, "");
  return {
    text: `${whole.toLocaleString("zh-CN")}${fraction ? `.${fraction}` : ""}`,
    unit: "万",
  };
}

export function BillStat({
  label,
  value,
  tokens = false,
  approximate = false,
  missing = "—",
}: {
  label: string;
  value: string | null;
  tokens?: boolean;
  approximate?: boolean;
  missing?: string;
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
  }, [label, value, approximate]);
  return (
    <article
      ref={root}
      className="min-w-0 rounded-xl border border-ql-border-zone bg-ql-surface px-2 py-4"
    >
      <span
        data-fit="label"
        className="block whitespace-nowrap text-[12px] text-ql-fg-secondary"
      >
        {label}
      </span>
      <strong
        data-fit="value"
        aria-label={
          value === null ? "数据缺失" : tokens ? `${value} Token` : value
        }
        className="mt-2 block whitespace-nowrap text-[24px] font-semibold tabular-nums text-ql-fg"
      >
        {approximate && value !== null ? "约 " : ""}
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
