import type { BillingRuleWindow } from "../kysely-ledger-tables.js";

interface PriceRow {
  rule_type: string; rule_version: string; pricing_mode?: string; effective_from: Date;
  effective_to?: Date | null; time_windows?: BillingRuleWindow[] | null; timezone?: string | null;
  days_of_week?: number[] | null; start_time?: string | null; end_time?: string | null;
  priority?: number; currency?: string;
}
function windows(rule: PriceRow): BillingRuleWindow[] {
  return rule.time_windows ?? (rule.timezone && rule.start_time && rule.end_time ? [{
    timezone: rule.timezone, start_time: rule.start_time, end_time: rule.end_time, days_of_week: rule.days_of_week ?? null,
  }] : []);
}
function periodsOverlap(a: PriceRow, b: PriceRow) {
  return a.effective_from.getTime() < (b.effective_to?.getTime() ?? Infinity)
    && b.effective_from.getTime() < (a.effective_to?.getTime() ?? Infinity);
}
function seconds(time: string) { const [h = 0, m = 0, s = 0] = time.split(":").map(Number); return h * 3600 + m * 60 + s; }
function segments(window: BillingRuleWindow) {
  return (window.days_of_week ?? [1, 2, 3, 4, 5, 6, 7]).flatMap((day) => {
    const start = seconds(window.start_time); const end = seconds(window.end_time);
    const base = (day - 1) * 86400;
    return start < end ? [[base + start, base + end] as const]
      : [[base + start, base + 86400] as const, [(day % 7) * 86400, (day % 7) * 86400 + end] as const];
  });
}
function overlap(a: BillingRuleWindow[], b: BillingRuleWindow[]) {
  return a.some((x) => b.some((y) => x.timezone !== y.timezone || segments(x).some(([s, e]) =>
    segments(y).some(([t, u]) => s < u && t < e))));
}

export function pricingSetIssue(rules: PriceRow[], existing: PriceRow[] = []): string | null {
  if (new Set(rules.map((rule) => rule.rule_version)).size !== rules.length) return "同一规则集的版本名称不能重复";
  if (new Set(rules.map((rule) => rule.effective_from.getTime())).size !== 1) return "整套规则必须使用同一生效时间";
  for (let i = 0; i < rules.length; i++) {
    const a = rules[i]!;
    for (const b of [...rules.slice(i + 1), ...existing]) {
      if (!periodsOverlap(a, b)) continue;
      if (a.rule_type === "API_PRICE" && b.rule_type === "API_PRICE"
        && (a.pricing_mode ?? "ABSOLUTE") !== (b.pricing_mode ?? "ABSOLUTE")) return "不能混用绝对价格与倍率计价；切换模式请替换旧规则集";
      if ((a.currency ?? "CNY") !== (b.currency ?? "CNY")) return "同资源同模型生效价格的币种必须一致";
      if ((a.priority ?? 100) !== (b.priority ?? 100)) continue;
      const aw = windows(a); const bw = windows(b);
      if ((aw.length === 0 && bw.length === 0) || (aw.length > 0 && bw.length > 0 && overlap(aw, bw))) {
        return "同优先级的计价时段重叠，请设置明确优先级或替换旧规则集";
      }
    }
  }
  return null;
}
