import { formatQuotaQuantity, formatTokenMagnitude } from "../../lib/format";

/** Keep the raw value available while giving the number and unit separate type styles. */
export function TokenAmount({ value, missing = "—", title }: {
  value: string | null | undefined;
  missing?: string;
  title?: string;
}) {
  if (value === null || value === undefined) return missing;
  const display = formatTokenMagnitude(value);
  if (!display.unit) return display.value;
  return (
    <span className="whitespace-nowrap tabular-nums" title={title ?? `${value} Token`}>
      <span className="font-semibold">{display.value}</span>{" "}
      <span className="font-sans text-[length:max(11px,0.65em)] font-normal text-ql-fg-secondary">{display.unit}</span>
    </span>
  );
}

export function QuotaAmount({ value, unit, missing = "—" }: {
  value: string | null | undefined;
  unit: string | null | undefined;
  missing?: string;
}) {
  if (value === null || value === undefined) return missing;
  return /^tokens?$/i.test(unit?.trim() ?? "") ? <TokenAmount value={value} /> : formatQuotaQuantity(value, unit);
}
