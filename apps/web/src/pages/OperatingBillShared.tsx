import { formatMoney } from "../lib/format";
export { currencyFacts, currencyMoney } from "../lib/currency";

export function money(value: string | null): string { return value === null ? "—" : `¥${formatMoney(value)}`; }
export function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[52rem] text-left text-[13px]"><thead className="border-y border-ql-border-zone bg-ql-surface-subtle text-[12px] text-ql-fg-tertiary"><tr>{headers.map((header, index) => <th className={`px-4 py-2 font-medium ${index > 1 && ["成本", "费用", "Token", "扣减", "投入"].some((word) => header.includes(word)) ? "text-right" : ""}`} key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}
export function Cell({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-ql-fg-secondary">{children}</td>; }
export function Num({ children }: { children: React.ReactNode }) { return <td className="px-4 py-3 text-right font-medium tabular-nums text-ql-fg">{children}</td>; }
