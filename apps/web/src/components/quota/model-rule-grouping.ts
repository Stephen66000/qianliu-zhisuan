import type { BillingRule, ModelRouteItem, Provider, ProviderResourceItem, UnifiedModel } from "../../api/types";
import { toPerMillion } from "../../lib/price-unit";
import { editableWindows } from "../../pages/quota-rule-contract";
import { formatDaysOfWeek, parseDaysOfWeek } from "./WeekdayPicker";

export function getRuleStatusCategory(
  rule: Pick<BillingRule, "enabled" | "effective_from" | "effective_to" | "archived_at">,
  now: number = Date.now()
): "ARCHIVED" | "DISABLED" | "PENDING" | "EXPIRED" | "ACTIVE" {
  if (rule.archived_at) return "ARCHIVED";
  if (!rule.enabled) return "DISABLED";
  if (new Date(rule.effective_from).getTime() > now) return "PENDING";
  if (rule.effective_to && new Date(rule.effective_to).getTime() <= now) return "EXPIRED";
  return "ACTIVE";
}

export interface ModelRuleGroup {
  id: string;
  providerResourceId: string | null;
  upstreamModel: string | null;
  resourceName: string;
  resourceMode: string;
  providerId: string | null;
  providerName: string;
  unifiedModelName?: string;
  unifiedModelAlias?: string;
  baseRule?: BillingRule;
  allBaseRules: BillingRule[];
  peakRules: BillingRule[];
  allRules: BillingRule[];
  status: "ACTIVE" | "PENDING" | "DISABLED" | "EXPIRED" | "ARCHIVED";
}

export function sortRulesByPriority(rules: BillingRule[]): BillingRule[] {
  const statusRank = (r: BillingRule) => {
    if (r.archived_at) return 4;
    if (!r.enabled) return 3;
    const now = Date.now();
    if (new Date(r.effective_from).getTime() > now) return 2;
    if (r.effective_to && new Date(r.effective_to).getTime() <= now) return 2;
    return 1;
  };

  return [...rules].sort(
    (a, b) =>
      statusRank(a) - statusRank(b) ||
      b.effective_from.localeCompare(a.effective_from) ||
      a.id.localeCompare(b.id)
  );
}

export function getGroupStatus(
  rules: BillingRule[],
  now: number = Date.now()
): "ACTIVE" | "PENDING" | "DISABLED" | "EXPIRED" | "ARCHIVED" {
  if (rules.length === 0) return "DISABLED";
  const statuses = rules.map((r) => getRuleStatusCategory(r, now));
  if (statuses.some((s) => s === "ACTIVE")) return "ACTIVE";
  if (statuses.some((s) => s === "PENDING")) return "PENDING";
  if (statuses.every((s) => s === "ARCHIVED")) return "ARCHIVED";
  if (statuses.every((s) => s === "DISABLED")) return "DISABLED";
  if (statuses.every((s) => s === "EXPIRED")) return "EXPIRED";
  return "DISABLED";
}

