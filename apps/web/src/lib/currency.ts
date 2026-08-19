import { formatMoney } from "./format";

export interface CurrencyAmount { currency: string; amount: string }

function addDecimalText(left: string, right: string): string {
  const scale = Math.max(left.split(".")[1]?.length ?? 0, right.split(".")[1]?.length ?? 0);
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  };
  const total = units(left) + units(right);
  if (scale === 0) return total.toString();
  const padded = total.toString().padStart(scale + 1, "0");
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`;
}

export function groupCurrencyAmounts(facts: CurrencyAmount[]): CurrencyAmount[] {
  const grouped = new Map<string, string>();
  for (const fact of facts) {
    grouped.set(fact.currency, addDecimalText(grouped.get(fact.currency) ?? "0", fact.amount));
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount }));
}

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
