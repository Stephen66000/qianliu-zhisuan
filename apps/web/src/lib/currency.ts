import { formatMoney } from "./format";

export interface CurrencyAmount { currency: string; amount: string }

export function currencyMoney(value: string | null, currency: string | null | undefined): string {
  if (value === null) return "—";
  if (currency === "CNY") return `¥${formatMoney(value)}`;
  return currency ? `${currency} ${formatMoney(value)}` : "—";
}

export function currencyFacts(
  facts: CurrencyAmount[] | undefined,
  fallback: string | null,
  fallbackCurrency?: string | null,
): string {
  if (facts?.length) return facts.map((fact) => currencyMoney(fact.amount, fact.currency)).join(" / ");
  return currencyMoney(fallback, fallbackCurrency);
}
