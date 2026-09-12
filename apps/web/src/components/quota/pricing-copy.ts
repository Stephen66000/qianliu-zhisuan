import type { BillingRule, ProviderResourceItem } from "../../api/types";
import { toPerMillion } from "../../lib/price-unit";
import { editableWindows, localDateTimeValue, type BillingRuleValues } from "../../pages/quota-rule-contract";

export function pricingCopyCandidates(rules: BillingRule[], resources: ProviderResourceItem[], targetId: string, model: string) {
  const target = resources.find((item) => item.id === targetId);
  if (!target) return [];
  return rules.filter((rule) => {
    const source = resources.find((item) => item.id === rule.provider_resource_id);
    return source?.provider_id === target.provider_id && source?.mode === target.mode
      && rule.enabled && !rule.archived_at && new Date(rule.effective_from).getTime() <= Date.now()
      && (!rule.effective_to || new Date(rule.effective_to).getTime() > Date.now());
  }).sort((a, b) => Number(b.provider_resource_id === targetId) - Number(a.provider_resource_id === targetId)
    || Number(b.upstream_model === model) - Number(a.upstream_model === model)
    || b.effective_from.localeCompare(a.effective_from));
}

export function copyPrice(rule: BillingRule, resourceId: string, upstreamModel: string, suffix: string): BillingRuleValues {
  return {
    rule_type: rule.rule_type as BillingRuleValues["rule_type"], rule_version: `${rule.rule_version.slice(0, 38)}-${suffix}`,
    provider_resource_id: resourceId, upstream_model: upstreamModel,
    effective_from: localDateTimeValue(), effective_to: "", windows: editableWindows(rule),
    pricing_mode: rule.pricing_mode ?? "ABSOLUTE", currency: rule.currency as "CNY" | "USD",
    multiplier: rule.multiplier ?? "",
    cache_hit_price: toPerMillion(rule.cache_hit_price),
    cache_miss_price: toPerMillion(rule.cache_miss_price),
    output_price: toPerMillion(rule.output_price),
    priority: rule.priority,
  };
}

export function currentPricingSet(rules: BillingRule[], source: BillingRule) {
  const grouped = rules.filter((rule) => rule.provider_resource_id === source.provider_resource_id && rule.upstream_model === source.upstream_model)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return grouped.filter((rule) => {
    const key = JSON.stringify([rule.rule_type, rule.priority, editableWindows(rule)]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}