// eslint-disable-next-line complexity -- 已登记例外（2026-09-14 I1 审核）：分组聚合多段归并逻辑，后续按基础规则/峰值规则/路由匹配提取子函数。
export function groupRulesByModel(
  rules: BillingRule[],
  resources: ProviderResourceItem[],
  providers: Provider[] = [],
  models: UnifiedModel[] = [],
  routes: ModelRouteItem[] = []
): ModelRuleGroup[] {
  const resourceMap = new Map(resources.map((r) => [r.id, r]));
  const providerMap = new Map(providers.map((p) => [p.id, p]));

  // Map to collect rules by (provider_resource_id, upstream_model)
  const groupMap = new Map<string, BillingRule[]>();

  for (const rule of rules) {
    const key = `${rule.provider_resource_id ?? "unassigned"}::${rule.upstream_model ?? "all"}`;
    const list = groupMap.get(key) ?? [];
    list.push(rule);
    groupMap.set(key, list);
  }

  const groups: ModelRuleGroup[] = [];

  for (const [key, groupRules] of groupMap.entries()) {
    const sample = groupRules[0];
    const resourceId = sample?.provider_resource_id ?? null;
    const upstreamModel = sample?.upstream_model ?? null;

    const resource = resourceId ? resourceMap.get(resourceId) : undefined;
    const provider = resource?.provider_id ? providerMap.get(resource.provider_id) : undefined;

    // Resolve unified model if route or alias matches
    let unifiedModelName: string | undefined;
    let unifiedModelAlias: string | undefined;

    const matchedRoute = routes.find(
      (rt) => rt.provider_resource_id === resourceId && rt.upstream_model === upstreamModel
    );
    if (matchedRoute) {
      const um = models.find((m) => m.id === matchedRoute.unified_model_id);
      if (um) {
        unifiedModelName = um.display_name;
        unifiedModelAlias = um.alias;
      }
    }
    if (!unifiedModelName && upstreamModel) {
      const um = models.find((m) => m.alias === upstreamModel || m.display_name === upstreamModel);
      if (um) {
        unifiedModelName = um.display_name;
        unifiedModelAlias = um.alias;
      }
    }

    const baseRules = groupRules.filter((r) => editableWindows(r).length === 0);
    const peakRules = groupRules.filter((r) => editableWindows(r).length > 0);

    const sortedBaseRules = sortRulesByPriority(baseRules);
    const sortedPeakRules = sortRulesByPriority(peakRules);

    const baseRule = sortedBaseRules[0];
    const status = getGroupStatus(groupRules);

    groups.push({
      id: key,
      providerResourceId: resourceId,
      upstreamModel,
      resourceName: resource?.name ?? (resourceId ? "未知资源" : "未指定资源"),
      resourceMode: resource?.mode ?? (sample?.rule_type === "MODEL_TIER" ? "CODING_PLAN" : "API"),
      providerId: resource?.provider_id ?? null,
      providerName: provider?.name ?? (resource ? resource.name : "未知厂商"),
      unifiedModelName,
      unifiedModelAlias,
      baseRule,
      allBaseRules: sortedBaseRules,
      peakRules: sortedPeakRules,
      allRules: groupRules,
      status,
    });
  }

  // Sort groups by provider name, then upstream model
  return groups.sort((a, b) => {
    const pComp = a.providerName.localeCompare(b.providerName, "zh-CN");
    if (pComp !== 0) return pComp;
    return (a.upstreamModel ?? "").localeCompare(b.upstreamModel ?? "");
  });
}

export function formatRulePricing(rule: BillingRule): string {
  if (rule.rule_type === "API_PRICE") {
    const parts: string[] = [];
    if (rule.cache_hit_price !== null && rule.cache_hit_price !== undefined) {
      parts.push(`命中 ${toPerMillion(rule.cache_hit_price)}`);
    }
    if (rule.cache_miss_price !== null && rule.cache_miss_price !== undefined) {
      parts.push(`未命中 ${toPerMillion(rule.cache_miss_price)}`);
    }
    if (rule.output_price !== null && rule.output_price !== undefined) {
      parts.push(`输出 ${toPerMillion(rule.output_price)}`);
    }
    const modeSuffix = rule.pricing_mode === "MULTIPLIER" && rule.multiplier ? ` × ${rule.multiplier}` : "";
    return `${rule.currency}/百万 Token: ${parts.join(" / ")}${modeSuffix}`;
  }
  return `×${rule.multiplier ?? "1.0"}`;
}

export function formatRuleTimeWindows(rule: BillingRule): string {
  const windows = editableWindows(rule);
  if (windows.length === 0) {
    return "全天 24 小时生效";
  }
  return windows
    .map(
      (w) =>
        `${formatDaysOfWeek(parseDaysOfWeek(w.days_of_week))} ${w.start_time}–${w.end_time} (${w.timezone})`
    )
    .join("；");
}

export function formatRuleEffective(rule: BillingRule): string {
  const fromStr = new Date(rule.effective_from).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const toStr = rule.effective_to
    ? new Date(rule.effective_to).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "长期有效";
  return `${fromStr} ～ ${toStr}`;
}
