import type { BillingRuleValues } from "../../pages/quota-rule-contract";

/** Exact decimal product for display only; prices remain decimal strings in the payload. */
export function decimalProduct(a: string, b: string): string {
  if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b)) return "—";
  const digits = (value: string) => (value.split(".")[1] ?? "").length;
  const scale = digits(a) + digits(b);
  const raw = (BigInt(a.replace(".", "")) * BigInt(b.replace(".", ""))).toString().padStart(scale + 1, "0");
  return scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}`.replace(/\.?0+$/, "") : raw;
}

export function PricingPreview({ values }: { values: Pick<Partial<BillingRuleValues>, "rule_type" | "pricing_mode" | "currency" | "multiplier" | "cache_hit_price" | "cache_miss_price" | "output_price"> }) {
  if (values.rule_type !== "API_PRICE") return null;
  const multiplier = values.pricing_mode === "MULTIPLIER" ? values.multiplier ?? "" : "1";
  const price = (value: string | undefined) => value ? decimalProduct(decimalProduct(value, multiplier), "1000000") : "未配置";
  return <div className="md:col-span-4 rounded border border-ql-border p-3 text-xs" aria-label="有效单价预览">
    此规则生效时的最终单价（{values.currency ?? "CNY"}/百万 Token）：
    缓存命中输入 {price(values.cache_hit_price)}；未命中输入 {price(values.cache_miss_price)}；输出 {price(values.output_price)}。
    {values.pricing_mode === "MULTIPLIER" ? ` 已按 ${multiplier || "未配置"} 倍计算。` : "绝对单价。"}
  </div>;
}
